/**
 * Automation persistence: rules, templates, internal notes, the job queue,
 * outbound webhooks, notifications and campaigns.
 *
 * Every function takes an optional `db` handle as its last argument so it can be
 * reused inside a transaction, matching the convention in the other db modules.
 * Rows are returned snake_case; the API layer maps them to camelCase views.
 */

import * as pool from './pool.js';
import { newId } from '../shared/ids.js';

const DEFAULT_POOL = pool;

// ─── Rules ───────────────────────────────────────────────────────────────────

const RULE_COLUMNS = `
  id, mailbox_id, name, description, is_active, conditions, actions,
  direction, stop_processing, run_order, created_by, created_at, updated_at
`;

export async function listRules(mailboxId, { includeInactive = true } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${RULE_COLUMNS} from public.automation_rules
     where mailbox_id = $1 ${includeInactive ? '' : 'and is_active'}
     order by run_order asc, created_at asc`,
    [mailboxId],
  );
}

export async function getRule(id, mailboxId, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${RULE_COLUMNS} from public.automation_rules where id = $1 and mailbox_id = $2`,
    [id, mailboxId],
  );
}

export async function createRule(
  {
    mailboxId,
    name,
    description = null,
    conditions = { match: 'all', conditions: [] },
    actions = [],
    direction = 'inbound',
    stopProcessing = false,
    runOrder = 100,
    createdBy = null,
  },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.automation_rules
       (id, mailbox_id, name, description, conditions, actions, direction, stop_processing, run_order, created_by)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
     returning ${RULE_COLUMNS}`,
    [
      newId('rule'),
      mailboxId,
      name,
      description,
      JSON.stringify(conditions ?? { match: 'all', conditions: [] }),
      JSON.stringify(actions ?? []),
      direction,
      stopProcessing,
      runOrder,
      createdBy,
    ],
  );
}

const RULE_PATCH = {
  name: 'name',
  description: 'description',
  isActive: 'is_active',
  conditions: 'conditions',
  actions: 'actions',
  direction: 'direction',
  stopProcessing: 'stop_processing',
  runOrder: 'run_order',
};

export async function updateRule(id, mailboxId, patch, db = DEFAULT_POOL) {
  const sets = [];
  const params = [id, mailboxId];
  for (const [key, column] of Object.entries(RULE_PATCH)) {
    if (patch[key] === undefined) continue;
    params.push(key === 'conditions' || key === 'actions' ? JSON.stringify(patch[key]) : patch[key]);
    const cast = key === 'conditions' || key === 'actions' ? '::jsonb' : '';
    sets.push(`${column} = $${params.length}${cast}`);
  }
  if (sets.length === 0) return getRule(id, mailboxId, db);
  return db.queryOne(
    `update public.automation_rules set ${sets.join(', ')}
     where id = $1 and mailbox_id = $2
     returning ${RULE_COLUMNS}`,
    params,
  );
}

export async function deleteRule(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.automation_rules where id = $1 and mailbox_id = $2',
    [id, mailboxId],
  );
  return rowCount > 0;
}

/** Active rules for a mailbox, in evaluation order, filtered by direction. */
export async function activeRulesFor(mailboxId, direction, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${RULE_COLUMNS} from public.automation_rules
     where mailbox_id = $1 and is_active and direction in ('both', $2)
     order by run_order asc, created_at asc`,
    [mailboxId, direction],
  );
}

/**
 * Record that a rule matched a message. The unique (rule_id, message_id)
 * constraint makes this idempotent: returns null when the pair already exists,
 * which the caller uses to skip re-applying actions on a webhook retry.
 */
export async function recordRuleRun(ruleId, messageId, actionsApplied = [], db = DEFAULT_POOL) {
  return db.queryOne(
    `insert into public.automation_rule_runs (rule_id, message_id, matched, actions_applied)
     values ($1, $2, true, $3::jsonb)
     on conflict (rule_id, message_id) do nothing
     returning id, created_at`,
    [ruleId, messageId, JSON.stringify(actionsApplied ?? [])],
  );
}

