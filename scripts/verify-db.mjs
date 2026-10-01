#!/usr/bin/env node
/**
 * Verify the database layer against a real PostgreSQL.
 *
 * Boots a throwaway Postgres (embedded-postgres, the same engine Supabase runs),
 * applies `database/schema.sql` followed by every migration in order, and then
 * exercises the parts that are easy to get wrong: the trigger functions, the
 * quota guard, inbound recipient resolution and the retention purge.
 *
 * This exists because none of it can be verified by reading — a data-modifying
 * CTE with the wrong scope or a `union all` with an unordered `limit 1` parses
 * fine and fails at runtime.
 *
 * Usage: npm run db:verify
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = path.join(ROOT, 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');

const PORT = Number(process.env.DB_VERIFY_PORT || 55432);
const DATA_DIR = path.join(ROOT, '.tmp', 'pgdata');
const BASE = `postgres://postgres:postgres@127.0.0.1:${PORT}`;

let failures = 0;
const ok = (message) => console.log(`  \x1b[32m✓\x1b[0m ${message}`);
const bad = (message, detail = '') => {
  failures += 1;
  console.error(`  \x1b[31m✗\x1b[0m ${message}${detail ? `\n      ${detail}` : ''}`);
};

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });

  console.log('\n\x1b[1m1. Booting PostgreSQL\x1b[0m');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('re_el');
  const { default: pgClient } = await import('pg');
  const Client = typeof pgClient === 'function' ? pgClient : pgClient.Client;
  const client = new Client({ connectionString: `${BASE}/re_el` });
  await client.connect();

  try {
    // Supabase provisions these roles; the RLS policies at the end of schema.sql
    // are written against them, so stand them up before applying anything.
    await client.query(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end
      $$;
    `);

    // ─── schema ──────────────────────────────────────────────────────────────
    console.log('\n\x1b[1m2. Supabase stand-ins + database/schema.sql\x1b[0m');

    // `storage` is a Supabase-provided schema that a vanilla Postgres does not
    // have, and schema.sql creates the attachment bucket in it. Stand it up
    // first; on a real Supabase project the existing schema wins and the
    // `create schema if not exists` below is a no-op.
    await client.query(`
      create schema if not exists storage;
      create table if not exists storage.buckets (
        id text primary key,
        name text not null,
        public boolean default false,
        file_size_limit bigint,
        allowed_mime_types text[]
      );
      grant usage on schema storage to anon, authenticated;
      grant select on storage.buckets to anon, authenticated;
    `);
    ok('storage schema stand-in created');

    try {
      await client.query(fs.readFileSync(SCHEMA, 'utf8'));
      ok('schema applied');
    } catch (err) {
      bad('schema.sql failed', err.message);
      return;
    }

    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    ok(`${tables.rowCount} tables: ${tables.rows.map((r) => r.table_name).join(', ')}`);

    // Supabase grants anon/authenticated/service_role full table privileges in
    // public and relies on RLS for access control. Mirror that here, otherwise
    // privilege denial would mask whether the policies actually hold.
    await client.query(`
      grant usage on schema public to anon, authenticated, service_role;
      grant all on all tables in schema public to anon, authenticated, service_role;
      grant all on all sequences in schema public to anon, authenticated, service_role;
      alter default privileges in schema public
        grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public
        grant all on sequences to anon, authenticated, service_role;
    `);
    ok('Supabase-style table privileges granted to anon, authenticated and service_role');

    const bucket = await client.query(`select id, public from storage.buckets where id = 'mail-attachments'`);
    ok(
      bucket.rows[0] && bucket.rows[0].public === false
        ? 'mail-attachments bucket exists and is private'
        : 'mail-attachments bucket missing or public',
    );

    // ─── migrations ──────────────────────────────────────────────────────────
    console.log('\n\x1b[1m4. Migrations\x1b[0m');
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        ok(file);
      } catch (err) {
        bad(`${file} failed`, err.message);
      }
    }

    // Re-running migrations must be safe: they are all written to be idempotent.
    console.log('\n\x1b[1m5. Migration idempotency\x1b[0m');
    for (const file of files) {
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        ok(`${file} re-applied`);
      } catch (err) {
        bad(`${file} is not idempotent`, err.message);
      }
    }

    // ─── behaviour ───────────────────────────────────────────────────────────
    console.log('\n\x1b[1m6. Seed data and behaviour\x1b[0m');
    const now = new Date().toISOString();

    // 0001 already seeded the default domain, so this only needs to be sure it
    // is active with a known id.
    await client.query(
      `insert into public.domains (id, name, status, verification_token)
       values ('dom_test', 're-el.co.za', 'active', 'verify_test')
       on conflict (name) do update set status = 'active', updated_at = now()`,
    );
    const domainId = await client.query(`select id from public.domains where name = 're-el.co.za'`);
    const DOMAIN_ID = domainId.rows[0].id;
    ok(`default domain present (${DOMAIN_ID})`);

    const bcryptish = '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU';

    // Credentials live on users; a mailbox inherits them through its user_id.
    await client.query(
      `insert into public.users (id, email, password_hash, display_name, role, status)
       values ('usr_admin', 'admin@re-el.co.za', $1, 'Admin', 'admin', 'active')`,
      [bcryptish],
    );

    await client.query(
      `insert into public.mailboxes
         (id, user_id, domain_id, email, display_name, status, quota_bytes,
          storage_used_bytes, daily_send_limit, hourly_send_limit, is_primary)
       values
         ('mbx_main', 'usr_admin', $1, 'admin@re-el.co.za', 'Admin', 'active',
          5368709120, 0, 500, 40, true),
         ('mbx_support', 'usr_admin', $1, 'support@re-el.co.za', 'Support', 'active',
          5368709120, 0, 500, 40, false)`,
      [DOMAIN_ID],
    );

    await client.query(
      `update public.settings set value = '["support@re-el.co.za"]'::jsonb
       where key = 'support_emails'`,
    );

    const mailbox = await client.query(
      `select * from public.mailbox_directory where email = 'admin@re-el.co.za'`,
    );
    ok(mailbox.rowCount === 1 ? 'mailbox_directory view returns the mailbox' : 'mailbox_directory view returned nothing');

    // Migration 0002 seeds default labels for mailboxes that exist at the time it
// runs. Re-running it after the fixtures are in place is exactly what happens
// when an admin adds a mailbox to an existing deployment, so it doubles as the
// "new mailboxes get default labels" check.
await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, '0002_labels_and_retention.sql'), 'utf8'));
const labels = await client.query(`select name from public.labels where mailbox_id = 'mbx_main' order by sort_order`);
    ok(
      labels.rowCount === 4
        ? `default labels seeded: ${labels.rows.map((r) => r.name).join(', ')}`
        : `expected 4 default labels, got ${labels.rowCount}`,
    );

    // set_updated_at trigger
    await client.query(`update public.mailboxes set display_name = 'Admin Renamed' where id = 'mbx_main'`);
    const triggerCheck = await client.query(
      `select updated_at > created_at as touched from public.mailboxes where id = 'mbx_main'`,
    );
    ok(triggerCheck.rows[0]?.touched ? 'set_updated_at trigger fires on update' : 'set_updated_at trigger did not fire');

    // Quota guard. `storage_used_bytes` is a running total refreshed separately
// (packages/db/mailboxes.js → refreshMailboxUsage), and the trigger refuses any
// insert that would push the mailbox past `quota_bytes`.
const CAP = 5368709120;
await client.query(`update public.mailboxes set storage_used_bytes = $1 where id = 'mbx_main'`, [CAP - 2000]);
    try {
      await client.query(
        `insert into public.messages (id, mailbox_id, thread_id, folder, subject, body_html, size_bytes)
         values ('msg_quota', 'mbx_main', 'thr_quota', 'inbox', 'Under quota', '', 1024)`,
      );
      ok('enforce_mailbox_quota allows an insert that fits');
    } catch (err) {
      bad(`enforce_mailbox_quota rejected a fitting insert: ${err.message}`);
    }

    await client.query(`update public.mailboxes set storage_used_bytes = $1 where id = 'mbx_main'`, [CAP - 500]);
    const quotaBlocked = await client.query(
      `insert into public.messages (id, mailbox_id, thread_id, folder, subject, body_html, size_bytes)
       values ('msg_quota2', 'mbx_main', 'thr_quota2', 'inbox', 'Over quota', '', 1024)`,
    ).then(() => false, (err) => err.message);
    if (quotaBlocked === false) {
      bad('enforce_mailbox_quota allowed a message past the storage quota');
    } else {
      ok(`enforce_mailbox_quota rejects over-quota insert: ${String(quotaBlocked).split('\n')[0]}`);
    }
    await client.query(`delete from public.messages where id in ('msg_quota', 'msg_quota2')`);
    await client.query(`update public.mailboxes set storage_used_bytes = 0 where id = 'mbx_main'`);

    // Inbound resolution, before any routes exist: an address that is not a
    // mailbox and has no route must resolve to nothing, which the API answers
    // with a 550 to the sender.
    const unrouted = await client.query(`select * from public.resolve_inbound_recipient($1)`, ['unknown@re-el.co.za']);
    if (unrouted.rowCount === 0) ok('resolve_inbound_recipient: unrouted address matches nothing');
    else bad(`resolve_inbound_recipient: unrouted address returned ${JSON.stringify(unrouted.rows[0])}`);

    await client.query(
      `insert into public.inbound_routes (id, domain_id, pattern, mailbox_id, action, priority)
       values ('rte_catchall', $1, '*', 'mbx_main', 'deliver', 900)`,
      [DOMAIN_ID],
    );
    await client.query(
      `insert into public.inbound_routes (id, domain_id, pattern, mailbox_id, action, priority)
       values ('rte_support', $1, 'support+*', 'mbx_support', 'deliver', 10)`,
      [DOMAIN_ID],
    );

    const cases = [
      ['admin@re-el.co.za', 'mbx_main', 'exact mailbox wins over the catch-all route'],
      ['support+tag@re-el.co.za', 'mbx_support', 'plus addressing resolves through a support+* route'],
      ['unknown@re-el.co.za', 'mbx_main', 'catch-all route delivers'],
    ];
    for (const [address, expected, label] of cases) {
      const result = await client.query(`select * from public.resolve_inbound_recipient($1)`, [address]);
      const actual = result.rows[0]?.mailbox_id ?? null;
      if (actual === expected) ok(`resolve_inbound_recipient: ${label}`);
      else bad(`resolve_inbound_recipient: ${label} — expected ${expected}, got ${actual}`);
    }

    // auto_read travels back with the route so the webhook can decide the
    // incoming read state without a second lookup.
    await client.query(`update public.mailboxes set auto_read = true where id = 'mbx_support'`);
    const autoReadRoute = await client.query(`select auto_read from public.resolve_inbound_recipient($1)`, [
      'support+tag@re-el.co.za',
    ]);
    if (autoReadRoute.rows[0]?.auto_read === true) ok('resolve_inbound_recipient: carries mailbox auto_read');
    else bad(`resolve_inbound_recipient: auto_read not propagated — got ${JSON.stringify(autoReadRoute.rows[0])}`);
    await client.query(`update public.mailboxes set auto_read = false where id = 'mbx_support'`);

    const rejectRoute = await client.query(
      `insert into public.inbound_routes (id, domain_id, pattern, mailbox_id, action, priority)
       values ('rte_blocked', $1, 'noreply', null, 'reject', 5)
       on conflict do nothing`,
      [DOMAIN_ID],
    ).then(() => null, (err) => err);
    if (rejectRoute) bad(`could not add a reject route: ${rejectRoute.message}`);

    const rejected = await client.query(`select * from public.resolve_inbound_recipient($1)`, ['noreply@re-el.co.za']);
    if (rejected.rows[0]?.action === 'reject') ok('resolve_inbound_recipient: reject route reported for the API to answer');
    else bad(`reject route not honoured: ${JSON.stringify(rejected.rows[0])}`);

    // Retention purge — the CTE-scope bug this check was written for.
    await client.query(
      `insert into public.messages (id, mailbox_id, thread_id, folder, subject, is_deleted, updated_at)
       values ('msg_trash', 'mbx_main', 'thr_trash', 'trash', 'Old trash', true, now() - interval '90 days')`,
    );
    await client.query(
      `insert into public.messages (id, mailbox_id, thread_id, folder, subject, is_deleted, updated_at)
       values ('msg_kept', 'mbx_main', 'thr_kept', 'inbox', 'Keep me', false, now())`,
    );
    const purged = await client.query(`select * from public.purge_expired_messages(30, 30)`);
    const row = purged.rows[0] ?? {};
    const survivors = await client.query(
      `select id from public.messages where id in ('msg_trash', 'msg_kept') order by id`,
    );
    ok(
      Number(row.messages_purged) === 1 && Number(row.attachments_purged) === 0
        ? 'purge_expired_messages removed 1 expired message, 0 attachments'
        : `purge_expired_messages returned ${JSON.stringify(row)} (expected messages_purged=1)`,
    );
    ok(
      survivors.rowCount === 1 && survivors.rows[0].id === 'msg_kept'
        ? 'purge_expired_messages kept the live message'
        : `purge_expired_messages wrong survivors: ${survivors.rows.map((r) => r.id).join(', ')}`,
    );

    // Cascade + full-text
// search_vector is a generated column, so the fixture only supplies the text and
    // the tsvector is built by the database itself.
    await client.query(
      `insert into public.messages (id, mailbox_id, thread_id, folder, subject, body_text)
       values ('msg_search', 'mbx_main', 'thr_search', 'inbox', 'Quarterly invoice', 'attached is the invoice')`,
    );
    const generatedVector = await client.query(
      `select search_vector::text as v from public.messages where id = 'msg_search'`,
    );
    ok(
      generatedVector.rows[0]?.v ? 'search_vector generated from subject and body' : 'search_vector was not generated',
    );
    const search = await client.query(
      `select id from public.messages where mailbox_id = 'mbx_main'
         and search_vector @@ websearch_to_tsquery('english', $1)`,
      ['invoice'],
    );
    ok(search.rowCount === 1 ? 'search_vector full-text query finds the message' : 'full-text search found nothing');

    await client.query(
      `insert into public.attachments (id, message_id, mailbox_id, filename, size_bytes, storage_path)
       values ('att_one', 'msg_search', 'mbx_main', 'invoice.pdf', 12, 'mbx_main/x/invoice.pdf')`,
    );
    await client.query(`delete from public.messages where id = 'msg_search'`);
    const orphans = await client.query(`select count(*)::int as n from public.attachments where id = 'att_one'`);
    ok(orphans.rows[0].n === 0 ? 'attachments cascade on message delete' : 'orphaned attachment left behind');

    // Usage views
    const usage = await client.query(`select * from public.usage_daily limit 1`);
    ok(usage.rows.length <= 1 ? 'usage_daily view is queryable' : 'usage_daily view returned unexpected rows');
    const health = await client.query(`select * from public.delivery_health`);
    ok(Array.isArray(health.rows) ? 'delivery_health view is queryable' : 'delivery_health view failed');
    const rollup = await client.query(`select * from public.storage_rollup`);
    ok(Array.isArray(rollup.rows) ? 'storage_rollup view is queryable' : 'storage_rollup view failed');
    const folders = await client.query(`select * from public.folder_totals where user_id = 'usr_admin'`);
    ok(
      folders.rowCount === 1
        ? `folder_totals view returns per-user counts (${folders.rows[0].total} messages)`
        : 'folder_totals view returned an unexpected number of rows',
    );

    // ── the application's own query layer ────────────────────────────────────
    // Sections 2–6 check the SQL. This runs the real repository functions
    // against the same database, which is what catches bind-parameter mistakes
    // that a schema-only review cannot see.
    console.log('\n\x1b[1m7. Application query layer\x1b[0m');
    process.env.DATABASE_URL = `${BASE}/re_el`;
    process.env.DATABASE_SSL = 'false';
    process.env.JWT_SECRET = 'verify-secret-at-least-32-characters-long';
    process.env.SESSION_SECRET = process.env.JWT_SECRET;
    process.env.APP_URL = 'http://localhost:3000';

    const messages = await import('../packages/db/messages.js');
    const mailboxes = await import('../packages/db/mailboxes.js');
    const system = await import('../packages/db/system.js');
    const users = await import('../packages/db/users.js');

    // storagePathsPendingPurge must page rather than cap. It runs immediately
    // before the SQL purge, which deletes every eligible row in one statement —
    // so a truncated path list would orphan objects nothing points at any more.
    const PAGE_PATHS = 2500;
    for (let i = 0; i < PAGE_PATHS; i += 1) {
      await client.query(
        `insert into public.messages (id, mailbox_id, thread_id, folder, subject, is_deleted, updated_at)
         values ($1, 'mbx_main', $2, 'trash', 'Bulk', true, now() - interval '90 days')`,
        [`msg_bulk_${i}`, `thr_bulk_${i}`],
      );
      await client.query(
        `insert into public.attachments
           (id, message_id, mailbox_id, filename, mime_type, size_bytes, storage_bucket, storage_path)
         values ($1, $2, 'mbx_main', 'f.txt', 'text/plain', 10, 'mail-attachments', $3)`,
        [`att_bulk_${i}`, `msg_bulk_${i}`, `mbx_main/msg_bulk_${i}/att_bulk_${i}/f.txt`],
      );
    }
    const pendingPaths = await messages.storagePathsPendingPurge({ trashDays: 30, spamDays: 30 });
    ok(
      pendingPaths.paths.length === PAGE_PATHS && pendingPaths.truncated === false
        ? `storagePathsPendingPurge returned all ${PAGE_PATHS} paths across pages`
        : `storagePathsPendingPurge returned ${pendingPaths.paths.length} paths (truncated=${pendingPaths.truncated}); expected ${PAGE_PATHS}`,
    );
    await client.query(`delete from public.messages where id like 'msg_bulk_%'`);

// Section 6 leaves one live message behind for the retention assertions; clear
    // it so the counts below are exactly what this section created.
    await client.query(`delete from public.messages where id = 'msg_kept'`);

    const seeded = await messages.createMessage({
      mailboxId: 'mbx_main',
      direction: 'inbound',
      fromEmail: 'client@example.com',
      fromName: 'Thandi Mokoena',
      to: ['admin@re-el.co.za'],
      subject: 'Quarterly invoice for August',
      bodyHtml: '<p>Please find the invoice attached.</p>',
      bodyText: 'Please find the invoice attached.',
      folder: 'inbox',
      isRead: false,
      hasAttachments: true,
      sizeBytes: 2048,
      receivedAt: new Date(Date.now() - 3600_000).toISOString(),
    });
    ok(`createMessage stored ${seeded.id} in thread ${seeded.thread_id}`);

    const sentOne = await messages.createMessage({
      mailboxId: 'mbx_main',
      direction: 'outbound',
      fromEmail: 'admin@re-el.co.za',
      to: ['client@example.com'],
      subject: 'Re: Quarterly invoice',
      bodyText: 'Received, thank you.',
      folder: 'sent',
      isRead: true,
      sizeBytes: 512,
      sentAt: new Date().toISOString(),
    });
    ok('createMessage stored an outbound message');

    // Search: free text first, because that is where the parameter numbering is.
    const byText = await messages.search('mbx_main', 'invoice', { limit: 10 });
    ok(
      byText.total === 1 && byText.rows[0].id === seeded.id
        ? 'search finds the message by free text, with a highlight fragment'
        : `search by text returned ${byText.total} rows`,
    );
    ok(
      typeof byText.rows[0]?.highlight === 'string' && byText.rows[0].highlight.includes('tsvector') === false
        ? 'search returns a highlight fragment'
        : 'search produced no highlight',
    );

    // Operator-only searches have no free-text term at all. This is the case that
    // silently ranked by the wrong bind parameter.
    const byOperator = await messages.search('mbx_main', 'is:unread', { limit: 10 });
    ok(byOperator.total === 1 ? 'search handles an operator-only query (is:unread)' : `is:unread returned ${byOperator.total} rows`);

    const byFolder = await messages.search('mbx_main', 'in:sent', { limit: 10 });
    ok(byFolder.total === 1 && byFolder.rows[0].id === sentOne.id ? 'search honours in:sent' : 'search ignored in:sent');

    const byFrom = await messages.search('mbx_main', 'from:client@example.com', { limit: 10 });
    ok(byFrom.total === 1 ? 'search honours from:' : `from: returned ${byFrom.total} rows`);

    const byHas = await messages.search('mbx_main', 'has:attachment', { limit: 10 });
    ok(byHas.total === 1 ? 'search honours has:attachment' : `has:attachment returned ${byHas.total} rows`);

    const byLabel = await messages.search('mbx_main', 'label:finance', { limit: 10 });
    ok(byLabel.total === 0 ? 'search honours label: with no matches' : 'label: matched unexpectedly');

    const byAfter = await messages.search('mbx_main', 'after:2000-01-01', { limit: 10 });
    ok(byAfter.total === 2 ? 'search honours after:' : `after: returned ${byAfter.total} rows`);

    // A free-text term containing SQL metacharacters must not change the query.
    const injection = await messages.search('mbx_main', "'; drop table public.messages; --", { limit: 5 });
    ok(injection.total === 0 ? 'search treats SQL metacharacters as literal text' : 'search matched an injection payload');
    const tableStillThere = await client.query(`select count(*)::int as n from information_schema.tables where table_schema='public' and table_name='messages'`);
    ok(tableStillThere.rows[0].n === 1 ? 'messages table survived the injection attempt' : 'messages table is gone');

    const listed = await messages.listByFolder('mbx_main', 'inbox', { limit: 10 });
    ok(
      listed.length === 1 && true
        ? 'listByFolder returns inbox rows with attachment rollup'
        : `listByFolder returned unexpected shape: ${listed[0]?.attachments}`,
    );

    const unread = await messages.countUnread('mbx_main');
    ok(unread === 1 ? 'countUnread matches the seeded unread message' : `countUnread returned ${unread}`);

    await messages.markAllRead('mbx_main', 'inbox');
    ok((await messages.countUnread('mbx_main')) === 0 ? 'markAllRead clears the unread count' : 'markAllRead did nothing');

    await messages.moveToFolder([seeded.id], 'mbx_main', 'archive');
    const archived = await messages.listByFolder('mbx_main', 'archive', { limit: 10 });
    ok(archived.length === 1 ? 'moveToFolder moves a message between folders' : 'moveToFolder did not move the message');
    await messages.moveToFolder([seeded.id], 'mbx_main', 'inbox');

    const starred = await messages.listStarred('mbx_main', { limit: 10 });
    ok(starred.length === 0 ? 'listStarred is empty before starring' : 'listStarred returned rows unexpectedly');
    await messages.update(seeded.id, 'mbx_main', { isStarred: true });
    ok((await messages.listStarred('mbx_main', { limit: 10 })).length === 1 ? 'update() sets is_starred' : 'update() did not star the message');

    const threadRows = await messages.listThread(seeded.thread_id, 'mbx_main');
    ok(threadRows.length === 1 ? 'listThread returns the thread' : `listThread returned ${threadRows.length} rows`);

    // Ownership: a message from another mailbox must be invisible and unmodifiable.
    const other = await messages.findOwned(sentOne.id, 'mbx_support');
    ok(other === null ? 'findOwned refuses a message from another mailbox' : 'findOwned leaked another mailbox\'s message');
    const crossUpdate = await messages
      .update(sentOne.id, 'mbx_support', { isRead: false })
      .then(() => 'allowed', (err) => err.code);
    ok(crossUpdate !== 'allowed' ? 'update() refuses to touch another mailbox\'s message' : 'update() crossed mailbox boundaries');

    // Mailboxes, labels, contacts
    const directory = await mailboxes.findMailboxByEmail('admin@re-el.co.za');
    ok(directory?.id === 'mbx_main' ? 'findMailboxByEmail resolves a login address' : 'findMailboxByEmail failed');

    const labelsFor = await mailboxes.listLabels('mbx_main');
    ok(labelsFor.length === 4 ? 'listLabels returns the four default labels' : `listLabels returned ${labelsFor.length}`);
    const newLabel = await mailboxes.createLabel({ mailboxId: 'mbx_main', name: 'Urgent', color: '#BA133A' });
    ok(newLabel?.id ? 'createLabel adds a label' : 'createLabel failed');
    await mailboxes.setMessageLabels(seeded.id, [newLabel.id]);
    const byLabelled = await messages.search('mbx_main', 'label:urgent', { limit: 5 });
    ok(byLabelled.total === 1 ? 'a labelled message is findable by label slug' : 'label search found nothing after labelling');
    await mailboxes.deleteLabel(newLabel.id, 'mbx_main');
    ok((await mailboxes.listLabels('mbx_main')).length === 4 ? 'deleteLabel removes the label' : 'deleteLabel did not remove the label');

    await mailboxes.rememberContacts('mbx_main', [
      { name: 'Thandi Mokoena', email: 'client@example.com' },
      { name: 'Client', email: 'CLIENT@example.com' },
    ]);
    const contacts = await mailboxes.searchContacts('mbx_main', { search: 'client' });
    ok(
      contacts.length === 1 ? 'rememberContacts de-duplicates by address, case-insensitively' : `searchContacts returned ${contacts.length} rows`,
    );

    const counts = await mailboxes.folderCounts('mbx_main');
    ok(counts?.inbox === 1 && counts?.sent === 1 ? 'folderCounts reports per-folder totals' : `folderCounts returned ${JSON.stringify(counts)}`);

    const quota = await mailboxes.quotaStatus('mbx_main');
    ok(quota && quota.quotaBytes > 0 ? 'quotaStatus reports the mailbox quota' : `quotaStatus reports the mailbox quota: ${JSON.stringify(quota)}`);

    const recipient = await mailboxes.resolveInboundRecipient('support+anything@re-el.co.za');
    ok(recipient?.mailbox_id === 'mbx_support' ? 'resolveInboundRecipient honours a plus route' : 'resolveInboundRecipient failed');

    const ownedId = await mailboxes.findOwnedMailboxId('usr_admin', 'Admin@Re-El.co.za');
    ok(ownedId === 'mbx_main' ? 'findOwnedMailboxId resolves an owned address, case-insensitively' : `findOwnedMailboxId returned ${ownedId}`);
    ok(
      (await mailboxes.isOwnedAddress('usr_admin', 'admin@re-el.co.za')) === true
        ? 'isOwnedAddress confirms a mailbox the user owns'
        : 'isOwnedAddress denied an owned address',
    );
    ok(
      (await mailboxes.isOwnedAddress('usr_admin', 'someone@elsewhere.co.za')) === false
        ? 'isOwnedAddress denies a foreign address'
        : 'isOwnedAddress allowed a foreign address',
    );

    // System tables
// createSession takes the raw token and stores only its hash.
    const rawRefresh = 'verify-refresh-token';
    const session = await system.createSession({
      userId: 'usr_admin',
      mailboxId: 'mbx_main',
      token: rawRefresh,
      userAgent: 'verify',
      ip: '127.0.0.1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    ok(session?.id ? 'createSession issues a session row' : 'createSession failed');
    ok(
      session.tokenHash && session.tokenHash !== rawRefresh
        ? 'createSession stores a hash, never the token itself'
        : 'createSession may have stored the raw token',
    );
    ok(
      (await system.findActiveSessionByTokenHash(session.tokenHash))?.id === session.id
        ? 'findActiveSessionByTokenHash resolves a live session'
        : 'findActiveSessionByTokenHash failed',
    );
    await system.revokeSessionByTokenHash(session.tokenHash, 'verify');
    ok(
      (await system.findActiveSessionByTokenHash(session.tokenHash)) === null
        ? 'a revoked session no longer resolves'
        : 'a revoked session still resolves',
    );
    ok(
      (await system.findActiveSessionById(session.id)) === null
        ? 'findActiveSessionById respects revocation (logout cannot be undone by an old access token)'
        : 'findActiveSessionById ignores revocation',
    );

    const bucket1 = await system.hitRateLimit('verify:bucket', { limit: 3, windowSeconds: 60 });
    const bucket2 = await system.hitRateLimit('verify:bucket', { limit: 3, windowSeconds: 60 });
    const bucket3 = await system.hitRateLimit('verify:bucket', { limit: 3, windowSeconds: 60 });
    const bucket4 = await system.hitRateLimit('verify:bucket', { limit: 3, windowSeconds: 60 });
    ok(
      bucket1.allowed && bucket2.allowed && bucket3.allowed && !bucket4.allowed && bucket4.retryAfterSeconds > 0
        ? 'hitRateLimit allows exactly `limit` requests, then blocks with Retry-After'
        : `hitRateLimit returned ${JSON.stringify([bucket1.allowed, bucket2.allowed, bucket3.allowed, bucket4.allowed])}`,
    );

    const settings = await system.getSettings();
    ok(settings && typeof settings === 'object' ? 'getSettings returns the settings map' : 'getSettings failed');
    await system.setSetting('verify_flag', { on: true }, 'usr_admin');
    const flag = await system.getSetting('verify_flag');
    ok(flag?.on === true ? 'setSetting stores a JSON value' : 'setSetting failed');

    const stats = await system.platformStats();
    ok(
      typeof stats?.users?.total === 'number' && typeof stats?.mailboxes?.total === 'number'
        ? `platformStats returns counts (${stats.users.total} users, ${stats.mailboxes.total} mailboxes)`
        : `platformStats returned ${JSON.stringify(stats)}`,
    );

    const usageRows = await system.usageSeries({ days: 7 });
    ok(Array.isArray(usageRows) ? 'usageSeries returns rows' : 'usageSeries failed');

    const found = await users.findByEmail('admin@re-el.co.za');
    ok(found?.password_hash ? 'findByEmail returns the hash for verification' : 'findByEmail failed');
    ok(
      (await users.findPublicById('usr_admin'))?.password_hash === undefined
        ? 'findPublicById never returns the password hash'
        : 'findPublicById leaked the password hash',
    );

    const poolModule = await import('../packages/db/pool.js');
    const latency = await poolModule.ping();
    ok(latency >= 0 ? `pool.ping round-trip ${latency} ms` : 'pool.ping failed');

    await poolModule.closePool();
    delete process.env.DATABASE_URL;

    // RLS posture. `set local role` only lives for the current transaction, and
    // the client is in autocommit mode, so the role change and the read have to
    // share one explicit transaction.
// `anon` may be denied by table privileges (a fresh database) or by RLS (a
// Supabase project, where anon holds privileges but every policy is deny). Both
// are correct; reading rows is not.
    const expectNoRows = async (sql, label) => {
      await client.query('begin');
      await client.query('set local role anon');
      const result = await client.query(sql).then(
        (value) => ({ rows: value.rows }),
        (err) => ({ error: err.code }),
      );
      await client.query('rollback');

      if (result.error === '42501') return ok(`${label}: denied by table privileges`);
      if (result.error) return bad(`${label}: unexpected error ${result.error}`);
      if (result.rows[0]?.n === 0) return ok(`${label}: denied by RLS`);
      return bad(`${label}: returned ${result.rows[0]?.n} rows`);
    };

await expectNoRows('select count(*)::int as n from public.messages', 'anon read of messages');
    await expectNoRows('select count(*)::int as n from public.settings', 'anon read of settings');
    await expectNoRows('select count(*)::int as n from public.sessions', 'anon read of sessions');

    await client.query('begin');
    await client.query('set local role anon');
    const anonWrite = await client.query(
      `insert into public.messages (id, mailbox_id, thread_id, folder, subject)
       values ('msg_anon', 'mbx_main', 'thr_anon', 'inbox', 'Injected')`,
    ).then(() => false, (err) => err.message);
    await client.query('rollback');
    if (anonWrite === false) bad('RLS allowed anon to insert a message');
    else if (String(anonWrite).includes('42501')) ok('anon write denied by table privileges');
    else ok(`anon write denied by RLS: ${String(anonWrite).split('\n')[0]}`);

    // The service role bypasses RLS, which is how the API reads everything.
    await client.query('begin');
    await client.query('set local role service_role');
    const serviceVisible = await client.query('select count(*)::int as n from public.messages');
    await client.query('rollback');
    ok(serviceVisible.rows[0].n > 0 ? 'service_role bypasses RLS' : 'service_role could not read messages');

    // ─── report ──────────────────────────────────────────────────────────────
    console.log(
      `\n${failures === 0 ? '\x1b[32mDatabase checks passed\x1b[0m' : `\x1b[31m${failures} database check(s) failed\x1b[0m`}\n`,
    );
  } finally {
    await client.end().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });