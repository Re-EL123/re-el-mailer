# Deployment

Two deployments: the API on Vercel, the frontend on GitHub Pages.

```
api.mail.re-el.co.za   →  Vercel serverless functions
mailer.re-el.co.za       →  GitHub Pages (static PWA)
```

## 1. Environment variables

Copy `.env.example` and set real values. `packages/shared/config.js` validates these at
boot and fails fast in production.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in deployed environments |
| `APP_URL` | Canonical frontend origin; required in production |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist including `APP_URL` |
| `DATABASE_URL` | Supabase Postgres, pooled (port 6543) connection string |
| `DIRECT_URL` | Supabase Postgres direct connection (port 5432), for migrations |
| `DATABASE_SSL` | `true` for Supabase |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage uploads and signed download URLs |
| `ATTACHMENT_BUCKET` | Private Storage bucket name; must **not** be public |
| `JWT_SECRET` | Signs access tokens, and derives reset/email-verify tokens |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS` | Session lifetimes (e.g. `15m`, `30`) |
| `COOKIE_SECURE`, `COOKIE_SAMESITE` | `true` / `lax` — the API and PWA are same-site subdomains |
| `RESEND_API_KEY` | Outbound delivery |
| `RESEND_INBOUND_WEBHOOK_SECRET` | Signs the inbound-mail webhook |
| `RESEND_EVENT_WEBHOOK_SECRET` | Signs the delivery-event webhook |
| `MAIL_FROM_EMAIL`, `MAIL_FROM_NAME` | Verified sending identity |
| `MAIL_DOMAINS` | Comma-separated domains this deployment serves mailboxes for |
| `CRON_SECRET` | Bearer secret Vercel sends to the maintenance cron |
| `HEALTHCHECK_TOKEN` | Optional bearer for `?action=ping` monitoring |

Generate secrets with `openssl rand -base64 48`.

`.env.example` is the authoritative list and `npm run check` fails if the two drift
apart, but that check only covers *presence*, not semantics. Two worth calling out:

- `COOKIE_SAMESITE` must stay `lax`. `mail.re-el.co.za` and `api.mail.re-el.co.za`
  are the same site, so `none` is unnecessary; `strict` would block the refresh
  cookie on some navigation paths.
- `MAIL_DOMAINS` must match the domains registered in the admin console. It is the
  first thing to check if a new domain's mail is rejected.

`npm run db:reset` is guarded by the `--yes` flag rather than an environment variable.

Because the API and frontend are on different origins, `ALLOWED_ORIGINS` must list the
frontend origin exactly, and the CORS layer must allow credentials so the `httpOnly`
refresh cookie travels. The frontend always sends `credentials: 'include'`.

## 2. Database (Supabase)

1. Create a Supabase project.
2. Copy the **pooled** connection string (port `6543`) into `DATABASE_URL` — this is what
   the serverless API uses — and the **direct** string (port `5432`) into `DIRECT_URL`.
3. Run migrations against the *direct* connection:

```bash
DIRECT_URL=postgres://...@db.<ref>.supabase.co:5432/postgres npm run db:migrate
```

If the variables are already on the Vercel project, skip the copy entirely:

```bash
npm run db:migrate:vercel
```

If a connection is rejected with `password authentication failed`, verify the
password before editing Vercel again — each edit-and-redeploy cycle costs minutes
and can leave a wrong password in the dashboard:

```bash
read -rs PASSWORD && printf '%s' "$PASSWORD" | npm run db:check -- --pull --stdin; unset PASSWORD
```

This connects once and reports whether the password is accepted, without touching
Vercel. The password is read from stdin, so it never enters argv or shell history,
and it is never printed or logged. The common mistake is substituting the Supabase
**account login** password: the connection strings need the **database** password,
which is a separate secret (Supabase → Settings → Database → Database password).
Special characters are encoded for you; if the value contains `@ : / ? # % & [ ]`,
use the strings copied straight from the dashboard.

`create-admin` and `db:seed` accept `--pull` for the same reason, so the whole
provisioning sequence runs without a local `.env` holding production secrets:

```bash
npm run db:migrate:vercel
npm run create-admin -- --pull --email admin@re-el.co.za
```

`db:migrate:vercel` pulls the production environment from Vercel, uses `DIRECT_URL`, and deletes
the pulled file afterwards — it contains every production secret, not just the
database URL. It is the most reliable route precisely because nothing is retyped:
the usual failure is a connection string pasted with the literal `[YOUR-PASSWORD]`
placeholder still in it. Requires `vercel login` and `vercel link`.

`npm run db:migrate` prefers `DIRECT_URL` and only falls back to `DATABASE_URL`. This is
not cosmetic: `schema.sql` issues `create extension`, `create policy` and
`alter table … enable row level security`, and the transaction pooler multiplexes
statements over a single backend connection, so DDL run through it can fail or apply
against the wrong session. The app itself is fine on the pooled string — keep
`DATABASE_URL` pooled for Vercel, where many concurrent functions share one pool.

4. Verify:

```bash
npm run db:verify
```

5. Create the first admin:

```bash
npm run create-admin -- --pull --email admin@re-el.co.za
```

It prints a temporary password; the account is flagged `must_change_password`.

6. Optionally seed reference data and demo mail:

```bash
npm run db:seed -- --pull
npm run db:seed -- --pull --demo
```

