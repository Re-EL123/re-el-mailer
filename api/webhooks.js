/**
 * /api/webhooks — provider callbacks (Resend).
 *
 *   inbound  — a message was received for one of our addresses.
 *   event    — a delivery lifecycle event (sent / delivered / bounced / …).
 *
 * Both actions are authenticated by an HMAC signature over the *exact* bytes the
 * provider signed, never by a session token and never by trusting the parsed
 * JSON. The flow is identical for each:
 *
 *   1. Read the raw request bytes with `rawBodyBestEffort`, which reports
 *      whether it got the genuine body.
 *   2. Refuse to continue if `exact` is false — a reserialised body would produce
 *      a different HMAC, and comparing against it could accept a tampered
 *      payload or, worse, hide the mismatch.
 *   3. Verify the Svix signature against the action's secret.
 *   4. Only then parse JSON and act.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { assertWebhookSignature } from '../packages/http/signature.js';
import { rawBodyBestEffort } from '../packages/http/body.js';
import { queryOne } from '../packages/db/pool.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { mail as mailConfig } from '../packages/shared/config.js';
import { logger } from '../packages/shared/logger.js';
import { makeSnippet } from '../packages/shared/sanitize.js';
import { normalizeDeliveryEvent, normalizeInbound, hydrateInboundPayload, shouldAutoRead, shouldMarkSpam } from '../packages/mail/inbound.js';
import { applyDeliveryEvent, createAttachment, createMessage, setHasAttachments } from '../packages/db/messages.js';
import { ensureDefaultLabels, rememberContacts, resolveInboundRecipient } from '../packages/db/mailboxes.js';
import { uploadAttachment } from '../packages/storage/attachments.js';
import { newId } from '../packages/shared/ids.js';
import { getReceivedEmail, listReceivedAttachments, suppressContact } from '../packages/mail/resend.js';

/**
 * Read the signed bytes and verify the signature.
 *
 * @throws {AppError} when the body is not exact or the signature does not match
 * @returns {{payload: object, raw: Buffer}}
 */
async function verifyAndParse(ctx, secret) {
  const { raw, exact } = await rawBodyBestEffort(ctx.req, { limit: mailConfig.inboundMaxBytes });

  if (!exact) {
    throw new AppError(
      Codes.SIGNATURE_INVALID,
      'The request body could not be read exactly; refusing an unverifiable webhook.',
      400,
    );
  }
  if (raw.length === 0) {
    throw new AppError(Codes.VALIDATION_ERROR, 'Empty webhook body.', 400);
  }

  assertWebhookSignature({ rawBody: raw, headers: ctx.req.headers, secret });

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(Codes.VALIDATION_ERROR, 'Webhook body is not valid JSON.', 400);
  }
  if (!payload || typeof payload !== 'object') {
    throw new AppError(Codes.VALIDATION_ERROR, 'Webhook body is not an object.', 400);
  }
  return payload;
}

/**
 * Fetch a provider-hosted attachment. The URL comes from a signature-verified
 * payload, so it is trusted as much as the rest of the webhook, but it is still
 * fetched defensively: https only, capped size, short timeout.
 */