export async function listRuleRuns(ruleId, { limit = 50 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select id, rule_id, message_id, matched, actions_applied, created_at
     from public.automation_rule_runs
     where rule_id = $1 order by created_at desc limit $2`,
    [ruleId, limit],
  );
}

// ─── Templates (canned responses) ────────────────────────────────────────────

const TEMPLATE_COLUMNS = `
  id, mailbox_id, name, slug, subject, body_html, body_text, sort_order, created_by, created_at, updated_at
`;

/** Turn a template name into a URL/identifier-safe slug. */
export function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'template';
}

export async function listTemplates(mailboxId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${TEMPLATE_COLUMNS} from public.templates
     where mailbox_id = $1 order by sort_order asc, name asc`,
    [mailboxId],
  );
}

export async function getTemplate(id, mailboxId, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${TEMPLATE_COLUMNS} from public.templates where id = $1 and mailbox_id = $2`,
    [id, mailboxId],
  );
}

export async function templateBySlug(mailboxId, slug, db = DEFAULT_POOL) {
  return db.queryOne(
    `select ${TEMPLATE_COLUMNS} from public.templates where mailbox_id = $1 and slug = $2`,
    [mailboxId, slug],
  );
}

export async function createTemplate(
  { mailboxId, name, subject = null, bodyHtml = null, bodyText = null, sortOrder = 0, createdBy = null, slug = null },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.templates (id, mailbox_id, name, slug, subject, body_html, body_text, sort_order, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${TEMPLATE_COLUMNS}`,
    [newId('template'), mailboxId, name, slug || slugify(name), subject, bodyHtml, bodyText, sortOrder, createdBy],
  );
}

const TEMPLATE_PATCH = {
  name: 'name',
  subject: 'subject',
  bodyHtml: 'body_html',
  bodyText: 'body_text',
  sortOrder: 'sort_order',
  slug: 'slug',
};

export async function updateTemplate(id, mailboxId, patch, db = DEFAULT_POOL) {
  const sets = [];
  const params = [id, mailboxId];
  for (const [key, column] of Object.entries(TEMPLATE_PATCH)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return getTemplate(id, mailboxId, db);
  return db.queryOne(
    `update public.templates set ${sets.join(', ')}
     where id = $1 and mailbox_id = $2 returning ${TEMPLATE_COLUMNS}`,
    params,
  );
}

export async function deleteTemplate(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.templates where id = $1 and mailbox_id = $2',
    [id, mailboxId],
  );
  return rowCount > 0;
}

// ─── Internal notes ──────────────────────────────────────────────────────────

export async function listNotes(messageId, mailboxId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select id, message_id, mailbox_id, author_id, author_email, body, created_at
     from public.message_notes
     where message_id = $1 and mailbox_id = $2 order by created_at asc`,
    [messageId, mailboxId],
  );
}

export async function createNote(
  { messageId, mailboxId, authorId = null, authorEmail = null, body },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.message_notes (id, message_id, mailbox_id, author_id, author_email, body)
     values ($1, $2, $3, $4, $5, $6)
     returning id, message_id, mailbox_id, author_id, author_email, body, created_at`,
    [newId('note'), messageId, mailboxId, authorId, authorEmail, body],
  );
}

export async function deleteNote(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.message_notes where id = $1 and mailbox_id = $2',
    [id, mailboxId],
  );
  return rowCount > 0;
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

const JOB_COLUMNS = `
  id, kind, mailbox_id, payload, run_at, status, priority, attempts, max_attempts,
  last_error, locked_at, locked_by, dedupe_key, result, created_at, updated_at, completed_at
`;

/**
 * Enqueue deferred work.
 *
 * When `dedupeKey` is supplied the insert is idempotent: a second enqueue with
 * the same key returns the existing row's id instead of a duplicate. This is
 * what keeps an at-least-once webhook from scheduling the same follow-up twice.
 */
