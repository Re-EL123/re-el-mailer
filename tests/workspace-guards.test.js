/**
 * Workspace access guards.
 *
 * These decide whether a caller may act in a workspace and at what role, and
 * whether a mailbox is reachable. The load-bearing rules are that a non-member is
 * refused, a platform admin is not, and a legacy mailbox with no workspace stays
 * owner-only so tenancy changes cannot silently widen access to old data.
 *
 * The database boundary is mocked; `roleAtLeast` is the real implementation so
 * the ranking itself is exercised.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
process.env.JWT_SECRET = 'x'.repeat(48);

const db = {
  listWorkspacesForUser: vi.fn(),
  getWorkspace: vi.fn(),
  findWorkspaceForUser: vi.fn(),
  userInWorkspace: vi.fn(),
};

vi.mock('../packages/db/workspaces.js', async (io) => ({
  ...(await io()),
  ...db,
}));

const mailboxesDb = {
  findMailboxById: vi.fn(),
  listMailboxesForUser: vi.fn(),
};
vi.mock('../packages/db/mailboxes.js', async (io) => ({ ...(await io()), ...mailboxesDb }));

vi.mock('../packages/db/users.js', async (io) => ({ ...(await io()) }));
vi.mock('../packages/db/system.js', async (io) => ({ ...(await io()) }));

const { requireMailbox, requireWorkspace, requireWorkspaceRole, assertEntitlement } = await import(
  '../packages/auth/guard.js'
);

const user = (over = {}) => ({ id: 'usr_1', role: 'user', status: 'active', ...over });
const session = (u = user()) => ({ user: u });
const workspace = (over = {}) => ({ id: 'wsp_1', owner_id: 'usr_1', name: 'Team', ...over });

beforeEach(() => {
  Object.values(db).forEach((fn) => fn.mockReset());
  Object.values(mailboxesDb).forEach((fn) => fn.mockReset());
});

describe('requireWorkspace', () => {
  it('resolves the workspace when none is named', async () => {
    db.listWorkspacesForUser.mockResolvedValue([
      { id: 'wsp_1', member_role: 'admin' },
    ]);
    const resolved = await requireWorkspace(session());
    expect(resolved.workspace.id).toBe('wsp_1');
    expect(resolved.role).toBe('admin');
  });

  it('forbids a non-admin with no workspace', async () => {
    db.listWorkspacesForUser.mockResolvedValue([]);
    await expect(requireWorkspace(session())).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a non-member of a named workspace', async () => {
    db.getWorkspace.mockResolvedValue(workspace());
    db.userInWorkspace.mockResolvedValue(false);
    await expect(requireWorkspace(session(), 'wsp_1')).rejects.toMatchObject({ status: 403 });
  });

  it('lets a platform admin administer any workspace', async () => {
    db.getWorkspace.mockResolvedValue(workspace({ owner_id: 'someone_else' }));
    const resolved = await requireWorkspace(session(user({ role: 'admin' })), 'wsp_1');
    expect(resolved.role).toBe('owner');
  });

  it('404s an unknown workspace', async () => {
    db.getWorkspace.mockResolvedValue(null);
    await expect(requireWorkspace(session(), 'wsp_missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('requireWorkspaceRole', () => {
  it('lets a platform admin pass when resolving a workspace', async () => {
    db.getWorkspace.mockResolvedValue(workspace({ owner_id: 'other' }));
    db.userInWorkspace.mockResolvedValue(true);
    const resolved = await requireWorkspaceRole(session(user({ role: 'admin' })), 'wsp_1', 'admin');
    expect(resolved.role).toBe('owner');
  });



  it('allows a platform admin to manage a workspace', async () => {
    db.getWorkspace.mockResolvedValue(workspace({ owner_id: 'other' }));
    db.userInWorkspace.mockResolvedValue(false);
    const resolved = await requireWorkspaceRole(session(user({ role: 'admin' })), 'wsp_1', 'admin');
    expect(resolved.role).toBe('owner');
  });

  it('refuses a non-admin from managing a workspace', async () => {
    db.getWorkspace.mockResolvedValue(workspace({ owner_id: 'other' }));
    db.userInWorkspace.mockResolvedValue(true);
    await expect(requireWorkspaceRole(session(), 'wsp_1', 'admin')).rejects.toMatchObject({ status: 403 });
  });
});

describe('requireMailbox tenancy', () => {
  it('allows the owner of a legacy mailbox', async () => {
    mailboxesDb.findMailboxById.mockResolvedValue({ id: 'mbx_1', user_id: 'usr_1', workspace_id: null, status: 'active' });
    const mailbox = await requireMailbox(session(), 'mbx_1');
    expect(mailbox.id).toBe('mbx_1');
  });

  it('keeps a legacy mailbox owner-only', async () => {
    mailboxesDb.findMailboxById.mockResolvedValue({ id: 'mbx_1', user_id: 'other', workspace_id: null, status: 'active' });
    await expect(requireMailbox(session(), 'mbx_1')).rejects.toMatchObject({ status: 403 });

  });

  it('still refuses a non-owner even if workspace-attached (owner-only)', async () => {
    mailboxesDb.findMailboxById.mockResolvedValue({ id: 'mbx_1', user_id: 'other', workspace_id: 'wsp_1', status: 'active' });
    await expect(requireMailbox(session(), 'mbx_1')).rejects.toMatchObject({ status: 403 });
  });

  it('keeps refusing a non-owner of a workspace mailbox', async () => {
    mailboxesDb.findMailboxById.mockResolvedValue({ id: 'mbx_1', user_id: 'other', workspace_id: 'wsp_1', status: 'active' });
    await expect(requireMailbox(session(), 'mbx_1')).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertEntitlement', () => {
  it('passes an allowed decision through', () => {
    const decision = { allowed: true };
    expect(assertEntitlement(decision)).toBe(decision);
  });

  it('refuses a disallowed decision with the plan reason and a 402', () => {
    expect(() => assertEntitlement({ allowed: false, reason: 'Team includes 10 seats.' })).toThrowError(
      'Team includes 10 seats.',
    );
    try {
      assertEntitlement({ allowed: false, reason: 'no' });
    } catch (err) {
      expect(err.status).toBe(402);
    }
  });
});
