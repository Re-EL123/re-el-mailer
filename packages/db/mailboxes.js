/**
 * Mailboxes, domains, inbound routes, labels and contacts.
 */

import * as pool from './pool.js';
import { newId, normalizeMessageId } from '../shared/ids.js';
import { slugify } from '../shared/sanitize.js';
import { AppError, Codes } from '../shared/errors.js';

const DEFAULT_POOL = pool;

const MAILBOX_COLUMNS = `
  mb.id, mb.user_id, mb.domain_id, mb.email, mb.display_name,
  mb.signature_html, mb.signature_text, mb.reply_to,
  mb.quota_bytes, mb.storage_used_bytes, mb.status,
  mb.daily_send_limit, mb.hourly_send_limit, mb.is_primary, mb.auto_read,
  mb.created_at, mb.updated_at
`;

// ─── Domains ─────────────────────────────────────────────────────────────────

export async function listDomains(db = DEFAULT_POOL) {
  return db.queryAll(
    `select d.*,
            (select count(*) from public.mailboxes mb where mb.domain_id = d.id) as mailbox_count,
            (select count(*) from public.mailboxes mb where mb.domain_id = d.id and mb.status = 'active') as active_mailboxes
     from public.domains d
     order by d.created_at asc`,
  );
}

export async function findDomainByName(name, db = DEFAULT_POOL) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.queryOne('select * from public.domains where lower(name) = $1', [normalized]);
}

export async function findDomainById(id, db = DEFAULT_POOL) {
  return db.queryOne('select * from public.domains where id = $1', [id]);
}

export async function upsertDomain({ name, status = 'pending', notes, dnsRecords }, db = DEFAULT_POOL) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) throw new AppError(Codes.VALIDATION_ERROR, 'A domain name is required.');
  return db.queryOne(
    `insert into public.domains (id, name, status, notes, dns_records)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (id) do update
       set status = excluded.status,
           notes = excluded.notes,
           dns_records = excluded.dns_records
     returning *`,
    [newId('domain'), normalized, status, notes ?? null, JSON.stringify(dnsRecords ?? [])],
  );
}

export async function updateDomainStatus(id, status, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.domains set status = $2 where id = $1 returning *`,
    [id, status],
  );
}

export async function updateDomainDns(id, dnsRecords, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.domains set dns_records = $2::jsonb where id = $1 returning *`,
    [id, JSON.stringify(dnsRecords ?? [])],
  );
}

export async function deleteDomain(id, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.domains where id = $1', [id]);
  return rowCount > 0;
}

/**
 * Update a domain by id.
 *
 * Name is intentionally not updatable — routes, mailboxes and DNS records all
 * key off it — but status, notes and the DNS record set are all editable from
 * the console and applied together so the domain row is never half-updated.
 *
 * @param {string} id
 * @param {{status?: string, notes?: string|null, dnsRecords?: Array}} patch
 */
export async function updateDomain(id, patch = {}, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id];
  const set = (column, value, cast = '') => {
    params.push(value);
    assignments.push(`${column} = $${params.length}${cast}`);
  };

  if (patch.status !== undefined) set('status', patch.status);
  if (patch.notes !== undefined) set('notes', patch.notes);
  if (patch.dnsRecords !== undefined) set('dns_records', JSON.stringify(patch.dnsRecords ?? []), '::jsonb');

  if (assignments.length === 0) return findDomainById(id, db);

  return db.queryOne(
    `update public.domains set ${assignments.join(', ')} where id = $1 returning *`,
    params,
  );
}

// ─── Mailboxes ───────────────────────────────────────────────────────────────

