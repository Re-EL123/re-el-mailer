/**
 * Messages, threads, attachments and search.
 *
 * Search accepts Gmail-style operators (`from:`, `subject:`, `has:attachment`,
 * `after:`, `in:`, `is:unread`, …). Operators are compiled into a single
 * parameterised WHERE clause; user text only ever reaches the database as a
 * bind parameter, never as SQL.
 */

import * as pool from './pool.js';
import { newId, newThreadRef, normalizeMessageId, threadIdFromReferences } from '../shared/ids.js';
import { AppError, Codes } from '../shared/errors.js';
import { clamp } from '../shared/dates.js';

const DEFAULT_POOL = pool;

const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];

const LIST_COLUMNS = `
  m.id, m.mailbox_id, m.message_id, m.thread_id, m.direction,
  m.from_email, m.from_name, m.to_emails, m.cc_emails, m.bcc_emails,
  m.subject, m.snippet, m.folder, m.is_read, m.is_starred, is_draft,
  m.has_attachments, m.size_bytes, m.priority, m.delivery_status,
  m.sent_at, m.received_at, m.created_at, m.read_at
`;

// ─── Inserts ─────────────────────────────────────────────────────────────────

/**
 * Store a message in a mailbox.
 *
 * @param {object} message
 * @param {import('./pool.js').default} [db] pass a transaction client
 */
export async function createMessage(
  {
    mailboxId,
    messageId = null,
    inReplyTo = null,
    references = null,
    threadId = null,
    direction = 'inbound',
    fromEmail = null,
    fromName = null,
    to = [],
    cc = [],
    bcc = [],
    replyTo = [],
    subject = '',
    bodyHtml = null,
    bodyText = null,
    snippet = '',
    rawMime = null,
    rawMimeSize = null,
    folder = 'inbox',
    isRead = false,
    isStarred = false,
    isDraft = false,
    isDeleted = false,
    hasAttachments = false,
    sizeBytes = 0,
    priority = 'normal',
    deliveryStatus = 'unknown',
    resendMessageId = null,
    resendId = null,
    sentAt = null,
    receivedAt = null,
    scheduledFor = null,
  },
  db = DEFAULT_POOL,
) {
  if (!FOLDERS.includes(folder)) {
    throw new AppError(Codes.VALIDATION_ERROR, `Unknown folder "${folder}".`);
  }

  const id = newId('message');
  const resolvedThreadId = threadId || newThreadRef();

  return db.queryOne(
    `insert into public.messages (
       id, mailbox_id, message_id, in_reply_to, references_text, thread_id, direction,
       from_email, from_name, to_emails, cc_emails, bcc_emails, reply_to_emails,
       subject, body_html, body_text, snippet, raw_mime, raw_mime_size,
       folder, is_read, is_starred, is_draft, is_deleted, has_attachments,
       size_bytes, priority, delivery_status, resend_message_id, resend_id,
       sent_at, received_at, scheduled_for
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10::text[], $11::text[], $12::text[], $13::text[],
       $14, $15, $16, $17, $18, $19,
       $20, $21, $22, $23, $24, $25,
       $26, $27, $28, $29, $30,
       $31, $32, $33
     ) returning *`,
    [
      id,
      mailboxId,
      messageId ? normalizeMessageId(messageId) : null,
      inReplyTo ? normalizeMessageId(inReplyTo) : null,
      Array.isArray(references) ? references.join(' ') : references,
      resolvedThreadId,
      direction,
      fromEmail ? fromEmail.toLowerCase() : null,
      fromName || null,
      to,
      cc,
      bcc,
      replyTo,
      subject,
      bodyHtml,
      bodyText,
      snippet,
      rawMime,
      rawMimeSize,
      folder,
      isRead,
      isStarred,
      isDraft,
      isDeleted,
      hasAttachments,
      sizeBytes,
      priority,
      deliveryStatus,
      resendMessageId,
      resendId,
      sentAt,
      receivedAt,
      scheduledFor,
    ],
  );
}

