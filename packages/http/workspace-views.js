/**
 * Shared workspace context for the workspace and billing endpoints.
 *
 * Both endpoints need the same three things — the workspace the caller is
 * acting in, its effective plan, and its current usage — so the assembly lives
 * here rather than being duplicated (and drifting) across two handlers.
 */

import { requireWorkspace } from '../auth/guard.js';
import {
  countMailboxes,
  countMembers,
  countOutboundThisMonth,
  countRules,
  countWebhooks,
  getSubscription,
  getWorkspace,
  listMembers,
} from '../db/workspaces.js';
import { effectivePlan, plan as planById, seatAllowance } from '../billing/plans.js';

/** Shape a workspace row for the client. */
export function workspaceView(row, { role = null } = {}) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.owner_id,
    domainId: row.domain_id ?? null,
    planId: row.plan_id,
    status: row.status,
    isDefault: Boolean(row.is_default),
    role: role ?? row.member_role ?? null,
    mailboxCount: row.mailbox_count === undefined ? undefined : Number(row.mailbox_count),
    memberCount: row.member_count === undefined ? undefined : Number(row.member_count),
    createdAt: row.created_at,
  };
}

/** Shape a member row for the client. */
export function memberView(row) {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    platformRole: row.platform_role,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

/** Shape a subscription row for the client. */
export function subscriptionView(row) {
  if (!row) return null;
  return {
    planId: row.plan_id,
    status: row.status,
    seats: Number(row.seats ?? 1),
    provider: row.provider,
    currentPeriodEnd: row.current_period_end,
    updatedAt: row.updated_at,
  };
}

/**
 * Load everything the client needs to render a workspace: the workspace, the
 * caller's role, the effective plan, and current usage vs limits.
 */
export async function loadWorkspaceContext(session, requestedId = null) {
  const { workspace, role } = await requireWorkspace(session, requestedId);
  const subscription = await getSubscription(workspace.id);

  const effective = subscription
    ? effectivePlan({ planId: subscription.plan_id, status: subscription.status })
    : planById(workspace.plan_id);

  const [members, mailboxes, sendsThisMonth, rules, webhooks] = await Promise.all([
    countMembers(workspace.id),
    countMailboxes(workspace.id),
    countOutboundThisMonth(workspace.id),
    countRules(workspace.id),
    countWebhooks(workspace.id),
  ]);

  return {
    workspace,
    role,
    subscription,
    effective,
    seats: seatAllowance(effective, subscription || {}),
    usage: { members, mailboxes, sendsThisMonth, rules, webhooks },
  };
}

/** Members list, shaped for the client. */
export async function membersFor(workspaceId) {
  return (await listMembers(workspaceId)).map(memberView);
}

/**
 * The effective plan behind a mailbox.
 *
 * A mailbox with no workspace is legacy/personal: it is treated as the free
 * plan but, because there is nothing to meter against, callers skip enforcement
 * when `workspaceId` is null. That keeps pre-migration rows and seeds working
 * while every real workspace mailbox is metered.
 */
export async function planForMailbox(mailbox) {
  if (!mailbox?.workspace_id) {
    return { effective: planById('solo'), subscription: null, workspaceId: null, seats: 1 };
  }
  const [workspace, subscription] = await Promise.all([
    getWorkspace(mailbox.workspace_id),
    getSubscription(mailbox.workspace_id),
  ]);
  const effective = subscription
    ? effectivePlan({ planId: subscription.plan_id, status: subscription.status })
    : planById(workspace?.plan_id || 'solo');
  return {
    effective,
    subscription,
    workspaceId: mailbox.workspace_id,
    seats: seatAllowance(effective, subscription || {}),
  };
}
