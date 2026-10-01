/**
 * /api/send — outbound mail.
 *
 *   send · reply · forward · suggest
 *
 * The `send` action is the one place a message leaves the system, so it is
 * deliberately paranoid:
 *
 *   1. The mailbox must be owned and writable (`requireMailbox` +
 *      `assertCanSend`), and the envelope From is derived from that mailbox —
 *      never accepted from the request — so a caller cannot spoof a sender.
 *   2. `assertSendable` and `buildSendPayload` re-check recipients, size and
 *      body, and re-sanitise the HTML on the way out.
 *   3. The message row is written *before* the provider call (status `queued`)
 *      and linked to the Resend id afterwards. If the provider call throws, the
 *      queued row is removed so a failed send never leaves a phantom in Sent.
 *
 * Scheduling is delegated to Resend's native `scheduled_at`. That keeps the
 * database free of a scheduler process while still producing real delivery
 * events over the webhook endpoint.
 */

import { createHandler, queryBool, queryInt } from '../packages/http/pipeline.js';
import { query, queryAll, queryOne } from '../packages/db/pool.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { logger } from '../packages/shared/logger.js';
import { mail as mailConfig, rateLimit } from '../packages/shared/config.js';
import { assertCanSend, requireMailbox } from '../packages/auth/guard.js';
import { makeSnippet } from '../packages/shared/sanitize.js';
import {
  attachProviderIds,
  countSentForDomain,
  countSentSince,
  createMessage,
  destroy,
  findOwned,
  listAttachments,
  setHasAttachments,
} from '../packages/db/messages.js';
import { listMailboxesForUser, rememberContacts, searchContacts } from '../packages/db/mailboxes.js';
import { downloadAttachment } from '../packages/storage/attachments.js';
import {
  assertSendable,
  buildForwardDraft,
  buildReplyDraft,
  buildSendPayload,
  formatFrom,
  recipientSuggestions,
} from '../packages/mail/compose.js';
import { sendEmail } from '../packages/mail/resend.js';
import { sendSchema } from '../packages/validation/schemas.js';

/** Resend will not schedule further out than this. */
const MAX_SCHEDULE_DAYS = 30;

/** Resolve the sending mailbox and confirm it may send. */
async function sendingMailbox(ctx) {
  const mailbox = await requireMailbox(ctx.session, ctx.body?.mailboxId || ctx.query.mailboxId || null);
  return assertCanSend(mailbox, ctx.session.user);
}

/**
 * Enforce the per-day and per-hour send ceilings.
 *
 * `rateLimit` above is a per-window request counter keyed by ip/mailbox; these
 * are volume ceilings that must hold across serverless instances and across the
 * whole account, so they are counted from the messages table rather than a
 * counter row.
 */
async function assertWithinSendQuota(mailbox, session) {
  const isAdmin = session.user.role === 'admin';
  const dailyCap = isAdmin ? mailConfig.dailyLimitAdmin : mailConfig.dailyLimitUser;
  const hourlyCap = isAdmin ? mailConfig.hourlyLimitAdmin : mailConfig.hourlyLimitUser;

  // The user ceilings apply to the whole account, not to one mailbox. A user
  // with several mailboxes would otherwise get a fresh allowance per mailbox and
  // send `n × cap` a day, which is exactly what the ceiling exists to prevent.
  const accountMailboxes = [mailbox.id];
  try {
    for (const mb of await listMailboxesForUser(session.user.id)) {
      if (!accountMailboxes.includes(mb.id)) accountMailboxes.push(mb.id);
    }
  } catch (err) {
    // Falling back to the selected mailbox keeps sending working if the lookup
    // fails; the stricter count is preferred, not required, for correctness.
    logger.warn('Could not list every mailbox for the send quota check', { error: err?.message });
  }

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const sentToday = Number(await countSentSince(accountMailboxes, dayAgo));
  if (sentToday >= dailyCap) {
    throw new AppError(Codes.RATE_LIMITED, `You have reached your daily send limit of ${dailyCap}.`, 429, {
      details: { limit: dailyCap, window: 'day', scope: 'account' },
    });
  }

  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const sentThisHour = Number(await countSentSince(accountMailboxes, hourAgo));
  if (sentThisHour >= hourlyCap) {
    throw new AppError(Codes.RATE_LIMITED, `You have reached your hourly send limit of ${hourlyCap}.`, 429, {
      details: { limit: hourlyCap, window: 'hour', scope: 'account' },
    });
  }

  if (mailbox.domain_id && mailConfig.dailyLimitDomain > 0) {
    const domainSent = Number(await countSentForDomain(mailbox.domain_id, dayAgo));
    if (domainSent >= mailConfig.dailyLimitDomain) {
      throw new AppError(Codes.RATE_LIMITED, 'This domain has reached its daily send limit.', 429, {
        details: { limit: mailConfig.dailyLimitDomain, window: 'day', scope: 'domain' },
      });
    }
  }
}

