// @vitest-environment jsdom
/**
 * List actions end to end: real client -> real pipeline -> real handlers.
 *
 * The view layer is exercised in list-actions.test.js and compose-view.test.js,
 * so this file pins the part none of them reach: the wire contract between
 * apps/web/js/api.js and the /api/mail handlers, driven through the actual
 * createHandler pipeline with the DB boundary mocked.
 *
 * The case that matters most is mailbox scoping. Every mutating action reads
 * the mailbox from `ctx.query.mailboxId` (mailboxFor in api/mail.js). Several
 * client methods used to put mailboxId in the request BODY instead, where the
 * action schemas strip it — so on a multi-mailbox account, Star/Move/Trash on
 * the second mailbox silently resolved to the primary one, deleting nothing and
 * mis-scoping writes. These tests send the exact bytes api.js sends and assert
 * the handler resolves to the mailbox the user is looking at.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test@localhost:5432/test';
process.env.ALLOWED_ORIGINS = 'https://mailer.re-el.co.za';
process.env.APP_URL = 'https://mailer.re-el.co.za';
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.RESEND_API_KEY = 're_test_key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-value';
process.env.RATE_LIMIT_ENABLED = 'false';

const dbMessages = {
  findOwned: vi.fn(),
  update: vi.fn(),
  createMessage: vi.fn(),
  createAttachment: vi.fn(),
  moveToFolder: vi.fn(),
  destroy: vi.fn(),
  listAttachments: vi.fn(),
  setHasAttachments: vi.fn(),
};
const dbMailboxes = {
  findMailboxById: vi.fn(),
  listMailboxesForUser: vi.fn(),
  refreshMailboxUsage: vi.fn(),
  rememberContacts: vi.fn(),
  setMessageLabels: vi.fn(),
  listMessageLabels: vi.fn(),
  createLabel: vi.fn(),
  deleteLabel: vi.fn(),
  folderCounts: vi.fn(),
  listLabels: vi.fn(),
  listMessagesByLabel: vi.fn(),
  quotaStatus: vi.fn(),
  searchContacts: vi.fn(),
  updateLabel: vi.fn(),
};

const dbStorage = {
  createUploadUrl: vi.fn(),
  statAttachment: vi.fn(),
  deleteAttachments: vi.fn(),
};

const dbPool = { query: vi.fn(), queryAll: vi.fn() };

vi.mock('../packages/db/pool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: dbPool.query, queryAll: dbPool.queryAll };
});

vi.mock('../packages/db/messages.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...dbMessages };
});
vi.mock('../packages/db/mailboxes.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...dbMailboxes };
});
vi.mock('../packages/storage/attachments.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...dbStorage };
});

const requireSession = vi.fn();
const requireMailbox = vi.fn();
vi.mock('../packages/auth/guard.js', () => ({
  requireSession: (...a) => requireSession(...a),
  requireMailbox: (...a) => requireMailbox(...a),
  isManager: () => false,
  requireAdmin: () => {},
  clientIp: () => '127.0.0.1',
  userAgent: () => 'vitest',
  assertCanSend: () => {},
}));

import { AppError, Codes } from '../packages/shared/errors.js';

const MAILBOXES = {
  mbx_1: { id: 'mbx_1', email: 'one@re-el.co.za', user_id: 'usr_1', is_primary: true, status: 'active' },
  mbx_2: { id: 'mbx_2', email: 'two@re-el.co.za', user_id: 'usr_1', is_primary: false, status: 'active' },
};

/** A message row, snake_case, as the db layer really returns it. */
function row(over = {}) {
  return {
    id: 'msg_x',
    message_id: 'msg_x',
    thread_id: 'thr_1',
    direction: 'outbound',
    from_email: 'one@re-el.co.za',
    from_name: 'One',
    to_emails: [],
    cc_emails: [],
    subject: 'Hi',
    snippet: 's',
    folder: 'inbox',
    is_read: false,
    is_starred: false,
    is_draft: false,
    has_attachments: false,
    size_bytes: 0,
    priority: 'normal',
    delivery_status: null,
    sent_at: null,
    received_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...over,
  };
}

