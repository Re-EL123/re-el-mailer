# Security

## Authentication

- **Passwords** are hashed with bcrypt at a configurable cost. Pure JavaScript on purpose:
  Argon2id is the stronger primitive, but it needs a native module, and a native build is the
  most common reason a serverless deploy fails. The cost factor is re-checked at login so
  hashes can be upgraded in place by raising it.
- **Access tokens** are short-lived JWTs held in memory by the frontend only. They are
  not written to `localStorage` or cookies.
- **Refresh tokens** are opaque, random, single-use, and stored only as a hash. They
  live in an `httpOnly`, `Secure`, `SameSite` cookie, so page scripts cannot read them.
  Each refresh rotates the token and revokes the predecessor; reuse of a rotated token
  revokes the whole session chain (refresh-token-reuse detection).
- **Sign out** revokes the current session. *Sign out other devices* revokes every other
  session for the user.
- **Password resets** use a single-use, hashed, expiring token. The API always responds
  identically to `forgot` whether or not the address exists, so it can't be used to
  enumerate accounts.
- **Locked accounts** are rate-limited by failed attempts and unlocked by an admin.
- **Newly provisioned accounts** are flagged `must_change_password` and the UI blocks
  access until the password is changed.

Because the refresh cookie is `httpOnly`, the frontend relies on the browser sending it
automatically. When the API is on a different origin than the frontend, requests must be
made with `credentials: 'include'` **and** the API's CORS configuration must allow
credentials for the exact frontend origin. The frontend always sets `credentials:
'include'`; the server side is configured via `ALLOWED_ORIGINS` and `APP_URL`.

## Authorisation

Authorisation is enforced server-side on every request; the client-side route guards are
convenience only.

- **Session** — required for all mail, send and self-service settings actions.
- **Mailbox ownership** — every mailbox-scoped query filters on the mailbox ids the
  session actually owns. A mailbox id supplied by the client is validated against the
  session before use, so guessing an id grants nothing.
- **Roles** — `admin` (full platform control), `manager` (mailbox/user operations),
  `user` (own mailboxes only).
- **Row-level security** — PostgreSQL policies mirror the application rules, so a bug in
  the query layer is not sufficient on its own to cross a tenant boundary.

The platform prevents demoting or deleting the last remaining admin, and prevents
deleting a user who still owns a mailbox.

## Webhooks

Webhook endpoints are public, so they are authenticated by signature rather than by
session.

- The HMAC-SHA256 signature is verified against the **exact raw request bytes**. The
  parsed body is never re-serialised for verification — a canonicalisation mismatch
  would otherwise let an attacker forge a signature over different content.
- Missing, malformed or mismatched signatures are rejected before parsing.
- The timestamp component is checked to bound replay.
- If the raw bytes cannot be recovered (a platform that consumed the stream), the
  request is **rejected**, never verified against a best-effort body. This is why the
  pipeline exposes the captured raw body rather than re-reading it.
- Inbound messages are idempotent on the provider message id, so a retried webhook does
  not create a duplicate.

## Input validation

Every action declares a schema. The pipeline parses and validates before the handler
runs and returns structured field-level errors. Notably:

- String lengths, array sizes and enum values are bounded.
- Recipients are parsed into structured addresses, and the recipient count is capped.
- HTML is sanitised on **ingest** and again on **send**, so stored message bodies
  are already safe.
- The reader renders a message body inside a sandboxed iframe that omits both
  `allow-scripts` and `allow-same-origin`. Sanitisation on ingest is the primary
  defence; this is the browser-enforced backstop that keeps a sanitizer bypass
  from reaching the app's own origin, session storage or DOM.
- JSON bodies are size-limited; webhooks opt in to a larger limit explicitly.

## Rate limiting

Rate limits are applied per identifier (user id, mailbox id or IP) and stored in
PostgreSQL so they hold across serverless instances:

- Login, password reset and verification endpoints are limited aggressively.
- Send actions are limited per mailbox and per hour, in addition to quota checks.
- API endpoints have a general per-IP ceiling.

Rate limiting runs **after** validation so malformed requests don't consume budget.

## Headers

`vercel.json` sets a strict baseline on every response:

- `Content-Security-Policy` with `default-src 'self'` and no inline script allowances
  beyond the small config shim; `frame-ancestors 'none'`; `object-src 'none'`.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY`
- `Permissions-Policy` disabling camera, microphone and geolocation.
- `Strict-Transport-Security` on HTTPS.

## Secrets

- All secrets come from the environment. `packages/shared/config.js` validates them at
  boot and refuses to start in production when a value is missing or too weak.
- `scripts/check.mjs` scans the repository for committed secrets and for hard-coded
  credentials.
- `.env` is git-ignored. Only `.env.example`, containing placeholders, is committed.
- No secret is ever returned to the client. The public settings endpoint returns only
  display-safe values.

## Storage

Attachments are stored under a per-mailbox path prefix. Access is never public: downloads
are short-lived signed URLs issued only after an ownership check. Deletion walks the
storage prefix and then the database rows, so a storage failure leaves the (inaccessible)
row in place rather than orphaning a file with no reference to it.

## Operational safeguards

- `reset.mjs` drops the schema and refuses to run without `ALLOW_DESTRUCTIVE_RESET=1`.
- The maintenance cron requires `CRON_SECRET`; retention deletes only already-trashed or
  already-spam messages older than the configured window.
- Health checks report configuration, database and storage status without leaking
  connection strings or internal hostnames.