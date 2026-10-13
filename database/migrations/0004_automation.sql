-- ═════════════════════════════════════════════════════════════════════════════
-- 0004 — business automation
--
-- Adds the persistence behind the automation feature set:
--   • automation_rules / automation_rule_runs — server-side filtering + actions
--   • templates                               — canned responses
--   • message_notes                           — internal, non-sent annotations
--   • jobs                                    — deferred work run by the cron tick
--   • webhook_endpoints / webhook_deliveries  — outbound integrations
--   • notifications                           — per-user in-app alerts
--   • campaigns / campaign_recipients         — bulk sending
--   • messages + mailboxes columns            — assignment, snooze, follow-up,
--                                               out-of-office auto-reply
--
-- Everything is idempotent so the file can be re-run. New tables are added to
-- the deny-by-default RLS set at the bottom, matching database/schema.sql.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- automation_rules
--
-- Evaluated against inbound (and optionally outbound) messages. `conditions`
-- and `actions` are JSON so the evaluator can grow without a migration each
-- time; the shapes are validated in packages/validation/schemas.js before
-- they are ever written.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.automation_rules (
  id              text primary key,
  mailbox_id      text not null references public.mailboxes (id) on delete cascade,
  name            text not null,
  description     text,
  is_active       boolean not null default true,
  -- { match: 'all' | 'any', conditions: [{ field, operator, value }] }
  conditions      jsonb not null default '{"match":"all","conditions":[]}'::jsonb,
  -- [{ type, ... }]
  actions         jsonb not null default '[]'::jsonb,
  -- Applies to inbound, outbound, or both message directions.
  direction       text not null default 'inbound'
                    check (direction in ('inbound', 'outbound', 'both')),
  -- When a rule matches, stop evaluating lower-priority rules for this message.
  stop_processing boolean not null default false,
  run_order       integer not null default 100,
  created_by      text references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists automation_rules_mailbox_idx
  on public.automation_rules (mailbox_id, run_order) where is_active;

create or replace trigger automation_rules_set_updated_at
  before update on public.automation_rules
  for each row execute function public.set_updated_at();

comment on table public.automation_rules is
  'Server-side rules. conditions/actions are JSON validated by the API; run_order ascending, lower runs first.';

-- ═════════════════════════════════════════════════════════════════════════════
-- automation_rule_runs
--
-- One row per (rule, message) that actually matched. The unique constraint is
-- the idempotency guard: a webhook retry re-evaluates the same message but
-- cannot apply a rule twice.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.automation_rule_runs (
  id              bigserial primary key,
  rule_id         text not null references public.automation_rules (id) on delete cascade,
  message_id      text not null references public.messages (id) on delete cascade,
  matched         boolean not null default true,
  actions_applied jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  unique (rule_id, message_id)
);

create index if not exists automation_rule_runs_message_idx
  on public.automation_rule_runs (message_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- templates — canned responses
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.templates (
  id           text primary key,
  mailbox_id   text not null references public.mailboxes (id) on delete cascade,
  name         text not null,
  slug         text not null,
  subject      text,
  body_html    text,
  body_text    text,
  sort_order   integer not null default 0,
  created_by   text references public.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (mailbox_id, slug)
);

create index if not exists templates_mailbox_idx
  on public.templates (mailbox_id, sort_order, name);

create or replace trigger templates_set_updated_at
  before update on public.templates
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- message_notes — internal annotations that never leave the platform
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.message_notes (
  id           text primary key,
  message_id   text not null references public.messages (id) on delete cascade,
  mailbox_id   text not null references public.mailboxes (id) on delete cascade,
  author_id    text references public.users (id) on delete set null,
  author_email text,
  body         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists message_notes_message_idx
  on public.message_notes (message_id, created_at);

comment on table public.message_notes is
  'Internal notes attached to a message. Never sent; visible only inside the mailbox.';

-- ═════════════════════════════════════════════════════════════════════════════
-- jobs — deferred work drained by the CRON_SECRET maintenance tick.
--
-- With no background worker, scheduling is a row plus a poller. `dedupe_key`
-- makes enqueueing idempotent so a retry never schedules the same work twice.
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.jobs (
  id           text primary key,
  kind         text not null,
  mailbox_id   text references public.mailboxes (id) on delete cascade,
  payload      jsonb not null default '{}'::jsonb,
  run_at       timestamptz not null default now(),
  status       text not null default 'pending'
                 check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  priority     integer not null default 100,
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  last_error   text,
  locked_at    timestamptz,
  locked_by    text,
  dedupe_key   text,
  result       jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists jobs_due_idx
  on public.jobs (run_at, priority) where status = 'pending';
create index if not exists jobs_mailbox_idx on public.jobs (mailbox_id, created_at desc);
create unique index if not exists jobs_dedupe_idx
  on public.jobs (dedupe_key) where dedupe_key is not null;

create or replace trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

comment on table public.jobs is
  'Deferred work. Drained by POST /api/health?action=maintenance (cron). dedupe_key is a unique idempotency key.';

-- ═════════════════════════════════════════════════════════════════════════════
-- webhook_endpoints — outbound integration targets
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.webhook_endpoints (
  id          text primary key,
  mailbox_id  text references public.mailboxes (id) on delete cascade,  -- null = account-wide
  url         text not null,
  secret      text not null,                                  -- HMAC-SHA256 signing key
  description text,
  events      text[] not null default '{}',                   -- empty = all events
  is_active   boolean not null default true,
  created_by  text references public.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists webhook_endpoints_mailbox_idx
  on public.webhook_endpoints (mailbox_id) where is_active;

create or replace trigger webhook_endpoints_set_updated_at
  before update on public.webhook_endpoints
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════════
-- webhook_deliveries — outbound delivery log (successes and failures)
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.webhook_deliveries (
  id              bigserial primary key,
  endpoint_id     text not null references public.webhook_endpoints (id) on delete cascade,
  event           text not null,
  payload         jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body   text,
  error           text,
  attempts        integer not null default 0,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists webhook_deliveries_endpoint_idx
  on public.webhook_deliveries (endpoint_id, created_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- notifications — per-user in-app alerts
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.notifications (
  id          text primary key,
  user_id     text not null references public.users (id) on delete cascade,
  mailbox_id  text references public.mailboxes (id) on delete cascade,
  kind        text not null default 'info',
  title       text not null,
  body        text,
  entity_type text,
  entity_id   text,
  url         text,
  is_read     boolean not null default false,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where not is_read;

-- ═════════════════════════════════════════════════════════════════════════════
-- campaigns / campaign_recipients — bulk sending
-- ═════════════════════════════════════════════════════════════════════════════
create table if not exists public.campaigns (
  id                 text primary key,
  mailbox_id         text not null references public.mailboxes (id) on delete cascade,
  name               text not null,
  subject            text not null,
  body_html          text,
  body_text          text,
  status             text not null default 'draft'
                       check (status in ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
  scheduled_for      timestamptz,
  -- Throttle: how many recipients the worker may send to per drain cycle.
  batch_size         integer not null default 50,
  total_recipients   integer not null default 0,
  sent_count         integer not null default 0,
  failed_count       integer not null default 0,
  created_by         text references public.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  started_at         timestamptz,
  completed_at       timestamptz
);

create index if not exists campaigns_mailbox_idx
  on public.campaigns (mailbox_id, created_at desc);
create index if not exists campaigns_due_idx
  on public.campaigns (scheduled_for) where status = 'scheduled';

create or replace trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

create table if not exists public.campaign_recipients (
  id          text primary key,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  email       text not null,
  name        text,
  status      text not null default 'pending'
                check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  message_id  text references public.messages (id) on delete set null,
  error       text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Case-insensitive: an address appears at most once per campaign.
create unique index if not exists campaign_recipients_email_ci
  on public.campaign_recipients (campaign_id, lower(email));
create index if not exists campaign_recipients_status_idx
  on public.campaign_recipients (campaign_id, status);

-- ═════════════════════════════════════════════════════════════════════════════
-- messages — assignment, snooze, reminders, follow-up
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.messages add column if not exists assigned_to       text references public.users (id) on delete set null;
alter table public.messages add column if not exists assigned_at       timestamptz;
alter table public.messages add column if not exists snoozed_until     timestamptz;
alter table public.messages add column if not exists remind_at         timestamptz;
alter table public.messages add column if not exists follow_up_at      timestamptz;
alter table public.messages add column if not exists follow_up_sent    boolean not null default false;

create index if not exists messages_assigned_idx
  on public.messages (mailbox_id, assigned_to) where assigned_to is not null;
create index if not exists messages_snoozed_idx
  on public.messages (mailbox_id, snoozed_until) where snoozed_until is not null;
create index if not exists messages_follow_up_idx
  on public.messages (follow_up_at) where follow_up_at is not null and not follow_up_sent;

-- ═════════════════════════════════════════════════════════════════════════════
-- mailboxes — out-of-office auto-reply
--
-- `auto_reply_log` is a small JSON map of sender → last auto-reply timestamp,
-- used to answer a given sender at most once per interval so two auto-responders
-- cannot loop forever.
-- ═════════════════════════════════════════════════════════════════════════════
alter table public.mailboxes add column if not exists auto_reply_enabled     boolean not null default false;
alter table public.mailboxes add column if not exists auto_reply_subject     text;
alter table public.mailboxes add column if not exists auto_reply_body        text;
alter table public.mailboxes add column if not exists auto_reply_start       timestamptz;
alter table public.mailboxes add column if not exists auto_reply_end         timestamptz;
alter table public.mailboxes add column if not exists auto_reply_interval_min integer not null default 1440;
alter table public.mailboxes add column if not exists auto_reply_log         jsonb not null default '{}'::jsonb;

comment on column public.mailboxes.auto_reply_log is
  'sender address → ISO timestamp of the last auto-reply, to rate-limit (and de-loop) out-of-office responses.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Row-level security: deny-by-default for every new table.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  t text;
begin
  foreach t in array array[
    'automation_rules', 'automation_rule_runs', 'templates', 'message_notes',
    'jobs', 'webhook_endpoints', 'webhook_deliveries', 'notifications',
    'campaigns', 'campaign_recipients'
  ]
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
