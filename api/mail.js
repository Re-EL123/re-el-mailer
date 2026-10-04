/**
 * /api/mail — everything a mailbox does with its own messages.
 *
 *   list · get · search · thread · star · move · read · trash · delete ·
 *   labels · contacts · draft · delete-draft · attachment-url · quota · folders
 *
 * Two rules run through every action:
 *
 *   1. The mailbox is resolved with `requireMailbox`, so a user can only ever
 *      reach mailboxes they own (or any, if they are an administrator).
 *   2. Message ids are always scoped by mailbox id in SQL, never trusted on
 *      their own — knowing an id is not authorisation.
 */

import { createHandler, queryBool, queryInt } from '../packages/http/pipeline.js';
import { parseMultipartBody } from '../packages/http/body.js';
import { query, queryAll } from '../packages/db/pool.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { logger } from '../packages/shared/logger.js';
import { mail as mailConfig, rateLimit } from '../packages/shared/config.js';
import { assertCanSend, requireMailbox } from '../packages/auth/guard.js';
import { htmlToText, makeSnippet } from '../packages/shared/sanitize.js';
import { newId } from '../packages/shared/ids.js';
import {
  createAttachment,
  createMessage,
  destroy,
  emptyFolder,
  findAttachment,
  findOwned,
  listAttachments,
  listByFolder,
  listStarred,
  listThread,
  markAllRead,
  moveToFolder,
  search,
  setHasAttachments,
  update,
} from '../packages/db/messages.js';
import {
  createLabel,
  deleteLabel,
  folderCounts,
  listLabels,
  listMessagesByLabel,
  quotaStatus,
  refreshMailboxUsage,
  rememberContacts,
  searchContacts,
  setMessageLabels,
  updateLabel,
} from '../packages/db/mailboxes.js';
import {
  assertUploadable,
  attachmentPath,
  createUploadUrl,
  deleteAttachments,
  signedDownloadUrl,
  statAttachment,
  uploadAttachments,
} from '../packages/storage/attachments.js';
import {
  attachmentCompleteSchema,
  attachmentUploadUrlSchema,
  labelSchema,
  labelUpdateSchema,
  markSchema,
  saveDraftSchema,
  updateMessageSchema,
} from '../packages/validation/schemas.js';

/** Shape a stored message for the list view. */
function listItem(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    threadId: row.thread_id,
    direction: row.direction,
    from: { email: row.from_email, name: row.from_name },
    to: row.to_emails ?? [],
    cc: row.cc_emails ?? [],
    subject: row.subject,
    snippet: row.snippet,
    folder: row.folder,
    isRead: Boolean(row.is_read),
    isStarred: Boolean(row.is_starred),
    isDraft: Boolean(row.is_draft),
    hasAttachments: Boolean(row.has_attachments),
    sizeBytes: Number(row.size_bytes ?? 0),
    priority: row.priority,
    deliveryStatus: row.delivery_status,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    attachments: Array.isArray(row.attachments)
      ? row.attachments.map((file) => ({
          id: file.id,
          filename: file.filename,
          mimeType: file.mime_type,
          sizeBytes: Number(file.size_bytes ?? 0),
          inline: Boolean(file.inline),
        }))
      : [],
  };
}

/** Shape a stored message for the reading pane. */
function detailItem(row) {
  return {
    ...listItem(row),
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    readAt: row.read_at,
    inReplyTo: row.in_reply_to,
    references: row.references_text ? String(row.references_text).split(/\s+/).filter(Boolean) : [],
    resendId: row.resend_id,
    smtpResponse: row.smtp_response,
    failedCount: Number(row.failed_count ?? 0),
    scheduledFor: row.scheduled_for,
  };
}

/** Resolve the mailbox and assert the caller may read mail from it. */
async function mailboxFor(ctx, { forSending = false } = {}) {
  const mailbox = await requireMailbox(ctx.session, ctx.query.mailboxId || null);
  if (forSending) assertCanSend(mailbox, ctx.session.user);
  return mailbox;
}