### Storage

The migration creates the `mail-attachments` bucket for you, private by default —
no manual step. Downloads go through short-lived signed URLs, so flipping the bucket to
public in the Supabase dashboard would bypass that entirely; the schema resets
`public = false` on every run.

## 3. DNS

For `re-el.co.za`, publish records for receiving and for sending reputation:

| Type | Name | Value |
| --- | --- | --- |
| MX | `re-el.co.za` | Resend inbound MX (from the Resend dashboard) |
| TXT | `re-el.co.za` | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey.re-el.co.za` | Resend DKIM public key |
| TXT | `_dmarc.re-el.co.za` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@re-el.co.za` |
| CNAME/A | `api.mail.re-el.co.za` | Vercel API domain |
| CNAME | `mailer.re-el.co.za` | GitHub Pages |

MX propagation can take a while; verify with `dig MX re-el.co.za` before expecting
inbound mail to arrive.

## 4. API (Vercel)

1. Import the repository into Vercel.
2. Vercel detects the functions in `api/` automatically; `vercel.json` declares the
   runtime, headers and cron. Confirm the function count matches `vercel.json`
   (`npm run check` enforces this).

   Do not "clean up" the two odd-looking entries in `vercel.json`. `"buildCommand": ""`
   is an empty string, not `null`: `null` means *unset*, so Vercel auto-detects the
   `build` script in `package.json`, runs it, and then fails with *"No Output
   Directory named \"public\" found"*. And `outputDirectory` must name a directory that
   exists and is empty (here, `public/`) — because the functions are deployed
   **unbundled**, each shipping its own copy of `api/`, `packages/` and
   `node_modules/`, Vercel uploads the whole repository. Without an explicit output
   directory it publishes that repository as static files, and `schema.sql`,
   `docs/security.md` and the rest of `packages/` become readable on the API domain.
   `npm run check` fails on either mistake.
3. Add every environment variable from step 1 to **Production and Preview**.
4. Set `APP_URL=https://mailer.re-el.co.za` and include that origin in `ALLOWED_ORIGINS`.
5. Deploy and verify:

```bash
curl https://api.mail.re-el.co.za/api/health?action=ping
```

Configure the Resend inbound webhook to
`https://api.mail.re-el.co.za/api/webhooks?action=inbound` with
`RESEND_INBOUND_WEBHOOK_SECRET`, and the delivery-event webhook to
`.../api/webhooks?action=delivery` with `RESEND_EVENT_WEBHOOK_SECRET`. Resend shows
each secret when you create the endpoint; they are distinct values.

The maintenance cron runs daily at 03:17 UTC and requires `CRON_SECRET`; Vercel sends it
as a bearer token automatically.

## 5. Frontend (GitHub Pages)

1. In *Settings → Pages*, set the source to **GitHub Actions**. `.github/workflows/pages.yml`
   publishes `apps/web` on every push to `main` that touches the frontend. There is no
   build step: the PWA is served as written, and the workflow only verifies that its
   asset references resolve.
2. `apps/web/CNAME` already pins `mailer.re-el.co.za`, so Pages serves the custom
   domain once the CNAME record exists. Add a second hostname as an extra CNAME line if needed.
3. The API base is set in `apps/web/index.html` via `window.__REEL_CONFIG__.apiBase`
   and defaults to `https://api.mail.re-el.co.za/api`, which is correct for this split
   deployment. It only falls back to the same-origin `/api` path when the page is
   served from `localhost`/`127.0.0.1`, where `scripts/serve-web.mjs` proxies the
   functions. Change the host if the API is hosted elsewhere.

   Keep the `/api` path. Vercel mounts everything in `api/` under `/api`, so a base of
   `https://api.mail.re-el.co.za` alone makes every request 404 — and because an edge
   404 carries no CORS headers, the browser reports it as *"Access-Control-Allow-Origin
   missing"*, which looks like an `ALLOWED_ORIGINS` problem rather than a routing one.
   `api.js` normalises the value, so `?api=http://localhost:3000` works with or without
   the path, and `tests/api-base.test.js` fails if the default loses it.
4. The service worker only registers on `https:` — expected, and required for Pages.

## 6. Post-deploy verification

```bash
npm run check                 # syntax, imports, functions, secret scan
npm test                      # unit tests
npm run db:verify             # against the production database (read-mostly)
curl 'https://api.mail.re-el.co.za/api/health?action=ping'
```

Then confirm, in the browser:

1. Sign in, and the inbox loads.
2. Send a test message to an external address and watch it arrive.
3. Send mail *to* `re-el.co.za` and confirm it lands in the inbox (checks MX, signature
   verification, routing).
4. Sign out and sign back in on another device, then use *sign out other devices*.
5. Install the PWA and confirm it launches standalone.
6. Trigger a bounce and confirm the message shows `bounced`.
7. In the admin console, add a domain, add a catch-all route for it, and confirm the
   Routes tab lists both the domain and its mailboxes.
8. Compose a message, attach a file, reload the page, and confirm the draft and its
   attachment are both still there.

## Rollback

The API is stateless, so a rollback is redeploying the previous commit. Database changes
are forward-only; take a Supabase backup before migrating, and note that
`schema_migrations` prevents a rolled-back migration from re-running automatically —
check `npm run db:migrate` output if a migration needs to be reapplied deliberately.