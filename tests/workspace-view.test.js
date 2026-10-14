// @vitest-environment jsdom
/**
 * Workspace + billing view.
 *
 * The screen is where a plan change is initiated, and the rule that matters is
 * that it goes through checkout when a payment provider is configured, but
 * switches the plan directly when it is not. Getting that backwards would either
 * break self-hosted plan changes or let a paid plan be granted without payment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDom, waitFor } from './helpers/view-harness.js';

const WORKSPACES = [
  { id: 'wsp_1', name: 'Acme', isDefault: true, role: 'owner' },
  { id: 'wsp_2', name: 'Side', isDefault: false, role: 'member' },
];

const MEMBERS = [
  { userId: 'usr_1', email: 'ada@re-el.co.za', displayName: 'Ada Lovelace', role: 'owner' },
  { userId: 'usr_2', email: 'bob@re-el.co.za', displayName: 'Bob Nkosi', role: 'member' },
];

function detail(over = {}) {
  return {
    workspace: { id: 'wsp_1', name: 'Acme', planId: 'team' },
    role: 'owner',
    plan: { id: 'team', name: 'Team', seats: 10, mailboxes: 10, monthlySends: 10000, rules: 50, webhooks: 5, campaigns: true, prioritySupport: false },
    subscription: { planId: 'team', status: 'active', seats: 1, provider: 'none', currentPeriodEnd: '2026-11-01T00:00:00Z' },
    seats: 10,
    usage: { members: 2, mailboxes: 1, sendsThisMonth: 10, rules: 0, webhooks: 0 },
    members: MEMBERS,
    billing: { configured: false, provider: 'none', currency: 'ZAR' },
    ...over,
  };
}

const apiMock = {
  workspaces: {
    list: vi.fn(async () => ({ workspaces: WORKSPACES })),
    current: vi.fn(async () => detail()),
    get: vi.fn(async () => detail()),
    plans: vi.fn(async () => ({ plans: [] })),
    create: vi.fn(async () => ({ workspace: { id: 'wsp_3', name: 'New' } })),
    update: vi.fn(async () => ({ workspace: { id: 'wsp_1', planId: 'solo' } })),
    addMember: vi.fn(async () => ({ member: { userId: 'usr_3' } })),
    updateMember: vi.fn(async () => ({ member: { userId: 'usr_2' } })),
    removeMember: vi.fn(async () => ({ removed: true })),
  },
  billing: {
    subscription: vi.fn(async () => detail()),
    checkout: vi.fn(async () => ({
      actionUrl: 'https://sandbox.payfast.co.za/eng/process',
      fields: { merchant_id: '10000100', m_payment_id: 'reel_wsp_1', signature: 'sig' },
      reference: 'reel_wsp_1',
      planId: 'business',
      seats: 1,
    })),
    verify: vi.fn(async () => detail()),
    cancel: vi.fn(async () => detail()),
  },
};

vi.mock('../apps/web/js/api.js', () => ({
  api: apiMock,
  setAccessToken: vi.fn(),
  describeApiError: (err) => err?.message || 'Something went wrong.',
}));

const { planList } = await import('../packages/billing/plans.js');
const { setState, state, loadWorkspaces, resetState } = await import('../apps/web/js/store.js');
const { renderWorkspace } = await import('../apps/web/js/views/workspace.js');
const { el } = await import('../apps/web/js/ui.js');

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

const button = (container, text) => [...container.querySelectorAll('button')].find((b) => b.textContent === text);
const planCard = (container, name) => [...container.querySelectorAll('.plan-card')].find((c) => c.textContent.includes(name));

beforeEach(() => {
  resetDom();
  vi.clearAllMocks();
  apiMock.workspaces.plans.mockResolvedValue({ plans: planList() });
  apiMock.workspaces.get.mockResolvedValue(detail());
  apiMock.workspaces.current.mockResolvedValue(detail());
  setState({ user: { id: 'usr_1', role: 'user' }, activeWorkspaceId: 'wsp_1', workspaces: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('store.loadWorkspaces', () => {
  it('stores the list and picks the first when none is chosen', async () => {
    setState({ activeWorkspaceId: null });
    const list = await loadWorkspaces();
    expect(list).toHaveLength(2);
    expect(state.activeWorkspaceId).toBe('wsp_1');
  });

  it('keeps the chosen workspace when it is still present', async () => {
    setState({ activeWorkspaceId: 'wsp_2' });
    await loadWorkspaces();
    expect(state.activeWorkspaceId).toBe('wsp_2');
  });

  it('falls back to the first when the chosen one is gone', async () => {
    setState({ activeWorkspaceId: 'wsp_deleted' });
    await loadWorkspaces();
    expect(state.activeWorkspaceId).toBe('wsp_1');
  });

  it('returns an empty list instead of throwing when the call fails', async () => {
    apiMock.workspaces.list.mockRejectedValueOnce(new Error('offline'));
    expect(await loadWorkspaces()).toEqual([]);
  });
});

describe('the workspace view', () => {
  it('renders the team and marks the current plan', async () => {
    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    const rows = container.querySelectorAll('.member-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Ada Lovelace');

    expect(planCard(container, 'Team').textContent).toContain('Current plan');
  });

  it('adds a member with the chosen role', async () => {
    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    container.querySelector('input[placeholder="colleague@example.com"]').value = 'carol@re-el.co.za';
    button(container, 'Add member').click();

    await vi.waitFor(() => expect(apiMock.workspaces.addMember).toHaveBeenCalled());
    expect(apiMock.workspaces.addMember).toHaveBeenCalledWith({
      workspaceId: 'wsp_1',
      email: 'carol@re-el.co.za',
      role: 'member',
    });
  });

  it('changes a member role', async () => {
    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    const bobRow = [...container.querySelectorAll('.member-row')].find((r) => r.textContent.includes('Bob Nkosi'));
    const roleSelect = bobRow.querySelector('select');
    roleSelect.value = 'manager';
    roleSelect.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(apiMock.workspaces.updateMember).toHaveBeenCalled());
    expect(apiMock.workspaces.updateMember).toHaveBeenCalledWith({ workspaceId: 'wsp_1', userId: 'usr_2', role: 'manager' });
  });

  it('switches the plan directly when no billing provider is configured', async () => {
    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    const business = planCard(container, 'Business');
    button(business, 'Choose plan').click();

    await vi.waitFor(() => expect(apiMock.workspaces.update).toHaveBeenCalledWith('wsp_1', { planId: 'business' }));
    expect(apiMock.billing.checkout).not.toHaveBeenCalled();
  });

  it('starts a checkout for a paid plan when billing is configured', async () => {
    apiMock.workspaces.get.mockResolvedValue(detail({ billing: { configured: true, provider: 'payfast', currency: 'ZAR' } }));
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});

    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    const business = planCard(container, 'Business');
    button(business, 'Choose plan').click();

    await vi.waitFor(() => expect(apiMock.billing.checkout).toHaveBeenCalled());
    expect(apiMock.billing.checkout.mock.calls[0][0]).toMatchObject({ workspaceId: 'wsp_1', planId: 'business', seats: 1 });
    // PayFast is a form POST, so the view submits a signed form rather than navigating.
    expect(submit).toHaveBeenCalled();
    expect(apiMock.workspaces.update).not.toHaveBeenCalled();
  });

  it('polls the subscription after returning from checkout', async () => {
    window.history.replaceState({}, '', '/?billing=return');
    apiMock.billing.subscription.mockResolvedValue(detail());

    const container = host();
    await renderWorkspace(container);

    await vi.waitFor(() => expect(apiMock.billing.subscription).toHaveBeenCalledWith('wsp_1'));
    expect(window.location.search).toBe('');
  });

  it('cancels a subscription', async () => {
    const container = host();
    await renderWorkspace(container);
    await waitFor('.member-row', container);

    button(container, 'Cancel subscription').click();
    // The confirmation is an in-page dialog; confirm it.
    await waitFor('.modal-actions', document);
    const confirm = [...document.querySelectorAll('.modal-actions button')].find((b) => b.textContent === 'Cancel subscription');
    confirm.click();

    await vi.waitFor(() => expect(apiMock.billing.cancel).toHaveBeenCalledWith('wsp_1'));
  });
});

describe('resetState', () => {
  it('clears workspace state on sign-out', () => {
    setState({ workspaces: WORKSPACES, activeWorkspaceId: 'wsp_1' });
    resetState();
    expect(state.workspaces).toEqual([]);
    expect(state.activeWorkspaceId).toBeNull();
  });
});
