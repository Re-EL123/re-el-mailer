#!/usr/bin/env node
/**
 * Seed baseline data that the application expects to exist:
 *   • default labels for every active mailbox
 *   • a catch-all inbound route on the primary domain (to the first admin's
 *     primary mailbox) so unaddressed mail has somewhere to land
 *
 * Idempotent — safe to run repeatedly. Pass --demo to additionally create a
 * demo mailbox with a few contacts and a welcome message.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- --demo
 */

import { loadEnvFile } from '../packages/shared/dotenv.js';
import { pullFromVercel } from './lib/vercel-env.js';

if (process.argv.includes('--pull')) pullFromVercel({ label: 'seeding' });
else loadEnvFile();

const DEMO = process.argv.includes('--demo');

async function main() {
  const { queryAll, closePool } = await import('../packages/db/pool.js');
  const { listDomains, listAllMailboxes, findMailboxByEmail, createMailbox, ensureDefaultLabels, createInboundRoute, listInboundRoutes, rememberContacts, findDomainByName } =
    await import('../packages/db/mailboxes.js');
  const { findByEmail } = await import('../packages/db/users.js');
  const { createMessage } = await import('../packages/db/messages.js');
  const { makeSnippet } = await import('../packages/shared/sanitize.js');
  const { mail: mailConfig } = await import('../packages/shared/config.js');

  const domainName = mailConfig.domains[0];
  const domain = await findDomainByName(domainName);
  if (!domain) {
    console.error(`Domain "${domainName}" not found. Run npm run db:migrate first.`);
    process.exit(1);
  }

  // 1. Default labels for every active mailbox.
  const mailboxes = await listAllMailboxes({ status: 'active', limit: 500 });
  let labelsCreated = 0;
  for (const mailbox of mailboxes) {
    const before = await queryAll('select id from public.labels where mailbox_id = $1', [mailbox.id]);
    await ensureDefaultLabels(mailbox.id);
    const after = await queryAll('select id from public.labels where mailbox_id = $1', [mailbox.id]);
    labelsCreated += after.length - before.length;
  }
  console.log(`Default labels ensured for ${mailboxes.length} mailbox(es) (+${labelsCreated} new).`);

  // 2. Catch-all route for the primary domain, to the first admin's primary mailbox.
  const admins = await queryAll(
    `select mb.* from public.mailboxes mb
     join public.users u on u.id = mb.user_id
     where u.role = 'admin' and mb.is_primary and mb.status = 'active'
     order by mb.created_at asc limit 1`,
  );
  const routes = await listInboundRoutes(domain.id);
  const hasCatchAll = routes.some((route) => route.pattern === '*' && route.action === 'deliver');
  if (!hasCatchAll && admins.length > 0) {
    await createInboundRoute({
      domainId: domain.id,
      pattern: '*',
      mailboxId: admins[0].id,
      action: 'deliver',
      priority: 1000,
      note: 'Catch-all to the primary admin mailbox.',
    });
    console.log(`Catch-all route created for ${domainName} → ${admins[0].email}.`);
  } else if (hasCatchAll) {
    console.log('Catch-all route already present.');
  } else {
    console.log('No admin mailbox found; skipping catch-all route (run create-admin first).');
  }

  // 3. Optional demo data.
  if (DEMO) {
    const email = `demo@${domainName}`;
    let mailbox = await findMailboxByEmail(email);
    if (!mailbox) {
      const admin = await findByEmail(admins[0]?.email || '');
      if (!admin) {
        console.log('Need an admin before seeding demo data; skipping.');
      } else {
        mailbox = await createMailbox({
          userId: admin.id,
          domainId: domain.id,
          email,
          displayName: 'Demo Mailbox',
          status: 'active',
          quotaBytes: 2_147_483_648,
          isPrimary: false,
        });
        console.log(`Demo mailbox created: ${email}`);
      }
    }
    if (mailbox) {
      await rememberContacts(mailbox.id, [
        { name: 'Thandi Mokoena', email: 'thandi@example.co.za' },
        { name: 'Support Desk', email: 'support@partner.example' },
        { name: 'Pieter van Wyk', email: 'pieter@client.example' },
      ]);

      const already = await queryAll(
        `select id from public.messages where mailbox_id = $1 and subject like 'Welcome to Re-EL Mailer%'`,
        [mailbox.id],
      );
      if (already.length === 0) {
        const body = 'This is a demo welcome message so the mailbox is not empty.';
        await createMessage({
          mailboxId: mailbox.id,
          direction: 'inbound',
          fromEmail: 'no-reply@re-el.co.za',
          fromName: 'Re-EL Mailer',
          to: [email],
          subject: 'Welcome to Re-EL Mailer',
          bodyText: body,
          snippet: makeSnippet(body, 160),
          folder: 'inbox',
          isRead: false,
          sizeBytes: Buffer.byteLength(body, 'utf8'),
          receivedAt: new Date().toISOString(),
        });
        console.log('Demo welcome message created.');
      }
    }
  }

  console.log('\nSeed complete.');
  await closePool().catch(() => {});
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});