export async function findMailboxById(id, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${MAILBOX_COLUMNS}, d.name as domain
     from public.mailboxes mb
     join public.domains d on d.id = mb.domain_id
     where mb.id = $1`,
    [id],
  );
}

export async function findMailboxByEmail(email, db = DEFAULT_POOL) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.queryOne(
    `select ${MAILBOX_COLUMNS}, d.name as domain
     from public.mailboxes mb
     join public.domains d on d.id = mb.domain_id
     where lower(mb.email) = $1`,
    [normalized],
  );
}

export async function listMailboxesForUser(userId, { includeDisabled = false } = {}, db = DEFAULT_POOL) {
  const params = [userId];
  let filter = '';
  if (!includeDisabled) {
    params.push('disabled');
    filter = `and mb.status <> $${params.length}`;
  }
  return db.queryAll(
    `select ${MAILBOX_COLUMNS}, d.name as domain
     from public.mailboxes mb
     join public.domains d on d.id = mb.domain_id
     where mb.user_id = $1 ${filter}
     order by mb.is_primary desc, mb.created_at asc`,
    params,
  );
}

export async function listAllMailboxes({ status, search, limit = 200, offset = 0 } = {}, db = DEFAULT_POOL) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`mb.status = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    conditions.push(
      `(lower(mb.email) like $${params.length} or lower(mb.display_name) like $${params.length}
        or lower(u.display_name) like $${params.length} or lower(u.email) like $${params.length})`,
    );
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit, offset);

  return db.queryAll(
    `select ${MAILBOX_COLUMNS}, d.name as domain,
            u.display_name as owner_name, u.email as owner_email, u.role, u.status as user_status,
            u.last_login_at
     from public.mailboxes mb
     join public.domains d on d.id = mb.domain_id
     join public.users   u on u.id = mb.user_id
     ${where}
     order by mb.created_at desc
     limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

export async function mailboxExists(email, excludeId, db = DEFAULT_POOL) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = await db.queryOne(
    `select id from public.mailboxes where lower(email) = $1 and ($2::text is null or id <> $2)`,
    [normalized, excludeId ?? null],
  );
  return Boolean(row);
}

export async function createMailbox(
  {
    userId,
    domainId,
    email,
    displayName,
    quotaBytes = 2_147_483_648,
    status = 'active',
    signatureHtml,
    signatureText,
    replyTo,
    dailySendLimit,
    hourlySendLimit,
    isPrimary = false,
    autoRead = false,
  },
  db = DEFAULT_POOL,
) {
  const id = newId('mailbox');
  return db.queryOne(
    `insert into public.mailboxes
       (id, user_id, domain_id, email, display_name, quota_bytes, status,
        signature_html, signature_text, reply_to, daily_send_limit, hourly_send_limit,
        is_primary, auto_read)
     values ($1, $2, $3, lower($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning ${MAILBOX_COLUMNS.replace(/mb\./g, '')}`,
    [
      id,
      userId,
      domainId,
      String(email).trim(),
      displayName,
      quotaBytes,
      status,
      signatureHtml ?? null,
      signatureText ?? null,
      replyTo ?? null,
      dailySendLimit ?? null,
      hourlySendLimit ?? null,
      isPrimary,
      autoRead,
    ],
  );
}

const UPDATABLE_MAILBOX_FIELDS = {
  displayName: 'display_name',
  status: 'status',
  quotaBytes: 'quota_bytes',
  signatureHtml: 'signature_html',
  signatureText: 'signature_text',
  replyTo: 'reply_to',
  dailySendLimit: 'daily_send_limit',
  hourlySendLimit: 'hourly_send_limit',
  isPrimary: 'is_primary',
  autoRead: 'auto_read',
  domainId: 'domain_id',
};

export async function updateMailbox(id, patch, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id];

  for (const [key, column] of Object.entries(UPDATABLE_MAILBOX_FIELDS)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      assignments.push(`${column} = $${params.length}`);
    }
  }
  if (patch.email !== undefined) {
    params.push(String(patch.email).trim().toLowerCase());
    assignments.push(`email = $${params.length}`);
  }
  if (assignments.length === 0) return findMailboxById(id, db);

  const row = await db.queryOne(
    `update public.mailboxes set ${assignments.join(', ')} where id = $1
     returning ${MAILBOX_COLUMNS.replace(/mb\./g, '')}`,
    params,
  );
  if (!row) throw new AppError(Codes.NOT_FOUND, 'Mailbox not found.');
  return row;
}

export async function deleteMailbox(id, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.mailboxes where id = $1', [id]);
  return rowCount > 0;
}

/**
 * Recompute a mailbox's stored usage from the attachments table.
 * `storage_used_bytes` is a cache for fast quota checks; this keeps it honest.
 */
export async function refreshMailboxUsage(mailboxId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `update public.mailboxes mb
     set storage_used_bytes = (
       select coalesce(sum(a.size_bytes), 0)
       from public.attachments a
       join public.messages m on m.id = a.message_id
       where m.mailbox_id = mb.id and not a.is_deleted
     )
     where mb.id = $1
     returning mb.id, mb.storage_used_bytes, mb.quota_bytes`,
    [mailboxId],
  );
  return row;
}

/** Quota state for a mailbox, used to reject oversized messages early. */
export async function quotaStatus(mailboxId, db = DEFAULT_POOL) {
  return db.queryOne(
    `select mb.id, mb.email, mb.quota_bytes, mb.storage_used_bytes,
            greatest(0, mb.quota_bytes - mb.storage_used_bytes) as available_bytes
     from public.mailboxes mb where mb.id = $1`,
    [mailboxId],
  );
}

/** Folder counts for the sidebar — one round trip. */
export async function folderCounts(mailboxId, db = DEFAULT_POOL) {
  const rows = await db.queryAll('select * from public.mailbox_folder_counts($1)', [mailboxId]);
  const result = { inbox: 0, sent: 0, drafts: 0, archive: 0, trash: 0, spam: 0 };
  let unread = 0;
  let starred = 0;
  for (const row of rows) {
    result[row.folder] = Number(row.total) || 0;
    if (row.folder === 'inbox') unread = Number(row.unread) || 0;
    starred += Number(row.starred) || 0;
  }
  return { folders: result, inboxUnread: unread, starred };
}

// ─── Inbound routes ──────────────────────────────────────────────────────────

export async function listInboundRoutes(domainId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select r.*, mb.email as mailbox_email, mb.display_name as mailbox_display_name
     from public.inbound_routes r
     left join public.mailboxes mb on mb.id = r.mailbox_id
     where r.domain_id = $1
     order by r.priority asc, r.created_at asc`,
    [domainId],
  );
}

export async function createInboundRoute({ domainId, pattern, mailboxId, action = 'deliver', priority = 100, note }, db = DEFAULT_POOL) {
  return db.queryOne(
    `insert into public.inbound_routes (id, domain_id, pattern, mailbox_id, action, priority, note)
     values ($1, $2, lower($3), $4, $5, $6, $7)
     returning *`,
    [newId('route'), domainId, String(pattern).trim().toLowerCase(), mailboxId ?? null, action, priority, note ?? null],
  );
}

export async function updateInboundRoute(id, patch, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id];
  const map = { pattern: 'pattern', mailboxId: 'mailbox_id', action: 'action', priority: 'priority', isActive: 'is_active', note: 'note' };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      assignments.push(`${column} = $${params.length}`);
    }
  }
  if (assignments.length === 0) return db.queryOne('select * from public.inbound_routes where id = $1', [id]);
  return db.queryOne(
    `update public.inbound_routes set ${assignments.join(', ')} where id = $1 returning *`,
    params,
  );
}

