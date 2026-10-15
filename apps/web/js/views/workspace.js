/**
 * Workspace settings: team, plan and billing.
 *
 * A workspace is the tenancy boundary — it owns mailboxes, has members, and
 * carries the subscription that decides what the team may do. This view is where
 * an owner manages all three.
 *
 * The plan numbers (seat counts, limits) come from the server (`plan` and
 * `usage`), never from constants here: the entitlement check that refuses an
 * action must be the same numbers the UI shows, or the UI promises something the
 * API will reject.
 */

import { api, describeApiError } from '../api.js';
import { el, mount, toast, confirmDialog } from '../ui.js';
import { loadWorkspaces, state } from '../store.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', manager: 'Manager', member: 'Member' };
const STATUS_LABEL = { active: 'Active', trialing: 'Trial', past_due: 'Past due', canceled: 'Canceled', pending: 'Pending' };

function money(minor) {
  const value = Number(minor || 0) / 100;
  return value === 0 ? 'Free' : `R${value.toLocaleString('en-ZA')}`;
}

/** A usage line: "3 of 10 seats used". */
function usageLine(label, used, limit) {
  const capped = limit === null || limit === undefined ? 'unlimited' : limit;
  return el('div', { class: 'usage-row' },
    el('span', { class: 'usage-label', text: label }),
    el('span', { class: 'usage-value', text: `${used} of ${capped}` }),
  );
}

/** The URL PayFast sends the browser back to (and where a refresh should land). */
function billingReturnUrl() {
  const url = new URL(window.location.href);
  url.search = '?billing=return';
  url.hash = '#/workspace';
  return url.toString();
}

/**
 * PayFast checkout is a signed HTML form POST, not a redirect URL. Build the form
 * from the returned fields and submit it.
 */
function submitCheckoutForm(result) {
  const form = el('form', { method: 'post', action: result.actionUrl });
  form.style.display = 'none';
  for (const [name, value] of Object.entries(result.fields || {})) {
    if (value === undefined || value === null) continue;
    form.append(el('input', { type: 'hidden', name, value: String(value) }));
  }
  document.body.append(form);
  form.submit();
}

/**
 * On return from checkout the URL carries a marker (never a trustworthy payment
 * reference — PayFast proves payment with the ITN, which may lag the redirect by
 * a few seconds). Clean the marker, then poll the subscription until the ITN has
 * moved it off `pending`.
 */
async function settleCheckout(workspaceId) {
  let returning = false;
  try {
    const params = new URLSearchParams(window.location.search);
    returning = params.get('billing') === 'return' || params.has('reference') || params.has('trxref');
  } catch {
    return false;
  }
  if (!returning) return false;

  const url = new URL(window.location.href);
  url.searchParams.delete('billing');
  url.searchParams.delete('reference');
  url.searchParams.delete('trxref');
  window.history.replaceState({}, '', url.toString());

  toast('Confirming your payment…', 'info');
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const detail = await api.billing.subscription(workspaceId || undefined);
      const status = detail?.subscription?.status;
      if (status && status !== 'pending') {
        if (status === 'active' || status === 'trialing') {
          toast('Payment received. Your plan is active.', 'success');
        }
        return true;
      }
    } catch {
      /* keep polling; a transient error should not abandon a paid checkout */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  toast('Your payment is still pending confirmation. It will appear here shortly.', 'info');
  return true;
}

async function loadContext(workspaceId) {
  return workspaceId ? api.workspaces.get(workspaceId) : api.workspaces.current();
}