function makeRes() {
  const state = { statusCode: null, payload: null, headers: {} };
  return {
    state,
    setHeader(k, v) { state.headers[k] = v; },
    getHeader(k) { return state.headers[k]; },
    removeHeader(k) { delete state.headers[k]; },
    writeHead(code, headers) { state.statusCode = code; Object.assign(state.headers, headers); return this; },
    status(code) { state.statusCode = code; return this; },
    json(payload) { state.payload = JSON.stringify(payload); return this; },
    end(chunk) {
      state.payload = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
      return this;
    },
    write() { return true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

const mail = await import('../api/mail.js');
const { createHandler } = await import('../packages/http/pipeline.js');
const { api } = await import('../apps/web/js/api.js');

let handler;
let started = false;
function ensureHandler() {
  if (started) return handler;
  started = true;
  handler = createHandler({ name: 'mail', actions: mail.actions, audit: {} });
  return handler;
}

/** The fetch stub everything below runs on: api.js speaks to the real pipeline. */
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url), 'https://api.mail.re-el.co.za');
  const body = typeof opts.body === 'string' ? opts.body : null;
  const req = {
    method: (opts.method || 'GET').toUpperCase(),
    query: Object.fromEntries(u.searchParams),
    headers: {
      'content-type': opts.headers?.['Content-Type'] || (body ? 'application/json' : undefined),
      'content-length': body ? String(Buffer.byteLength(body)) : undefined,
    },
    body,
  };
  const res = makeRes();
  await ensureHandler()(req, res);
  const text = () => res.state.payload ?? '';
  return {
    ok: res.state.statusCode >= 200 && res.state.statusCode < 300,
    status: res.state.statusCode,
    text,
    json: async () => { try { return JSON.parse(res.state.payload); } catch { return null; } },
  };
};

beforeEach(() => {
  requireSession.mockReset();
  requireMailbox.mockReset();
  for (const fn of [...Object.values(dbMessages), ...Object.values(dbMailboxes), ...Object.values(dbStorage)]) {
    fn.mockReset().mockResolvedValue({});
  }
  dbPool.query.mockReset();
  dbPool.queryAll.mockReset();
  dbMessages.listAttachments.mockResolvedValue([]);

  requireSession.mockResolvedValue({ user: { id: 'usr_1', email: 'a@re-el.co.za', role: 'user', status: 'active' }, mailboxIds: ['mbx_1', 'mbx_2'] });
  requireMailbox.mockImplementation(async (session, requestedId) => {
    if (requestedId) {
      const mailbox = MAILBOXES[requestedId];
      if (!mailbox) throw new AppError(Codes.NOT_FOUND, 'Mailbox not found.');
      if (mailbox.user_id !== session.user.id) throw new AppError(Codes.MAILBOX_FORBIDDEN, undefined, 403);
      return mailbox;
    }
    return MAILBOXES.mbx_1;
  });
  // Rate-limiting is a rely-on-rows count; the only direct-SQL insert we reach
  // is the attachment record, which every downstream shape depends on.
  dbPool.query.mockImplementation(async (statement) => {
    if (typeof statement === 'string' && statement.includes('insert into public.attachments')) {
      return {
        id: 'att_1',
        message_id: 'draft_1',
        mailbox_id: 'mbx_2',
        filename: 'f.txt',
        mime_type: 'text/plain',
        size_bytes: 3,
        storage_bucket: 'x',
        storage_path: '/x',
        content_id: null,
        inline: false,
      };
    }
    return { count: 1 };
  });
  dbPool.queryAll.mockResolvedValue([]);
});