export async function enqueueJob(
  { kind, mailboxId = null, payload = {}, runAt = null, priority = 100, maxAttempts = 5, dedupeKey = null },
  db = DEFAULT_POOL,
) {
  const id = newId('job');
  if (dedupeKey) {
    const row = await db.queryOne(
      `insert into public.jobs (id, kind, mailbox_id, payload, run_at, priority, max_attempts, dedupe_key)
       values ($1, $2, $3, $4::jsonb, coalesce($5::timestamptz, now()), $6, $7, $8)
       on conflict (dedupe_key) where dedupe_key is not null do nothing
       returning ${JOB_COLUMNS}`,
      [id, kind, mailboxId, JSON.stringify(payload ?? {}), runAt, priority, maxAttempts, dedupeKey],
    );
    if (row) return row;
    // Already enqueued: surface the existing id so callers stay idempotent.
    return db.queryOne(`select ${JOB_COLUMNS} from public.jobs where dedupe_key = $1`, [dedupeKey]);
  }
  return db.queryOne(
    `insert into public.jobs (id, kind, mailbox_id, payload, run_at, priority, max_attempts)
     values ($1, $2, $3, $4::jsonb, coalesce($5::timestamptz, now()), $6, $7)
     returning ${JOB_COLUMNS}`,
    [id, kind, mailboxId, JSON.stringify(payload ?? {}), runAt, priority, maxAttempts],
  );
}

/**
 * Atomically claim up to `limit` due jobs. `for update skip locked` lets
 * concurrent cron invocations drain the queue in parallel without ever handing
 * the same job to two workers.
 */
export async function claimDueJobs({ limit = 25, workerId = 'cron', kinds = null } = {}, db = DEFAULT_POOL) {
  const params = [limit, workerId];
  let kindFilter = '';
  if (Array.isArray(kinds) && kinds.length) {
    params.push(kinds);
    kindFilter = `and kind = any($${params.length}::text[])`;
  }
  return db.queryAll(
    `update public.jobs
     set status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1, updated_at = now()
     where id in (
       select id from public.jobs
       where status = 'pending' and run_at <= now() ${kindFilter}
       order by priority asc, run_at asc
       limit $1
       for update skip locked
     )
     returning ${JOB_COLUMNS}`,
    params,
  );
}

export async function completeJob(id, result = {}, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.jobs
     set status = 'done', result = $2::jsonb, completed_at = now(), locked_at = null, locked_by = null
     where id = $1 returning ${JOB_COLUMNS}`,
    [id, JSON.stringify(result ?? {})],
  );
}

/**
 * Mark a claimed job failed. Retries with a linear backoff until `max_attempts`
 * (already incremented at claim time), then parks it as `failed` for inspection.
 */
export async function failJob(id, error, { backoffSeconds = 60 } = {}, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.jobs
     set status = case when attempts >= max_attempts then 'failed' else 'pending' end,
         last_error = $2,
         run_at = case when attempts >= max_attempts then run_at else now() + make_interval(secs => $3) end,
         locked_at = null, locked_by = null
     where id = $1 returning ${JOB_COLUMNS}`,
    [id, String(error ?? '').slice(0, 500), backoffSeconds],
  );
}

export async function cancelJob(id, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.jobs set status = 'cancelled', locked_at = null, locked_by = null
     where id = $1 and status in ('pending', 'running') returning ${JOB_COLUMNS}`,
    [id],
  );
}

/** Return jobs stuck in `running` (a crashed worker) to the queue. */
export async function reclaimStaleJobs({ olderThanSeconds = 300 } = {}, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `update public.jobs set status = 'pending', locked_at = null, locked_by = null
     where status = 'running' and locked_at < now() - make_interval(secs => $1)`,
    [olderThanSeconds],
  );
  return { rowCount };
}

export async function listJobs({ mailboxId = null, status = null, limit = 100 } = {}, db = DEFAULT_POOL) {
  const conditions = [];
  const params = [];
  if (mailboxId) {
    params.push(mailboxId);
    conditions.push(`mailbox_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit);
  return db.queryAll(
    `select ${JOB_COLUMNS} from public.jobs ${where} order by created_at desc limit $${params.length}`,
    params,
  );
}

export async function pruneJobs({ doneDays = 7, failedDays = 30 } = {}, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `delete from public.jobs
     where (status = 'done' and completed_at < now() - make_interval(days => $1))
        or (status in ('failed', 'cancelled') and updated_at < now() - make_interval(days => $2))`,
    [doneDays, failedDays],
  );
  return { rowCount };
}

