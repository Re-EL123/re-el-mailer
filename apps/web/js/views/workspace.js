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
const ROLE_OPTIONS = ['member', 'manager', 'admin', 'owner'];

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
    const select = el('select', { class: 'field' },
      ...workspaces.map((w) => el('option', { value: w.id, text: w.name, selected: w.id === activeId })),
    );
    select.addEventListener('change', async () => {
      activeId = select.value;
      const ws = workspaces.find((w) => w.id === activeId);
      if (ws) state.activeWorkspaceId = ws.id;
      await refresh();
    });

    const name = el('input', { class: 'field', placeholder: 'New workspace name', maxlength: 120 });
    const create = el('button', { class: 'btn btn-primary', text: 'Create', onClick: async () => {
      if (!name.value.trim()) return;
      try {
        const created = await api.workspaces.create(name.value.trim());
        toast('Workspace created.', 'success');
        name.value = '';
        await loadWorkspaces();
        activeId = created?.workspace?.id || activeId;
        await refresh();
      } catch (err) { toast(describeApiError(err), 'error'); }
    } });

    mount(header,
      el('h3', { class: 'card-title', text: 'Workspace' }),
      el('p', { class: 'setting-note', text: `Your role here: ${ROLE_LABEL[context.role] || context.role}.` }),
      el('div', { class: 'setting-grid' },
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Current workspace' }), select),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Create another' }), name),
      ),
      create,
    );
  }

  function renderTeam(context) {
    const canManage = ['owner', 'admin'].includes(context.role) || state.user?.role === 'admin';

    const email = el('input', { class: 'field', type: 'email', placeholder: 'colleague@example.com' });
    const role = el('select', { class: 'field' },
      ...ROLE_OPTIONS.map((r) => el('option', { value: r, text: ROLE_LABEL[r] })),
    );
    const add = el('button', { class: 'btn btn-primary', text: 'Add member', onClick: async () => {
      if (!email.value.trim()) return;
      try {
        await api.workspaces.addMember({ workspaceId: activeId, email: email.value.trim(), role: role.value });
        toast('Member added.', 'success');
        email.value = '';
        await refresh();
      } catch (err) { toast(describeApiError(err), 'error'); }
    } });

    const rows = (context.members || []).map((member) => {
      const roleSelect = el('select', { class: 'field field-inline', disabled: !canManage },
        ...ROLE_OPTIONS.map((r) => el('option', { value: r, text: ROLE_LABEL[r], selected: r === member.role })),
      );
      roleSelect.addEventListener('change', async () => {
        try {
          await api.workspaces.updateMember({ workspaceId: activeId, userId: member.userId, role: roleSelect.value });
          toast('Role updated.', 'success');
          await refresh();
        } catch (err) { toast(describeApiError(err), 'error'); await refresh(); }
      });

      return el('div', { class: 'member-row' },
        el('div', { class: 'member-body' },
          el('span', { class: 'member-name', text: member.displayName || member.email }),
          el('span', { class: 'muted small', text: member.email }),
        ),
        roleSelect,
        canManage
          ? el('button', { class: 'btn btn-sm', text: 'Remove', onClick: async () => {
              const ok = await confirmDialog(`Remove ${member.displayName || member.email} from this workspace?`, { confirmText: 'Remove', danger: true });
              if (!ok) return;
              try {
                await api.workspaces.removeMember(member.userId, activeId);
                toast('Member removed.', 'success');
                await refresh();
              } catch (err) { toast(describeApiError(err), 'error'); }
            } })
          : null,
      );
    });

    mount(team,
      el('h3', { class: 'card-title', text: 'Team' }),
      usageLine('Seats used', context.usage?.members ?? 0, context.seats),
      ...(rows.length ? rows : [el('p', { class: 'muted small', text: 'No members yet.' })]),
      canManage
        ? el('div', { class: 'setting-grid' },
            el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Invite by email' }), email),
            el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Role' }), role),
          )
        : null,
      canManage ? add : null,
      canManage
        ? null
        : el('p', { class: 'setting-note', text: 'Only an owner or admin can manage the team.' }),
    );
  }

  function renderPlan(context, planList) {
    const current = context.plan?.id || 'solo';
    const billingReady = Boolean(context.billing?.configured);
    const canManage = ['owner', 'admin'].includes(context.role) || state.user?.role === 'admin';

    const cards = planList.map((p) => {
      const isCurrent = p.id === current;
      const button = isCurrent
        ? el('span', { class: 'pill', text: 'Current plan' })
        : el('button', { class: 'btn btn-primary', text: 'Choose plan', disabled: !canManage, onClick: async () => {
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
