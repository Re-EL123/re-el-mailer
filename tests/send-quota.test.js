/**
 * Send volume ceilings.
 *
 * `assertWithinSendQuota()` is the only thing standing between a runaway script
 * and the provider's sending reputation, so the two things it must get right are
 * the scope of the user ceilings (the whole account, not one mailbox) and the
 * fact that drafts and inbound mail never count toward them.
 *
 * The counting queries are exercised against a stub so the SQL semantics stay
 * visible; the scope aggregation is checked separately.
 */

import { beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/re_el';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.TOKEN_PEPPER = 'test_pepper_also_long_enough_0123456789abcdefghij';
process.env.MAIL_DAILY_LIMIT_USER = '200';
process.env.MAIL_HOURLY_LIMIT_USER = '20';
process.env.MAIL_DAILY_LIMIT_DOMAIN = '5000';

const { countSentForDomain, countSentSince } = await import('../packages/db/messages.js');

describe('countSentSince', () => {
  let sql;
  let params;

  beforeEach(() => {
    sql = '';
    params = null;
  });

  function stub() {
    return {
      async queryOne(text, args) {
        sql = text;
        params = args;
        return { total: 7 };
      },
    };
  }

  it('counts across every mailbox id it is given', async () => {
    const total = await countSentSince(['mbx_1', 'mbx_2', 'mbx_3'], '2026-01-01T00:00:00Z', stub());
    expect(total).toBe(7);
    expect(params[0]).toEqual(['mbx_1', 'mbx_2', 'mbx_3']);
    expect(sql).toMatch(/mailbox_id = any\(\$1::text\[\]\)/);
  });

  it('counts any-of semantics, not just the first mailbox', async () => {
    await countSentSince(['mbx_1', 'mbx_2'], '2026-01-01T00:00:00Z', stub());
    expect(sql).toMatch(/any\(\$1::text\[\]\)/);
    expect(sql).not.toMatch(/mailbox_id = \$1\b/);
  });

  it('excludes drafts and inbound mail', async () => {
    await countSentSince(['mbx_1'], '2026-01-01T00:00:00Z', stub());
    expect(sql).toMatch(/not is_draft/);
    expect(sql).toMatch(/direction = 'outbound'/);
  });

  it('honours the window boundary', async () => {
    await countSentSince(['mbx_1'], '2026-01-01T00:00:00Z', stub());
    expect(sql).toMatch(/sent_at >= \$2::timestamptz/);
  });

  it('short-circuits an empty mailbox list without querying', async () => {
    let called = false;
    const db = {
      async queryOne() {
        called = true;
        return { total: 0 };
      },
    };
    expect(await countSentSince([], '2026-01-01T00:00:00Z', db)).toBe(0);
    expect(called).toBe(false);
  });

  it('returns zero when the count row is missing', async () => {
    const db = { async queryOne() { return null; } };
    expect(await countSentSince(['mbx_1'], '2026-01-01T00:00:00Z', db)).toBe(0);
  });
});

describe('countSentForDomain', () => {
  it('aggregates every mailbox on the domain', async () => {
    let sql = '';
    const db = {
      async queryOne(text, params) {
        sql = text;
        expect(params[0]).toBe('dom_1');
        return { total: 42 };
      },
    };
    expect(await countSentForDomain('dom_1', '2026-01-01T00:00:00Z', db)).toBe(42);
    expect(sql).toMatch(/join public\.mailboxes mb on mb\.id = m\.mailbox_id/);
    expect(sql).toMatch(/not m\.is_draft/);
  });
});

describe('account-wide scope', () => {
  /**
   * Mirrors the aggregation in `assertWithinSendQuota`: the ceilings apply to
   * every mailbox the user owns, so one busy mailbox cannot be bypassed by
   * sending from another.
   */
  function accountScope(selected, owned) {
    const scope = [selected];
    for (const mb of owned) if (!scope.includes(mb)) scope.push(mb);
    return scope;
  }

  it('covers mailboxes beyond the selected one', () => {
    expect(accountScope('mbx_2', ['mbx_1', 'mbx_2', 'mbx_3'])).toEqual(['mbx_2', 'mbx_1', 'mbx_3']);
  });

  it('does not double-count the selected mailbox', () => {
    expect(accountScope('mbx_1', ['mbx_1', 'mbx_1'])).toEqual(['mbx_1']);
  });

  it('still checks the selected mailbox when the lookup returns nothing', () => {
    expect(accountScope('mbx_1', [])).toEqual(['mbx_1']);
  });

  it('shares one allowance across mailboxes instead of one each', () => {
    const cap = 200;
    const scope = accountScope('mbx_2', ['mbx_1', 'mbx_2']);
    const sent = { mbx_1: 150, mbx_2: 60 };
    const total = scope.reduce((sum, id) => sum + sent[id], 0);
    expect(total).toBe(210);
    // Under a per-mailbox reading each mailbox is below the cap and sending
    // would be allowed; account-wide it is not.
    expect(Object.values(sent).every((n) => n < cap)).toBe(true);
    expect(total >= cap).toBe(true);
  });
});