export async function renderWorkspace(container) {
  const app = el('div', { class: 'workspace' });
  mount(container, app);

  const workspaces = await loadWorkspaces();
  let activeId =
    state.activeWorkspaceId && workspaces.some((w) => w.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : workspaces[0]?.id || null;

  await settleCheckout(activeId);

  let plans = [];
  try {
    plans = (await api.workspaces.plans()).plans || [];
  } catch {
    /* the plan cards simply do not render; the rest of the page still works */
  }

  const header = el('section', { class: 'card' });
  const team = el('section', { class: 'card' });
  const plan = el('section', { class: 'card' });
  app.append(header, team, plan);

  async function refresh() {
    let context;
    try {
      context = await loadContext(activeId);
    } catch (err) {
      mount(header, el('p', { class: 'muted small', text: describeApiError(err) }));
      mount(team);
      mount(plan);
      return;
    }
    activeId = context?.workspace?.id || null;
    renderHeader(context);
    renderTeam(context);
    renderPlan(context, plans);
  }

  function renderHeader(context) {
    const children = [
      el('h3', { class: 'card-title', text: 'Organisation' }),
      el('p', { class: 'setting-note', text: 'A workspace is a domain. Its mailboxes and billing belong to the organisation.' }),
    ];

    if (workspaces.length > 1) {
      const select = el('select', { class: 'field' },
        ...workspaces.map((w) => el('option', { value: w.id, text: w.name, selected: w.id === activeId })),
      );
      select.addEventListener('change', async () => {
        activeId = select.value;
        const ws = workspaces.find((w) => w.id === activeId);
        if (ws) state.activeWorkspaceId = ws.id;
        await refresh();
      });
      children.push(
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Current workspace' }), select),
      );
    } else {
      children.push(el('p', { class: 'muted small', text: context.workspace?.name || '' }));
    }

    mount(header, ...children);
  }

  function renderTeam(context) {
    const meId = state.user?.id;
    const rows = (context.members || []).map((member) => {
      const isMe = member.userId && member.userId === meId;
      const name = member.displayName || member.email;
      return el('div', { class: 'member-row' },
        el('div', { class: 'member-body' },
          el('span', { class: 'member-name', text: isMe ? `${name} (you)` : name }),
          el('span', { class: 'muted small', text: member.email }),
        ),
        el('span', { class: 'pill', text: ROLE_LABEL[member.role] || 'Member' }),
      );
    });

    mount(team,
      el('h3', { class: 'card-title', text: 'Team' }),
      usageLine('Seats used', context.usage?.members ?? 0, context.seats),
      ...(rows.length ? rows : [el('p', { class: 'muted small', text: 'No members yet.' })]),
      el('p', { class: 'setting-note', text: 'Everyone with a mailbox on this domain. Access is managed by an administrator.' }),
    );
  }

  function renderPlan(context, planList) {
    const current = context.plan?.id || 'solo';
    const billingReady = Boolean(context.billing?.configured);
    const canManage = state.user?.role === 'admin';

    const cards = planList.map((p) => {
      const isCurrent = p.id === current;
      let button;
      if (isCurrent) {
        button = el('span', { class: 'pill', text: 'Current plan' });
      } else if (!canManage) {
        // A member cannot change the plan. Showing a disabled button reads as a
        // broken control; a note explains why the control is absent. Only a
        // platform administrator manages the organisation's subscription.
        button = null;
      } else {
        button = el('button', { class: 'btn btn-primary', text: 'Choose plan', onClick: async () => {
          // With a payment provider, a paid plan must go through checkout so the
          // server grants it only after a verified payment. Without one
          // (self-hosted) the plan switch is a direct update.
          if (billingReady && p.id !== 'solo') {
            try {
              const result = await api.billing.checkout({
                workspaceId: activeId,
                planId: p.id,
                seats: 1,
                callbackUrl: billingReturnUrl(),
              });
              if (result?.actionUrl && result?.fields) submitCheckoutForm(result);
            } catch (err) { toast(describeApiError(err), 'error'); }
            return;
          }
          try {
            await api.workspaces.update(activeId, { planId: p.id });
            toast('Plan updated.', 'success');
            await refresh();
          } catch (err) { toast(describeApiError(err), 'error'); }
        } });
      }

      return el('div', { class: `plan-card${isCurrent ? ' current' : ''}` },
        el('h4', { class: 'plan-name', text: p.name }),
        el('p', { class: 'plan-price', text: `${money(p.pricePerSeat)}${p.pricePerSeat ? ' / seat' : ''}` }),
        el('p', { class: 'muted small', text: p.blurb || '' }),
        el('ul', { class: 'plan-features' },
          el('li', { text: `${p.seats} seats` }),
          el('li', { text: `${p.mailboxes} mailboxes` }),
          el('li', { text: `${p.monthlySends.toLocaleString('en-ZA')} sends / month` }),
          el('li', { text: `${p.rules} rules` }),
          el('li', { text: `${p.webhooks} webhooks` }),
          p.campaigns ? el('li', { text: 'Campaigns' }) : null,
          p.prioritySupport ? el('li', { text: 'Priority support' }) : null,
        ),
        button,
      );
    });

    const subscription = context.subscription;
    mount(plan,
      el('h3', { class: 'card-title', text: 'Plan' }),
      el('p', { class: 'setting-note', text: subscription
        ? `${context.plan.name} · ${STATUS_LABEL[subscription.status] || subscription.status}${subscription.currentPeriodEnd ? ` · renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}` : ''}`
        : `${context.plan.name} (free)` }),
      canManage ? null : el('p', { class: 'setting-note', text: 'Only an organisation administrator can change the plan or billing.' }),
      usageLine('Mailboxes', context.usage?.mailboxes ?? 0, context.plan?.mailboxes),
      usageLine('Sends this month', context.usage?.sendsThisMonth ?? 0, context.plan?.monthlySends),
      usageLine('Rules', context.usage?.rules ?? 0, context.plan?.rules),
      usageLine('Webhooks', context.usage?.webhooks ?? 0, context.plan?.webhooks),
      subscription && subscription.status !== 'canceled' && canManage
        ? el('button', { class: 'btn btn-danger', text: 'Cancel subscription', onClick: async () => {
            const ok = await confirmDialog('Cancel your subscription? The workspace drops to the free plan.', { confirmText: 'Cancel subscription', danger: true });
            if (!ok) return;
            try {
              await api.billing.cancel(activeId);
              toast('Subscription canceled.', 'success');
              await refresh();
            } catch (err) { toast(describeApiError(err), 'error'); }
          } })
        : null,
      el('div', { class: 'plan-grid' }, ...cards),
    );
  }

  await refresh();
}
