# Re-EL Mailer

Business email. Built for Re-EL.

A self-hosted mail platform for `re-el.co.za`: serverless API on Vercel, PostgreSQL +
object storage on Supabase, and Resend for delivery. The frontend is a dependency-free
PWA on GitHub Pages, so it works as an installable desktop/mobile client.

## Features

- **Mailboxes & aliases** — domains, mailboxes, catch-all and alias routes, per-mailbox quotas.
- **Inbound & outbound** — Resend inbound webhooks, multipart attachments, scheduled sends
  (up to 30 days ahead), reply/forward threading.
- **Folders & labels** — inbox, starred, drafts, sent, archive, spam, trash plus custom labels.
- **Search & threads** — server-side search with thread grouping.
- **Security** — rotating access/refresh tokens, `httpOnly` cookies, bcrypt password
  hashing, rate limiting, RLS, structured audit log, HMAC-verified webhooks, and message
  bodies rendered in a sandboxed frame.
- **Administration** — users, roles, mailbox provisioning, domains, routes, quota, audit log.
- **Operations** — health probes, scheduled retention maintenance, migrations, seeding, local dev server.

## Layout

```
api/            Vercel serverless functions (one module per bounded context)
packages/
  auth/         password hashing, tokens, sessions, guards
  db/           repositories (the only place SQL lives)
  http/         pipeline, validation, errors, signature verification
  mail/         compose + inbound normalisation
  resend/       provider client
  storage/      attachment lifecycle
  shared/       config, logger, dotenv, validation schemas
apps/web/       static PWA frontend
database/       schema.sql + migrations
scripts/        migrate, seed, reset, create-admin, check, verify-db, serve-web, build-icons
.github/        CI (check + test) and Pages deployment workflows
docs/           architecture, security, deployment
tests/          vitest
```

## Quick start

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, RESEND_API_KEY, …
npm run db:migrate         # apply schema + migrations
npm run create-admin        # provision the first admin (prints a temp password)
npm run db:seed            # optional: demo domain, mailboxes, labels, demo mail
npm run check               # syntax, imports, function wiring, secret scan
npm test                    # unit tests
npm run db:verify           # integration tests against a real PostgreSQL
npm run dev:web             # http://localhost:4173 with /api proxied
```

Frontend-only changes can be previewed with `npm run dev:web`; icons regenerate with
`npm run build`.

## Configuration

All server configuration is read from the environment via `packages/shared/config.js`,
which fails fast on missing/invalid values in production. See `.env.example` for the
full list and `docs/deployment.md` for the production values.

The frontend reads its API base from `window.__REEL_CONFIG__.apiBase`, set inline in
`apps/web/index.html`. It defaults to `https://api.mail.re-el.co.za/api` for this split
deployment, and to `/api` when served from localhost, where the dev proxy forwards it.
The trailing `/api` is the Vercel mount point for `api/` — without it every request 404s
and the browser misreports that as a CORS failure.

## Documentation

- [docs/architecture.md](docs/architecture.md) — request flow, data model, modules.
- [docs/security.md](docs/security.md) — auth model, webhooks, rate limits, headers.
- [docs/deployment.md](docs/deployment.md) — DNS, Supabase, Resend, Vercel, Pages.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev:api` | Vercel dev server for the API |
| `npm run dev:web` | Static frontend server with an `/api` proxy |
| `npm run check` | Static validation of the whole repo |
| `npm test` | Vitest unit tests |
| `npm run db:verify` | PostgreSQL integration verification |
| `npm run db:migrate` | Apply schema and pending migrations |
| `npm run db:reset` | Destructive: drop `public` and re-apply the schema |
| `npm run db:seed` | Seed reference data (and optional demo mail) |
| `npm run create-admin` | Create or promote an admin user |
| `npm run build` | Regenerate PWA icons |