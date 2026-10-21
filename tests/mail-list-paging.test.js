// @vitest-environment jsdom
/**
 * Paging through a folder, a label and search results.
 *
 * The list loads one page at a time. These cases pin the contract the view has
 * with the API: the offset it sends, how it decides there is more, and what it
 * tells the reader about how much is left — all of which are easy to get subtly
 * wrong because the three endpoints express "more" differently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultRoutes, fakeMailboxes, fakeUser, resetDom, stubApi, waitFor } from './helpers/view-harness.js';

const { setState } = await import('../apps/web/js/store.js');
const { renderMailList } = await import('../apps/web/js/views/mail-list.js');
const { el } = await import('../apps/web/js/ui.js');

const MB = 'mbx_1';
const PAGE = 10;

function message(id) {
  return {
    id,
    threadId: `thr_${id}`,
    direction: 'inbound',
    from: { email: 'bob@example.com', name: 'Bob Nkosi' },
    to: [{ email: 'ada@re-el.co.za' }],
    cc: [],
    subject: `Subject ${id}`,
    snippet: 'A short preview.',
    folder: 'inbox',
    isRead: false,
    isStarred: false,
    isDraft: false,
    hasAttachments: false,
    labels: [],
    receivedAt: '2026-10-01T09:00:00Z',
    sentAt: null,
  };
}

const offsetOf = (url) => Number(new URL(url, 'http://localhost').searchParams.get('offset') || 0);
const rowCount = (container) => container.querySelectorAll('.msg-row').length;

/** A list handler that pages a fixed set of messages the way the API does. */
function pagedList(all) {
  return (url) => {
    const offset = offsetOf(url);
    const page = all.slice(offset, offset + PAGE);
    return {
      messages: page,
      // The API returns the per-folder count map directly under `counts`.
      counts: { inbox: all.length },
      inboxUnread: all.length,
      starred: 0,
      hasMore: page.length === PAGE,
      offset,
    };
  };
}

async function render(routes, ctx = { params: ['inbox'], query: {} }) {
  const { calls } = stubApi(defaultRoutes(routes));
  const container = el('div');
  document.body.append(container);
  await renderMailList(container, ctx);
  return { container, calls };
}

beforeEach(() => {
  resetDom();
  setState({
    user: fakeUser(),
    mailboxes: fakeMailboxes(),
    activeMailboxId: MB,
    counts: { folders: {}, inboxUnread: 0, starred: 0 },
    labels: [],
    pageSize: PAGE,
  });
});

describe('loading the first page', () => {
  it('requests a single page and offers more when the API says so', async () => {
    const all = Array.from({ length: 25 }, (_, i) => message(`msg_${i}`));
    const { container, calls } = await render({ 'action=list': pagedList(all) });
    await waitFor('.msg-row', container);

    expect(rowCount(container)).toBe(PAGE);
    expect(offsetOf(calls.find((url) => url.includes('action=list')))).toBe(0);

    const control = container.querySelector('.list-more button');
    expect(control.textContent).toBe('Load more');
    expect(container.querySelector('.list-more .small').textContent).toBe('Showing 10 of 25');
  });

  it('uses the folder total for trash and spam, which are deleted views', async () => {
    // Regression: folder counts excluded trash/spam (is_deleted), so the footer
    // read "Showing 10 of 0" and the sidebar had no count for either folder.
    const all = Array.from({ length: 25 }, (_, i) => message(`msg_${i}`));
    const { container } = await render({
      'action=list': (url) => {
        const offset = offsetOf(url);
        const page = all.slice(offset, offset + PAGE);
        return {
          messages: page,
          counts: { spam: all.length },
          inboxUnread: 0,
          starred: 0,
          hasMore: page.length === PAGE,
          offset,
        };
      },
    }, { params: ['spam'], query: {} });
    await waitFor('.list-more button', container);

    expect(container.querySelector('.list-more .small').textContent).toBe('Showing 10 of 25');
    expect(container.querySelector('.side-link.active .pill').textContent).toBe('25');

    container.querySelector('.list-more button').click();
    await vi.waitFor(() => expect(rowCount(container)).toBe(20));
    expect(container.querySelector('.list-more .small').textContent).toBe('Showing 20 of 25');
  });

  it('does not show a paging control when everything fits on one page', async () => {
    const all = Array.from({ length: 3 }, (_, i) => message(`msg_${i}`));
    const { container } = await render({ 'action=list': pagedList(all) });
    await waitFor('.msg-row', container);

    expect(rowCount(container)).toBe(3);
    expect(container.querySelector('.list-more')).toBeNull();
    // A short list should not carry an "End of…" line that states the obvious.
    expect(container.querySelector('.list-more-end')).toBeNull();
  });
});

describe('loading the next page', () => {
  it('appends rows and advances the offset, then reports the end', async () => {
    const all = Array.from({ length: 25 }, (_, i) => message(`msg_${i}`));
    const { container, calls } = await render({ 'action=list': pagedList(all) });
    await waitFor('.list-more button', container);

    container.querySelector('.list-more button').click();
    await vi.waitFor(() => expect(rowCount(container)).toBe(20));
    expect(container.querySelector('.list-more .small').textContent).toBe('Showing 20 of 25');

    container.querySelector('.list-more button').click();
    await vi.waitFor(() => expect(rowCount(container)).toBe(25));

    expect(container.querySelector('.list-more button')).toBeNull();
    expect(container.querySelector('.list-more-end').textContent).toBe('End of Inbox.');

    const listOffsets = calls
      .filter((url) => url.includes('action=list'))
      .map(offsetOf);
    expect(listOffsets).toEqual([0, 10, 20]);
  });

  it('does not ask for more once the last page has arrived', async () => {
    const all = Array.from({ length: 15 }, (_, i) => message(`msg_${i}`));
    const { container, calls } = await render({ 'action=list': pagedList(all) });
    await waitFor('.list-more button', container);

    container.querySelector('.list-more button').click();
    await vi.waitFor(() => expect(rowCount(container)).toBe(15));

    // The second page is short, so hasMore flips off: the button is gone and a
    // further click is impossible.
    expect(container.querySelector('.list-more button')).toBeNull();
    const requests = calls.filter((url) => url.includes('action=list'));
    expect(requests).toHaveLength(2);
  });
});

describe('paging search results', () => {
  it('uses the reported total to know when more exist', async () => {
    const all = Array.from({ length: 15 }, (_, i) => message(`msg_${i}`));
    const { container, calls } = await render({
      'action=search': (url) => {
        const offset = offsetOf(url);
        return { messages: all.slice(offset, offset + PAGE), total: all.length };
      },
    }, { params: ['search'], query: { q: 'quarterly' } });
    await waitFor('.list-more button', container);

    expect(container.querySelector('.list-more .small').textContent).toBe('Showing 10 of 15');

    container.querySelector('.list-more button').click();
    await vi.waitFor(() => expect(rowCount(container)).toBe(15));

    expect(container.querySelector('.list-more button')).toBeNull();
    expect(container.querySelector('.list-more-end').textContent).toBe('End of Search results.');
    expect(calls.some((url) => url.includes('action=search') && url.includes('offset=10'))).toBe(true);
  });
});
