// @vitest-environment jsdom
/**
 * Settings → Automation.
 *
 * These are the first screens that write the automation tables, so the asserts
 * are mainly about the payload shape: a rule that reaches the server with the
 * wrong condition/action shape silently matches nothing, and a webhook secret
 * that is never shown cannot be configured on the receiving end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDom, waitFor } from './helpers/view-harness.js';

const MB = 'mbx_1';

vi.mock('../apps/web/js/api.js', () => ({
  api: {
    settings: {
      mailboxes: vi.fn(async () => ({
        mailboxes: [{ id: 'mbx_1', email: 'ada@re-el.co.za', displayName: 'Ada', status: 'active', signatureHtml: '', signatureText: '', replyTo: null, isPrimary: true }],
      })),
      updateMailbox: vi.fn(async () => ({ ok: true })),
      disconnect: vi.fn(async () => ({ revoked: 0 })),
    },
    mail: {
      labels: vi.fn(async () => ({ labels: [] })),
      createLabel: vi.fn(),
      updateLabel: vi.fn(),
      deleteLabel: vi.fn(),
    },
    auth: { sessions: vi.fn(async () => ({ sessions: [] })), revokeSession: vi.fn() },
    automation: {
      templates: vi.fn(async () => ({
        templates: [{ id: 'tpl_1', name: 'Greeting', subject: 'Hello', bodyText: 'Hi there' }],
      })),
      createTemplate: vi.fn(async () => ({ template: { id: 'tpl_2' } })),
      updateTemplate: vi.fn(async () => ({ template: { id: 'tpl_1' } })),
      deleteTemplate: vi.fn(async () => ({ deleted: true })),
      autoReply: vi.fn(async () => ({
        autoReply: { enabled: true, subject: 'Away', body: 'Back soon', intervalMinutes: 60, start: null, end: null },
      })),
      setAutoReply: vi.fn(async () => ({ autoReply: {} })),
      rules: vi.fn(async () => ({ rules: [] })),
      createRule: vi.fn(async () => ({ rule: { id: 'rul_1' } })),
      updateRule: vi.fn(async () => ({ rule: { id: 'rul_1' } })),
      deleteRule: vi.fn(async () => ({ deleted: true })),
      webhooks: vi.fn(async () => ({ webhooks: [] })),
      createWebhook: vi.fn(async () => ({ webhook: { id: 'whk_1', url: 'https://x.example/hook' }, secret: 'shh_secret_value' })),
      updateWebhook: vi.fn(async () => ({ webhook: { id: 'whk_1' } })),
      deleteWebhook: vi.fn(async () => ({ deleted: true })),
    },
  },
}));

const { setState } = await import('../apps/web/js/store.js');
const { api } = await import('../apps/web/js/api.js');
const { renderSettings } = await import('../apps/web/js/views/settings.js');
const { el } = await import('../apps/web/js/ui.js');

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

const button = (container, text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);

beforeEach(() => {
  resetDom();
  setState({ user: { id: 'usr_1', role: 'admin' }, mailboxes: [{ id: MB, email: 'ada@re-el.co.za' }], activeMailboxId: MB, counts: { folders: {}, inboxUnread: 0, starred: 0 } });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('canned responses', () => {
  it('lists the mailbox templates', async () => {
    const container = host();
    await renderSettings(container);

    const rows = container.querySelectorAll('.template-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('input').value).toBe('Greeting');
    expect(api.automation.templates).toHaveBeenCalledWith(MB);
  });

  it('creates a canned response from the form', async () => {
    const container = host();
    await renderSettings(container);

    container.querySelector('input[placeholder="Name"]').value = 'Thanks';
    container.querySelector('input[placeholder="Subject (optional)"]').value = 'Thank you';
    container.querySelector('textarea[placeholder="Body text"]').value = 'Thanks for your message.';
    button(container, 'Add canned response').click();

    await vi.waitFor(() => expect(api.automation.createTemplate).toHaveBeenCalled());
    expect(api.automation.createTemplate.mock.calls[0][0]).toMatchObject({
      name: 'Thanks',
      subject: 'Thank you',
      bodyText: 'Thanks for your message.',
    });
    expect(api.automation.createTemplate.mock.calls[0][1]).toBe(MB);
  });
});

describe('out of office', () => {
  it('loads the saved settings and saves the form', async () => {
    const container = host();
    await renderSettings(container);
    await waitFor('input[type="checkbox"].toggle', container);

    const toggle = container.querySelector('input[type="checkbox"].toggle');
    expect(toggle.checked).toBe(true);

    button(container, 'Save auto-reply').click();
    await vi.waitFor(() => expect(api.automation.setAutoReply).toHaveBeenCalled());
    expect(api.automation.setAutoReply.mock.calls[0][0]).toMatchObject({
      enabled: true,
      subject: 'Away',
      body: 'Back soon',
      intervalMinutes: 60,
    });
  });
});

describe('rules', () => {
  it('sends a condition and an action in the shapes the server expects', async () => {
    const container = host();
    await renderSettings(container);

    container.querySelector('input[placeholder="Rule name"]').value = 'Archive newsletters';
    container.querySelector('input[placeholder="Value"]').value = 'newsletter@example.com';
    container.querySelector('input[placeholder^="Folder"]').value = 'archive';
    button(container, 'Add rule').click();

    await vi.waitFor(() => expect(api.automation.createRule).toHaveBeenCalled());
    const [payload, mailboxId] = api.automation.createRule.mock.calls[0];
    expect(mailboxId).toBe(MB);
    expect(payload.name).toBe('Archive newsletters');
    expect(payload.conditions).toEqual({
      match: 'all',
      conditions: [{ field: 'from', operator: 'contains', value: 'newsletter@example.com' }],
    });
    expect(payload.actions).toEqual([{ type: 'move', folder: 'archive' }]);
  });
});

describe('webhooks', () => {
  it('shows the signing secret exactly once, on creation', async () => {
    const container = host();
    await renderSettings(container);

    container.querySelector('input[placeholder="https://example.com/hook"]').value = 'https://x.example/hook';
    button(container, 'Add webhook').click();

    await vi.waitFor(() => expect(api.automation.createWebhook).toHaveBeenCalled());
    await vi.waitFor(() => expect(container.textContent).toContain('shh_secret_value'));
    expect(api.automation.createWebhook.mock.calls[0][0]).toMatchObject({ url: 'https://x.example/hook' });
  });
});