export default createHandler({
  name: 'mail',
  audit: {
    delete: { action: 'mail.delete', entityType: 'message' },
    trash: { action: 'mail.trash', entityType: 'message' },
    move: { action: 'mail.move', entityType: 'message' },
  },

  actions: {
    // ── List a folder ───────────────────────────────────────────────────────
    list: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const folder = String(ctx.query.folder || 'inbox');

        const options = {
          limit: queryInt(ctx, 'limit', { min: 1, max: 100, fallback: 30 }),
          offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
          unreadOnly: queryBool(ctx, 'unread'),
          starredOnly: queryBool(ctx, 'starred'),
        };

        const rows =
          folder === 'starred'
            ? await listStarred(mailbox.id, { limit: options.limit, offset: options.offset })
            : await listByFolder(mailbox.id, folder, options);

        const counts = await folderCounts(mailbox.id);

        return {
          mailbox: { id: mailbox.id, email: mailbox.email, displayName: mailbox.display_name },
          folder,
          messages: rows.map(listItem),
          counts: counts.folders,
          inboxUnread: counts.inboxUnread,
          starred: counts.starred,
          hasMore: rows.length === options.limit,
          offset: options.offset,
        };
      },
    },

    // ── Read one message ────────────────────────────────────────────────────
    get: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A message id is required.');

        const row = await findOwned(id, mailbox.id);
        if (!row) throw new AppError(Codes.NOT_FOUND, 'Message not found.');

        const attachments = await listAttachments(row.id);

        // Opening a message marks it read, unless the mailbox is set to mark
        // everything read on arrival.
        let updated = row;
        if (!row.is_read && !row.is_draft && !mailbox.auto_read) {
          updated = await update(row.id, mailbox.id, { isRead: true });
        }

        // Remember the people involved so recipient suggestions improve.
        if (row.from_email) {
          await rememberContacts(mailbox.id, [{ name: row.from_name, email: row.from_email }]).catch(() => {});
        }

        return {
          message: detailItem({ ...updated, attachments }),
          thread: await listThread(row.thread_id, mailbox.id).then((list) => list.map(listItem)),
        };
      },
    },

    // ── Thread view ─────────────────────────────────────────────────────────
    thread: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const threadId = String(ctx.query.threadId || '').trim();
        if (!threadId) throw new AppError(Codes.VALIDATION_ERROR, 'A thread id is required.');

        const rows = await listThread(threadId, mailbox.id);
        if (rows.length === 0) throw new AppError(Codes.NOT_FOUND, 'Thread not found.');

        return { threadId, messages: rows.map(detailItem) };
      },
    },

    // ── Search ──────────────────────────────────────────────────────────────
    search: {
      method: 'GET',
      auth: 'session',
      rateLimit: rateLimit.maxSearch,
      rateLimitWindow: 60,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const query = String(ctx.query.q || '').trim();
        if (!query) throw new AppError(Codes.VALIDATION_ERROR, 'Enter something to search for.');

        const result = await search(mailbox.id, query, {
          limit: queryInt(ctx, 'limit', { min: 1, max: 100, fallback: 30 }),
          offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
          folder: ctx.query.folder ? String(ctx.query.folder) : null,
        });

        return {
          query,
          parsed: result.parsed,
          total: result.total,
          messages: result.rows.map((row) => ({ ...listItem(row), highlight: row.highlight ?? null })),
        };
      },
    },

    // ── Labels ──────────────────────────────────────────────────────────────
    labels: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        return { labels: await listLabels(mailbox.id) };
      },
    },

    'create-label': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: labelSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        return { label: await createLabel({ mailboxId: mailbox.id, ...ctx.body }) };
      },
    },

    'update-label': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: labelUpdateSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const id = String(ctx.query.id || ctx.body.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A label id is required.');
        return { label: await updateLabel(id, mailbox.id, ctx.body) };
      },
    },

    'delete-label': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A label id is required.');
        await deleteLabel(id, mailbox.id);
        return { deleted: true };
      },
    },

    'messages-by-label': {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const labelId = String(ctx.query.labelId || '').trim();
        if (!labelId) throw new AppError(Codes.VALIDATION_ERROR, 'A label id is required.');

        const rows = await listMessagesByLabel(mailbox.id, labelId, {
          limit: queryInt(ctx, 'limit', { min: 1, max: 100, fallback: 30 }),
          offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
        });
        return { labelId, messages: rows.map(listItem) };
      },
    },

    'set-labels': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema.pick({ ids: true, labelIds: true }),
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const { ids, labelIds } = ctx.body;

        // Confirm every message belongs to this mailbox before touching them.
        for (const id of ids) {
          if (!(await findOwned(id, mailbox.id))) {
            throw new AppError(Codes.NOT_FOUND, 'Message not found.', 404, { details: { id } });
          }
        }
        for (const id of ids) {
          await setMessageLabels(id, labelIds ?? []);
        }
        return { updated: ids.length };
      },
    },

    // ── Mutations ───────────────────────────────────────────────────────────
    update: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const { ids, folder, isRead, isStarred, labelIds } = ctx.body;

        const updated = [];
        for (const id of ids) {
          const patch = {};
          if (isRead !== undefined) patch.isRead = isRead;
          if (isStarred !== undefined) patch.isStarred = isStarred;
          if (folder !== undefined) patch.folder = folder;

          const row = await update(id, mailbox.id, patch);
          if (labelIds !== undefined) await setMessageLabels(id, labelIds);
          updated.push(listItem(row));
        }

        return { messages: updated };
      },
    },

    star: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema.pick({ ids: true, isStarred: true }),
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const results = [];
        for (const id of ctx.body.ids) {
          results.push(listItem(await update(id, mailbox.id, { isStarred: ctx.body.isStarred !== false })));
        }
        return { messages: results };
      },
    },

    move: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema.pick({ ids: true, folder: true }),
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        if (!ctx.body.folder) throw new AppError(Codes.VALIDATION_ERROR, 'A destination folder is required.');
        const { rowCount } = await moveToFolder(ctx.body.ids, mailbox.id, ctx.body.folder);
        return { moved: rowCount };
      },
    },

    'mark-all-read': {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: markSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const { rowCount } = await markAllRead(mailbox.id, ctx.body.folder);
        return { marked: rowCount };
      },
    },

    empty: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: markSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const folder = ctx.body.folder;

        // Attachments are removed from storage first: after the rows are gone
        // there is no way to find the objects again.
        const attachments = await queryAll(
          `select a.storage_path from public.attachments a
           join public.messages m on m.id = a.message_id
           where m.mailbox_id = $1 and m.folder = $2 and not a.is_deleted`,
          [mailbox.id, folder],
        );
        await deleteAttachments(attachments.map((row) => row.storage_path)).catch((err) => {
          logger.warn('Could not remove attachment objects before emptying a folder', {
            error: err?.message,
            mailbox: mailbox.id,
            folder,
          });
        });

        const { rowCount } = await emptyFolder(mailbox.id, folder);
        await refreshMailboxUsage(mailbox.id).catch(() => {});
        return { deleted: rowCount };
      },
    },

    trash: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema.pick({ ids: true }),
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const { rowCount } = await moveToFolder(ctx.body.ids, mailbox.id, 'trash');
        return { trashed: rowCount };
      },
    },

    delete: {
      method: 'POST',
      body: 'json',
      auth: 'session',
      schema: updateMessageSchema.pick({ ids: true }),
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        let deleted = 0;

        for (const id of ctx.body.ids) {
          const row = await findOwned(id, mailbox.id);
          if (!row) continue; // already gone; treat as idempotent

          const attachments = await listAttachments(id);
          // Remove storage objects before the rows, so a failure cannot orphan
          // an object with nothing pointing at it.
          await deleteAttachments(attachments.map((file) => file.storage_path)).catch((err) => {
            logger.warn('Attachment removal failed; rows still deleted', { error: err?.message, message: id });
          });
          await destroy(id, mailbox.id);
          deleted += 1;
        }

        await refreshMailboxUsage(mailbox.id).catch(() => {});
        return { deleted };
      },
    },

    // ── Drafts ──────────────────────────────────────────────────────────────
    draft: {
      method: ['POST', 'PUT'],
      body: 'json',
      auth: 'session',
      schema: saveDraftSchema,
      rateLimit: 120,
      rateLimitWindow: 300,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx, { forSending: true });
        const body = ctx.body;

        const html = body.html ?? '';
        const text = body.text ?? (html ? htmlToText(html) : '');

        if (body.id) {
          const existing = await findOwned(body.id, mailbox.id);
          if (!existing) throw new AppError(Codes.NOT_FOUND, 'Draft not found.');
          if (existing.folder !== 'drafts') {
            throw new AppError(Codes.VALIDATION_ERROR, 'That message is not a draft.');
          }

          // Recipients and threading are part of the draft, not decoration: an
          // update must overwrite everything the caller sent, not just the body,
          // otherwise a reply's recipients silently revert to the first save.
          await query(
            `update public.messages
                set to_emails = $3, cc_emails = $4, bcc_emails = $5,
                    in_reply_to = $6, references = $7, thread_id = $8,
                    subject = $9, body_html = $10, body_text = $11, snippet = $12
              where id = $1 and mailbox_id = $2`,
            [
              body.id,
              mailbox.id,
              body.to,
              body.cc,
              body.bcc,
              body.inReplyTo ?? null,
              body.references ?? [],
              body.threadId ?? null,
              body.subject,
              html,
              text,
              makeSnippet(text, 160),
            ],
          );
          const row = await findOwned(body.id, mailbox.id);
          return { draft: listItem(row) };
        }

        const row = await createMessage({
          mailboxId: mailbox.id,
          direction: 'outbound',
          inReplyTo: body.inReplyTo ?? null,
          references: body.references ?? [],
          threadId: body.threadId ?? null,
          fromEmail: mailbox.email,
          fromName: mailbox.display_name,
          to: body.to,
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          bodyHtml: html,
          bodyText: text,
          snippet: makeSnippet(text, 160),
          folder: 'drafts',
          isDraft: true,
          isRead: true,
          sizeBytes: Buffer.byteLength(html, 'utf8') + Buffer.byteLength(text, 'utf8'),
          priority: 'normal',
        });

        return { draft: listItem(row) };
      },
    },

    'delete-draft': {
      method: 'DELETE',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const id = String(ctx.query.id || '').trim();
        if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A draft id is required.');

        // Prove ownership before touching storage. `destroy` is mailbox-scoped,
        // so without this check an attacker could name another mailbox's draft id
        // and have its attachments deleted even though the row delete no-ops.
        const draft = await findOwned(id, mailbox.id, { isDraft: true });
        if (!draft) throw new AppError(Codes.NOT_FOUND, 'That draft does not exist.');

        const attachments = await listAttachments(id);
        await deleteAttachments(attachments.map((file) => file.storage_path)).catch(() => {});
        await destroy(id, mailbox.id);
        return { deleted: true };
      },
    },

    // ── Attachment upload (multipart) ────────────────────────────────────────
    'upload-attachment': {
      method: 'POST',
      auth: 'session',
      // A multipart body is parsed here, not by the pipeline, because it can be
      // much larger than a JSON body and has a different ceiling. No Zod schema:
      // the pipeline leaves ctx.body empty for multipart requests.
      body: 'multipart',
      bodyLimit: mailConfig.attachmentMaxBytes * 10 + 65_536,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx, { forSending: true });

        const { fields, files } = await parseMultipartBody(ctx.req, {
          limit: mailConfig.attachmentMaxBytes * 10 + 65_536,
        });

        const draftId = fields.draftId || null;
        if (!draftId) {
          throw new AppError(Codes.VALIDATION_ERROR, 'A draftId is required to attach a file.');
        }
        const draft = await findOwned(draftId, mailbox.id);
        if (!draft || draft.folder !== 'drafts') {
          throw new AppError(Codes.NOT_FOUND, 'Draft not found.');
        }
        if (files.length === 0) {
          throw new AppError(Codes.VALIDATION_ERROR, 'No files were uploaded.');
        }

        const prepared = files.map((file) => ({
          attachmentId: newId('attachment'),
          filename: file.filename,
          mimeType: file.mimeType,
          data: file.data,
        }));

        const { uploaded, rejected } = await uploadAttachments({
          mailboxId: mailbox.id,
          messageId: draft.id,
          files: prepared,
        });

        // Only record the rows for uploads that actually succeeded.
        const stored = [];
        for (const file of uploaded) {
          stored.push(
            await createAttachment({
              // Reuse the id that built the storage path so the object and the
              // row refer to each other by the same key.
              id: file.attachmentId,
              messageId: draft.id,
              mailboxId: mailbox.id,
              filename: file.filename,
              mimeType: file.mimeType,
              sizeBytes: file.size,
              storageBucket: file.bucket,
              storagePath: file.path,
              inline: Boolean(file.inline),
            }),
          );
        }

        if (stored.length) {
          await setHasAttachments(draft.id, true);
          await refreshMailboxUsage(mailbox.id).catch(() => {});
        }

        return {
          draftId: draft.id,
          uploaded: stored.map((row) => ({
            id: row.id,
            filename: row.filename,
            mimeType: row.mime_type,
            sizeBytes: Number(row.size_bytes),
          })),
          rejected,
        };
      },
    },

    // ── Direct-to-storage attachment upload ────────────────────────────────
    // The function body limit is far below the attachment limit, so the bytes
    // never come through here. The client asks for a signed URL scoped to one
    // path, PUTs the file to Storage, then reports it back for verification.

    'attachment-upload-url': {
      method: 'POST',
      auth: 'session',
      body: 'json',
      schema: attachmentUploadUrlSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx, { forSending: true });
        const draft = await findOwned(ctx.body.draftId, mailbox.id);
        if (!draft || draft.folder !== 'drafts') {
          throw new AppError(Codes.NOT_FOUND, 'Draft not found.');
        }

        const { filename, mimeType, size } = ctx.body;
        assertUploadable({ filename, mimeType, size });

        const attachmentId = newId('attachment');
        const target = await createUploadUrl({
          mailboxId: mailbox.id,
          messageId: draft.id,
          attachmentId,
          filename,
          mimeType,
        });

        return {
          draftId: draft.id,
          attachmentId,
          filename,
          mimeType,
          size,
          url: target.url,
          path: target.path,
          expiresIn: target.expiresIn,
        };
      },
    },

    'attachment-complete': {
      method: 'POST',
      auth: 'session',
      body: 'json',
      schema: attachmentCompleteSchema,
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx, { forSending: true });
        const draft = await findOwned(ctx.body.draftId, mailbox.id);
        if (!draft || draft.folder !== 'drafts') {
          throw new AppError(Codes.NOT_FOUND, 'Draft not found.');
        }

        // Rebuild the path rather than trusting one from the client, so a
        // completed upload can only ever land on its own draft's storage key.
        const path = attachmentPath(mailbox.id, draft.id, ctx.body.attachmentId, ctx.body.filename);
        const stat = await statAttachment(path);

        if (!stat || stat.size === 0) {
          throw new AppError(Codes.VALIDATION_ERROR, 'That file was not received. Please try again.', 400);
        }

        try {
          assertUploadable({
            filename: ctx.body.filename,
            mimeType: stat.contentType || ctx.body.mimeType,
            size: stat.size,
          });
        } catch (err) {
          // The object is already in the bucket, so a file that turns out to be
          // unusable is removed rather than left to be found later.
          await deleteAttachments([path]).catch(() => {});
          throw err;
        }

        const row = await createAttachment({
          id: ctx.body.attachmentId,
          messageId: draft.id,
          mailboxId: mailbox.id,
          filename: ctx.body.filename,
          mimeType: stat.contentType || ctx.body.mimeType,
          sizeBytes: stat.size,
          storageBucket: mailConfig.attachmentBucket,
          storagePath: path,
          inline: false,
        });

        await setHasAttachments(draft.id, true);
        await refreshMailboxUsage(mailbox.id).catch(() => {});

        return {
          attachment: {
            id: row.id,
            filename: row.filename,
            mimeType: row.mime_type,
            sizeBytes: Number(row.size_bytes),
          },
        };
      },
    },

    // ── Attachment download ─────────────────────────────────────────────────
    'attachment-url': {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const attachmentId = String(ctx.query.id || '').trim();
        const messageId = String(ctx.query.messageId || '').trim();
        if (!attachmentId || !messageId) {
          throw new AppError(Codes.VALIDATION_ERROR, 'An attachment id and message id are required.');
        }

        // Ownership is checked on the *message*, then the attachment is read
        // scoped to that message, so a guessed id cannot cross mailboxes.
        const message = await findOwned(messageId, mailbox.id);
        if (!message) throw new AppError(Codes.NOT_FOUND, 'Message not found.');

        const attachment = await findAttachment(attachmentId, messageId);
        if (!attachment) throw new AppError(Codes.NOT_FOUND, 'Attachment not found.');

        const inline = queryBool(ctx, 'inline') && attachment.inline;
        const signed = await signedDownloadUrl(attachment.storage_path, {
          download: !inline,
          downloadSeconds: 300,
        });

        return {
          url: signed.url,
          expiresIn: signed.expiresIn,
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          sizeBytes: Number(attachment.size_bytes),
        };
      },
    },

    // ── Contacts ────────────────────────────────────────────────────────────
    contacts: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        return {
          contacts: await searchContacts(mailbox.id, {
            search: String(ctx.query.q || ''),
            limit: queryInt(ctx, 'limit', { min: 1, max: 50, fallback: 10 }),
          }),
        };
      },
    },

    // ── Quota and folder counts ─────────────────────────────────────────────
    quota: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        const status = await quotaStatus(mailbox.id);
        const used = Number(status?.storage_used_bytes ?? 0);
        const limit = Number(status?.quota_bytes ?? 0);
        return {
          mailbox: mailbox.email,
          usedBytes: used,
          quotaBytes: limit,
          availableBytes: Math.max(0, limit - used),
          ratio: limit > 0 ? Math.min(1, used / limit) : 0,
        };
      },
    },

    folders: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const mailbox = await mailboxFor(ctx);
        return { counts: await folderCounts(mailbox.id) };
      },
    },
  },
});