/** Map stored attachment rows onto the request shape `resolveAttachments` wants. */
function toSendPayloads(files) {
  return files.map((file) => ({
    storagePath: file.storage_path,
    filename: file.filename,
    mimeType: file.mime_type,
    inline: file.inline,
    contentId: file.content_id,
  }));
}

/**
 * Turn the request's attachments into base64 for the provider, verifying that
 * any pre-uploaded storage path actually belongs to this mailbox.
 */
async function resolveAttachments(body, mailboxId) {
  const provider = [];

  for (const file of body.attachments) {
    let content = file.data || null;
    let size = file.data ? Buffer.byteLength(file.data, 'base64') : 0;

    if (!content) {
      if (!file.storagePath) continue; // nothing to send; skip

      // Ownership: a storage path is a capability, but confirm it belongs to a
      // live attachment in this mailbox before reading its bytes.
      const owned = await queryOne(
        `select storage_path from public.attachments
         where storage_path = $1 and mailbox_id = $2 and not is_deleted`,
        [file.storagePath, mailboxId],
      );
      if (!owned) {
        throw new AppError(Codes.NOT_FOUND, `Attachment not found: ${file.filename}`, 404, {
          details: { filename: file.filename },
        });
      }

      const { data } = await downloadAttachment(file.storagePath);
      content = data.toString('base64');
      size = data.length;
    }

    provider.push({
      filename: file.filename,
      content,
      size,
      content_type: file.mimeType,
      ...(file.inline && file.contentId ? { content_id: file.contentId } : null),
    });
  }

  return provider;
}

