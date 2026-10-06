// @vitest-environment jsdom
/**
 * What each row says about who the message is between.
 *
 * The row's identity line and its accessible name come from one helper, so these
 * cases are the same assertion twice: the text on screen and the text a screen
 * reader announces have to agree, and neither may be the label alone.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { defaultRoutes, fakeMailboxes, fakeUser, resetDom, stubApi, waitFor } from './helpers/view-harness.js';

const { setState } = await import('../apps/web/js/store.js');
const { renderMailList } = await import('../apps/web/js/views/mail-list.js');
const { displayName, el } = await import('../apps/web/js/ui.js');

const MB = 'mbx_1';

/** A message as the list receives it, with the fields each case needs. */
function message(over = {}) {
  return {
    id: 'msg_1',
    threadId: 'thr_1',
    direction: 'inbound',
    from: { email: 'bob@example.com', name: 'Bob Nkosi' },
    to: ['ada@re-el.co.za'],
    cc: [],
    subject: 'Quarterly numbers',
    snippet: 'Here they are.',
    folder: 'inbox',
    isRead: false,
    isStarred: false,
    isDraft: false,
    hasAttachments: false,
    labels: [],
    receivedAt: '2026-10-01T09:00:00Z',
    sentAt: null,
    createdAt: '2026-10-01T09:00:00Z',
    ...over,
  };
}

function render(messages, folder = 'inbox') {
  stubApi(defaultRoutes({
    'action=list': { messages, counts: { folders: { [folder]: messages.length } }, inboxUnread: 0, starred: 0 },
  }));
  const container = el('div');
  document.body.append(container);
  return renderMailList(container, { params: [folder], query: {} }).then(() => container);
}

beforeEach(() => {
  resetDom();
  setState({ user: fakeUser(), mailboxes: fakeMailboxes(), activeMailboxId: MB, counts: { folders: {}, inboxUnread: 0, starred: 0 }, labels: [], pageSize: 30 });
});

describe('the identity line', () => {
  it('shows who a sent message went to, not the word To', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, to: ['alice@example.com', 'carol@example.com'] }),
    ], 'sent');

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('To: alice@example.com, carol@example.com');
    // The regression: displayName({ name, email }) returns the name, so the
    // label was rendered on its own and the recipients were dropped.
    expect(line.textContent).not.toBe('To');
  });

  it('shows a draft\u2019s recipients the same way', async () => {
    const container = await render([
      message({ direction: 'outbound', isDraft: true, isRead: true, to: ['alice@example.com'] }),
    ], 'drafts');

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('To: alice@example.com');
  });

  it('falls back to cc when a message was sent with cc only', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, to: [], cc: ['team@example.com'] }),
    ], 'sent');

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('Cc: team@example.com');
  });

  it('still says what is missing on an empty draft', async () => {
    const container = await render([
      message({ direction: 'outbound', isDraft: true, isRead: true, to: [], cc: [] }),
    ], 'drafts');

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('To');
  });

  it('names the sender on an inbound message', async () => {
    const container = await render([message()]);

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('Bob Nkosi');
  });

  it('falls back to the address when the sender has no name', async () => {
    const container = await render([message({ from: { email: 'bob@example.com', name: '' } })]);

    const line = await waitFor('.msg-from', container);
    expect(line.textContent).toBe('bob@example.com');
    expect(displayName({ email: 'bob@example.com', name: '' })).toBe('bob@example.com');
  });
});

describe('the row\u2019s accessible name', () => {
  it('announces the recipients on an outbound row', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, to: ['alice@example.com'] }),
    ], 'sent');

    const row = await waitFor('.msg-row', container);
    expect(row.getAttribute('aria-label')).toBe('To: alice@example.com. Quarterly numbers');
  });

  it('does not announce a sender who is the reader themselves', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, from: { email: 'ada@re-el.co.za', name: 'Ada Lovelace' }, to: ['alice@example.com'] }),
    ], 'sent');

    const row = await waitFor('.msg-row', container);
    // The old label always used msg.from, so an outbound row read back the
    // mailbox's own address as though it were the sender.
    expect(row.getAttribute('aria-label')).toContain('To: alice@example.com');
    expect(row.getAttribute('aria-label')).not.toContain('Ada Lovelace');
  });

  it('says what an inbound row says on screen', async () => {
    const container = await render([message()]);

    const row = await waitFor('.msg-row', container);
    const line = row.querySelector('.msg-from');
    expect(row.getAttribute('aria-label')).toContain(line.textContent);
    expect(row.getAttribute('aria-label')).toBe('Unread. Bob Nkosi. Quarterly numbers');
  });
});

describe('the avatar', () => {
  it('initials the first recipient on an outbound row', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, to: ['alice@example.com'] }),
    ], 'sent');

    const avatar = await waitFor('.msg-avatar', container);
    expect(avatar.textContent).toBe('A');
  });

  it('falls back to cc when there is no To', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, to: [], cc: ['team@example.com'] }),
    ], 'sent');

    const avatar = await waitFor('.msg-avatar', container);
    expect(avatar.textContent).toBe('T');
  });

  it('shows a placeholder rather than nothing on an empty draft', async () => {
    const container = await render([
      message({ direction: 'outbound', isDraft: true, isRead: true, to: [], cc: [] }),
    ], 'drafts');

    const avatar = await waitFor('.msg-avatar', container);
    expect(avatar.textContent).toBe('?');
  });
});

describe('the delivery tag', () => {
  const tagsOf = async (container) => {
    await waitFor('.msg-row', container);
    return [...container.querySelectorAll('.msg-tags .tag')].map((node) => node.textContent);
  };

  it('stays off a received message', async () => {
    // delivery_status is `not null default 'unknown'` and is never written for
    // inbound mail, so this is every row in a real inbox.
    const container = await render([message({ deliveryStatus: 'unknown' })]);

    expect(await tagsOf(container)).toEqual([]);
    expect((await waitFor('.msg-row', container)).textContent).not.toContain('unknown');
  });

  it('stays off an outbound message the provider has not reported on', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, deliveryStatus: 'unknown' }),
    ], 'sent');

    expect(await tagsOf(container)).toEqual([]);
  });

  it('stays off a message that was accepted or delivered', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, deliveryStatus: 'delivered' }),
      message({ id: 'msg_2', direction: 'outbound', isRead: true, deliveryStatus: 'sent' }),
    ], 'sent');

    expect(await tagsOf(container)).toEqual([]);
  });

  it('names a failure the way a person would', async () => {
    const container = await render([
      message({ direction: 'outbound', isRead: true, deliveryStatus: 'bounced' }),
    ], 'sent');

    // The column stores `bounced`; the reader should not have to know that.
    expect(await tagsOf(container)).toEqual(['Bounced']);
  });

  it('does not mistake an inbound row for one with telemetry', async () => {
    const container = await render([
      message({ direction: 'inbound', deliveryStatus: 'bounced' }),
    ]);

    expect(await tagsOf(container)).toEqual([]);
  });

  it('labels the transient states too', async () => {
    const container = await render([
      message({ id: 'msg_1', direction: 'outbound', isRead: true, deliveryStatus: 'queued' }),
      message({ id: 'msg_2', direction: 'outbound', isRead: true, deliveryStatus: 'deferred' }),
      message({ id: 'msg_3', direction: 'outbound', isRead: true, deliveryStatus: 'complained' }),
    ], 'sent');

    expect(await tagsOf(container)).toEqual(['Queued', 'Delayed', 'Spam complaint']);
  });
});