// ─── Outbound webhooks ───────────────────────────────────────────────────────

const WEBHOOK_COLUMNS = `
  id, mailbox_id, url, secret, description, events, is_active, created_by, created_at, updated_at
`;

/** Endpoints are listed without the signing secret; it is only read at dispatch. */
const WEBHOOK_PUBLIC_COLUMNS = `
  id, mailbox_id, url, description, events, is_active, created_by, created_at, updated_at
`;

export async function listWebhookEndpoints(mailboxId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${WEBHOOK_PUBLIC_COLUMNS} from public.webhook_endpoints
     where mailbox_id = $1 or mailbox_id is null
     order by created_at desc`,
    [mailboxId],
  );
}

export async function getWebhookEndpoint(id, mailboxId, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${WEBHOOK_COLUMNS} from public.webhook_endpoints where id = $1 and (mailbox_id = $2 or mailbox_id is null)`,
    [id, mailboxId],
  );
}

export async function createWebhookEndpoint(
  { mailboxId = null, url, secret, description = null, events = [], createdBy = null },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.webhook_endpoints (id, mailbox_id, url, secret, description, events, created_by)
     values ($1, $2, $3, $4, $5, $6::text[], $7)
     returning ${WEBHOOK_PUBLIC_COLUMNS}`,
    [newId('webhook'), mailboxId, url, secret, description, events ?? [], createdBy],
  );
}

export async function updateWebhookEndpoint(id, mailboxId, patch, db = DEFAULT_POOL) {
  const sets = [];
  const params = [id, mailboxId];
  const map = { url: 'url', description: 'description', isActive: 'is_active', secret: 'secret' };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (patch.events !== undefined) {
    params.push(patch.events);
    sets.push(`events = $${params.length}::text[]`);
  }
  if (sets.length === 0) return getWebhookEndpoint(id, mailboxId, db);
  return db.queryOne(
    `update public.webhook_endpoints set ${sets.join(', ')}
     where id = $1 and (mailbox_id = $2 or mailbox_id is null)
     returning ${WEBHOOK_PUBLIC_COLUMNS}`,
    params,
  );
}

export async function deleteWebhookEndpoint(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.webhook_endpoints where id = $1 and (mailbox_id = $2 or mailbox_id is null)',
    [id, mailboxId],
  );
  return rowCount > 0;
}

/** Active endpoints that should receive `event` for this mailbox (incl. global). */
export async function activeEndpointsFor(mailboxId, event, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${WEBHOOK_COLUMNS} from public.webhook_endpoints
     where is_active
       and (mailbox_id = $1 or mailbox_id is null)
       and (coalesce(array_length(events, 1), 0) = 0 or $2 = any(events))`,
    [mailboxId, event],
  );
}

export async function recordWebhookDelivery(
  { endpointId, event, payload = {}, responseStatus = null, responseBody = null, error = null, attempts = 1, delivered = false },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.webhook_deliveries
       (endpoint_id, event, payload, response_status, response_body, error, attempts, delivered_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, $7, case when $8 then now() else null end)
     returning id, created_at`,
    [
      endpointId,
      event,
      JSON.stringify(payload ?? {}),
      responseStatus,
      responseBody ? String(responseBody).slice(0, 1000) : null,
      error ? String(error).slice(0, 500) : null,
      attempts,
      delivered,
    ],
  );
}

export async function listWebhookDeliveries(endpointId, { limit = 50 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select id, endpoint_id, event, response_status, response_body, error, attempts, delivered_at, created_at
     from public.webhook_deliveries where endpoint_id = $1 order by created_at desc limit $2`,
    [endpointId, limit],
  );
}

// ─── Notifications ───────────────────────────────────────────────────────────

const NOTIFICATION_COLUMNS = `
  id, user_id, mailbox_id, kind, title, body, entity_type, entity_id, url, is_read, read_at, created_at
`;

