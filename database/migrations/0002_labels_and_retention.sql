-- ═════════════════════════════════════════════════════════════════════════════
-- 0002 — label colours per mailbox and message retention helper
-- ═════════════════════════════════════════════════════════════════════════════

-- Ensure every mailbox has the four default labels from the UI spec
-- (Clients / Projects / Finance / Internal). Idempotent.
insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
select
  'lbl_' || md5(mb.id || ':clients'),
  mb.id, 'Clients',  '#21396A', 'clients', 10
from public.mailboxes mb
on conflict (mailbox_id, slug) do nothing;

insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
select
  'lbl_' || md5(mb.id || ':projects'),
  mb.id, 'Projects', '#F5BF48', 'projects', 20
from public.mailboxes mb
on conflict (mailbox_id, slug) do nothing;

insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
select
  'lbl_' || md5(mb.id || ':finance'),
  mb.id, 'Finance',  '#2F855A', 'finance', 30
from public.mailboxes mb
on conflict (mailbox_id, slug) do nothing;

insert into public.labels (id, mailbox_id, name, color, slug, sort_order)
select
  'lbl_' || md5(mb.id || ':internal'),
  mb.id, 'Internal', '#BA133A', 'internal', 40
from public.mailboxes mb
on conflict (mailbox_id, slug) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- Retention: purge expired soft-deleted / spam rows.
--
-- Attachments are removed from Supabase Storage by the API (which holds the
-- service-role key) before it calls this; the SQL here only handles rows. The
-- API lists the expired rows first, deletes their storage objects, then calls
-- this function, so nothing is left orphaned in the bucket.
--
-- Run from Supabase cron (pg_cron) or a Vercel cron hitting
-- POST /api/admin?action=maintenance.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.purge_expired_messages(p_trash_days integer default 30, p_spam_days integer default 30)
returns table (messages_purged bigint, attachments_purged bigint)
language plpgsql
as $$
declare
  n_messages    bigint := 0;
  n_attachments bigint := 0;
begin
  -- A data-modifying CTE sees one snapshot and every branch runs, so the deleted
  -- message ids are visible to the attachment delete and both counts come from
  -- the same statement. (A CTE is only in scope for its own statement, which
  -- is why this cannot be split across two statements.)
  with doomed as (
    delete from public.messages
    where (folder = 'trash' and is_deleted and updated_at < now() - make_interval(days => p_trash_days))
       or (folder = 'spam'  and updated_at < now() - make_interval(days => p_spam_days))
    returning id
  ),
  removed_attachments as (
    delete from public.attachments
    where message_id in (select id from doomed)
    returning 1
  )
  select
    (select count(*) from doomed),
    (select count(*) from removed_attachments)
  into n_messages, n_attachments;

  delete from public.sessions       where expires_at  < now() - interval '7 days';
  delete from public.password_resets where expires_at  < now() - interval '1 day';
  delete from public.rate_limits    where window_start < now() - interval '1 hour';

  return query select n_messages, n_attachments;
end;
$$;