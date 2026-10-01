# Deployment

Two deployments: the API on Vercel, the frontend on GitHub Pages.

```
api.mail.re-el.co.za   →  Vercel serverless functions
mail.re-el.co.za       →  GitHub Pages (static PWA)
```

## 1. Environment variables

Copy `.env.example` and set real values. `packages/shared/config.js` validates these at
boot and fails fast in production.

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in deployed environments |
| `APP_URL` | Canonical frontend origin; required in production |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist including `APP_URL` |
| `DATABASE_URL` / `DIRECT_URL` | Supabase Postgres (pooled) and direct connection |
| `DATABASE_SSL` | `true` for Supabase |
| `JWT_SECRET`, `TOKEN_PEPPER`, `WEBHOOK_SECRET` | Signing/verification secrets |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` | Session lifetimes |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Resend delivery + inbound verification |
| `STORAGE_BUCKET`, `STORAGE_*` | Supabase Storage credentials and path prefix |
| `CRON_SECRET` | Bearer secret for the maintenance cron endpoint |
| `ALLOW_DESTRUCTIVE_RESET` | Must be `1` to allow `npm run reset` |

Generate secrets with something like `openssl rand -base64 48`.

Because the API and frontend are on different origins, `ALLOWED_ORIGINS` must list the
frontend origin exactly, and the CORS layer must allow credentials so the `httpOnly`
refresh cookie travels. The frontend always sends `credentials: 'include'`.

## 2. Database (Supabase)

1. Create a Supabase project.
2. Copy the pooled connection string into `DATABASE_URL` and the direct (non-pooler)
   string into `DIRECT_URL`.
3. Run migrations:

```bash
DATABASE_URL=... DIRECT_URL=... npm run migrate
```

4. Verify:

```bash
npm run db:verify
```

5. Create the first admin:

```bash
npm run create-admin -- admin@re-el.co.za
```

It prints a temporary password; the account is flagged `must_change_password`.

6. Optionally seed reference data and demo mail:

```bash
npm run seed
npm run seed -- --demo
```

### Storage

Create a private bucket (default name in `.env.example`), then configure
`STORAGE_BUCKET`, `STORAGE_*` credentials and `STORAGE_PATH_PREFIX`. The bucket must
**not** be public — downloads go through short-lived signed URLs.

## 3. DNS

For `re-el.co.za`, publish records for receiving and for sending reputation:

| Type | Name | Value |
| --- | --- | --- |
| MX | `re-el.co.za` | Resend inbound MX (from the Resend dashboard) |
| TXT | `re-el.co.za` | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey.re-el.co.za` | Resend DKIM public key |
| TXT | `_dmarc.re-el.co.za` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@re-el.co.za` |
| CNAME/A | `api.mail.re-el.co.za` | Vercel API domain |
| CNAME | `mail.re-el.co.za` | GitHub Pages |

MX propagation can take a while; verify with `dig MX re-el.co.za` before expecting
inbound mail to arrive.

## 4. API (Vercel)

1. Import the repository into Vercel.
2. Vercel detects the functions in `api/` automatically; `vercel.json` declares the
   runtime, headers and cron. Confirm the function count matches `vercel.json`
   (`npm run check` enforces this).
3. Add every environment variable from step 1 to **Production and Preview**.
4. Set `APP_URL=https://mail.re-el.co.za` and include that origin in `ALLOWED_ORIGINS`.
5. Deploy and verify:

```bash
curl https://api.mail.re-el.co.za/api/health?action=ping
```

Configure the Resend inbound webhook to
`https://api.mail.re-el.co.za/api/webhooks?action=inbound` and the delivery-event
webhook to `.../api/webhooks?action=delivery`, both signed with `RESEND_WEBHOOK_SECRET`.

The maintenance cron runs daily at 03:17 UTC and requires `CRON_SECRET`; Vercel sends it
as a bearer token automatically.

## 5. Frontend (GitHub Pages)

1. In *Settings → Pages*, set the source to **GitHub Actions**. `.github/workflows/pages.yml`
   publishes `apps/web` on every push to `main` that touches the frontend. There is no
   build step: the PWA is served as written, and the workflow only verifies that its
   asset references resolve.
2. Point `mail.re-el.co.za` at the Pages site (or add a CNAME file if serving from a
   `github.io` domain).
3. The API origin is set in `apps/web/index.html` via `window.__REEL_CONFIG__.apiBase`
   and defaults to `https://api.mail.re-el.co.za`, which is correct for this split
   deployment. It only falls back to the same-origin `/api` path when the page is
   served from `localhost`/`127.0.0.1`, where `scripts/serve-web.mjs` proxies the
   functions. Change it if the API is hosted elsewhere; a same-origin `/api` on
   Pages has no functions behind it and every request will 404.
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
check `npm run migrate` output if a migration needs to be reapplied deliberately.