-- ═════════════════════════════════════════════════════════════════════════════
-- Re-EL Mailer — migration 0005: workspaces, teams and billing
--
-- Introduces the tenancy boundary the product actually sells: a workspace owns
-- mailboxes, has members with roles, and holds the subscription that decides
-- what the workspace is entitled to.
--
-- Design notes
--   * Backward compatible. Every existing user gets a personal workspace
--     (`is_default = true`) and each of their mailboxes is attached to it, so a
--     single-tenant deployment keeps working with no data migration on the
--     operator's side.
--   * `mailboxes.workspace_id` is nullable on purpose. A mailbox with no
--     workspace is "legacy/personal" and access falls back to ownership, which
--     keeps direct seeds and any not-yet-backfilled row usable.
--   * Idempotent. The backfill is guarded by `not exists`, so re-running the
--     migration (as `npm run db:verify` does) cannot duplicate a workspace.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── workspaces ──────────────────────────────────────────────────────────────

create table if not exists public.workspaces (
  id          text primary key,
  name        text not null,
  slug        text not null,
  owner_id    text not null references public.users (id) on delete cascade,
  plan_id     text not null default 'solo',
  status      text not null default 'active'
                check (status in ('active', 'suspended')),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, slug)
);

create index if not exists workspaces_owner_idx on public.workspaces (owner_id);
create index if not exists workspaces_plan_idx  on public.workspaces (plan_id);

create or replace trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

comment on table public.workspaces is
  'Tenant boundary: owns mailboxes, members and the subscription that grants entitlements.';
comment on column public.workspaces.is_default is
  'The personal workspace auto-created for a user. Used to attach mailboxes created without an explicit workspace.';

-- ─── workspace_members ───────────────────────────────────────────────────────

create table if not exists public.workspace_members (
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  user_id       text not null references public.users (id) on delete cascade,
  role          text not null default 'member'
                  check (role in ('owner', 'admin', 'manager', 'member')),
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

comment on table public.workspace_members is
  'Membership + role within a workspace. Distinct from users.role, which is the platform role.';

-- ─── subscriptions ───────────────────────────────────────────────────────────

create table if not exists public.subscriptions (
  id                   text primary key,
  workspace_id         text not null unique references public.workspaces (id) on delete cascade,
  plan_id              text not null,
  status               text not null default 'trialing'
                         check (status in ('trialing', 'active', 'past_due', 'canceled', 'pending')),
  seats                integer not null default 1,
  provider             text not null default 'none',
  provider_ref         text,
  provider_customer    text,
  current_period_end   timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists subscriptions_status_idx on public.subscriptions (status);

create or replace trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

comment on column public.subscriptions.seats is
  'Purchased seat count. Entitlement checks compare workspace_members against this + the plan floor.';

-- ─── billing_events ──────────────────────────────────────────────────────────

-- Webhook idempotency: providers retry, so an event already recorded must be a
-- no-op rather than a second plan change.
create table if not exists public.billing_events (
  id            text primary key,
  provider      text not null,
  event_id      text not null,
  workspace_id  text references public.workspaces (id) on delete set null,
  type          text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (provider, event_id)
);

create index if not exists billing_events_workspace_idx on public.billing_events (workspace_id, created_at desc);

-- ─── mailboxes — attach to a workspace ───────────────────────────────────────

alter table public.mailboxes
  add column if not exists workspace_id text references public.workspaces (id) on delete set null;

create index if not exists mailboxes_workspace_idx on public.mailboxes (workspace_id);

comment on column public.mailboxes.workspace_id is
  'Owning workspace. Null means a legacy/personal mailbox whose access falls back to user_id ownership.';

-- ─── Backfill: a personal workspace per user, mailboxes attached ─────────────

-- One default workspace per user, guarded so re-running is a no-op. The slug
-- suffix is random because two users may share a display name; the id itself is
-- generated the same way the application does.
insert into public.workspaces (id, name, slug, owner_id, plan_id, is_default)
select
  'wsp_' || replace(gen_random_uuid()::text, '-', ''),
  coalesce(nullif(trim(u.display_name), ''), u.email) || '''s workspace',
  lower(regexp_replace(split_part(u.email, '@', 1), '[^a-zA-Z0-9]+', '-', 'g'))
    || '-' || substr(md5(u.id), 1, 6),
  u.id,
  'solo',
  true
from public.users u
where not exists (
  select 1 from public.workspaces w where w.owner_id = u.id and w.is_default
);

-- The owner is always a member (role owner).
insert into public.workspace_members (workspace_id, user_id, role)
select w.id, w.owner_id, 'owner'
from public.workspaces w
where not exists (
  select 1 from public.workspace_members m
  where m.workspace_id = w.id and m.user_id = w.owner_id
);

-- Attach every mailbox whose owner has a default workspace and none assigned yet.
update public.mailboxes mb
set workspace_id = w.id
from public.workspaces w
where w.owner_id = mb.user_id
  and w.is_default
  and mb.workspace_id is null;

-- ─── Row-level security: deny-by-default for every new table ─────────────────

do $$
declare
  t text;
begin
  foreach t in array array['workspaces', 'workspace_members', 'subscriptions', 'billing_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "reel_no_direct_access" on public.%I', t);
    execute format(
      'create policy "reel_no_direct_access" on public.%I for all to anon, authenticated using (false) with check (false)',
      t
    );
  end loop;
end;
$$;
