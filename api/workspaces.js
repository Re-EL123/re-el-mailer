/**
 * /api/workspaces — the tenancy boundary.
 *
 *   current · list · get · create · update · members ·
 *   add-member · update-member · remove-member · plans
 *
 * A workspace owns mailboxes and has members with roles. Membership is the
 * access control: `requireWorkspace` proves the caller belongs, and
 * `requireWorkspaceRole('admin')` gates the mutations. Seat entitlement is
 * enforced on add-member so a workspace cannot exceed what it has bought.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { requireWorkspace, requireWorkspaceRole, assertEntitlement } from '../packages/auth/guard.js';
import {
  addMember,
  createWorkspace,
  findMembership,
  listWorkspacesForUser,
  removeMember,
  roleAtLeast,
  updateMemberRole,
  updateWorkspace,
} from '../packages/db/workspaces.js';
import { findByEmail, findById } from '../packages/db/users.js';
import { billing as billingConfig } from '../packages/shared/config.js';
import { entitlement, planList } from '../packages/billing/plans.js';
import { billingProvider } from '../packages/billing/provider.js';
import {
  loadWorkspaceContext,
  memberView,
  membersFor,
  subscriptionView,
  workspaceView,
} from '../packages/http/workspace-views.js';
import {
  idSchema,
  workspaceCreateSchema,
  workspaceMemberSchema,
  workspaceMemberUpdateSchema,
  workspaceUpdateSchema,
} from '../packages/validation/schemas.js';

/** Owners currently in the workspace, used to protect the last one. */
function ownerCount(members) {
  return members.filter((member) => member.role === 'owner').length;
}

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
  create: { action: 'workspace.create', entityType: 'workspace', entityId: (data) => data?.workspace?.id ?? null },
  update: { action: 'workspace.update', entityType: 'workspace', entityId: (data) => data?.workspace?.id ?? null },
  'add-member': { action: 'workspace.member.add', entityType: 'workspace', entityId: (data) => data?.member?.userId ?? null },
  'update-member': { action: 'workspace.member.update', entityType: 'workspace', entityId: (data) => data?.member?.userId ?? null },
  'remove-member': { action: 'workspace.member.remove', entityType: 'workspace', entityId: (_data, context) => context.query.userId ?? null },
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
      workspaces: (await listWorkspacesForUser(ctx.session.user.id)).map((row) =>
        workspaceView(row, { role: row.member_role }),
      ),
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

  // ── Mutations ───────────────────────────────────────────────────────────
  create: {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: workspaceCreateSchema,
    handler: async (ctx) => {
      const workspace = await createWorkspace({
        ownerId: ctx.session.user.id,
        name: ctx.body.name,
        planId: 'solo',
        isDefault: false,
      });
      await addMember(workspace.id, ctx.session.user.id, 'owner');
      return { workspace: workspaceView(workspace, { role: 'owner' }) };
    },
  },

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

  'add-member': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: workspaceMemberSchema.extend({ workspaceId: idSchema.optional() }),
    handler: async (ctx) => {
      const workspaceId = String(ctx.body.workspaceId || ctx.query.id || '').trim();
      const context = await loadWorkspaceContext(ctx.session, workspaceId || null);
      if (!roleAtLeast(context.role, 'admin') && ctx.session.user.role !== 'admin') {
        throw new AppError(Codes.FORBIDDEN, 'Only an admin can add members.', 403);
      }

      // Resolve the invitee: an existing account by id or email. New accounts
      // are provisioned by an admin first (they need a mailbox and domain).
      let user = ctx.body.userId ? await findById(ctx.body.userId) : null;
      if (!user && ctx.body.email) user = await findByEmail(ctx.body.email);
      if (!user) {
        throw new AppError(
          Codes.NOT_FOUND,
          'No account with that address. Create the user in Admin first.',
        );
      }

      // Seat entitlement is only spent when a genuinely new member is added.
      const existing = await findMembership(context.workspace.id, user.id);
      if (!existing) {
        assertEntitlement(
          entitlement({
            plan: context.effective,
            used: context.usage.members,
            limit: context.seats,
            key: 'seats',
          }),
        );
      }

      // Only an owner/admin may grant owner or admin.
      const requestedRole = ctx.body.role || 'member';
      if (
        roleAtLeast(requestedRole, 'admin') &&
        !roleAtLeast(context.role, 'admin') &&
        ctx.session.user.role !== 'admin'
      ) {
        throw new AppError(Codes.FORBIDDEN, 'Only an admin can grant that role.', 403);
      }

      const member = await addMember(context.workspace.id, user.id, requestedRole);
      return {
        member: memberView({
          ...member,
          email: user.email,
          display_name: user.display_name,
          status: user.status,
        }),
      };
    },
  },

  'update-member': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: workspaceMemberUpdateSchema.extend({ workspaceId: idSchema.optional() }),
    handler: async (ctx) => {
      const workspaceId = String(ctx.body.workspaceId || ctx.query.id || '').trim();
      const context = await loadWorkspaceContext(ctx.session, workspaceId || null);

      const members = await membersFor(context.workspace.id);
      const target = members.find((member) => member.userId === ctx.body.userId);
      if (!target) throw new AppError(Codes.NOT_FOUND, 'That person is not a member.');

      if (!roleAtLeast(context.role, 'admin') && ctx.session.user.role !== 'admin') {
        throw new AppError(Codes.FORBIDDEN, 'Only an admin can change roles.', 403);
      }
      // Do not strand the workspace without an owner.
      if (target.role === 'owner' && ctx.body.role !== 'owner' && ownerCount(members) <= 1) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Promote another owner first.');
      }
      // Cannot grant a role higher than your own.
      if (
        roleAtLeast(ctx.body.role, 'admin') &&
        !roleAtLeast(context.role, 'admin') &&
        ctx.session.user.role !== 'admin'
      ) {
        throw new AppError(Codes.FORBIDDEN, 'Only an admin can grant that role.', 403);
      }

      const updated = await updateMemberRole(context.workspace.id, ctx.body.userId, ctx.body.role);
      return {
        member: memberView({
          ...updated,
          email: target.email,
          display_name: target.displayName,
          status: target.status,
        }),
      };
    },
  },

  'remove-member': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const workspaceId = String(ctx.query.id || ctx.query.workspaceId || '').trim();
      const userId = String(ctx.query.userId || '').trim();
      if (!userId) throw new AppError(Codes.VALIDATION_ERROR, 'A member id is required.');

      const context = await loadWorkspaceContext(ctx.session, workspaceId || null);
      if (!roleAtLeast(context.role, 'admin') && ctx.session.user.role !== 'admin') {
        throw new AppError(Codes.FORBIDDEN, 'Only an admin can remove members.', 403);
      }

      const members = await membersFor(context.workspace.id);
      const target = members.find((member) => member.userId === userId);
      if (!target) throw new AppError(Codes.NOT_FOUND, 'That person is not a member.');
      if (target.role === 'owner' && ownerCount(members) <= 1) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Promote another owner first.');
      }

      await removeMember(context.workspace.id, userId);
      return { removed: true };
    },
  },
};

export default createHandler({
  name: 'workspaces',
  audit: AUDIT_ACTIONS,
  actions,
});
