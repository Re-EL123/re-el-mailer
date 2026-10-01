-- ═════════════════════════════════════════════════════════════════════════════
-- 0003 — usage reporting views
--
-- The admin dashboard must only show metrics that can be calculated reliably.
-- These views are the single source of truth for those numbers.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Per-day send/receive volume, per domain ──────────────────────────────────
create or replace view public.usage_daily as
select
  d.name                                                        as domain,
  (coalesce(m.sent_at, m.received_at))::date                   as day,
  count(*) filter (where m.direction = 'outbound')             as sent,
  count(*) filter (where m.direction = 'inbound')              as received,
  count(*) filter (where m.delivery_status = 'delivered')      as delivered,
  count(*) filter (where m.delivery_status = 'bounced')        as bounced,
  count(*) filter (where m.delivery_status = 'complained')     as complained,
  coalesce(sum(m.size_bytes), 0)                                as bytes
from public.messages m
join public.mailboxes mb on mb.id = m.mailbox_id
join public.domains    d on d.id = mb.domain_id
where m.folder <> 'drafts'
  and coalesce(m.sent_at, m.received_at) is not null
  and coalesce(m.sent_at, m.received_at) > now() - interval '90 days'
group by d.name, 2;

-- ── Delivery health: only counts messages Resend has actually accepted ───────
create or replace view public.delivery_health as
select
  d.name as domain,
  count(*) filter (where m.direction = 'outbound')                                        as total,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'delivered')    as delivered,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'bounced')      as bounced,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'complained')   as complained,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'deferred')     as deferred,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'sent')         as sent,
  count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'queued')       as queued,
  round(
    100.0 * count(*) filter (where m.direction = 'outbound' and m.delivery_status = 'delivered')
    / nullif(count(*) filter (where m.direction = 'outbound'
                              and m.delivery_status in ('delivered', 'bounced', 'complained')), 0),
    2
  ) as delivery_rate_pct
from public.messages m
join public.mailboxes mb on mb.id = m.mailbox_id
join public.domains    d on d.id = mb.domain_id
where m.direction = 'outbound'
  and m.sent_at > now() - interval '30 days'
group by d.name;

-- ── Storage rollup per mailbox, recomputed from the attachments table ────────
create or replace view public.storage_rollup as
select
  mb.id as mailbox_id,
  mb.email,
  mb.quota_bytes,
  coalesce(sum(a.size_bytes) filter (where not a.is_deleted), 0) as attachments_bytes,
  coalesce(sum(a.size_bytes) filter (where not a.is_deleted), 0)
    + coalesce(sum(m.size_bytes) filter (where m.folder <> 'trash'), 0) as total_bytes,
  count(a.id) filter (where not a.is_deleted) as attachment_count
from public.mailboxes mb
left join public.messages    m on m.mailbox_id = mb.id
left join public.attachments a on a.message_id = m.id
group by mb.id, mb.email, mb.quota_bytes;

-- ── Folder counts across all mailboxes (admin dashboard) ─────────────────────
create or replace view public.folder_totals as
select
  mb.user_id,
  count(*) filter (where m.folder = 'inbox')                        as inbox,
  count(*) filter (where m.folder = 'sent')                         as sent,
  count(*) filter (where m.folder = 'drafts')                       as drafts,
  count(*) filter (where m.folder = 'archive')                      as archive,
  count(*) filter (where m.folder = 'trash')                        as trash,
  count(*) filter (where m.folder = 'spam')                         as spam,
  count(*) filter (where m.folder = 'inbox' and not m.is_read)      as unread,
  count(*)                                                      as total
from public.mailboxes mb
left join public.messages m on m.mailbox_id = mb.id and not m.is_deleted
group by mb.user_id;