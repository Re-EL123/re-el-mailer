-- ═════════════════════════════════════════════════════════════════════════════
-- 0001 — bootstrap defaults
--
-- Data, not schema. Idempotent: safe to run on an existing database.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Primary domain ───────────────────────────────────────────────────────────
insert into public.domains (id, name, status, notes)
values ('dom_re_el', 're-el.co.za', 'active',
        'Primary Re-EL domain. Publish the MX/SPF/DKIM/DMARC records from docs/dns.md before enabling inbound.')
on conflict (id) do nothing;

-- ── Editable settings ────────────────────────────────────────────────────────
-- These override the matching environment variables at runtime. Admin UI
-- writes here; deleting a row reverts to the environment default.
insert into public.settings (key, value, description) values
  ('company.name',            '"Re-EL Mailer"',                 'Product name shown in the UI and in outbound email.'),
  ('company.tagline',         '"Business email. Built for Re-EL."', 'Tagline used on the landing page and email footers.'),
  ('company.support_email',   '"support@re-el.co.za"',          'Reply-to for automated messages such as password resets.'),
  ('company.website',         '"https://re-el.co.za"',          'Used in email footers and the landing page.'),
  ('security.session_max',    '5',                              'Maximum concurrent sessions per user. Oldest are revoked first.'),
  ('security.password_min',   '10',                             'Minimum accepted password length.'),
  ('security.login_lockout',  '10',                             'Failed logins before the account is temporarily locked.'),
  ('security.login_lockout_minutes', '15',                      'Duration of a temporary login lockout.'),
  ('security.require_mixed_case_password', 'true',              'Require upper and lower case characters.'),
  ('security.require_number_password',    'true',              'Require at least one number.'),
  ('security.require_symbol_password',    'false',             'Require at least one symbol.'),
  ('limits.user_daily',       '100',    'Per-user daily outbound messages. null = fall back to SEND_DAILY_LIMIT_USER.'),
  ('limits.user_hourly',      '25',     'Per-user hourly outbound messages.'),
  ('limits.admin_daily',      '1000',   'Per-admin daily outbound messages.'),
  ('limits.admin_hourly',     '250',    'Per-admin hourly outbound messages.'),
  ('limits.domain_daily',     '5000',   'Whole-domain daily outbound messages.'),
  ('limits.max_recipients',   '25',     'Max to+cc recipients per message.'),
  ('limits.max_bcc',          '50',     'Max bcc recipients per message.'),
  ('retention.trash_days',    '30',     'Days before trashed messages are purged.'),
  ('retention.spam_days',     '30',     'Days before spam is purged.'),
  ('retention.audit_days',    '730',    'Days before audit log rows are purged (2 years).'),
  ('features.dark_mode',      'true',   'Expose the dark theme toggle.'),
  ('features.pwa',            'true',   'Serve the PWA manifest and service worker.'),
  ('features.notifications',  'true',   'Allow browser notifications for new mail.')
on conflict (key) do nothing;

-- ── Convenience view: mailbox with owner details ─────────────────────────────
create or replace view public.mailbox_directory as
select
  mb.id,
  mb.email,
  mb.display_name,
  mb.status,
  mb.quota_bytes,
  mb.storage_used_bytes,
  mb.is_primary,
  mb.auto_read,
  mb.daily_send_limit,
  mb.hourly_send_limit,
  mb.created_at,
  u.id  as user_id,
  u.display_name as owner_name,
  u.role,
  u.status as user_status,
  u.last_login_at,
  d.name as domain
from public.mailboxes mb
join public.users   u on u.id = mb.user_id
join public.domains d on d.id = mb.domain_id;