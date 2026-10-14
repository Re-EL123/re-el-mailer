/**
 * Plan catalogue and effective entitlement.
 *
 * These are pure functions with no I/O, and they are the source of truth for
 * every limit the API enforces. The property that matters most is that a lapsed
 * subscription cannot keep granting a paid plan — that is what stops an expired
 * card from leaving unlimited seats active indefinitely.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PLAN_ID,
  PLANS,
  effectivePlan,
  entitlement,
  plan,
  planList,
  seatAllowance,
} from '../packages/billing/plans.js';

describe('plan catalogue', () => {
  it('exposes the plans cheapest first', () => {
    expect(planList().map((p) => p.id)).toEqual(['solo', 'team', 'business']);
  });

  it('falls back to the free plan for an unknown id', () => {
    expect(plan('does-not-exist').id).toBe(DEFAULT_PLAN_ID);
    expect(plan(undefined).id).toBe('solo');
  });

  it('prices are in minor units and the free plan is zero', () => {
    expect(PLANS.solo.pricePerSeat).toBe(0);
    expect(Number.isInteger(PLANS.team.pricePerSeat)).toBe(true);
    expect(PLANS.business.pricePerSeat).toBeGreaterThan(PLANS.team.pricePerSeat);
  });
});

describe('effectivePlan', () => {
  it('grants the free plan when there is no subscription', () => {
    expect(effectivePlan(null).id).toBe('solo');
  });

  it('grants a paid plan only while the status is active or trialing', () => {
    expect(effectivePlan({ planId: 'team', status: 'active' }).id).toBe('team');
    expect(effectivePlan({ planId: 'team', status: 'trialing' }).id).toBe('team');
  });

  it('drops a lapsed subscription to the free plan', () => {
    for (const status of ['past_due', 'canceled', 'pending', 'suspended']) {
      expect(effectivePlan({ planId: 'business', status }).id).toBe('solo');
    }
  });

  it('ignores an unknown plan id on an active subscription', () => {
    expect(effectivePlan({ planId: 'enterprise', status: 'active' }).id).toBe('solo');
  });
});

describe('seatAllowance', () => {
  it('uses the plan floor when no extra seats were bought', () => {
    const team = plan('team');
    expect(seatAllowance(team, {})).toBe(team.seats);
    expect(seatAllowance(team, null)).toBe(team.seats);
  });

  it('honours purchased seats above the included floor', () => {
    expect(seatAllowance(plan('solo'), { seats: 5 })).toBe(5);
  });

  it('never drops below the plan floor', () => {
    expect(seatAllowance(plan('team'), { seats: 1 })).toBe(plan('team').seats);
  });
});

describe('entitlement', () => {
  it('allows usage strictly below the limit', () => {
    const decision = entitlement({ plan: plan('team'), used: 9, limit: 10, key: 'seats' });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
    expect(decision.reason).toBeNull();
  });

  it('refuses usage at the limit and explains the plan', () => {
    const decision = entitlement({ plan: plan('solo'), used: 1, limit: 1, key: 'seats' });
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.reason).toMatch(/Solo includes 1 seats/);
  });

  it('treats an Infinity limit as unlimited', () => {
    const decision = entitlement({ plan: plan('business'), used: 1000, limit: Infinity, key: 'sends' });
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBeNull();
    expect(decision.remaining).toBeNull();
  });
});
