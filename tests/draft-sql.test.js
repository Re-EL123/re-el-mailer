/**
 * Draft saves.
 *
 * The draft update in api/mail.js addressed a column called `references`, which
 * is both the wrong name and a reserved word in Postgres: the real column is
 * `references_text`. Postgres rejected the statement with
 *
 *   syntax error at or near "references"   (SQLSTATE 42601)
 *
 * before any row was touched, so *every* save of an existing draft failed —
 * opening a draft and closing it without edits was enough. Nothing in the test
 * suite exercised that branch, because the draft tests only ever created new
 * drafts, which take the INSERT path.
 *
 * These tests pin the statement so the reserved word cannot come back, and pin
 * the header-list encoding so a saved draft round-trips in the same shape
 * createMessage() writes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const queryAll = vi.fn();

vi.mock('../packages/db/pool.js', () => ({
  query: (...a) => query(...a),
  queryAll: (...a) => queryAll(...a),
  default: { query: (...a) => query(...a), queryAll: (...a) => queryAll(...a) },
}));

vi.mock('../packages/db/messages.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findOwned: vi.fn(async () => ({
      id: 'msg_draft_1',
      mailbox_id: 'mbx_1',
      folder: 'drafts',
      is_draft: true,
      subject: 'old',
    })),
    createMessage: vi.fn(async () => ({ id: 'msg_new' })),
  };
});

vi.mock('../packages/db/mailboxes.js', () => ({
  findMailboxById: vi.fn(async () => ({ id: 'mbx_1', email: 'info@re-el.co.za', status: 'active' })),
  listMailboxesForUser: vi.fn(async () => []),
  countMailboxStorage: vi.fn(async () => ({ used: 0 })),
  rememberContacts: vi.fn(async () => {}),
}));

vi.mock('../packages/auth/guard.js', () => ({
  requireMailbox: vi.fn(async () => ({
    id: 'mbx_1',
    email: 'info@re-el.co.za',
    display_name: 'Info',
    status: 'active',
    signature_html: null,
    signature_text: null,
    auto_read: false,
  })),
  assertCanSend: vi.fn(),
}));

function ctx(body) {
  return {
    body,
    query: {},
    headers: {},
    session: { user: { id: 'usr_1', role: 'admin' }, claims: {}, mailboxId: 'mbx_1' },
    log: { info: vi.fn(), warn: vi.fn() },
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  };
}

async function saveDraft(body) {
  const mod = await import('../api/mail.js');
  return mod.actions.draft.handler(ctx(body));
}

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
  query.mockResolvedValue({ rowCount: 1 });
});

describe('saving an existing draft', () => {
  it('writes references_text, not the reserved word', async () => {
    await saveDraft({
      id: 'msg_draft_1',
      to: ['someone@example.com'],
      subject: 'Hello',
      references: ['<a@x>', '<b@x>'],
    });

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/references_text\s*=\s*\$7/);
    // A bare `references =` is the exact statement Postgres refused.
    expect(sql).not.toMatch(/(^|[\s,(])references\s*=/);
  });

  it('stores the header list as one space-separated string', async () => {
    await saveDraft({
      id: 'msg_draft_1',
      to: ['someone@example.com'],
      subject: 'Hello',
      references: ['<a@x>', '<b@x>'],
    });

    const [, params] = query.mock.calls[0];
    expect(params[6]).toBe('<a@x> <b@x>');
  });

  it('keeps an absent header list null rather than an empty string', async () => {
    await saveDraft({ id: 'msg_draft_1', to: ['a@b.co'], subject: 'Hi' });
    const [, params] = query.mock.calls[0];
    expect(params[6]).toBeNull();
  });

  it('never sends an array into a text column', async () => {
    await saveDraft({
      id: 'msg_draft_1',
      to: ['a@b.co'],
      subject: 'Hi',
      references: ['<a@x>'],
    });
    const [, params] = query.mock.calls[0];
    expect(Array.isArray(params[6])).toBe(false);
  });
});