/**
 * Find an existing thread that a reply belongs to.
 * Prefers an exact thread_id match, then In-Reply-To, then References.
 */
export async function findThreadFor({ threadId, inReplyTo, references }, db = DEFAULT_POOL) {
  if (threadId) {
    const byThread = await db.queryOne(
      `select thread_id, mailbox_id from public.messages
       where thread_id = $1 order by created_at asc limit 1`,
      [threadId],
    );
    if (byThread) return byThread.thread_id;
  }

  for (const candidate of [inReplyTo, ...(Array.isArray(references) ? references : references ? [references] : [])]) {
    const normalized = normalizeMessageId(candidate);
    if (!normalized) continue;
    const row = await db.queryOne(
      `select thread_id from public.messages
       where message_id = $1 or in_reply_to = $1
       order by created_at asc limit 1`,
      [normalized],
    );
    if (row) return row.thread_id;
  }

  const hashed = threadIdFromReferences(
    Array.isArray(references) ? references : references ? [references] : [],
  );
  if (hashed) {
    const row = await db.queryOne(
      `select thread_id from public.messages where thread_id = $1 limit 1`,
      [hashed],
    );
    if (row) return row.thread_id;
  }

  return newThreadRef();
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function findById(id, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne('select * from public.messages where id = $1', [id]);
}

export async function findOwned(id, mailboxId, { isDraft } = {}, db = DEFAULT_POOL) {
  if (!id) return null;
  if (isDraft === undefined) {
    return db.queryOne('select * from public.messages where id = $1 and mailbox_id = $2', [id, mailboxId]);
  }
  return db.queryOne(
    `select * from public.messages
     where id = $1 and mailbox_id = $2 and is_draft = $3 and direction = 'outbound'`,
    [id, mailboxId, isDraft],
  );
}

export async function findByResendId(resendId, db = DEFAULT_POOL) {
  if (!resendId) return null;
  return db.queryOne('select * from public.messages where resend_id = $1 limit 1', [resendId]);
}

export async function findByResendMessageId(resendMessageId, db = DEFAULT_POOL) {
  if (!resendMessageId) return null;
  return db.queryOne('select * from public.messages where resend_message_id = $1 limit 1', [resendMessageId]);
}

/** All messages of a thread, oldest first, for the conversation view. */
export async function listThread(threadId, mailboxId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${LIST_COLUMNS}, m.body_html, m.body_text, m.read_at, m.delivery_status,
            m.resend_message_id, m.failed_count
     from public.messages m
     where m.thread_id = $1 and m.mailbox_id = $2
     order by coalesce(m.received_at, m.sent_at, m.created_at) asc`,
    [threadId, mailboxId],
  );
}

export async function listByFolder(
  mailboxId,
  folder,
  { limit = 30, offset = 0, unreadOnly = false, starredOnly = false } = {},
  db = DEFAULT_POOL,
) {
  const params = [mailboxId, folder];
  const conditions = ['m.mailbox_id = $1', 'm.folder = $2'];

  // Trash and spam are explicitly "deleted" views; everywhere else hides them.
  if (folder !== 'trash' && folder !== 'spam') conditions.push('not m.is_deleted');
  if (unreadOnly) conditions.push('not m.is_read');
  if (starredOnly) conditions.push('m.is_starred');

  params.push(clamp(limit, 1, 100), clamp(offset, 0, 100_000));

  return db.queryAll(
    `select ${LIST_COLUMNS},
            (select json_agg(json_build_object(
                       'id', a.id, 'filename', a.filename, 'mime_type', a.mime_type,
                       'size_bytes', a.size_bytes, 'inline', a.inline
                     ) order by a.created_at)
               from public.attachments a
              where a.message_id = m.id and not a.is_deleted) as attachments
     from public.messages m
     where ${conditions.join(' and ')}
     order by coalesce(m.received_at, m.sent_at, m.created_at) desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

export async function countByFolder(
  mailboxId,
  folder,
  { unreadOnly = false, starredOnly = false } = {},
  db = DEFAULT_POOL,
) {
  const params = [mailboxId, folder];
  const conditions = ['m.mailbox_id = $1', 'm.folder = $2'];
  if (folder !== 'trash' && folder !== 'spam') conditions.push('not m.is_deleted');
  if (unreadOnly) conditions.push('not m.is_read');
  if (starredOnly) conditions.push('m.is_starred');

  const row = await db.queryOne(
    `select count(*)::int as total from public.messages m where ${conditions.join(' and ')}`,
    params,
  );
  return row?.total ?? 0;
}

export async function countUnread(mailboxId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as total from public.messages
     where mailbox_id = $1 and folder = 'inbox' and not is_read and not is_deleted`,
    [mailboxId],
  );
  return row?.total ?? 0;
}

/** Starred messages span every folder. */
export async function listStarred(mailboxId, { limit = 30, offset = 0 } = {}, db = DEFAULT_POOL) {
  const params = [mailboxId, limit, offset];
  return db.queryAll(
    `select ${LIST_COLUMNS},
            (select json_agg(json_build_object('id', a.id, 'filename', a.filename,
                       'mime_type', a.mime_type, 'size_bytes', a.size_bytes))
               from public.attachments a
              where a.message_id = m.id and not a.is_deleted) as attachments
     from public.messages m
     where m.mailbox_id = $1 and m.is_starred and not m.is_deleted
     order by coalesce(m.received_at, m.sent_at, m.created_at) desc
     limit $2 offset $3`,
    params,
  );
}

// ─── Search ──────────────────────────────────────────────────────────────────

const OPERATOR_PATTERN = /(from|to|cc|bcc|subject|has|after|before|on|in|is|label|folder|is|older_than|newer_than):("[^"]*"|\S+)/gi;

/**
 * Parse a search string into structured terms.
 * Unrecognised text becomes a free-text term matched against the search vector.
 */
export function parseSearchQuery(input) {
  const query = String(input || '').trim();
  const result = { text: [], from: [], to: [], subject: [], has: [], in: [], is: [], label: [], after: null, before: null, on: null, olderThan: null, newerThan: null };

  let remainder = query.replace(OPERATOR_PATTERN, (match, operator, rawValue) => {
    const value = rawValue.replace(/^"|"$/g, '').trim();
    const key = operator.toLowerCase();
    switch (key) {
      case 'from': result.from.push(value); break;
      case 'to': case 'cc': case 'bcc': result.to.push(value); break;
      case 'subject': result.subject.push(value); break;
      case 'has': result.has.push(value.toLowerCase()); break;
      case 'in': case 'folder': result.in.push(value.toLowerCase()); break;
      case 'is': result.is.push(value.toLowerCase()); break;
      case 'label': result.label.push(value.toLowerCase()); break;
      case 'after': case 'newer_than': result.after = value; break;
      case 'before': case 'older_than': result.before = value; break;
      case 'on': result.on = value; break;
      default: break;
    }
    return ' ';
  });

  remainder = remainder.replace(/\s+/g, ' ').trim();
  if (remainder) result.text.push(remainder);
  return result;
}

function parseDateBound(value, endOfDay = false) {
  if (!value) return null;
  const relative = /^(\d+)([dwmy])$/i.exec(value);
  if (relative) {
    const amount = Number.parseInt(relative[1], 10);
    const unitDays = { d: 1, w: 7, m: 30, y: 365 }[relative[2].toLowerCase()];
    return new Date(Date.now() - amount * unitDays * 86_400_000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfDay ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Build the SQL predicate + params for a parsed query.
 * @returns {{where: string[], params: unknown[]}}
 */
export function buildSearchPredicate(mailboxId, parsed) {
  const where = ['m.mailbox_id = $1', 'not m.is_deleted'];
  const params = [mailboxId];
  const push = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const term of parsed.text) {
    const placeholder = push(term);
    where.push(
      `(m.search_vector @@ websearch_to_tsquery('english', ${placeholder})
        or m.subject ilike ${push(`%${term}%`)}
        or m.from_email ilike ${push(`%${term}%`)}
        or m.from_name ilike ${push(`%${term}%`)}
        or m.snippet ilike ${push(`%${term}%`)}
        or array_to_string(m.to_emails, ' ') ilike ${push(`%${term}%`)})`,
    );
  }

  for (const term of parsed.from) {
    where.push(`(m.from_email ilike ${push(`%${term}%`)} or m.from_name ilike ${push(`%${term}%`)})`);
  }

  for (const term of parsed.to) {
    where.push(`(array_to_string(m.to_emails, ' ') ilike ${push(`%${term}%`)}
                 or array_to_string(m.cc_emails, ' ') ilike ${push(`%${term}%`)}
                 or array_to_string(m.bcc_emails, ' ') ilike ${push(`%${term}%`)})`);
  }

  for (const term of parsed.subject) {
    where.push(`m.subject ilike ${push(`%${term}%`)}`);
  }

  for (const term of parsed.has) {
    if (['attachment', 'attachments', 'file', 'files'].includes(term)) where.push('m.has_attachments');
  }

  for (const term of parsed.in) {
    const folder = term === 'inbox' ? 'inbox' : term;
    if (FOLDERS.includes(folder)) where.push(`m.folder = ${push(folder)}`);
  }

  for (const term of parsed.is) {
    if (term === 'unread') where.push('not m.is_read');
    else if (term === 'read') where.push('m.is_read');
    else if (term === 'starred') where.push('m.is_starred');
    else if (term === 'unstarred') where.push('not m.is_starred');
  }

  for (const term of parsed.label) {
    const placeholder = push(term);
    where.push(
      `exists (select 1 from public.message_labels ml
               join public.labels l on l.id = ml.label_id
               where ml.message_id = m.id and (l.slug = ${placeholder} or lower(l.name) = ${placeholder}))`,
    );
  }

  const after = parseDateBound(parsed.after) ?? parseDateBound(parsed.newerThan);
  if (after) where.push(`coalesce(m.received_at, m.sent_at, m.created_at) >= ${push(after)}`);

  const before = parseDateBound(parsed.before, true) ?? parseDateBound(parsed.olderThan, true);
  if (before) where.push(`coalesce(m.received_at, m.sent_at, m.created_at) <= ${push(before)}`);

  const on = parseDateBound(parsed.on);
  if (on) {
    where.push(`coalesce(m.received_at, m.sent_at, m.created_at)::date = ${push(on.slice(0, 10))}::date`);
  }

  return { where, params };
}

/**
 * Full-text search across one mailbox.
 * @returns {{rows: object[], total: number, parsed: object}}
 */
export async function search(
  mailboxId,
  queryString,
  { limit = 30, offset = 0, folder = null } = {},
  db = DEFAULT_POOL,
) {
  const parsed = parseSearchQuery(queryString);
  const { where, params } = buildSearchPredicate(mailboxId, parsed);

  if (folder && FOLDERS.includes(folder)) {
    params.push(folder);
    where.push(`m.folder = $${params.length}`);
  }

  const whereSql = where.join(' and ');

  const countRow = await db.queryOne(
    `select count(*)::int as total from public.messages m where ${whereSql}`,
    params,
  );

  // The highlight query is its own bind parameter, appended after the WHERE
  // parameters. Referencing a fixed position like `$2` would only be right when
  // the first term happened to be free text — `is:unread` alone would rank by
  // whatever else landed in that slot.
  const highlightQuery = parsed.text.join(' ');
  const highlightParam = `$${params.length + 1}`;
  const pageParams = [...params, highlightQuery, limit, offset];
  const limitParam = `$${pageParams.length - 1}`;
  const offsetParam = `$${pageParams.length}`;

  const rows = await db.queryAll(
    `select ${LIST_COLUMNS},
            case when ${highlightParam} = '' then null
              else ts_headline('english', coalesce(m.body_text, m.subject),
                               websearch_to_tsquery('english', ${highlightParam}),
                               'MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=1, FragmentDelimiter= … ')
            end as highlight
     from public.messages m
     where ${whereSql}
     order by case when ${highlightParam} = '' then 0
                   else ts_rank(m.search_vector, websearch_to_tsquery('english', ${highlightParam})) end desc,
              coalesce(m.received_at, m.sent_at, m.created_at) desc
     limit ${limitParam} offset ${offsetParam}`,
    pageParams,
  );

  return { rows, total: countRow?.total ?? 0, parsed };
}

// ─── Mutations ───────────────────────────────────────────────────────────────

const MUTATION_FIELDS = {
  isRead: 'is_read',
  isStarred: 'is_starred',
  folder: 'folder',
  priority: 'priority',
  subject: 'subject',
  scheduledFor: 'scheduled_for',
};

/** Patch a message the caller owns. Returns the updated row. */
export async function update(id, mailboxId, patch, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id, mailboxId];

  for (const [key, column] of Object.entries(MUTATION_FIELDS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      assignments.push(`${column} = $${params.length}`);
    }
  }
  if (patch.bodyHtml !== undefined) {
    params.push(patch.bodyHtml);
    assignments.push(`body_html = $${params.length}`);
  }
  if (patch.bodyText !== undefined) {
    params.push(patch.bodyText);
    assignments.push(`body_text = $${params.length}`);
  }
  if (patch.snippet !== undefined) {
    params.push(patch.snippet);
    assignments.push(`snippet = $${params.length}`);
  }
  if (patch.isDeleted !== undefined) {
    params.push(patch.isDeleted);
    assignments.push(`is_deleted = $${params.length}`);
  }
  if (patch.isDraft !== undefined) {
    params.push(patch.isDraft);
    assignments.push(`is_draft = $${params.length}`);
  }

  if (patch.isRead === true) assignments.push('read_at = coalesce(read_at, now())');
  if (patch.isRead === false) assignments.push('read_at = null');

  // `findOwned`'s third parameter is an options object, not the db handle, so
  // the caller-supplied pool has to be passed through in its own position.
  if (assignments.length === 0) return findOwned(id, mailboxId, {}, db);

  const row = await db.queryOne(
    `update public.messages set ${assignments.join(', ')}
     where id = $1 and mailbox_id = $2 returning *`,
    params,
  );
  if (!row) throw new AppError(Codes.NOT_FOUND, 'Message not found.');
  return row;
}

/** Move messages between folders, restricted to one mailbox. */
export async function moveToFolder(ids, mailboxId, folder, db = DEFAULT_POOL) {
  if (!FOLDERS.includes(folder)) {
    throw new AppError(Codes.VALIDATION_ERROR, `Unknown folder "${folder}".`);
  }
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (uniqueIds.length === 0) return { rowCount: 0 };

  const { rowCount } = await db.query(
    `update public.messages
     set folder = $3,
         is_deleted = case when $3 in ('trash', 'spam') then true else false end,
         is_draft = case when $3 = 'drafts' then true else false end
     where mailbox_id = $2 and id = any($1::text[])`,
    [uniqueIds, mailboxId, folder],
  );
  return { rowCount };
}

/** Mark every message in a folder as read/unread. */
export async function markAllRead(mailboxId, folder = 'inbox', db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `update public.messages
     set is_read = true, read_at = coalesce(read_at, now())
     where mailbox_id = $1 and folder = $2 and not is_read`,
    [mailboxId, folder],
  );
  return { rowCount };
}

export async function emptyFolder(mailboxId, folder, db = DEFAULT_POOL) {
  if (!FOLDERS.includes(folder)) {
    throw new AppError(Codes.VALIDATION_ERROR, `Unknown folder "${folder}".`);
  }
  const { rowCount } = await db.query(
    `delete from public.messages where mailbox_id = $1 and folder = $2`,
    [mailboxId, folder],
  );
  return { rowCount };
}

/** Permanently delete a single message (hard delete, cascades attachments). */
export async function destroy(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.messages where id = $1 and mailbox_id = $2',
    [id, mailboxId],
  );
  return rowCount > 0;
}

/** Merge a thread into another one (used when a reply arrives out of order). */
export async function mergeThreads(targetThreadId, sourceThreadId, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `update public.messages set thread_id = $1 where thread_id = $2 and mailbox_id = $3`,
    [targetThreadId, sourceThreadId, mailboxId],
  );
  return { rowCount };
}

// ─── Delivery telemetry ──────────────────────────────────────────────────────

/**
 * Apply a Resend delivery event.
 * Matches on `resend_id` first (the provider's own id), then on the
 * `resend_message_id` / RFC Message-ID it echoes back.
 */
export async function applyDeliveryEvent(
  { resendId, resendMessageId, status, smtpStatus, smtpResponse, occurredAt },
  db = DEFAULT_POOL,
) {
  const existing =
    (resendId && (await db.queryOne('select * from public.messages where resend_id = $1 limit 1', [resendId]))) ||
    (resendMessageId &&
      (await db.queryOne('select * from public.messages where resend_message_id = $1 limit 1', [resendMessageId])));
  if (!existing) return null;

  const nextStatus = {
    queued: 'queued',
    sent: 'sent',
    delivered: 'delivered',
    bounced: 'bounced',
    complained: 'complained',
    delivery_delayed: 'deferred',
  }[status] || existing.delivery_status;

  return db.queryOne(
    `update public.messages
     set delivery_status = $2,
         smtp_status = coalesce($3, smtp_status),
         smtp_response = coalesce($4, smtp_response),
         delivered_at = case when $2 = 'delivered' then coalesce(delivered_at, $5::timestamptz) else delivered_at end,
         last_event_at = coalesce($5::timestamptz, now()),
         failed_count = failed_count + case when $2 in ('bounced', 'complained') then 1 else 0 end
     where id = $1
     returning *`,
    [existing.id, nextStatus, smtpStatus ?? null, smtpResponse ?? null, occurredAt ?? null],
  );
}

/** Attach the provider ids after a successful send. */
export async function attachProviderIds(id, { resendId, resendMessageId, deliveryStatus = 'queued' }, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.messages
     set resend_id = $2, resend_message_id = coalesce($3, resend_message_id),
         delivery_status = $4, last_event_at = now()
     where id = $1 returning *`,
    [id, resendId ?? null, resendMessageId ?? null, deliveryStatus],
  );
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export async function listAttachments(messageId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select a.id, a.filename, a.mime_type, a.size_bytes, a.storage_bucket,
            a.storage_path, a.content_id, a.inline, a.created_at
     from public.attachments a
     where a.message_id = $1 and not a.is_deleted
     order by a.created_at asc`,
    [messageId],
  );
}

export async function findAttachment(id, messageId, db = DEFAULT_POOL) {
  // The `a` alias is required: this statement filters on `a.is_deleted` but the
  // table was selected without one, so Postgres rejected it with
  // "missing FROM-clause entry for table a" (42P01) and every attachment
  // download failed with a database error.
  return db.queryOne(
    'select * from public.attachments a where a.id = $1 and a.message_id = $2 and not a.is_deleted',
    [id, messageId],
  );
}

/**
 * @param {string} [id] explicit attachment id. Pass the id that was already used
 *   to build the storage path so the object and its row agree; omit it and a new
 *   id is generated.
 */
export async function createAttachment(
  { id, messageId, mailboxId, filename, mimeType, sizeBytes, storageBucket, storagePath, contentId = null, inline = false },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.attachments
       (id, message_id, mailbox_id, filename, mime_type, size_bytes, storage_bucket, storage_path, content_id, inline)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning *`,
    [id || newId('attachment'), messageId, mailboxId, filename, mimeType, sizeBytes, storageBucket, storagePath, contentId, inline],
  );
}

export async function markAttachmentDeleted(id, messageId, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.attachments set is_deleted = true where id = $1 and message_id = $2 returning *`,
    [id, messageId],
  );
}

export async function hardDeleteAttachmentsForMessage(messageId, db = DEFAULT_POOL) {
  return db.queryAll(
    'select * from public.attachments where message_id = $1 and is_deleted',
    [messageId],
  );
}

export async function setHasAttachments(messageId, value, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.messages set has_attachments = $2 where id = $1 returning id, has_attachments`,
    [messageId, value],
  );
}

