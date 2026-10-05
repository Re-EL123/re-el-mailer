/**
 * Attachment lookup SQL.
 *
 * findAttachment() filtered on `a.is_deleted` but selected the table without
 * declaring the alias, so Postgres rejected the statement with
 *
 *   missing FROM-clause entry for table "a"   (SQLSTATE 42P01)
 *
 * The failure sat directly on the attachment-download path: the client asks for
 * a signed URL, the server resolves the row, and a missing alias meant every
 * single download 500'd. Nothing covered it because the attachment tests only
 * ever exercised the upload half.
 *
 * The statement is pinned here with a check that generalises past this one bug:
 * every `<alias>.` reference in the SQL must be bound by an `as <alias>` (or
 * bare-alias) declaration in the from clause. A stray alias can therefore not
 * creep back into any of these queries unnoticed.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../packages/db/pool.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  queryAll: vi.fn(async () => []),
  default: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    queryAll: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
  },
}));

const { findAttachment, listAttachments } = await import('../packages/db/messages.js');

/**
 * Collect the table aliases a from clause binds, e.g.
 *   "from public.attachments a"            -> ['attachments']
 *   "from public.attachments as a"         -> ['attachments']
 *   "from public.attachments"              -> ['attachments']
 *   "from public.a, public.b as b"         -> ['a', 'b']
 */
function boundAliases(sql) {
  const from = sql.slice(sql.indexOf('from '));
  // Stop at the first clause keyword that ends the from list.
  const list = from.split(/\b(where|order by|group by|limit|returning|join)\b/i)[0];
  const aliases = [];
  // Table references, optionally followed by `as alias` or a bare alias.
  for (const m of list.matchAll(/\b([a-z_][\w]*)\.(\w+)(?:\s+(?:as\s+)?(\w+))?/g)) {
    const [full, qualifier, table, alias] = m;
    // A bare word after the table is only an alias if it isn't a keyword.
    const bare = alias && !['on', 'where', 'order', 'group', 'limit', 'join', 'inner', 'left', 'set', 'using'].includes(alias.toLowerCase());
    // `schema.table` resolves through the schema, so both parts are reachable
    // from the row — recording the qualifier here is what stops "public." in
    // `public.attachments a` from being mistaken for an undeclared alias.
    aliases.push(qualifier);
    aliases.push(bare ? alias : table);
    void full;
  }
  return new Set(aliases.map((a) => a.toLowerCase()));
}

/** Every `<name>.` qualifier referenced anywhere in the statement. */
function referencedQualifiers(sql) {
  return new Set(
    [...sql.matchAll(/\b([a-z_]\w*)\.[a-z_]\w+/g)].map((m) => m[1].toLowerCase()),
  );
}

async function captureSql(fn) {
  const queryOne = vi.fn(async () => null);
  const queryAll = vi.fn(async () => []);
  await fn({ queryOne, queryAll });
  return queryOne.mock.calls[0]?.[0] ?? queryAll.mock.calls[0]?.[0];
}

describe('attachment lookup statements', () => {
  it('findAttachment declares every alias it references', async () => {
    const sql = await captureSql((db) => findAttachment('att_1', 'msg_1', db));

    expect(sql).toBeTruthy();
    const bound = boundAliases(sql);
    for (const qualifier of referencedQualifiers(sql)) {
      expect(
        bound.has(qualifier),
        `findAttachment references "${qualifier}." but never binds it in the from clause — this is the 42P01 bug. SQL: ${sql}`,
      ).toBe(true);
    }
  });

  it('findAttachment filters out soft-deleted rows and scopes to the message', async () => {
    const queryOne = vi.fn(async () => null);
    await findAttachment('att_1', 'msg_1', { queryOne });

    const [sql, params] = queryOne.mock.calls[0];
    expect(sql.toLowerCase()).toContain('is_deleted');
    expect(params).toEqual(['att_1', 'msg_1']);
  });

  it('listAttachments declares every alias it references', async () => {
    const sql = await captureSql((db) => listAttachments('msg_1', db));

    expect(sql).toBeTruthy();
    const bound = boundAliases(sql);
    for (const qualifier of referencedQualifiers(sql)) {
      expect(
        bound.has(qualifier),
        `listAttachments references "${qualifier}." but never binds it in the from clause. SQL: ${sql}`,
      ).toBe(true);
    }
  });
});