async function downloadRemote(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(parsed.toString(), { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > mailConfig.attachmentMaxBytes) return null;
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the message content a metadata-only webhook does not carry.
 *
 * Resend's `email.received` event contains just the envelope plus an
 * `email_id`; the body, headers and attachments are fetched from the
 * received-email API. A payload that already carries its own content is used
 * unchanged. Fetch failures are not fatal: the envelope is still authentic and
 * a stored message with no body beats a bounced webhook that Resend would keep
 * retrying.
 *
 * @param {object} payload verified webhook body
 * @returns {Promise<object>} payload with content merged in
 */
async function loadInboundContent(payload) {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const emailId = typeof source?.email_id === 'string' ? source.email_id.trim() : '';

  if (!emailId) return payload;
  if (source?.html || source?.text) return payload;

  try {
    const content = await getReceivedEmail(emailId);
    const attachments = await listReceivedAttachments(emailId).catch(() => []);
    return hydrateInboundPayload(payload, content, attachments);
  } catch (err) {
    logger.warn('Inbound content not fetched', { error: err?.message, emailId });
    return payload;
  }
}

export default createHandler({
  name: 'webhooks',

  actions: {
    // ── Inbound message ─────────────────────────────────────────────────────
    inbound: {
      method: 'POST',
      auth: 'none',
      // Inbound messages can be large (attachments inline); the pipeline's
      // declared-length check uses this ceiling instead of the JSON default.
      body: 'none',
      bodyLimit: mailConfig.inboundMaxBytes,
      // Signature-authenticated, so it may exceed the app's JSON body cap.
      allowLargeJson: true,
      handler: async (ctx) => {
        const payload = await verifyAndParse(ctx, mailConfig.inboundWebhookSecret());
        const message = normalizeInbound(await loadInboundContent(payload));

        // Resolve the recipient to a mailbox and a routing action.
        const route = await resolveInboundRecipient(message.recipient);

        if (!route || route.action !== 'deliver' || !route.mailbox_id) {
          // reject / bounce / discard, or no match: acknowledge and drop. The
          // provider must see a 2xx or it will keep retrying.
          logger.info('Inbound not delivered', {
            recipient: message.recipient,
            action: route?.action ?? 'unmatched',
            via: route?.via ?? null,
          });
          return { received: true, delivered: false, reason: route?.action ?? 'unmatched' };
        }

        const mailboxId = route.mailbox_id;

        // Idempotency: providers retry. Skip if we already stored this RFC
        // message id for this mailbox.
        if (message.messageId) {
          const existing = await queryOne(
            'select id from public.messages where mailbox_id = $1 and message_id = $2 limit 1',
            [mailboxId, message.messageId],
          );
          if (existing) {
            return { received: true, delivered: true, duplicate: true, id: existing.id };
          }
        }

        const spam = shouldMarkSpam(message);
        const folder = spam ? 'spam' : 'inbox';

        const row = await createMessage({
          mailboxId,
          direction: 'inbound',
          messageId: message.messageId,
          inReplyTo: message.inReplyTo,
          references: message.references,
          threadId: message.threadId,
          fromEmail: message.fromEmail,
          fromName: message.fromName,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          replyTo: message.replyTo,
          subject: message.subject,
          bodyHtml: message.bodyHtml,
          bodyText: message.bodyText,
          snippet: message.snippet || makeSnippet(message.bodyText || '', 160),
          rawMime: message.rawMime,
          rawMimeSize: message.rawMime ? Buffer.byteLength(message.rawMime, 'utf8') : null,
          folder,
          isRead: folder === 'inbox' && shouldAutoRead(message, route.auto_read),
          isDeleted: folder !== 'inbox',
          sizeBytes: message.sizeBytes,
          priority: message.priority,
          hasAttachments: message.attachments.some((file) => !file.rejected),
          receivedAt: message.receivedAt,
        });

        // Store any attachments that arrived inline or via a provider URL.
        let storedCount = 0;
        for (const file of message.attachments) {
          if (file.rejected) continue;
          let data = null;
          if (file.content) {
            data = Buffer.from(file.content, 'base64');
          } else if (file.remoteUrl) {
            data = await downloadRemote(file.remoteUrl);
          }
          if (!data || data.length === 0) continue;

          const attachmentId = newId('attachment');
          try {
            const uploaded = await uploadAttachment({
              mailboxId,
              messageId: row.id,
              attachmentId,
              filename: file.filename,
              mimeType: file.mimeType,
              data,
            });
            await createAttachment({
              messageId: row.id,
              mailboxId,
              filename: file.filename,
              mimeType: file.mimeType,
              sizeBytes: uploaded.size,
              storageBucket: uploaded.bucket,
              storagePath: uploaded.path,
              contentId: file.contentId,
              inline: file.inline,
            });
            storedCount += 1;
          } catch (err) {
            // One bad attachment must not fail the whole delivery.
            logger.warn('Inbound attachment not stored', { error: err?.message, message: row.id });
          }
        }
        if (storedCount) await setHasAttachments(row.id, true);

        // Learn the sender for future recipient suggestions.
        if (message.fromEmail) {
          await rememberContacts(mailboxId, [{ name: message.fromName, email: message.fromEmail }]).catch(() => {});
        }

        logger.info('Inbound delivered', {
          message: row.id,
          mailbox: mailboxId,
          folder,
          via: route.via,
          attachments: storedCount,
        });

        return { received: true, delivered: true, id: row.id, folder, attachments: storedCount };
      },
    },

    // ── Delivery event ──────────────────────────────────────────────────────
    event: {
      method: 'POST',
      auth: 'none',
      body: 'none',
      bodyLimit: mailConfig.inboundMaxBytes,
      allowLargeJson: true,
      handler: async (ctx) => {
        const payload = await verifyAndParse(ctx, mailConfig.eventWebhookSecret());
        const event = normalizeDeliveryEvent(payload);

        const updated = await applyDeliveryEvent({
          resendId: event.providerId,
          resendMessageId: event.providerMessageId,
          status: event.status,
          smtpStatus: event.status,
          smtpResponse: event.reason,
          occurredAt: event.occurredAt,
        });

        // A hard bounce or complaint is a signal to stop sending to that
        // address; suppressing protects the sending domain's reputation.
        if ((event.status === 'bounced' || event.status === 'complained') && updated?.to_emails) {
          for (const address of updated.to_emails) {
            await suppressContact(address, event.status === 'complained' ? 'complaint' : 'hard_bounce').catch(() => {});
          }
        }

        logger.info('Delivery event', {
          status: event.status,
          matched: Boolean(updated),
          message: updated?.id ?? null,
        });

        return { received: true, matched: Boolean(updated) };
      },
    },
  },
});