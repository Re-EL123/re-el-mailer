// @vitest-environment jsdom
/**
 * Campaigns (bulk send).
 *
 * The parsing of the recipient box is the risky part: the server rejects bad
 * addresses, so a parser that keeps junk turns a typo into a failed recipient
 * row the operator never sees. The rest checks that a campaign can actually be
 * created and started from the view.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDom, waitFor } from './helpers/view-harness.js';

const MB = 'mbx_1';

vi.mock('../apps/web/js/api.js', () => ({
  api: {
    send: {
      campaigns: vi.fn(async () => ({
        campaigns: [
          { id: 'cmp_1', name: 'Newsletter', subject: 'October news', status: 'draft', totalRecipients: 3, sentCount: 0, failedCount: 0 },
          { id: 'cmp_2', name: 'Follow-up', subject: 'Checking in', status: 'sending', totalRecipients: 10, sentCount: 4, failedCount: 1 },
        ],
      })),
      createCampaign: vi.fn(async () => ({ campaign: { id: 'cmp_3' } })),
      sendCampaign: vi.fn(async () => ({ started: true })),
      pauseCampaign: vi.fn(async () => ({ campaign: { id: 'cmp_2' } })),
      deleteCampaign: vi.fn(async () => ({ deleted: true })),
    },
  },
}));

const { setState } = await import('../apps/web/js/store.js');
const { api } = await import('../apps/web/js/api.js');
const { renderCampaigns, parseRecipients } = await import('../apps/web/js/views/campaigns.js');
const { el } = await import('../apps/web/js/ui.js');

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

const button = (container, text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);

beforeEach(() => {
  resetDom();
  setState({ user: { id: 'usr_1', role: 'admin' }, mailboxes: [{ id: MB, email: 'ada@re-el.co.za' }], activeMailboxId: MB });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('parseRecipients', () => {
  it('reads one address per line with an optional display name', () => {
    expect(parseRecipients('a@example.com, Alex\nb@example.com')).toEqual([
      { email: 'a@example.com', name: 'Alex' },
      { email: 'b@example.com', name: null },
    ]);
  });

  it('drops lines that are not addresses', () => {
    expect(parseRecipients('not an address\n\n  \nc@example.com')).toEqual([{ email: 'c@example.com', name: null }]);
  });
});

describe('the campaigns view', () => {
  it('lists campaigns with their progress', async () => {
    const container = host();
    await renderCampaigns(container);

    const rows = container.querySelectorAll('.campaign-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Newsletter');
    expect(rows[1].textContent).toContain('4 sent, 1 failed of 10');
  });

  it('creates a campaign with the parsed recipients', async () => {
    const container = host();
    await renderCampaigns(container);
    await waitFor('.campaign-row', container);

    container.querySelector('input[placeholder="Campaign name"]').value = 'Launch';
    container.querySelector('input[placeholder="Subject"]').value = 'We launched';
    container.querySelector('textarea[placeholder^="Write the message"]').value = 'Hello everyone';
    container.querySelector('textarea[placeholder^="name@example.com"]').value = 'a@example.com, Alex\nb@example.com';
    button(container, 'Create campaign').click();

    await vi.waitFor(() => expect(api.send.createCampaign).toHaveBeenCalled());
    const payload = api.send.createCampaign.mock.calls[0][0];
    expect(payload).toMatchObject({ mailboxId: MB, name: 'Launch', subject: 'We launched', bodyText: 'Hello everyone' });
    expect(payload.recipients).toEqual([
      { email: 'a@example.com', name: 'Alex' },
      { email: 'b@example.com', name: null },
    ]);
  });

  it('starts a draft campaign', async () => {
    const container = host();
    await renderCampaigns(container);
    await waitFor('.campaign-row', container);

    const sendNow = [...container.querySelectorAll('.campaign-row')]
      .map((row) => [...row.querySelectorAll('button')].find((b) => b.textContent === 'Send now'))
      .find(Boolean);
    sendNow.click();

    await vi.waitFor(() => expect(api.send.sendCampaign).toHaveBeenCalledWith('cmp_1', MB));
  });
});