export async function createNotification(
  { userId, mailboxId = null, kind = 'info', title, body = null, entityType = null, entityId = null, url = null },
  db = DEFAULT_POOL,
) {
  return db.queryOne(
    `insert into public.notifications
       (id, user_id, mailbox_id, kind, title, body, entity_type, entity_id, url)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning ${NOTIFICATION_COLUMNS}`,
    [newId('notification'), userId, mailboxId, kind, title, body, entityType, entityId, url],
  );
}

export async function listNotifications(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${NOTIFICATION_COLUMNS} from public.notifications
     where user_id = $1 ${unreadOnly ? 'and not is_read' : ''}
     order by created_at desc limit $2 offset $3`,
    [userId, limit, offset],
  );
}

export async function countUnreadNotifications(userId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    'select count(*)::int as total from public.notifications where user_id = $1 and not is_read',
    [userId],
  );
  return row?.total ?? 0;
}

export async function markNotificationRead(id, userId, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.notifications set is_read = true, read_at = coalesce(read_at, now())
     where id = $1 and user_id = $2 returning ${NOTIFICATION_COLUMNS}`,
    [id, userId],
  );
}

export async function markAllNotificationsRead(userId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `update public.notifications set is_read = true, read_at = now()
     where user_id = $1 and not is_read`,
    [userId],
  );
  return { rowCount };
}

export async function pruneNotifications({ days = 90 } = {}, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `delete from public.notifications
     where is_read and created_at < now() - make_interval(days => $1)`,
    [days],
  );
  return { rowCount };
}