export default createHandler({
  name: 'send',
  audit: {
    send: { action: 'mail.send', entityType: 'message' },
  },

  actions: {
    // ── Send ────────────────────────────────────────────────────────────────
    send: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: sendSchema,
      rateLimit: rateLimit.maxSend,
      rateLimitWindow: 3600,
      handler: async (ctx) => {
        const mailbox = await sendingMailbox(ctx);
        const body = ctx.body;

        // Schedule window: must be in the future, no more than 30 days out.
        let scheduledIso = null;
        if (body.scheduledFor) {
          const when = new Date(body.scheduledFor);
          if (when.getTime() <= Date.now()) {
            throw new AppError(Codes.VALIDATION_ERROR, 'Pick a send time in the future.');
          }
          if (when.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) {
            throw new AppError(Codes.VALIDATION_ERROR, `You can schedule up to ${MAX_SCHEDULE_DAYS} days ahead.`);
          }
          scheduledIso = when.toISOString();
        }

        // Load a draft if this is sending one; it supplies the thread context
        // and, when the client sent no attachments, its uploaded attachments.
        let draft = null;
        if (body.draftId) {
          draft = await findOwned(body.draftId, mailbox.id);
          if (!draft) throw new AppError(Codes.NOT_FOUND, 'Draft not found.');
          if (draft.folder !== 'drafts') {
            throw new AppError(Codes.VALIDATION_ERROR, 'That message is not a draft.');
          }
        }

        // Check the volume ceilings before assembling large payloads.
        await assertWithinSendQuota(mailbox, ctx.session);

        let attachments = await resolveAttachments(body, mailbox.id);

        // A draft's attachments were uploaded against the draft id. When the
        // client sends a message with no attachments of its own, fall back to the
        // draft's — otherwise everything the user attached in the editor would be
        // silently dropped at send time.
        if (attachments.length === 0 && draft) {
          const draftFiles = await listAttachments(draft.id);
          if (draftFiles.length) {
            attachments = await resolveAttachments(
              { attachments: toSendPayloads(draftFiles) },
              mailbox.id,
            );
          }
        }

        // Forwarding: `attachmentMessageId` names the message being forwarded, as
        // returned by the `forward` action. Without this the UI silently dropped
        // every forwarded attachment even though the user ticked "include".
        if (attachments.length === 0 && body.attachmentMessageId) {
          const source = await findOwned(body.attachmentMessageId, mailbox.id);
          if (!source) throw new AppError(Codes.NOT_FOUND, 'The message being forwarded was not found.');
          const forwarded = await listAttachments(source.id);
          if (forwarded.length) {
            attachments = await resolveAttachments(
              { attachments: toSendPayloads(forwarded) },
              mailbox.id,
            );
          }
        }

        const from = formatFrom(mailbox.email, mailbox.display_name);

        // Threading: an explicit threadId wins, else the draft's, else a fresh
        // thread. references/inReplyTo are carried onto the outgoing headers.
        const threadId = body.threadId || draft?.thread_id || null;
        const inReplyTo = body.inReplyTo || draft?.in_reply_to || null;
        const references = body.references?.length
          ? body.references
          : draft?.references_text
            ? String(draft.references_text).split(/\s+/).filter(Boolean)
            : [];

        assertSendable({
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          replyTo: body.replyTo,
          subject: body.subject,
          html: body.html,
          text: body.text,
          attachments,
          from,
        });

        const payload = buildSendPayload({
          from,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          replyTo: body.replyTo,
          subject: body.subject,
          html: body.html,
          text: body.text,
          attachments,
          priority: body.priority,
          scheduledFor: scheduledIso,
          headers: {
            ...(inReplyTo ? { 'In-Reply-To': inReplyTo } : null),
            ...(references.length ? { References: references.join(' ') } : null),
          },
        });

        const isScheduled = Boolean(scheduledIso);
        const sizeBytes =
          Buffer.byteLength(body.html || '', 'utf8') +
          Buffer.byteLength(body.text || '', 'utf8') +
          attachments.reduce((total, file) => total + file.size, 0);

        // Persist the outgoing message first, so a provider response always has
        // a row to attach to.
        const row = await createMessage({
          mailboxId: mailbox.id,
          direction: 'outbound',
          inReplyTo,
          references,
          threadId,
          fromEmail: mailbox.email,
          fromName: mailbox.display_name,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          replyTo: body.replyTo,
          subject: body.subject,
          bodyHtml: body.html ?? null,
          bodyText: body.text ?? null,
          snippet: makeSnippet(body.text || body.html || '', 160),
          folder: 'sent',
          isDraft: false,
          isRead: true,
          sizeBytes,
          priority: body.priority,
          deliveryStatus: 'queued',
          sentAt: isScheduled ? null : new Date().toISOString(),
          scheduledFor: scheduledIso,
        });

        try {
          const { id: resendId } = await sendEmail(payload);
          await attachProviderIds(row.id, { resendId, deliveryStatus: 'queued' });

          // The draft has been consumed: re-parent its attachment rows onto the
          // sent message so the history keeps them, then drop the draft row.
          if (draft) {
            await query(
              `update public.attachments set message_id = $2 where message_id = $1`,
              [draft.id, row.id],
            ).catch(() => {});
            await setHasAttachments(row.id, attachments.length > 0).catch(() => {});
            await destroy(draft.id, mailbox.id).catch(() => {});
          }

          // Learn the recipients for future suggestions.
          const participants = [
            ...body.to.map((email) => ({ email })),
            ...body.cc.map((email) => ({ email })),
          ].filter((entry) => entry.email);
          if (participants.length) {
            await rememberContacts(mailbox.id, participants).catch(() => {});
          }

          ctx.auditEntity = { type: 'message', id: row.id };
          ctx.auditData = { recipients: body.to.length + body.cc.length + body.bcc.length, scheduled: isScheduled };

          return {
            id: row.id,
            resendId,
            threadId: row.thread_id,
            scheduled: isScheduled,
            scheduledFor: scheduledIso,
            status: isScheduled ? 'scheduled' : 'queued',
          };
        } catch (err) {
          // Provider refused or timed out: remove the queued row so the Sent
          // folder only ever contains mail the provider actually accepted.
          await destroy(row.id, mailbox.id).catch(() => {});
          logger.warn('Outbound send failed', { error: err?.message, mailbox: mailbox.id });
          throw err;
        }
      },
    },

    // ── Reply draft ─────────────────────────────────────────────────────────
    reply: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await sendingMailbox(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A message id is required.');

        const message = await findOwned(id, mailbox.id);
        if (!message) throw new AppError(Codes.NOT_FOUND, 'Message not found.');

        const mode = ctx.query.mode === 'all' ? 'all' : 'sender';
        // A reply-all should not include the mailbox doing the replying.
        return { draft: buildReplyDraft(message, { mode, excludeAddress: mailbox.email }) };
      },
    },

    // ── Forward draft ───────────────────────────────────────────────────────
    forward: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await sendingMailbox(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A message id is required.');

        const message = await findOwned(id, mailbox.id);
        if (!message) throw new AppError(Codes.NOT_FOUND, 'Message not found.');

        return {
          draft: buildForwardDraft(message, {
            includeAttachments: queryBool(ctx, 'attachments', true),
          }),
        };
      },
    },

    // ── Recipient suggestions ───────────────────────────────────────────────
    suggest: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await requireMailbox(ctx.session, ctx.query.mailboxId || null);

        // Recent senders and stored contacts, merged and ranked.
        const contacts = await searchContacts(mailbox.id, {
          search: String(ctx.query.q || ''),
          limit: 20,
        });

        // Most frequent inbound correspondents.
        const recent = await queryAll(
          `select m.from_email as email,
                  coalesce(max(m.from_name), '') as name,
                  count(*)::int as count
           from public.messages m
           where m.mailbox_id = $1
             and m.direction = 'inbound'
             and m.folder not in ('trash', 'spam')
             and m.from_email is not null
           group by m.from_email
           order by count(*) desc, max(m.received_at) desc
           limit 20`,
          [mailbox.id],
        );

        return {
          suggestions: recipientSuggestions({
            recent,
            contacts,
            query: String(ctx.query.q || ''),
            limit: queryInt(ctx, 'limit', { min: 1, max: 25, fallback: 8 }),
            exclude: [mailbox.email],
          }),
        };
      },
    },
  },
});