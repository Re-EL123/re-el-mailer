/**
 * Workspaces, members and billing state.
 *
 * A workspace is the tenancy boundary. Mailboxes belong to a workspace,
 * membership grants access to it, and the subscription attached to it decides
 * what the workspace may do. This module owns the rows; the plan/entitlement
 * arithmetic lives in ../billing/plans.js and stays pure.
 */

import * as pool from './pool.js';
import { newId } from '../shared/ids.js';
import { slugify } from '../shared/sanitize.js';
import { AppError, Codes } from '../shared/errors.js';

const DEFAULT_POOL = pool;

export const WORKSPACE_ROLES = ['owner', 'admin', 'manager', 'member'];
const ROLE_RANK = { owner: 4, admin: 3, manager: 2, member: 1 };

/** True when `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role, minimum) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minimum] || 0);
}

const WORKSPACE_COLUMNS = `
  w.id, w.name, w.slug, w.owner_id, w.plan_id, w.status, w.is_default,
  w.created_at, w.updated_at
`;

// ─── Workspaces ──────────────────────────────────────────────────────────────

export async function getWorkspace(id, db = DEFAULT_POOL) {
  if (!id) return null;
  return db.queryOne(`select ${WORKSPACE_COLUMNS} from public.workspaces w where w.id = $1`, [id]);
}

export async function findDefaultWorkspaceForUser(userId, db = DEFAULT_POOL) {
  if (!userId) return null;
  return db.queryOne(
    `select ${WORKSPACE_COLUMNS} from public.workspaces w
     where w.owner_id = $1 and w.is_default
     order by w.created_at asc limit 1`,
    [userId],
  );
}

/** A unique slug the caller may retry on collision. */
function slugFor(name, ownerId) {
  const base = slugify(name) || 'workspace';
  return `${base}-${String(ownerId || newId('workspace')).slice(-6)}`;
}

export async function createWorkspace(
  { ownerId, name, slug, planId = 'solo', isDefault = false },
  db = DEFAULT_POOL,
) {
  const id = newId('workspace');
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new AppError(Codes.VALIDATION_ERROR, 'A workspace name is required.');

  return db.queryOne(
    `insert into public.workspaces (id, name, slug, owner_id, plan_id, is_default)
     values ($1, $2, $3, $4, $5, $6)
     returning ${WORKSPACE_COLUMNS.replace(/w\./g, '')}`,
    [id, cleanName, slug || slugFor(cleanName, ownerId), ownerId, planId, isDefault],
  );
}

/**
 * The user's default workspace, created on first use.
 *
 * Called on user creation and as a fallback so a user that predates the
 * workspace migration always has somewhere to put a mailbox.
 */
export async function ensureWorkspaceForUser(userId, { name } = {}, db = DEFAULT_POOL) {
  const existing = await findDefaultWorkspaceForUser(userId, db);
  if (existing) return existing;

  const workspace = await createWorkspace(
    { ownerId: userId, name: name || 'My workspace', planId: 'solo', isDefault: true },
    db,
  );
  await addMember(workspace.id, userId, 'owner', db);
  return workspace;
}

