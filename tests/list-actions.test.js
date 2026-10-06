// @vitest-environment jsdom
/**
 * Bulk actions only exist when a message is selected.
 *
 * The report came in twice: "the list actions say the details are not valid
 * when clicked" and "there are no actions after selecting messages". One cause
 * produced both. The bar was mounted with buttons but `updateActions()` set
 * `textContent` on the whole bar, deleting those buttons the first time a row
 * was picked — so selection hid the actions. And `.list-actions` set
 * `display: flex`, which overrides the UA `[hidden]` rule, so the empty bar was
 * always visible above the list; clicking Star with nothing selected sent
 * `ids: []`, which the API schema rejects with the generic validation error.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { defaultRoutes, fakeMailboxes, fakeUser, resetDom, stubApi, waitFor } from './helpers/view-harness.js';

const { setState } = await import('../apps/web/js/store.js');
const { renderMailList } = await import('../apps/web/js/views/mail-list.js');
const { el } = await import('../apps/web/js/ui.js');

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
    isRead: true,
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

let fetchStub = null;
function render(messages, folder = 'inbox') {
  const { stub } = stubApi(defaultRoutes({
    'action=list': { messages, counts: { folders: { [folder]: messages.length } }, inboxUnread: 0, starred: 0 },
    'action=labels': { labels: [] },
  }));
  fetchStub = stub;
  const container = el('div');
  document.body.append(container);
  return renderMailList(container, { params: [folder], query: {} }).then(() => container);
}

beforeEach(() => {
  resetDom();
  setState({
    user: fakeUser(),
    mailboxes: fakeMailboxes(),
    activeMailboxId: MB,
    counts: { folders: {}, inboxUnread: 0, starred: 0 },
    labels: [],
    pageSize: 30,
  });
});

describe('list actions', () => {
  it('hides the bar while nothing is selected', async () => {
    const container = await render([message()]);
    expect(container.querySelector('.list-actions').hidden).toBe(true);
  });

  it('keeps Star/Archive/Trash/Clear next to the count when a row is chosen', async () => {
    const container = await render([message()]);
    const box = await waitFor('.msg-check', container);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));

    const node = container.querySelector('.list-actions');
    expect(node.hidden).toBe(false);
    expect(node.querySelector('.list-actions-count').textContent).toBe('1 selected');
    expect([...node.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Star', 'Archive', 'Trash', 'Clear']);
  });

  it('reselecting after a clear still shows the buttons', async () => {
    const container = await render([message()]);
    const box = await waitFor('.msg-check', container);
    const select = () => {
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };
    select();
    // Clear removes the selection, then selecting again must restore buttons.
    const clear = [...container.querySelectorAll('.list-actions button')].find((b) => b.textContent === 'Clear');
    clear.click();
    expect(container.querySelector('.list-actions').hidden).toBe(true);
    select();
    expect(container.querySelector('.list-actions-count').textContent).toBe('1 selected');
    expect([...container.querySelectorAll('.list-actions button')].map((b) => b.textContent)).toEqual(['Star', 'Archive', 'Trash', 'Clear']);
  });

  it('clicking an action with nothing selected does not call the API', async () => {
    const container = await render([message()]);
    const before = fetchStub.mock.calls.length;
    container.querySelector('.list-actions button').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchStub.mock.calls.length).toBe(before);
  });

  it('Star with a row selected sends that id in the body', async () => {
    const container = await render([message()]);
    const box = await waitFor('.msg-check', container);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const star = [...container.querySelectorAll('.list-actions button')].find((b) => b.textContent === 'Star');
    star.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const call = fetchStub.mock.calls.find(([url]) => String(url).includes('action=star'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body).ids).toEqual(['msg_1']);
  });

  it('Starred view offers Unstar, not Star', async () => {
    const container = await render([message({ isStarred: true })], 'starred');
    const box = await waitFor('.msg-check', container);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const buttons = [...container.querySelectorAll('.list-actions button')].map((b) => b.textContent);
    expect(buttons).toContain('Unstar');
    expect(buttons).not.toContain('Star');

    const unstar = [...container.querySelectorAll('.list-actions button')].find((b) => b.textContent === 'Unstar');
    unstar.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const call = fetchStub.mock.calls.find(([url]) => String(url).includes('action=star'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toEqual({ ids: ['msg_1'], isStarred: false });
  });

  it('Archive view offers Unarchive and moves back to inbox', async () => {
    const container = await render([message({ folder: 'archive' })], 'archive');
    const box = await waitFor('.msg-check', container);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const buttons = [...container.querySelectorAll('.list-actions button')].map((b) => b.textContent);
    expect(buttons).toContain('Unarchive');
    expect(buttons).not.toContain('Archive');

    const unarchive = [...container.querySelectorAll('.list-actions button')].find((b) => b.textContent === 'Unarchive');
    unarchive.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const call = fetchStub.mock.calls.find(([url]) => String(url).includes('action=move'));
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body)).toEqual({ ids: ['msg_1'], folder: 'inbox' });
  });

  it('other folders keep Star and Archive labels', async () => {
    const container = await render([message()], 'sent');
    const box = await waitFor('.msg-check', container);
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const buttons = [...container.querySelectorAll('.list-actions button')].map((b) => b.textContent);
    expect(buttons).toContain('Star');
    expect(buttons).toContain('Archive');
  });
});