// @vitest-environment jsdom
/**
 * Reader team actions: snooze, follow-up reminders and internal notes.
 *
 * The payloads matter more than the pixels here: a snooze sent as the wrong
 * field, or a note missing its message id, fails silently against the API and
 * the operator only notices when the message never comes back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDom, waitFor } from './helpers/view-harness.js';

const MB = 'mbx_1';

vi.mock('../apps/web/js/api.js', () => ({
  api: {
    mail: {
      get: vi.fn(async () => ({
        message: { id: 'msg_1', subject: 'Quarterly numbers', folder: 'inbox', from: { email: 'bob@example.com', name: 'Bob' }, to: [{ email: 'ada@re-el.co.za' }], cc: [], labels: [], attachments: [], bodyText: 'Hello there', isDraft: false, isStarred: false, receivedAt: '2026-10-01T09:00:00Z' },
        thread: [],
      })),
      attachmentUrl: vi.fn(async () => ({ url: 'https://x/y' })),
      setLabels: vi.fn(async () => ({ ok: true })),
      move: vi.fn(async () => ({ moved: 1 })),
    },
    automation: {
      notes: vi.fn(async () => ({ notes: [{ id: 'not_1', authorEmail: 'ada@re-el.co.za', body: 'Called the client', createdAt: new Date().toISOString() }] })),
      createNote: vi.fn(async () => ({ note: { id: 'not_2' } })),
      deleteNote: vi.fn(async () => ({ deleted: true })),
      snooze: vi.fn(async () => ({ snoozed: true })),
      followUp: vi.fn(async () => ({ ok: true })),
      assign: vi.fn(async () => ({ assigned: 1 })),
      assignableUsers: vi.fn(async () => ({ users: [{ id: 'usr_2', email: 'bea@re-el.co.za', displayName: 'Bea', role: 'manager' }] })),
    },
  },
}));

const { api } = await import('../apps/web/js/api.js');
const { renderMessage } = await import('../apps/web/js/views/message.js');
const { el } = await import('../apps/web/js/ui.js');

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

/** Open a reader dropdown and return its menu. */
function openPicker(container, label) {
  const details = [...container.querySelectorAll('.reader-toolbar details')]
    .find((d) => d.querySelector('summary')?.getAttribute('aria-label') === label);
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  return details;
}

beforeEach(() => {
  resetDom();
  window.history.replaceState(null, '', '#/message/msg_1');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('snooze', () => {
  it('snoozes until the chosen time, not merely for a duration', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const details = openPicker(container, 'Snooze');
    const option = [...details.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'Later today (3 hours)');
    option.click();

    await vi.waitFor(() => expect(api.automation.snooze).toHaveBeenCalled());
    const [ids, opts, mailboxId] = api.automation.snooze.mock.calls[0];
    expect(ids).toEqual(['msg_1']);
    expect(mailboxId).toBe(MB);
    expect(Number.isNaN(Date.parse(opts.until))).toBe(false);
    expect(new Date(opts.until).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('follow-up', () => {
  it('sets a day-based reminder', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const details = openPicker(container, 'Set a follow-up reminder');
    [...details.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'In 3 days').click();

    await vi.waitFor(() => expect(api.automation.followUp).toHaveBeenCalled());
    expect(api.automation.followUp.mock.calls[0][1]).toEqual({ days: 3 });
  });
});

describe('assignment', () => {
  it('assigns the message to a chosen team member', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const details = openPicker(container, 'Assign this message');
    await vi.waitFor(() => expect(details.querySelectorAll('.menu-btn').length).toBeGreaterThan(0));
    [...details.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'Bea').click();

    await vi.waitFor(() => expect(api.automation.assign).toHaveBeenCalledWith(['msg_1'], 'usr_2', MB));
  });

  it('unassigns with a null user id', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const details = openPicker(container, 'Assign this message');
    await vi.waitFor(() => expect(details.querySelectorAll('.menu-btn').length).toBeGreaterThan(0));
    [...details.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'Unassign').click();

    await vi.waitFor(() => expect(api.automation.assign).toHaveBeenCalledWith(['msg_1'], null, MB));
  });
});

describe('reply buttons', () => {
  it('opens the composer in reply-all mode for the message being read', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const button = container.querySelector('.reader-toolbar [aria-label="Reply all"]');
    expect(button).not.toBeNull();
    button.click();
    expect(window.location.hash).toBe(`#/compose?reply=msg_1&mode=all&mailbox=${MB}`);
  });

  it('opens a plain reply without the reply-all mode', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    // The reply-all button must not be the one the plain reply resolves to.
    container.querySelector('.reader-toolbar [aria-label="Reply"]').click();
    expect(window.location.hash).toBe(`#/compose?reply=msg_1&mailbox=${MB}`);
  });
});

describe('spam actions', () => {
  it('marks an inbox message as spam and leaves the reader', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    const button = container.querySelector('.reader-toolbar [aria-label="Mark as spam"]');
    expect(button).not.toBeNull();
    button.click();

    await vi.waitFor(() => expect(api.mail.move).toHaveBeenCalledWith(['msg_1'], 'spam', MB));
    expect(window.location.hash).toBe('#/inbox');
  });

  it('offers Not spam only for a message already in spam', async () => {
    api.mail.get.mockResolvedValueOnce({
      message: { id: 'msg_1', subject: 'Cheap pills', folder: 'spam', from: { email: 'spam@example.com', name: '' }, to: [{ email: 'ada@re-el.co.za' }], cc: [], labels: [], attachments: [], bodyText: 'Buy now', isDraft: false, isStarred: false, receivedAt: '2026-10-01T09:00:00Z' },
      thread: [],
    });

    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.reader-toolbar', container);

    expect(container.querySelector('.reader-toolbar [aria-label="Mark as spam"]')).toBeNull();
    // Starred never lists the deleted views, so the reader does not offer a star.
    expect(container.querySelector('.reader-toolbar [aria-label="Star this message"]')).toBeNull();
    const button = container.querySelector('.reader-toolbar [aria-label="Move to inbox (not spam)"]');
    expect(button).not.toBeNull();
    button.click();

    await vi.waitFor(() => expect(api.mail.move).toHaveBeenCalledWith(['msg_1'], 'inbox', MB));
    expect(window.location.hash).toBe('#/inbox');
  });
});

describe('notes', () => {
  it('lists the notes already on the message', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });

    await waitFor('.note-body', container);
    expect(container.querySelector('.note-body').textContent).toBe('Called the client');
    expect(api.automation.notes).toHaveBeenCalledWith('msg_1', MB);
  });

  it('adds a note against the message id', async () => {
    const container = host();
    await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
    await waitFor('.note-add', container);

    container.querySelector('.note-add textarea').value = 'Follow up Friday';
    [...container.querySelectorAll('.note-add button')].find((b) => b.textContent === 'Add note').click();

    await vi.waitFor(() => expect(api.automation.createNote).toHaveBeenCalled());
    expect(api.automation.createNote.mock.calls[0][0]).toEqual({ messageId: 'msg_1', body: 'Follow up Friday' });
    expect(api.automation.createNote.mock.calls[0][1]).toBe(MB);
  });
});