// ─── Quota accounting ────────────────────────────────────────────────────────

/**
 * Count outbound messages in a window for quota enforcement.
 * Drafts do not count.
 */
export async function countSentSince(mailboxIds, sinceIso, db = DEFAULT_POOL) {
  if (mailboxIds.length === 0) return 0;
  const row = await db.queryOne(
    `select count(*)::int as total from public.messages
     where mailbox_id = any($1::text[])
       and direction = 'outbound'
       and not is_draft
       and sent_at >= $2::timestamptz`,
    [mailboxIds, sinceIso],
  );
  return row?.total ?? 0;
}

/** Count outbound messages for a whole domain since a timestamp. */
export async function countSentForDomain(domainId, sinceIso, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as total
     from public.messages m
     join public.mailboxes mb on mb.id = m.mailbox_id
     where mb.domain_id = $1 and m.direction = 'outbound' and not m.is_draft and m.sent_at >= $2::timestamptz`,
    [domainId, sinceIso],
  );
  return row?.total ?? 0;
}

/**
 * Storage paths of attachments belonging to messages that
 * `purge_expired_messages()` is about to delete.
 *
 * The SQL purge function can drop rows but cannot reach Supabase Storage, so
 * the caller sweeps these objects *before* running it. If storage deletion is
 * skipped the worst case is an orphan object, never a missing one.
 *
 * @returns {Promise<string[]>}
 */
/**
 * Storage paths for attachments whose message is about to be purged.
 *
 * Paged rather than capped: the SQL purge that follows deletes *all* eligible
 * messages in one statement, so returning only the first N paths would orphan
 * every object beyond N with nothing left pointing at it.
 *
 * @returns {Promise<{paths: string[], truncated: boolean}>}
 */
export async function storagePathsPendingPurge(
  { trashDays = 30, spamDays = 30, pageSize = 1000, maxPaths = 50_000 } = {},
  db = DEFAULT_POOL,
) {
  const paths = [];
  let offset = 0;
  let truncated = false;

  for (;;) {
    const rows = await db.queryAll(
      `select a.storage_path
       from public.attachments a
       join public.messages m on m.id = a.message_id
       where (m.folder = 'trash' and m.is_deleted and m.updated_at < now() - make_interval(days => $1))
          or (m.folder = 'spam'  and m.updated_at < now() - make_interval(days => $2))
       order by a.storage_path
       limit $3 offset $4`,
      [trashDays, spamDays, pageSize, offset],
    );
    const found = rows.map((row) => row.storage_path).filter(Boolean);
    const remaining = maxPaths - paths.length;

    // Truncated means "this page held more paths than the cap allowed", which is
    // the only way paths can be left behind — including on the final short page.
    // Judging it that way (rather than "was the last page full?") keeps a sweep
    // that lands exactly on the cap from deferring forever, while still flagging
    // the partial-page case that a full-page check would miss.
    if (found.length > remaining) {
      paths.push(...found.slice(0, remaining));
      truncated = true;
      break;
    }
    paths.push(...found);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  return { paths, truncated };
}

export { FOLDERS };