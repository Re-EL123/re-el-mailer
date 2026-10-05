# Architecture

## Request flow

Every API module is a Vercel serverless function with the same shape: an
`ACTIONS` table mapping an action name to a handler, wrapped in the shared
pipeline.

```
Browser
  │  fetch (access token: Bearer, refresh token: httpOnly cookie)
  ▼
/api/<module>?action=<name>        ← one of: auth, mail, send, admin, webhooks, health, settings
  ▼
packages/http/pipeline.js
  ├─ CORS preflight / origin allowlist      (ALLOWED_ORIGINS, APP_URL)
  ├─ method allowlist
  ├─ request id + structured logging
  ├─ raw body capture (packages/http/body.js)
  ├─ validation (packages/validation/schemas.js)   ← runs BEFORE rate limiting
  ├─ rate limit (packages/auth/rate-limit.js)
  ├─ session + guards (packages/auth/guards.js)
  └─ handler
  ▼
packages/db/*  →  PostgreSQL (Supabase) with RLS
packages/resend →  Resend API
packages/storage →  Supabase Storage
  ▼
{ ok: true, data, requestId }  |  { ok: false, error: { code, message, details }, requestId }
```

Two pipeline rules matter:

- **Validation precedes rate limiting.** A malformed request is rejected without
  consuming a rate-limit slot, so a bad client can't lock out a real one.
- **`allowLargeJson`** is opt-in and only used by signature-authenticated webhooks,
  which must see the exact bytes for HMAC verification.

## API modules

| Module | Responsibility | Auth |
| --- | --- | --- |
| `api/auth.js` | login, refresh, logout, session, password reset, preferences | public + session |
| `api/mail.js` | folders, labels, search, threads, drafts, attachments, contacts, quota | session + mailbox owner |
| `api/send.js` | send, reply, forward, contact suggestions | session + mailbox owner + quota |
| `api/admin.js` | users, mailboxes, domains, routes, audit log | admin / manager |
| `api/webhooks.js` | Resend inbound mail and delivery events | HMAC signature only |
| `api/health.js` | ping, status, retention maintenance | public / admin / cron secret |
| `api/settings.js` | app settings and self-service mailbox settings | session |

Each module exports `ACTIONS` plus `meta`. `scripts/check.mjs` verifies that the
number of functions matches `vercel.json` and that every referenced module imports
cleanly.

## Data model

Core tables (full definitions in `database/schema.sql`):

- `users` — identity, bcrypt hash, role (`admin` / `manager` / `user`), status.
- `sessions` — hashed refresh tokens, rotation lineage, `revoked_at`.
- `domains`, `mailboxes`, `routes` — addressing. `routes` back catch-all and aliases.
- `messages` — one row per message, inbound and outbound. `thread_id` groups a
  conversation; `provider_id` stores the Resend id for delivery reconciliation.
- `attachments` — object-storage metadata plus a per-mailbox storage path.
- `labels`, `message_labels` — user-defined labels.
- `password_resets`, `email_verifications` — one-shot, hashed tokens.
- `audit_logs`, `rate_limits`, `app_settings`, `mailbox_stats` — operational state.

Every user-facing table carries `mailbox_id` (directly or via `messages`) and is
protected by row-level security so a compromised query layer still cannot cross
mailbox boundaries.

## Sending

Outbound mail is a single code path (`api/send.js` → `packages/mail/compose.js`):

1. Resolve the mailbox from the session; derive `From` from the owned mailbox address.
2. Assert the mailbox can send (status, quota, per-day/hour limits).
3. Verify every attachment id belongs to a message in that mailbox.
4. Build the provider payload. Scheduling is delegated to Resend
   (`scheduled_at`, max 30 days ahead) — the API does not run its own sender.
5. Insert the message row in `sent` with `delivery_status='queued'`, re-parent any
   draft attachments onto it, then send.
6. Delivery events from `api/webhooks.js` reconcile `queued` → `delivered` / `failed` /
   `bounced` / `complained` by `provider_id`.

## Inbound

Resend posts to `/api/webhooks?action=inbound`. The handler verifies the HMAC over the
**raw bytes**, then normalises the provider payload in
`packages/mail/inbound.js`: recipient → mailbox via the routing table, dedupe by
provider id, store attachments, thread by subject/reference headers, and place the
message in `inbox` (or `spam` when the provider flags it).

## Frontend

Native ES modules served as-is: no framework, no transpiler, and no bundler for
first-party code. The one build step bundles the composer editor (see
`build-editor.mjs`), because ProseMirror is a third-party package that cannot be
served to the browser as an unbundled ES module.

```
apps/web/
  index.html          inline API base config + module entry
  js/api.js           fetch wrapper: token refresh, error envelope
  js/store.js         observable state + local preferences
  js/router.js        hash router with per-view cleanup
  js/keys.js          scoped keyboard shortcuts + help dialog
  js/icons.js         inline SVG icon set (no icon font, no emoji in chrome)
  js/ui.js            el()/mount() DOM helpers, Intl formatting, skeletons, toasts
  js/views/*          auth, mail list, message, compose, settings, admin
  js/editor-entry.js  editor bundle source, bundled at build time
  js/vendor/          generated editor.bundle.js (committed)
  css/app.css         tokens + layout, light/dark via [data-theme]
  service-worker.js   caches the shell only, never API responses
```

The API is always fetched live; only static assets are cached, so a stale message list
can never be displayed. Views render through `el()`, which assigns `textContent` for
strings, so user data is never assigned as markup. The one exception is a message
body, which is sender-controlled and therefore rendered inside a sandboxed iframe
(`sandbox` without `allow-scripts` or `allow-same-origin`) rather than into the
document; the server also sanitises bodies on ingest and on send.

## Operational scripts

- `migrate.mjs` — applies `schema.sql` then pending migrations, tracked in
  `schema_migrations`.
- `reset.mjs` — drops `public` and re-applies. Destructive; refuses unless
  `ALLOW_DESTRUCTIVE_RESET=1`.
- `seed.mjs` — reference data (labels, settings, roles) and optional demo mail.
- `create-admin.mjs` — creates or promotes an admin and prints a temporary password.
- `check.mjs` — static validation: syntax, imports, function wiring, secret scan,
  required project files.
- `verify-db.mjs` — real PostgreSQL verification of schema, migrations, RLS,
  SQL functions and repositories.
- `serve-web.mjs` — static server with an `/api` proxy for local development.
- `build-icons.mjs` — deterministic SVG/PNG generation for the PWA icons, the
  Apple touch icon and the Open Graph card.
- `build-editor.mjs` — bundles the composer editor (TipTap/ProseMirror) into
  `apps/web/js/vendor/editor.bundle.js` with esbuild. The bundle is committed and
  precached by the service worker; `apps/web/js/editor-entry.js` is its source and
  is never loaded by the browser, which is why it is not in the precache list.