describe('mail mutations reach the right mailbox', () => {
  it('Star uses the active mailbox, not the default', async () => {
    dbMessages.update.mockResolvedValue(row({ mailbox_owner: 'mbx_2' }));
    await api.mail.star(['msg_x'], true, 'mbx_2');
    expect(dbMessages.update).toHaveBeenCalledWith('msg_x', 'mbx_2', { isStarred: true });
  });

  it('Archive and Trash move within the active mailbox', async () => {
    dbMessages.moveToFolder.mockResolvedValue({ rowCount: 1 });
    await api.mail.move(['msg_x'], 'archive', 'mbx_2');
    expect(dbMessages.moveToFolder).toHaveBeenCalledWith(['msg_x'], 'mbx_2', 'archive');
    dbMessages.moveToFolder.mockClear();
    await api.mail.trash(['msg_x'], 'mbx_2');
    expect(dbMessages.moveToFolder).toHaveBeenCalledWith(['msg_x'], 'mbx_2', 'trash');
  });

  it('markRead scopes to the active mailbox', async () => {
    dbMessages.update.mockResolvedValue(row());
    await api.mail.markRead(['msg_x'], false, 'mbx_2');
    expect(dbMessages.update).toHaveBeenCalledWith('msg_x', 'mbx_2', { isRead: false });
  });

  it('Delete forever removes rows only from the active mailbox', async () => {
    dbMessages.findOwned.mockResolvedValue(row());
    dbMessages.destroy.mockResolvedValue(true);
    await api.mail.deleteForever(['msg_x'], 'mbx_2');
    expect(dbMessages.findOwned).toHaveBeenCalledWith('msg_x', 'mbx_2');
    expect(dbMessages.destroy).toHaveBeenCalledWith('msg_x', 'mbx_2');
  });

  it('setLabels checks ownership in the active mailbox', async () => {
    dbMessages.findOwned.mockResolvedValue(row());
    await api.mail.setLabels(['msg_x'], ['lbl_1'], 'mbx_2');
    expect(dbMessages.findOwned).toHaveBeenCalledWith('msg_x', 'mbx_2');
    expect(dbMailboxes.setMessageLabels).toHaveBeenCalledWith('msg_x', ['lbl_1']);
  });
});

describe('drafts and attachments resolve their mailbox too', () => {
  it('a draft saved on a non-primary mailbox lands there', async () => {
    dbMessages.createMessage.mockResolvedValue(
      row({ id: 'draft_1', folder: 'drafts', is_draft: true }),
    );
    const out = await api.mail.saveDraft({ mailboxId: 'mbx_2', to: 'two@re-el.co.za', subject: 'D' });
    expect(out.draft.id).toBe('draft_1');
    expect(dbMessages.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mailboxId: 'mbx_2', folder: 'drafts' }),
    );
  });

  it('attachment-upload-url issues a ticket against the right mailbox', async () => {
    dbMessages.findOwned.mockResolvedValue(row({ id: 'draft_1', folder: 'drafts', is_draft: true }));
    dbStorage.createUploadUrl.mockResolvedValue({ url: 'https://bucket/x', path: '/x', expiresIn: 300 });
    await api.mail.attachmentUploadUrl({ draftId: 'draft_1', filename: 'f.txt', mimeType: 'text/plain', size: 3, mailboxId: 'mbx_2' });
    expect(dbStorage.createUploadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ mailboxId: 'mbx_2', messageId: 'draft_1' }),
    );
  });

  it('attachment-complete records the object against the right mailbox', async () => {
    dbMessages.findOwned.mockResolvedValue(row({ id: 'draft_1', folder: 'drafts', is_draft: true }));
    dbStorage.statAttachment.mockResolvedValue({ size: 3, contentType: 'text/plain' });
    dbMessages.createAttachment.mockResolvedValue({ id: 'att_1', filename: 'f.txt', mime_type: 'text/plain', size_bytes: 3 });
    await api.mail.attachmentComplete({ draftId: 'draft_1', attachmentId: 'att_1', filename: 'f.txt', mimeType: 'text/plain', mailboxId: 'mbx_2' });
    expect(dbMessages.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ mailboxId: 'mbx_2', messageId: 'draft_1' }),
    );
  });

  it('setting a label on a message the user owns elsewhere still works (no mailbox mixes)', async () => {
    dbMessages.findOwned.mockResolvedValue(null);
    await expect(api.mail.setLabels(['msg_x'], ['lbl_1'], 'mbx_2')).rejects.toThrow(/Message not found/);
    expect(dbMessages.destroy).not.toHaveBeenCalled();
  });
});