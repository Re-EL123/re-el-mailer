/**
 * Plan catalogue and entitlements.
 *
 * The plans are code, not database rows: they change with a deploy, they are
 * read on every entitlement check, and keeping them out of the database means a
 * plan limit can never be silently edited into an inconsistent state. The
 * database only stores which plan a workspace is on and its billing status.
 *
 * Every numeric limit is *included in the plan*. A purchased seat count above
 * the plan's included seats is honoured as an add-on (see `seatAllowance`).
 */

/** Prices are in minor units (kobo/cents) so no floating point is involved. */
export const CURRENCY = 'ZAR';

/** Number of members included before a workspace must buy extra seats. */
export const PLANS = Object.freeze({
  solo: {
    id: 'solo',
    name: 'Solo',
    blurb: 'One person, one mailbox.',
    pricePerSeat: 0,
    seats: 1,
    mailboxes: 1,
    monthlySends: 500,
    rules: 5,
    webhooks: 0,
    campaigns: false,
    prioritySupport: false,
  },
  team: {
    id: 'team',
    name: 'Team',
    blurb: 'A shared inbox for a small team.',
    pricePerSeat: 14900,
    seats: 10,
    mailboxes: 10,
    monthlySends: 10000,
    rules: 50,
    webhooks: 5,
    campaigns: true,
    prioritySupport: false,
  },
  business: {
    id: 'business',
    name: 'Business',
    blurb: 'Higher volume and every integration.',
    pricePerSeat: 29900,
    seats: 50,
    mailboxes: 50,
    monthlySends: 50000,
    rules: 500,
    webhooks: 25,
    campaigns: true,
    prioritySupport: true,
  },
});

export const DEFAULT_PLAN_ID = 'solo';

/** Statuses that grant the paid plan rather than falling back to the free one. */
const GRANTING_STATUSES = new Set(['active', 'trialing']);

/** @returns {typeof PLANS.solo} the plan for `id`, or the free plan. */
export function plan(id) {
  return PLANS[id] || PLANS[DEFAULT_PLAN_ID];
}

/** Every plan, cheapest first, for the pricing UI. */
export function planList() {
  return Object.values(PLANS);
}

/**
 * Resolve the plan a workspace is actually entitled to.
 *
 * A subscription that is past due or canceled does not keep the paid plan: the
 * workspace drops to the free plan immediately, which is what stops a lapsed
 * card from granting unlimited seats.
 *
 * @param {{planId?: string|null, status?: string|null}} [subscription]
 * @returns {typeof PLANS.solo}
 */
export function effectivePlan(subscription) {
  if (!subscription) return plan(DEFAULT_PLAN_ID);
  if (!GRANTING_STATUSES.has(String(subscription.status))) return plan(DEFAULT_PLAN_ID);
  return plan(subscription.planId);
}

/**
 * Seats available: the greater of what the plan includes and what has been
 * purchased, so buying extra seats on a low tier still works.
 *
 * @param {typeof PLANS.solo} effective
 * @param {{seats?: number|null}} [subscription]
 */
export function seatAllowance(effective, subscription) {
  return Math.max(Number(effective.seats) || 0, Number(subscription?.seats) || 0);
}

/**
 * Shape an entitlement decision, used by guards and the API response so the UI
 * can render why an action was refused without re-deriving the numbers.
 */
export function entitlement({ plan: effective, used = 0, limit = 0, key = 'value' } = {}) {
  const allowed = limit === Infinity || used < limit;
  return {
    key,
    allowed,
    used: Number(used) || 0,
    limit: limit === Infinity ? null : limit,
    remaining: limit === Infinity ? null : Math.max(0, limit - (Number(used) || 0)),
    planId: effective.id,
    reason: allowed ? null : `${effective.name} includes ${limit} ${key}. Upgrade to add more.`,
  };
}