export async function updateWorkspace(id, patch = {}, db = DEFAULT_POOL) {
  const assignments = [];
  const params = [id];
  if (patch.name !== undefined) {
    params.push(String(patch.name).trim());
    assignments.push(`name = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    assignments.push(`status = $${params.length}`);
  }
  if (patch.planId !== undefined) {
    params.push(patch.planId);
    assignments.push(`plan_id = $${params.length}`);
  }
  if (assignments.length === 0) return getWorkspace(id, db);
  return db.queryOne(
    `update public.workspaces w set ${assignments.join(', ')} where w.id = $1
     returning ${WORKSPACE_COLUMNS.replace(/w\./g, '')}`,
    params,
  );
}

/** Workspaces the user belongs to, newest first, with their role and plan. */
export async function listWorkspacesForUser(userId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select ${WORKSPACE_COLUMNS}, m.role as member_role,
            (select count(*) from public.mailboxes mb where mb.workspace_id = w.id) as mailbox_count,
            (select count(*) from public.workspace_members mm where mm.workspace_id = w.id) as member_count,
            s.plan_id as subscription_plan, s.status as subscription_status
     from public.workspace_members m
     join public.workspaces w on w.id = m.workspace_id
     left join public.subscriptions s on s.workspace_id = w.id
     where m.user_id = $1
     order by w.is_default desc, w.created_at asc`,
    [userId],
  );
}

// ─── Members ─────────────────────────────────────────────────────────────────

export async function findMembership(workspaceId, userId, db = DEFAULT_POOL) {
  if (!workspaceId || !userId) return null;
  return db.queryOne(
    `select workspace_id, user_id, role, created_at
     from public.workspace_members
     where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId],
  );
}

export async function listMembers(workspaceId, db = DEFAULT_POOL) {
  return db.queryAll(
    `select m.user_id, m.role, m.created_at,
            u.email, u.display_name, u.status, u.role as platform_role, u.last_login_at
     from public.workspace_members m
     join public.users u on u.id = m.user_id
     where m.workspace_id = $1
     order by (m.role = 'owner') desc, u.display_name asc`,
    [workspaceId],
  );
}

export async function addMember(workspaceId, userId, role = 'member', db = DEFAULT_POOL) {
  return db.queryOne(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, $3)
     on conflict (workspace_id, user_id) do update set role = excluded.role
     returning workspace_id, user_id, role, created_at`,
    [workspaceId, userId, role],
  );
}

export async function updateMemberRole(workspaceId, userId, role, db = DEFAULT_POOL) {
  return db.queryOne(
    `update public.workspace_members set role = $3
     where workspace_id = $1 and user_id = $2
     returning workspace_id, user_id, role, created_at`,
    [workspaceId, userId, role],
  );
}

export async function removeMember(workspaceId, userId, db = DEFAULT_POOL) {
  const { rowCount } = await db.query(
    `delete from public.workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, userId],
  );
  return rowCount > 0;
}

export async function countMembers(workspaceId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as count from public.workspace_members where workspace_id = $1`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

const SUBSCRIPTION_COLUMNS = `
  id, workspace_id, plan_id, status, seats, provider, provider_ref,
  provider_customer, current_period_end, created_at, updated_at
`;

export async function getSubscription(workspaceId, db = DEFAULT_POOL) {
  if (!workspaceId) return null;
  return db.queryOne(
    `select ${SUBSCRIPTION_COLUMNS} from public.subscriptions where workspace_id = $1`,
    [workspaceId],
  );
}

export async function findSubscriptionByProviderRef(provider, providerRef, db = DEFAULT_POOL) {
  if (!providerRef) return null;
  return db.queryOne(
    `select ${SUBSCRIPTION_COLUMNS} from public.subscriptions
     where provider = $1 and provider_ref = $2`,
    [provider, providerRef],
  );
}

/**
 * Insert or update the subscription for a workspace. Only the keys present in
 * `patch` are written, so a webhook that only carries a status change cannot
 * blank the plan.
 */
export async function upsertSubscription(workspaceId, patch = {}, db = DEFAULT_POOL) {
  const columns = {
    planId: 'plan_id',
    status: 'status',
    seats: 'seats',
    provider: 'provider',
    providerRef: 'provider_ref',
    providerCustomer: 'provider_customer',
    currentPeriodEnd: 'current_period_end',
  };

  const insertCols = ['id', 'workspace_id'];
  const insertVals = ['$1', '$2'];
  const params = [newId('subscription'), workspaceId];
  const updates = [];

  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    insertCols.push(column);
    insertVals.push(`$${params.length}`);
    updates.push(`${column} = excluded.${column}`);
  }

  // plan_id is the one non-null column with no database default, so a partial
  // patch (e.g. a cancel that only sets a status) must still supply one on the
  // insert path. It is deliberately kept out of `updates`: if the caller did not
  // mention a plan, an existing paid plan must not be reset to the free one.
  if (!insertCols.includes('plan_id')) {
    params.push('solo');
    insertCols.push('plan_id');
    insertVals.push(`$${params.length}`);
  }

  return db.queryOne(
    `insert into public.subscriptions (${insertCols.join(', ')})
     values (${insertVals.join(', ')})
     on conflict (workspace_id) do update set ${updates.length ? updates.join(', ') : 'plan_id = public.subscriptions.plan_id'}
     returning ${SUBSCRIPTION_COLUMNS}`,
    params,
  );
}

// ─── Billing events (webhook idempotency) ────────────────────────────────────

/**
 * Record a provider event exactly once.
 *
 * @returns {Promise<{ inserted: boolean }>} false when the event was already
 *   seen, which the caller treats as "nothing to do".
 */
export async function recordBillingEvent({ provider, eventId, workspaceId = null, type = null, payload = {} }, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `insert into public.billing_events (id, provider, event_id, workspace_id, type, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (provider, event_id) do nothing
     returning id`,
    [newId('billingEvent'), provider, String(eventId), workspaceId, type, JSON.stringify(payload ?? {})],
  );
  return { inserted: Boolean(row) };
}

// ─── Usage counts for entitlement checks ─────────────────────────────────────

export async function countMailboxes(workspaceId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as count from public.mailboxes where workspace_id = $1 and status <> 'disabled'`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}

export async function countRules(workspaceId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as count
     from public.automation_rules r
     join public.mailboxes mb on mb.id = r.mailbox_id
     where mb.workspace_id = $1`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}

export async function countWebhooks(workspaceId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as count
     from public.webhook_endpoints we
     join public.mailboxes mb on mb.id = we.mailbox_id
     where mb.workspace_id = $1`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}

/** Outbound messages sent by the workspace since the start of the calendar month. */
export async function countOutboundThisMonth(workspaceId, db = DEFAULT_POOL) {
  const row = await db.queryOne(
    `select count(*)::int as count
     from public.messages m
     join public.mailboxes mb on mb.id = m.mailbox_id
     where mb.workspace_id = $1
       and m.direction = 'outbound'
       and m.sent_at >= date_trunc('month', now())`,
    [workspaceId],
  );
  return Number(row?.count ?? 0);
}