export async function deleteInboundRoute(id, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.inbound_routes where id = $1', [id]);
  return rowCount > 0;
}

/** Resolve an inbound recipient address to a mailbox + action. */
export async function resolveInboundRecipient(email, db = DEFAULT_POOL) {
  return db.queryOne('select * from public.resolve_inbound_recipient($1)', [String(email || '').trim()]);
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const DEFAULT_LABELS = [
  { name: 'Clients', color: '#21396A', slug: 'clients', sortOrder: 10 },
  { name: 'Projects', color: '#F5BF48', slug: 'projects', sortOrder: 20 },
  { name: 'Finance', color: '#2F855A', slug: 'finance', sortOrder: 30 },
  { name: 'Internal', color: '#BA133A', slug: 'internal', sortOrder: 40 },
];

/** Create the four default labels for a mailbox. Idempotent. */
export async function ensureDefaultLabels(mailboxId, db = DEFAULT_POOL) {
  for (const label of DEFAULT_LABELS) {
    await db.query(
      `insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (mailbox_id, slug) do nothing`,
      [newId('label'), mailboxId, label.name, label.color, label.slug, label.sortOrder],
    );
  }
}

export async function listLabels(mailboxId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select l.id, l.name, l.color, l.slug, l.sort_order,
            (select count(*) from public.message_labels ml
              join public.messages m on m.id = ml.message_id
             where ml.label_id = l.id and m.mailbox_id = $1 and not m.is_deleted) as message_count
     from public.labels l
     where l.mailbox_id = $1
     order by l.sort_order asc, l.name asc`,
    [mailboxId],
  );
}

export async function createLabel({ mailboxId, name, color = '#21396A' }, db = DEFAULT_POOL) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new AppError(Codes.VALIDATION_ERROR, 'A label name is required.');
  return db.queryOne(
    `insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
     values ($1, $2, $3, $4, $5, 100)
     returning *`,
    [newId('label'), mailboxId, cleanName, color, slugify(cleanName)],
  );
}

export async function updateLabel(id, mailboxId, patch, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id, mailboxId];
  if (patch.name !== undefined) {
    params.push(patch.name);
    assignments.push(`name = $${params.length}`);
    params.push(slugify(patch.name));
    assignments.push(`slug = $${params.length}`);
  }
  if (patch.color !== undefined) {
    params.push(patch.color);
    assignments.push(`color = $${params.length}`);
  }
  if (patch.sortOrder !== undefined) {
    params.push(patch.sortOrder);
    assignments.push(`sort_order = $${params.length}`);
  }
  if (assignments.length === 0) return null;
  return db.queryOne(
    `update public.labels set ${assignments.join(', ')} where id = $1 and mailbox_id = $2 returning *`,
    params,
  );
}

export async function deleteLabel(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.labels where id = $1 and mailbox_id = $2', [id, mailboxId]);
  return rowCount > 0;
}

/** Attach labels to a message. Passing an empty list clears them. */
export async function setMessageLabels(messageId, labelIds, db = DEFAULT_POOL) {
  await db.query('delete from public.message_labels where message_id = $1', [messageId]);
  const unique = [...new Set((labelIds || []).filter(Boolean))];
  for (const labelId of unique) {
    await db.query(
      `insert into public.message_labels (message_id, label_id) values ($1, $2)
       on conflict do nothing`,
      [messageId, labelId],
    );
  }
  return unique;
}

export async function listMessageLabels(messageId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select l.id, l.name, l.color, l.slug
     from public.message_labels ml
     join public.labels l on l.id = ml.label_id
     where ml.message_id = $1
     order by l.sort_order asc`,
    [messageId],
  );
}

