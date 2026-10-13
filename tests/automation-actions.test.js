// @vitest-environment jsdom
/**
 * Automation API actions, driven through the real createHandler pipeline with
 * the database boundary mocked.
 *
 * The distinct thing this covers is that the new endpoints live on existing
 * functions (api/mail.js and api/send.js) and resolve their mailbox exactly like
 * the reader does — a template or a rule saved from the second mailbox must not
 * land on the primary one.
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

const dbAutomation = {
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  getTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  listRules: vi.fn(),
  createRule: vi.fn(),
  getRule: vi.fn(),
  activeRulesFor: vi.fn(),
  listNotes: vi.fn(),
  createNote: vi.fn(),
  listNotifications: vi.fn(),
  countUnreadNotifications: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  listWebhookEndpoints: vi.fn(),
  createWebhookEndpoint: vi.fn(),
  listCampaigns: vi.fn(),
  getCampaign: vi.fn(),
  createCampaign: vi.fn(),
  addCampaignRecipients: vi.fn(),
  refreshCampaignCounts: vi.fn(),
  listCampaignRecipients: vi.fn(),
};

const dbMessages = { findOwned: vi.fn() };
const dbMailboxes = { listMailboxesForUser: vi.fn() };
const dbUsers = { listUsers: vi.fn() };
const mailAutomation = {
  dispatchEvent: vi.fn(),
  runDueJobs: vi.fn(),
  startDueCampaigns: vi.fn(),
  processCampaign: vi.fn(),
  runInboundAutomation: vi.fn(),
  runAutoReply: vi.fn(),
};

const dbPool = { query: vi.fn(), queryAll: vi.fn(), queryOne: vi.fn() };

vi.mock('../packages/db/pool.js', async (io) => ({ ...(await io()), ...dbPool }));
vi.mock('../packages/db/messages.js', async (io) => ({ ...(await io()), ...dbMessages }));
vi.mock('../packages/db/mailboxes.js', async (io) => ({ ...(await io()), ...dbMailboxes }));
vi.mock('../packages/db/users.js', async (io) => ({ ...(await io()), ...dbUsers }));
vi.mock('../packages/db/automation.js', async (io) => ({ ...(await io()), ...dbAutomation }));
vi.mock('../packages/mail/automation.js', async (io) => ({ ...(await io()), ...mailAutomation }));

const requireSession = vi.fn();
const requireMailbox = vi.fn();
const isManager = vi.fn(() => false);
vi.mock('../packages/auth/guard.js', () => ({
  requireSession: (...a) => requireSession(...a),
  requireMailbox: (...a) => requireMailbox(...a),
  assertCanSend: (m) => m,
  isManager: (...a) => isManager(...a),
  requireAdmin: () => {},
  requireRole: () => {},
  clientIp: () => '127.0.0.1',
  userAgent: () => 'vitest',
}));

const MAILBOXES = {
  mbx_1: { id: 'mbx_1', email: 'one@re-el.co.za', display_name: 'One', user_id: 'usr_1', is_primary: true, status: 'active' },
  mbx_2: { id: 'mbx_2', email: 'two@re-el.co.za', display_name: 'Two', user_id: 'usr_1', is_primary: false, status: 'active', auto_reply_enabled: false, auto_reply_interval_min: 1440 },
};

const templateRow = (over = {}) => ({
  id: 'tpl_1', mailbox_id: 'mbx_2', name: 'Thank You', slug: 'thank-you', subject: 'Thanks', body_html: null, body_text: 'Hi', sort_order: 0, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
});
const ruleRow = (over = {}) => ({
  id: 'rul_1', mailbox_id: 'mbx_2', name: 'Invoices', description: null, is_active: true,
  conditions: { match: 'all', conditions: [] }, actions: [], direction: 'inbound', stop_processing: false,
  run_order: 100, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
});
const campaignRow = (over = {}) => ({
  id: 'cmp_1', mailbox_id: 'mbx_2', name: 'News', subject: 'Hello', body_html: null, body_text: 'Hi',
  status: 'draft', scheduled_for: null, batch_size: 50, total_recipients: 0, sent_count: 0, failed_count: 0,
  created_at: '2026-01-01', updated_at: '2026-01-01', started_at: null, completed_at: null, ...over,
});

function makeRes() {
  const state = { statusCode: null, payload: null, headers: {} };
  return {
    state,
    setHeader(k, v) { state.headers[k] = v; },
    getHeader(k) { return state.headers[k]; },
    removeHeader(k) { delete state.headers[k]; },
    writeHead(code, headers) { state.statusCode = code; Object.assign(state.headers, headers); return this; },
    status(code) { state.statusCode = code; return this; },
    json(p) { state.payload = JSON.stringify(p); return this; },
    end(chunk) { state.payload = typeof chunk === 'string' ? chunk : JSON.stringify(chunk); return this; },
    write() { return true; },
    on() { return this; },
    once() { return this; },
    emit() { return false; },
  };
}

const mail = await import('../api/mail.js');
const send = await import('../api/send.js');

const handlers = { mail: mail.default, send: send.default };

function call(fn, action, { method = 'GET', body = null, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : null;
  const req = {
    method,
    query: { action, ...query },
    headers: {
      'content-type': raw ? 'application/json' : undefined,
      'content-length': raw ? String(Buffer.byteLength(raw)) : undefined,
    },
    body: raw,
  };
  const res = makeRes();
  return Promise.resolve(handlers[fn](req, res)).then(() => {
    let data = null;
    try { data = JSON.parse(res.state.payload); } catch { data = res.state.payload; }
    return { status: res.state.statusCode, body: data };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isManager.mockReturnValue(false);
  requireSession.mockResolvedValue({ user: { id: 'usr_1', email: 'a@re-el.co.za', role: 'user', status: 'active' } });
  requireMailbox.mockImplementation(async (session, requestedId) => {
    const mailbox = MAILBOXES[requestedId || 'mbx_1'];
    if (!mailbox) {
      const { AppError, Codes } = await import('../packages/shared/errors.js');
      throw new AppError(Codes.NOT_FOUND, 'Mailbox not found.');
    }
    return mailbox;
  });
  dbAutomation.listTemplates.mockResolvedValue([]);
  dbAutomation.listRules.mockResolvedValue([]);
  dbAutomation.listNotifications.mockResolvedValue([]);
  dbAutomation.countUnreadNotifications.mockResolvedValue(0);
  dbAutomation.listCampaigns.mockResolvedValue([]);
  dbMessages.findOwned.mockResolvedValue({ id: 'msg_1' });
  dbPool.query.mockResolvedValue({ rowCount: 1 });
  dbPool.queryAll.mockResolvedValue([]);
});

describe('automation actions resolve the active mailbox', () => {
  it('templates are listed for the mailbox named in the query', async () => {
    dbAutomation.listTemplates.mockResolvedValue([templateRow()]);
    const { status, body } = await call('mail', 'templates', { query: { mailboxId: 'mbx_2' } });
    expect(status).toBe(200);
    expect(dbAutomation.listTemplates).toHaveBeenCalledWith('mbx_2');
    expect(body.data.templates[0]).toMatchObject({ id: 'tpl_1', sortOrder: 0, bodyText: 'Hi' });
  });

  it('create-template stores against the active mailbox with camelCase mapped back', async () => {
    dbAutomation.createTemplate.mockResolvedValue(templateRow());
    const { status, body } = await call('mail', 'create-template', {
      method: 'POST',
      query: { mailboxId: 'mbx_2' },
      body: { name: 'Thank You', subject: 'Thanks', bodyText: 'Hi' },
    });
    expect(status).toBe(200);
    expect(dbAutomation.createTemplate).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'mbx_2', name: 'Thank You' }));
    expect(body.data.template.id).toBe('tpl_1');
  });

  it('create-rule validates its body and returns the shaped rule', async () => {
    dbAutomation.createRule.mockResolvedValue(ruleRow());
    const { status, body } = await call('mail', 'create-rule', {
      method: 'POST',
      query: { mailboxId: 'mbx_2' },
      body: { name: 'Invoices', conditions: { match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }] }, actions: [{ type: 'mark_read' }] },
    });
    expect(status).toBe(200);
    expect(dbAutomation.createRule).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'mbx_2', name: 'Invoices' }));
    expect(body.data.rule).toMatchObject({ id: 'rul_1', isActive: true, runOrder: 100 });
  });

  it('rejects a rule with no name (validation runs before the handler)', async () => {
    const { status } = await call('mail', 'create-rule', { method: 'POST', query: { mailboxId: 'mbx_2' }, body: { actions: [] } });
    expect(status).toBe(400);
    expect(dbAutomation.createRule).not.toHaveBeenCalled();
  });

  it('assign updates messages in the active mailbox only', async () => {
    dbPool.query.mockResolvedValue({ rowCount: 1 });
    const { status } = await call('mail', 'assign', {
      method: 'POST',
      query: { mailboxId: 'mbx_2' },
      body: { ids: ['msg_1', 'msg_2'], userId: 'usr_9' },
    });
    expect(status).toBe(200);
    expect(dbMessages.findOwned).toHaveBeenCalledWith('msg_1', 'mbx_2');
    expect(dbMessages.findOwned).toHaveBeenCalledWith('msg_2', 'mbx_2');
  });

  it('assignable-users returns the whole directory to a manager', async () => {
    isManager.mockReturnValue(true);
    dbUsers.listUsers.mockResolvedValue([
      { id: 'usr_2', email: 'b@re-el.co.za', display_name: 'Bea', role: 'manager', status: 'active' },
    ]);
    const { status, body } = await call('mail', 'assignable-users', { query: { mailboxId: 'mbx_2' } });
    expect(status).toBe(200);
    expect(dbUsers.listUsers).toHaveBeenCalledWith({ status: 'active', limit: 200 });
    expect(body.data.users).toEqual([{ id: 'usr_2', email: 'b@re-el.co.za', displayName: 'Bea', role: 'manager' }]);
  });

  it('assignable-users narrows a regular user to themselves and never lists the directory', async () => {
    const { status, body } = await call('mail', 'assignable-users', { query: { mailboxId: 'mbx_2' } });
    expect(status).toBe(200);
    expect(dbUsers.listUsers).not.toHaveBeenCalled();
    expect(body.data.users).toEqual([
      { id: 'usr_1', email: 'a@re-el.co.za', displayName: null, role: 'user' },
    ]);
  });

  it('notifications are listed for the session user, not a mailbox', async () => {
    dbAutomation.listNotifications.mockResolvedValue([
      { id: 'ntf_1', kind: 'assignment', title: 'Hi', body: null, entity_type: 'message', entity_id: 'msg_1', url: null, is_read: false, created_at: '2026-01-01' },
    ]);
    dbAutomation.countUnreadNotifications.mockResolvedValue(1);
    const { status, body } = await call('mail', 'notifications');
    expect(status).toBe(200);
    expect(dbAutomation.listNotifications).toHaveBeenCalledWith('usr_1', expect.anything());
    expect(body.data.notifications[0]).toMatchObject({ id: 'ntf_1', isRead: false });
    expect(body.data.unread).toBe(1);
  });

  it('set-auto-reply updates the mailbox and echoes the new state', async () => {
    dbPool.queryOne.mockResolvedValue({ ...MAILBOXES.mbx_2, auto_reply_enabled: true, auto_reply_subject: 'Away', auto_reply_body: 'Back soon' });
    const { status, body } = await call('mail', 'set-auto-reply', {
      method: 'PUT',
      query: { mailboxId: 'mbx_2' },
      body: { enabled: true, subject: 'Away', body: 'Back soon' },
    });
    expect(status).toBe(200);
    expect(body.data.autoReply).toMatchObject({ enabled: true, subject: 'Away' });
  });
});

describe('campaign actions live on /api/send', () => {
  it('create-campaign stores recipients and returns the campaign', async () => {
    dbAutomation.createCampaign.mockResolvedValue(campaignRow({ total_recipients: 1 }));
    dbAutomation.addCampaignRecipients.mockResolvedValue(1);
    dbAutomation.getCampaign.mockResolvedValue(campaignRow({ total_recipients: 1 }));
    const { status, body } = await call('send', 'create-campaign', {
      method: 'POST',
      body: { mailboxId: 'mbx_2', name: 'News', subject: 'Hello', bodyText: 'Hi', recipients: [{ email: 'a@b.com' }] },
    });
    expect(status).toBe(200);
    expect(dbAutomation.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ mailboxId: 'mbx_2', name: 'News' }));
    expect(dbAutomation.addCampaignRecipients).toHaveBeenCalledWith('cmp_1', [{ email: 'a@b.com' }]);
    expect(body.data.campaign.id).toBe('cmp_1');
  });

  it('send-campaign kicks a batch through processCampaign', async () => {
    dbAutomation.getCampaign.mockResolvedValue(campaignRow({ total_recipients: 3 }));
    mailAutomation.processCampaign.mockResolvedValue({ sent: 3, remaining: 0 });
    const { status, body } = await call('send', 'send-campaign', { method: 'POST', body: { mailboxId: 'mbx_2', id: 'cmp_1' } });
    expect(status).toBe(200);
    expect(mailAutomation.processCampaign).toHaveBeenCalledWith('cmp_1', 'mbx_2');
    expect(body.data.started).toBe(true);
  });

  it('send-campaign refuses a campaign with no recipients', async () => {
    dbAutomation.getCampaign.mockResolvedValue(campaignRow({ total_recipients: 0 }));
    const { status } = await call('send', 'send-campaign', { method: 'POST', body: { mailboxId: 'mbx_2', id: 'cmp_1' } });
    expect(status).toBe(400);
    expect(mailAutomation.processCampaign).not.toHaveBeenCalled();
  });
});