/** Notify every active user who owns the given mailbox. */
export async function notifyMailboxOwners(
  { mailboxId, kind = 'info', title, body = null, entityType = null, entityId = null, url = null },
  db = DEFAULT_POOL,
) {
  return db.queryAll(
    `insert into public.notifications (id, user_id, mailbox_id, kind, title, body, entity_type, entity_id, url)
     select 'ntf_' || replace(gen_random_uuid()::text, '-', ''), u.id, $1, $2, $3, $4, $5, $6, $7
     from public.users u
     join public.mailboxes mb on mb.user_id = u.id
     where mb.id = $1 and u.status = 'active'
     returning ${NOTIFICATION_COLUMNS}`,
    [mailboxId, kind, title, body, entityType, entityId, url],
  );
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const CAMPAIGN_COLUMNS = `
  id, mailbox_id, name, subject, body_html, body_text, status, scheduled_for, batch_size,
  total_recipients, sent_count, failed_count, created_by, created_at, updated_at, started_at, completed_at
`;

export async function listCampaigns(mailboxId, { limit = 100, offset = 0 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${CAMPAIGN_COLUMNS} from public.campaigns
     where mailbox_id = $1 order by created_at desc limit $2 offset $3`,
    [mailboxId, limit, offset],
  );
}

export async function getCampaign(id, mailboxId, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(
    `select ${CAMPAIGN_COLUMNS} from public.campaigns where id = $1 and mailbox_id = $2`,
    [id, mailboxId],
  );
}

export async function createCampaign(
  { mailboxId, name, subject, bodyHtml = null, bodyText = null, scheduledFor = null, batchSize = 50, createdBy = null },
  db = DEFAULT_POOL,
) {
  const status = scheduledFor ? 'scheduled' : 'draft';
  return db.queryOne(
    `insert into public.campaigns
       (id, mailbox_id, name, subject, body_html, body_text, status, scheduled_for, batch_size, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)
     returning ${CAMPAIGN_COLUMNS}`,
    [newId('campaign'), mailboxId, name, subject, bodyHtml, bodyText, status, scheduledFor, batchSize, createdBy],
  );
}

const CAMPAIGN_PATCH = {
  name: 'name',
  subject: 'subject',
  bodyHtml: 'body_html',
  bodyText: 'body_text',
  status: 'status',
  scheduledFor: 'scheduled_for',
  batchSize: 'batch_size',
};

export async function updateCampaign(id, mailboxId, patch, db = DEFAULT_POOL) {
  const sets = [];
  const params = [id, mailboxId];
  for (const [key, column] of Object.entries(CAMPAIGN_PATCH)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return getCampaign(id, mailboxId, db);
  return db.queryOne(
    `update public.campaigns set ${sets.join(', ')}
     where id = $1 and mailbox_id = $2 returning ${CAMPAIGN_COLUMNS}`,
    params,
  );
}

export async function deleteCampaign(id, mailboxId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    'delete from public.campaigns where id = $1 and mailbox_id = $2',
    [id, mailboxId],
  );
  return rowCount > 0;
}

/**
 * Add recipients, skipping duplicates (case-insensitively). Returns the number
 * actually inserted so the campaign's `total_recipients` can be refreshed.
 */
export async function addCampaignRecipients(campaignId, recipients, db = DEFAULT_POOL) {
  const clean = [];
  const seen = new Set();
  for (const entry of recipients || []) {
    const email = String(entry?.email ?? entry ?? '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    clean.push({ email, name: entry?.name ?? null });
  }
  if (clean.length === 0) return 0;

  let inserted = 0;
  for (const entry of clean) {
    const row = await db.queryOne(
      `insert into public.campaign_recipients (id, campaign_id, email, name)
       values ($1, $2, $3, $4)
       on conflict (campaign_id, lower(email)) do nothing
       returning id`,
      [newId('recipient'), campaignId, entry.email, entry.name],
    );
    if (row) inserted += 1;
  }
  const total = await db.queryOne(
    'select count(*)::int as total from public.campaign_recipients where campaign_id = $1',
    [campaignId],
  );
  await db.query('update public.campaigns set total_recipients = $2 where id = $1', [
    campaignId,
    total?.total ?? 0,
  ]);
  return inserted;
}

export async function listCampaignRecipients(campaignId, { status = null, limit = 200, offset = 0 } = {}, db = DEFAULT_POOL) {
  const params = [campaignId];
  let filter = '';
  if (status) {
    params.push(status);
    filter = `and status = $${params.length}`;
  }
  params.push(limit, offset);
  return db.queryAll(
    `select id, campaign_id, email, name, status, message_id, error, sent_at, created_at
     from public.campaign_recipients
     where campaign_id = $1 ${filter}
     order by created_at asc limit $${params.length - 1} offset $${params.length}`,
    params,
  );
}

/**
 * Claim the next batch of pending recipients for sending by flipping them to
 * `sending`. `for update skip locked` keeps two workers from grabbing the same
 * recipient.
 */
export async function claimCampaignRecipients(campaignId, limit, db = DEFAULT_POOL) {
  return db.queryAll(
    `update public.campaign_recipients
     set status = 'sending'
     where id in (
       select id from public.campaign_recipients
       where campaign_id = $1 and status = 'pending'
       order by created_at asc limit $2
       for update skip locked
     )
     returning id, campaign_id, email, name, status`,
    [campaignId, limit],
  );
}

export async function markRecipientSent(id, messageId, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.campaign_recipients set status = 'sent', message_id = $2, sent_at = now()
     where id = $1 returning id, status, message_id, sent_at`,
    [id, messageId ?? null],
  );
}

export async function markRecipientFailed(id, error, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.campaign_recipients set status = 'failed', error = $2
     where id = $1 returning id, status, error`,
    [id, String(error ?? '').slice(0, 500)],
  );
}

export async function refreshCampaignCounts(campaignId, db = DEFAULT_POOL) {
  const counts = await db.queryOne(
    `select
       count(*) filter (where status = 'sent')::int as sent,
       count(*) filter (where status = 'failed')::int as failed,
       count(*) filter (where status in ('pending', 'sending'))::int as remaining,
       count(*)::int as total
     from public.campaign_recipients where campaign_id = $1`,
    [campaignId],
  );
  return db.queryOne(
    `update public.campaigns
     set sent_count = $2, failed_count = $3, total_recipients = $4
     where id = $1 returning ${CAMPAIGN_COLUMNS}`,
    [campaignId, counts?.sent ?? 0, counts?.failed ?? 0, counts?.total ?? 0],
  );
}

/** Campaigns whose scheduled time has arrived. */
export async function dueCampaigns({ limit = 10 } = {}, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${CAMPAIGN_COLUMNS} from public.campaigns
     where status = 'scheduled' and scheduled_for is not null and scheduled_for <= now()
     order by scheduled_for asc limit $1`,
    [limit],
  );
}
