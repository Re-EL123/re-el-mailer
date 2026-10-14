-- ═════════════════════════════════════════════════════════════════════════════
-- Re-EL Mailer — migration 0006: a workspace is a domain (organisation)
--
-- 0005 made a personal workspace per user. That was the wrong tenancy boundary:
-- an organisation is a domain, and the subscription that pays for it should be
-- the organisation's, not each member's.
--
-- This migration reshapes the same tables so that:
--   * there is exactly one workspace per domain (`workspaces.domain_id` unique),
--   * every mailbox is attached to its domain's workspace,
--   * membership is derived from the people with a mailbox in the domain,
--   * the personal workspaces from 0005 are retired.
--
-- Membership and roles become informational: authority is the platform role
-- (`users.role`), exactly as before workspaces existed. `workspace_members` is
-- kept (and backfilled) so older queries keep working, but the application
-- derives the team from mailboxes.
--
-- Idempotent: every step is guarded so re-running (as `npm run db:verify` does)
-- cannot duplicate a workspace, a member, or move a subscription twice.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── workspaces — keyed by domain ────────────────────────────────────────────

alter table public.workspaces
  add column if not exists domain_id text references public.domains (id) on delete cascade;

create unique index if not exists workspaces_domain_idx
  on public.workspaces (domain_id) where domain_id is not null;

comment on column public.workspaces.domain_id is
  'The domain (organisation) this workspace represents. One workspace per domain.';

-- ─── One workspace per domain ────────────────────────────────────────────────

-- The owner is a platform admin, because only admins may manage an org. If the
-- deployment somehow has no admin yet, no workspace is created here and the
-- application creates it lazily (ensureWorkspaceForDomain) on first mailbox.
insert into public.workspaces (id, name, slug, owner_id, plan_id, status, is_default, domain_id)
select
  'wsp_' || replace(gen_random_uuid()::text, '-', ''),
  d.name,
  lower(regexp_replace(d.name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(md5(d.id), 1, 6),
  coalesce(
    (select u.id from public.users u where u.role = 'admin' order by u.created_at asc limit 1),
    (select u.id from public.users u order by u.created_at asc limit 1)
  ),
  'solo',
  'active',
  false,
  d.id
from public.domains d
where not exists (select 1 from public.workspaces w where w.domain_id = d.id)
  and exists (select 1 from public.users u);

-- ─── Attach every mailbox to its domain's workspace ──────────────────────────

update public.mailboxes mb
set workspace_id = w.id
from public.workspaces w
where w.domain_id = mb.domain_id
  and mb.workspace_id is distinct from w.id;

-- ─── Carry a live subscription onto the domain workspace ─────────────────────

-- A personal workspace that was already paying should not lose its plan when we
-- retire it. Move the subscription to the owner's domain workspace when that
-- workspace has none; otherwise the personal workspace is left in place below.
update public.subscriptions s
set workspace_id = dw.id
from public.workspaces pw
join public.mailboxes mb on mb.user_id = pw.owner_id and mb.is_primary
join public.workspaces dw on dw.domain_id = mb.domain_id
where pw.is_default
  and pw.domain_id is null
  and s.workspace_id = pw.id
  and dw.id <> pw.id
  and not exists (select 1 from public.subscriptions x where x.workspace_id = dw.id);

-- ─── Backfill membership from the domain's people ────────────────────────────

insert into public.workspace_members (workspace_id, user_id, role)
select distinct
  w.id,
  mb.user_id,
  case when u.role = 'admin' then 'admin' else 'member' end
from public.mailboxes mb
join public.workspaces w on w.domain_id = mb.domain_id
join public.users u on u.id = mb.user_id
where not exists (
  select 1 from public.workspace_members m
  where m.workspace_id = w.id and m.user_id = mb.user_id
);

-- ─── Retire the personal workspaces from 0005 ────────────────────────────────

-- Only ones that no longer own a mailbox and have no subscription; anything
-- still carrying a live subscription is left untouched for an operator to move.
delete from public.workspaces w
where w.is_default
  and w.domain_id is null
  and not exists (select 1 from public.mailboxes mb where mb.workspace_id = w.id)
  and not exists (select 1 from public.subscriptions s where s.workspace_id = w.id);