/** Messages carrying a given label (paged). */
export async function listMessagesByLabel(mailboxId, labelId, { limit = 30, offset = 0 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select m.id, m.thread_id, m.subject, m.snippet, m.from_email, m.from_name,
            m.to_emails, m.received_at, m.sent_at, m.is_read, m.is_starred,
            m.has_attachments, m.folder
     from public.message_labels ml
     join public.messages m on m.id = ml.message_id
     where ml.label_id = $1 and m.mailbox_id = $2 and not m.is_deleted
     order by coalesce(m.received_at, m.sent_at, m.created_at) desc
     limit $3 offset $4`,
    [labelId, mailboxId, limit, offset],
  );
}

// ─── Contacts ────────────────────────────────────────────────────────────────

/** Upsert participants into the derived address book. */
export async function rememberContacts(mailboxId, participants, db = DEFAULT_POOL) {
  const entries = (participants || []).filter((entry) => entry && entry.email);
  for (const entry of entries) {
    await db.query(
      `insert into public.contacts (id, mailbox_id, email, name, last_seen_at, seen_count)
       values ($1, $2, $3, $4, now(), 1)
       on conflict (mailbox_id, lower(email)) do update
         set name = coalesce(nullif(excluded.name, ''), public.contacts.name),
             last_seen_at = now(),
             seen_count = public.contacts.seen_count + 1`,
      [newId('contact'), mailboxId, String(entry.email).trim().toLowerCase(), entry.name ?? ''],
    );
  }
  return entries.length;
}

export async function searchContacts(mailboxId, { search = '', limit = 8 } = {}, db = DEFAULT_POOL) {
  const params = [mailboxId];
  let filter = '';
  if (search) {
    params.push(`%${String(search).trim().toLowerCase()}%`);
    filter = `and (lower(email) like $${params.length} or lower(coalesce(name, '')) like $${params.length})`;
  }
  params.push(limit);
  return db.queryAll(
    `select id, email, name, last_seen_at, seen_count
     from public.contacts
     where mailbox_id = $1 ${filter}
     order by last_seen_at desc, email asc
     limit $${params.length}`,
    params,
  );
}

export async function deleteContact(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query('delete from public.contacts where id = $1 and mailbox_id = $2', [id, mailboxId]);
  return rowCount > 0;
}

/**
 * The mailbox id that owns `email` for this user, or null.
 *
 * Callers use this to stop a user sending as an address they do not hold; the
 * id is returned rather than a boolean so the caller can also confirm the
 * mailbox it matched.
 */
export async function findOwnedMailboxId(userId, email, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select id from public.mailboxes where user_id = $1 and lower(email) = lower($2)`,
    [userId, String(email || '').trim()],
  );
  return row?.id ?? null;
}

/** Boolean form of {@link findOwnedMailboxId}. */
export async function isOwnedAddress(userId, email, db = DEFAULT_POOL) {
  return (await findOwnedMailboxId(userId, email, db)) !== null;
}

export { normalizeMessageId };