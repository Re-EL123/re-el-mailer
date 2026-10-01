/**
 * Retention path collection.
 *
 * `storagePathsPendingPurge()` feeds the storage sweep that runs *before* the SQL
 * purge, so two things matter and are easy to get subtly wrong:
 *
 *   • `truncated` must be true whenever paths were left behind, because the
 *     caller skips the SQL purge in that case. Reporting false while the cap cut
 *     the list short would delete rows whose objects were never collected.
 *   • `truncated` must be false when the cap happens to be reached exactly at the
 *     end of the table, or maintenance would defer forever on a stable backlog.
 *
 * The function takes a `db` argument, so a stub is enough — no database needed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/re_el';
process.env.JWT_SECRET = 'test_jwt_secret_that_is_definitely_long_enough_to_pass_validation_0123456789';
process.env.TOKEN_PEPPER = 'test_pepper_also_long_enough_0123456789abcdefghij';

const { storagePathsPendingPurge } = await import('../packages/db/messages.js');

/** Stub that serves `total` rows in pages of the requested size. */
function stubDb(total) {
  const queries = [];
  return {
    queries,
    async queryAll(sql, params) {
      queries.push(params);
      const [, , pageSize, offset] = params;
      const rows = [];
      for (let i = offset; i < Math.min(offset + pageSize, total); i += 1) {
        rows.push({ storage_path: `mbx/msg_${String(i).padStart(4, '0')}.pdf` });
      }
      return rows;
    },
  };
}

let total;
let db;

beforeEach(() => {
  total = 0;
  db = stubDb(0);
});

describe('storagePathsPendingPurge', () => {
  it('returns nothing when no message is past retention', async () => {
    db = stubDb(0);
    const result = await storagePathsPendingPurge({ trashDays: 30, spamDays: 30 }, db);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('collects every path when the backlog fits under the cap', async () => {
    db = stubDb(2500);
    const result = await storagePathsPendingPurge({ pageSize: 1000 }, db);
    expect(result.paths).toHaveLength(2500);
    expect(result.truncated).toBe(false);
    expect(new Set(result.paths).size).toBe(2500);
  });

  it('pages with an offset instead of loading the whole table', async () => {
    db = stubDb(2500);
    await storagePathsPendingPurge({ pageSize: 1000 }, db);
    expect(db.queries.map((p) => p[3])).toEqual([0, 1000, 2000]);
  });

  it('flags truncation and stops at the cap', async () => {
    db = stubDb(2500);
    const result = await storagePathsPendingPurge({ pageSize: 1000, maxPaths: 1500 }, db);
    expect(result.paths).toHaveLength(1500);
    expect(result.truncated).toBe(true);
  });

  it('flags truncation when a full page sits exactly on the cap', async () => {
    db = stubDb(2000);
    const result = await storagePathsPendingPurge({ pageSize: 1000, maxPaths: 1000 }, db);
    expect(result.paths).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('does not flag truncation when the cap coincides with the end of the table', async () => {
    // 1000 rows with a cap of 1000 and a page size of 1000: the first page is
    // full, but there is nothing after it, so nothing was left behind.
    db = stubDb(1000);
    const result = await storagePathsPendingPurge({ pageSize: 1000, maxPaths: 1000 }, db);
    expect(result.paths).toHaveLength(1000);
    expect(result.truncated).toBe(false);
  });

  it('never returns more than the cap even on the final partial page', async () => {
    db = stubDb(3);
    const result = await storagePathsPendingPurge({ pageSize: 2, maxPaths: 2 }, db);
    expect(result.paths).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('collects nothing and reports truncation for a zero cap', async () => {
    db = stubDb(3);
    const result = await storagePathsPendingPurge({ pageSize: 2, maxPaths: 0 }, db);
    expect(result.paths).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it('ignores rows with no storage path', async () => {
    db = {
      async queryAll() {
        return [{ storage_path: null }, { storage_path: 'mbx/a.pdf' }, { storage_path: undefined }];
      },
    };
    const result = await storagePathsPendingPurge({}, db);
    expect(result.paths).toEqual(['mbx/a.pdf']);
  });
});