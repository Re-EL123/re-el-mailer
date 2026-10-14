/**
 * /api/workspaces — the organisation boundary.
 *
 *   current · list · get · update · members · plans
 *
 * A workspace is a domain (organisation): it owns the domain's mailboxes and
 * carries the subscription that decides what the organisation may do. Only a
 * platform administrator may change it — a workspace is not a thing a user
 * creates or invites people into. The people in a workspace are simply the users
 * with a mailbox on the domain; see ../packages/db/workspaces.js.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { requireWorkspace, requireWorkspaceRole } from '../packages/auth/guard.js';
import { listWorkspacesForUser, updateWorkspace } from '../packages/db/workspaces.js';
import { billing as billingConfig } from '../packages/shared/config.js';
import { planList } from '../packages/billing/plans.js';
import { billingProvider } from '../packages/billing/provider.js';
import {
  loadWorkspaceContext,
  membersFor,
  subscriptionView,
  workspaceView,
} from '../packages/http/workspace-views.js';
import { idSchema, workspaceUpdateSchema } from '../packages/validation/schemas.js';

/** Full detail payload for one workspace. */
async function detail(session, requestedId) {
  const context = await loadWorkspaceContext(session, requestedId);
  const provider = billingProvider();
  return {
    workspace: workspaceView(context.workspace, { role: context.role }),
    role: context.role,
    plan: context.effective,
    subscription: subscriptionView(context.subscription),
    seats: context.seats,
    usage: context.usage,
    members: await membersFor(context.workspace.id),
    billing: { configured: provider.configured, provider: provider.name, currency: billingConfig.currency() },
  };
}

const AUDIT_ACTIONS = {
  update: { action: 'workspace.update', entityType: 'workspace', entityId: (data) => data?.workspace?.id ?? null },
};

export const actions = {
  // ── Read ────────────────────────────────────────────────────────────────
  current: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => detail(ctx.session, ctx.query.id || ctx.query.workspaceId || null),
  },

  list: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => ({
      workspaces: (
        await listWorkspacesForUser(ctx.session.user.id, { isAdmin: ctx.session.user.role === 'admin' })
      ).map((row) => workspaceView(row, { role: row.member_role })),
    }),
  },

  get: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A workspace id is required.');
      return detail(ctx.session, id);
    },
  },

  plans: {
    method: 'GET',
    auth: 'session',
    handler: async () => ({ plans: planList() }),
  },

  // ── Mutations (administrators only) ─────────────────────────────────────
  update: {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: workspaceUpdateSchema.extend({ id: idSchema }),
    handler: async (ctx) => {
      const { workspace, role } = await requireWorkspaceRole(ctx.session, ctx.body.id, 'admin');

      const patch = {};
      if (ctx.body.name !== undefined) patch.name = ctx.body.name;
      if (ctx.body.planId !== undefined) {
        // A paid plan is normally granted by the billing webhook, never set by
        // hand. Only a self-hosted deployment (no billing provider) may switch
        // plans directly, so a customer cannot promote themselves for free.
        if (billingConfig.provider() !== 'none' && ctx.session.user.role !== 'admin') {
          throw new AppError(Codes.FORBIDDEN, 'Change your plan through billing, not directly.', 403);
        }
        patch.planId = ctx.body.planId;
      }

      const updated = await updateWorkspace(workspace.id, patch);
      return { workspace: workspaceView(updated, { role }) };
    },
  },

  members: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const { workspace } = await requireWorkspace(ctx.session, ctx.query.id || null);
      return { members: await membersFor(workspace.id) };
    },
  },
};

export default createHandler({
  name: 'workspaces',
  audit: AUDIT_ACTIONS,
  actions,
});
