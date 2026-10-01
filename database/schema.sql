-- ═════════════════════════════════════════════════════════════════════════════
-- Re-EL Mailer — database schema
--
-- Target: Supabase PostgreSQL
-- Apply with:  npm run db:migrate   (runs database/migrations/*.sql in order)
-- Or paste into Supabase Studio → SQL Editor.
--
-- Design notes
--   * Passwords are stored as bcrypt hashes only. There is no plaintext column.
--   * Every access token has a matching row in `sessions` so that access can be
--     revoked server-side (JWTs alone cannot be revoked).
--   * Attachment bytes never enter PostgreSQL; only metadata + a storage key.
--   * `messages.search_vector` is a generated column so search stays indexable.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;   -- gen_random_uuid(), crypt()
create extension if not exists pg_trgm;    -- fuzzy sender/subject search

-- ═════════════════════════════════════════════════════════════════════════════
-- Reusable helpers
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- `array_to_string` is only STABLE, and a generated column's expression has to
-- be IMMUTABLE, so the recipient array is flattened through this wrapper when
-- building messages.search_vector.
create or replace function public.text_array_join(p_values text[], p_separator text default ' ')
returns text
language sql
immutable
parallel safe
as $$
  select coalesce(array_to_string(p_values, p_separator), '');
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- domains
--
-- Every mailbox lives under a domain. v1 ships with re-el.co.za; the table
-- exists so Re-EL Mailer can later serve client domains (see docs/roadmap).
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.domains (
  id                  text primary key,
  name                text not null unique,
  status              text not null default 'pending'
                        check (status in ('pending', 'active', 'suspended')),
  verification_token  text,
  dns_records         jsonb not null default '[]'::jsonb,
  dkim_public_key     text,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.domains is
  'Domains served by Re-EL Mailer. status=active means MX/SPF/DKIM/DMARC are published and inbound is routed.';

create index if not exists domains_status_idx on public.domains (status);

-- ═════════════════════════════════════════════════════════════════════════════
-- users
--
-- A user is a human identity (login). A user may own one or more mailboxes.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.users (
  id                  text primary key,
  email               text not null unique,          -- login identity
  password_hash       text not null,                 -- bcrypt, cost 12
  display_name        text not null,
  role                text not null default 'user'
                        check (role in ('admin', 'manager', 'user')),
  status              text not null default 'active'
                        check (status in ('active', 'disabled', 'pending')),
  password_changed_at timestamptz not null default now(),
  must_change_password boolean not null default false,
  failed_login_count  integer not null default 0,
  locked_until        timestamptz,
  preferences         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_login_at       timestamptz
);

create index if not exists users_role_idx   on public.users (role);
create index if not exists users_status_idx on public.users (status);

create or replace trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

comment on column public.users.preferences is
  'Client-side preferences: { theme, density, signature_html, signature_text, notifications, pageSize, language }';

-- ═════════════════════════════════════════════════════════════════════════════
-- mailboxes
--
-- The actual email address. `email` is globally unique so that inbound routing
-- is a single unambiguous lookup.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.mailboxes (
  id                  text primary key,
  user_id             text not null references public.users (id) on delete cascade,
  domain_id           text not null references public.domains (id) on delete restrict,
  email               text not null unique,
  display_name        text not null,
  signature_html      text,
  signature_text      text,
  reply_to            text,
  quota_bytes         bigint not null default 2147483648,   -- 2 GB
  storage_used_bytes  bigint not null default 0,
  status              text not null default 'active'
                        check (status in ('active', 'disabled', 'read_only', 'pending')),
  daily_send_limit    integer,           -- null = inherit from user role
  hourly_send_limit   integer,
  is_primary          boolean not null default false,
  auto_read           boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists mailboxes_user_idx   on public.mailboxes (user_id);
create index if not exists mailboxes_domain_idx on public.mailboxes (domain_id);
create index if not exists mailboxes_status_idx on public.mailboxes (status);

-- Only one primary mailbox per user.
create unique index if not exists mailboxes_one_primary_per_user
  on public.mailboxes (user_id) where is_primary;

create or replace trigger mailboxes_set_updated_at
  before update on public.mailboxes
  for each row execute function public.set_updated_at();

comment on column public.mailboxes.storage_used_bytes is
  'Maintained by the API from the attachments table. Compared against quota_bytes before accepting a message.';

-- ═════════════════════════════════════════════════════════════════════════════
-- inbound_routes
--
-- Inbound routing rules. Resolved before falling back to an exact mailbox
-- lookup, so plus-addressing (support+lwm@), aliases and a catch-all are all
-- expressible without creating a mailbox per address.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.inbound_routes (
  id            text primary key,
  domain_id     text not null references public.domains (id) on delete cascade,
  pattern       text not null,              -- 'support', 'sales+*', '*' (catch-all)
  mailbox_id    text references public.mailboxes (id) on delete cascade,
  action        text not null default 'deliver'
                  check (action in ('deliver', 'reject', 'bounce', 'discard')),
  priority      integer not null default 100,   -- lower runs first
  is_active     boolean not null default true,
  note          text,
  created_at    timestamptz not null default now(),
  unique (domain_id, pattern)
);

create index if not exists inbound_routes_domain_idx on public.inbound_routes (domain_id, priority)
  where is_active;

comment on table public.inbound_routes is
  'pattern matches the local part. "*" matches everything; "prefix+*" matches plus-addressing. priority 0 is evaluated before catch-all.';

-- ═════════════════════════════════════════════════════════════════════════════
-- messages
--
-- One row per message per mailbox. A sent message and its inbox copy are two
-- rows sharing a `message_id` (RFC 5322 Message-ID) but not an `id`.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.messages (
  id                  text primary key,
  mailbox_id          text not null references public.mailboxes (id) on delete cascade,
  message_id          text,                       -- RFC 5322 Message-ID
  in_reply_to         text,
  references_text     text,
  thread_id           text not null,
  direction           text not null default 'inbound'
                        check (direction in ('inbound', 'outbound', 'internal')),

  -- Envelope participants. Addresses are lowercased arrays of text.
  from_email          text,
  from_name           text,
  to_emails           text[] not null default '{}',
  cc_emails           text[] not null default '{}',
  bcc_emails          text[] not null default '{}',
  reply_to_emails     text[] not null default '{}',

  subject             text not null default '',
  body_html           text,
  body_text           text,
  snippet             text not null default '',
  raw_mime            text,                       -- only when STORE_RAW_MIME=true
  raw_mime_size       integer,

  folder              text not null default 'inbox'
                        check (folder in ('inbox', 'sent', 'drafts', 'archive', 'trash', 'spam')),
  is_read             boolean not null default false,
  is_starred          boolean not null default false,
  is_draft            boolean not null default false,
  is_deleted          boolean not null default false,
  has_attachments     boolean not null default false,

  size_bytes          integer not null default 0,
  priority            text not null default 'normal'
                        check (priority in ('low', 'normal', 'high')),

  -- Resend delivery telemetry (populated by /api/webhooks?action=event)
  delivery_status     text not null default 'unknown'
                        check (delivery_status in ('unknown', 'queued', 'sent', 'delivered',
                                                   'bounced', 'complained', 'deferred')),
  resend_message_id   text,
  resend_id           text,
  smtp_status         text,
  smtp_response       text,
  delivered_at        timestamptz,
  last_event_at       timestamptz,
  failed_count        integer not null default 0,

  scheduled_for        timestamptz,              -- v2 scheduling, nullable
  sent_at              timestamptz,
  received_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  read_at              timestamptz,

  search_vector        tsvector generated always as (
                        setweight(to_tsvector('english', coalesce(subject, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(body_text, '')), 'B') ||
                        setweight(to_tsvector('simple', coalesce(from_email, '')), 'C') ||
                        setweight(to_tsvector('simple', coalesce(from_name, '')), 'C') ||
                        setweight(to_tsvector('simple', public.text_array_join(to_emails, ' ')), 'D') ||
                        setweight(to_tsvector('simple', coalesce(snippet, '')), 'D')
                      ) stored
);

create index if not exists messages_mailbox_folder_idx
  on public.messages (mailbox_id, folder, is_read);
create index if not exists messages_mailbox_received_idx
  on public.messages (mailbox_id, received_at desc nulls last);
create index if not exists messages_mailbox_sent_idx
  on public.messages (mailbox_id, sent_at desc nulls last);
create index if not exists messages_mailbox_starred_idx
  on public.messages (mailbox_id, is_starred) where is_starred;
create index if not exists messages_thread_idx
  on public.messages (thread_id);
create index if not exists messages_message_id_idx
  on public.messages (message_id);
create index if not exists messages_resend_id_idx
  on public.messages (resend_id);
create index if not exists messages_resend_message_id_idx
  on public.messages (resend_message_id);
create index if not exists messages_search_idx
  on public.messages using gin (search_vector);
create index if not exists messages_from_trgm_idx
  on public.messages using gin (from_email gin_trgm_ops);
create index if not exists messages_subject_trgm_idx
  on public.messages using gin (subject gin_trgm_ops);
create index if not exists messages_attachments_idx
  on public.messages (mailbox_id) where has_attachments;
create index if not exists messages_undelivered_idx
  on public.messages (delivery_status) where delivery_status in ('queued', 'sent');

create or replace trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

comment on column public.messages.snippet is
  'Short plain-text preview, also indexed for search.';
comment on column public.messages.folder is
  'inbox | sent | drafts | archive | trash | spam. Trash is soft-delete; rows are purged by the retention job.';

-- ═════════════════════════════════════════════════════════════════════════════
-- attachments
--
-- Bytes live in Supabase Storage (`mail-attachments`); this table is metadata
-- plus the storage key. `storage_path` is scoped to the bucket root.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.attachments (
  id              text primary key,
  message_id      text not null references public.messages (id) on delete cascade,
  mailbox_id      text not null references public.mailboxes (id) on delete cascade,
  filename        text not null,
  mime_type       text not null default 'application/octet-stream',
  size_bytes      integer not null default 0,
  storage_bucket  text not null default 'mail-attachments',
  storage_path    text not null,
  content_id      text,
  inline          boolean not null default false,
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists attachments_message_idx  on public.attachments (message_id);
create index if not exists attachments_mailbox_idx  on public.attachments (mailbox_id) where not is_deleted;

-- ═════════════════════════════════════════════════════════════════════════════
-- sessions
--
-- One row per refresh token. `token_hash` is SHA-256 of the opaque token —
-- the raw token is only ever held in an httpOnly cookie.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.sessions (
  id              text primary key,
  user_id         text not null references public.users (id) on delete cascade,
  mailbox_id      text references public.mailboxes (id) on delete set null,
  token_hash      text not null unique,
  prev_token_hash text,
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text
);

create index if not exists sessions_user_idx    on public.sessions (user_id);
create index if not exists sessions_active_idx  on public.sessions (user_id, expires_at)
  where revoked_at is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- password_resets
--
-- Single-use, hashed tokens, short expiry, invalidated on use or on any
-- subsequent reset request for the same account.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.password_resets (
  id            text primary key,
  user_id       text not null references public.users (id) on delete cascade,
  token_hash    text not null unique,
  ip            text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);

create index if not exists password_resets_user_idx on public.password_resets (user_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- labels
--
-- Sidebar labels (Clients / Projects / Finance / Internal / custom).
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.labels (
  id           text primary key,
  mailbox_id   text not null references public.mailboxes (id) on delete cascade,
  name         text not null,
  color        text not null default '#21396A',
  slug         text not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (mailbox_id, slug)
);

-- ═════════════════════════════════════════════════════════════════════════════
-- message_labels
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.message_labels (
  message_id  text not null references public.messages (id) on delete cascade,
  label_id    text not null references public.labels (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (message_id, label_id)
);

create index if not exists message_labels_label_idx on public.message_labels (label_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- contacts
--
-- Derived from sent/received mail so compose has recipient autocomplete
-- without a separate address-book UI.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.contacts (
  id             text primary key,
  mailbox_id     text not null references public.mailboxes (id) on delete cascade,
  email          text not null,
  name           text,
  last_seen_at   timestamptz not null default now(),
  seen_count     integer not null default 1
);

-- Case-insensitive uniqueness: mail providers treat local parts
-- case-insensitively, so `Client@x.co` and `client@x.co` are one contact, not two.
create unique index if not exists contacts_mailbox_email_ci
  on public.contacts (mailbox_id, lower(email));

create index if not exists contacts_mailbox_idx on public.contacts (mailbox_id, last_seen_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- audit_logs
--
-- Append-only security and administration trail.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.audit_logs (
  id           bigserial primary key,
  actor_id     text references public.users (id) on delete set null,
  actor_email  text,
  action       text not null,
  entity_type  text,
  entity_id    text,
  ip           text,
  user_agent   text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_logs_actor_idx   on public.audit_logs (actor_id, created_at desc);
create index if not exists audit_logs_action_idx  on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);

comment on table public.audit_logs is
  'Append-only. Rows are never updated; only the scheduled retention job deletes them, past retention.audit_days.';

-- ═════════════════════════════════════════════════════════════════════════════
-- rate_limits
--
-- Fixed-window counters in Postgres, because a serverless instance cache is not
-- shared between invocations and would under-count.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.rate_limits (
  bucket_key    text not null,
  window_start  timestamptz not null,
  count         integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- ═════════════════════════════════════════════════════════════════════════════
-- settings
--
-- Admin-editable configuration (overrides the env-var defaults).
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.settings (
  key          text primary key,
  value        jsonb not null,
  description  text,
  updated_at   timestamptz not null default now(),
  updated_by   text references public.users (id) on delete set null
);

create or replace trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- Function: mailbox folder counts (one round trip for the whole sidebar)
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.mailbox_folder_counts(p_mailbox_id text)
returns table (folder text, total bigint, unread bigint, starred bigint)
language sql
stable
as $$
  select m.folder,
         count(*)                                              as total,
         count(*) filter (where not m.is_read and not m.is_deleted) as unread,
         count(*) filter (where m.is_starred)                  as starred
  from public.messages m
  where m.mailbox_id = p_mailbox_id
    and not m.is_deleted
    and m.folder <> 'spam'
  group by m.folder;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Function: resolve inbound recipient
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.resolve_mailbox(p_email text)
returns table (id text, user_id text, status text)
language sql
stable
as $$
  select mb.id, mb.user_id, mb.status
  from public.mailboxes mb
  where lower(mb.email) = lower(p_email)
  limit 1;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Function: resolve an inbound recipient through routing rules
--
-- Precedence: exact mailbox address → explicit route (priority asc) → catch-all
-- route. Returns no rows when the recipient is unknown and no catch-all exists,
-- which the webhook turns into a 550 rejection.
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.resolve_inbound_recipient(p_email text)
returns table (
  mailbox_id   text,
  action       text,
  matched_rule text,
  via          text,
  auto_read    boolean
)
language sql
stable
as $$
  with input as (
    select lower(p_email) as addr,
           split_part(lower(p_email), '@', 1) as local_part
  ),
  exact as (
    select mb.id as mailbox_id,
           'deliver'::text as action,
           null::text as rule,
           'mailbox'::text as via,
           mb.auto_read
    from public.mailboxes mb, input i
    where lower(mb.email) = i.addr and mb.status <> 'pending'
  ),
  routed as (
    select r.mailbox_id,
           r.action,
           r.pattern as rule,
           'route'::text as via,
           coalesce((select mb.auto_read from public.mailboxes mb where mb.id = r.mailbox_id), false) as auto_read,
           row_number() over (order by r.priority asc, r.created_at asc) as rn
    from public.inbound_routes r, input i
    where r.is_active
      and r.domain_id = (select id from public.domains where name = split_part(i.addr, '@', 2))
      and (
            r.pattern = i.local_part
         -- "sales+*" routes support+anything to support. LIKE treats * and % as
            -- wildcards, so the trailing * is stripped and the rest matched as a
            -- literal prefix; that keeps plus-addressed mail inside the route.
         or (r.pattern like '%+*' and i.local_part like left(r.pattern, length(r.pattern) - 1) || '%')
         or (r.pattern = i.local_part || '+%')
         or r.pattern = '*'
      )
      and (r.mailbox_id is not null or r.action <> 'deliver')
  ),
  best as (
    select * from routed where rn = 1
  )
  -- An exact mailbox address always wins over a wildcard route, so the ranking
  -- is explicit: `limit 1` alone would take whichever branch came first.
  select mailbox_id, action, rule, via, auto_read from (
      select mailbox_id, action, rule, via, auto_read, 1 as match_rank from exact
      union all
      select mailbox_id, action, rule, via, auto_read, 2 as match_rank from best
  ) ranked
  order by match_rank
  limit 1;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Function: enforce per-mailbox storage quota before insert/update
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_mailbox_quota()
returns trigger
language plpgsql
as $$
declare
  used bigint;
  cap  bigint;
begin
  select storage_used_bytes into used from public.mailboxes where id = new.mailbox_id for update;
  select quota_bytes into cap from public.mailboxes where id = new.mailbox_id;

  if cap is not null and used + greatest(coalesce(new.size_bytes, 0), 0) > cap then
    -- A bare code string so the API can map the failure to HTTP 507 instead of
    -- surfacing an internal error; the hint stays human-readable.
    raise exception 'MAILBOX_QUOTA_EXCEEDED'
      using errcode = 'P0001',
            detail = format('Mailbox %s has %s of %s bytes in use', new.mailbox_id, used, cap);
  end if;

  new.size_bytes := greatest(coalesce(new.size_bytes, 0), 0);
  return new;
end;
$$;

create or replace trigger messages_quota_guard
  before insert or update of size_bytes on public.messages
  for each row execute function public.enforce_mailbox_quota();

-- ═════════════════════════════════════════════════════════════════════════════
-- Row-level security
--
-- The API connects with the service-role / direct Postgres credentials and
-- performs its own authorisation in code, so RLS stays permissive for the
-- `service_role` path while still protecting the anon role used by Supabase
-- clients. These policies intentionally grant nothing to anon/authenticated:
-- all browser access to data goes through the Vercel API.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.domains          enable row level security;
alter table public.users            enable row level security;
alter table public.mailboxes        enable row level security;
alter table public.inbound_routes   enable row level security;
alter table public.messages         enable row level security;
alter table public.attachments      enable row level security;
alter table public.sessions         enable row level security;
alter table public.password_resets  enable row level security;
alter table public.labels           enable row level security;
alter table public.message_labels   enable row level security;
alter table public.contacts         enable row level security;
alter table public.audit_logs       enable row level security;
alter table public.rate_limits      enable row level security;
alter table public.settings         enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row level security: deny-by-default
--
-- The API authenticates with the service role (which bypasses RLS), so no
-- policy is required for it. Adding these explicit deny policies makes the
-- intent unambiguous and keeps the anon key useless for data access, while
-- still allowing Supabase's own dashboard/service paths to work.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'domains', 'users', 'mailboxes', 'inbound_routes', 'messages', 'attachments',
    'sessions', 'password_resets', 'labels', 'message_labels', 'contacts',
    'audit_logs', 'rate_limits', 'settings'
  ]
  loop
    execute format('drop policy if exists "reel_no_direct_access" on public.%I', t);
    execute format(
      'create policy "reel_no_direct_access" on public.%I for all to anon, authenticated using (false) with check (false)',
      t
    );
  end loop;
end;
$$;

-- Storage objects are private too; the API mints short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('mail-attachments', 'mail-attachments', false)
on conflict (id) do update set public = false;

do $$
begin
  if exists (select 1 from storage.objects limit 1) then
    execute 'drop policy if exists "reel_attachments_private" on storage.objects';
    create policy "reel_attachments_private"
      on storage.objects for all to anon, authenticated
      using (false) with check (false);
  end if;
exception when undefined_table then
  null;
end;
$$;