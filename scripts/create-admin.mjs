#!/usr/bin/env node
/**
 * Create an administrator (and a primary mailbox on the default domain).
 *
 * Idempotent by email: if the user already exists it updates the role to admin
 * rather than failing, so it is safe to re-run.
 *
 * Usage:
 *   npm run create-admin -- --email akani@re-el.co.za --name "Akani M"
 *   npm run create-admin -- --email akani@re-el.co.za --password 'S3cret!pass'
 *
 * With no --password a strong one is generated and printed once.
 */

import { loadEnvFile, REPO_ROOT } from '../packages/shared/dotenv.js';

loadEnvFile();

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const { query, closePool } = await import('../packages/db/pool.js');
  const { createUser, findByEmail, updateUser } = await import('../packages/db/users.js');
  const { hashPassword, generatePassword, checkPasswordPolicy } = await import('../packages/auth/passwords.js');
  const { createMailbox, findDomainByName, findMailboxByEmail, listMailboxesForUser } = await import(
    '../packages/db/mailboxes.js'
  );
  const { mail: mailConfig } = await import('../packages/shared/config.js');

  const email = (arg('email') || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const displayName = (arg('name') || process.env.ADMIN_NAME || email.split('@')[0] || 'Administrator').trim();
  let password = arg('password') || process.env.ADMIN_PASSWORD || null;

  if (!email || !email.includes('@')) {
    console.error('An email is required: --email you@re-el.co.za');
    process.exit(1);
  }

  const domain = await findDomainByName(email.split('@')[1]);
  if (!domain) {
    console.error(`Unknown domain "${email.split('@')[1]}". Run npm run db:migrate first.`);
    process.exit(1);
  }

  let temporaryPassword = null;
  if (password) {
    checkPasswordPolicy(password);
  } else {
    password = generatePassword();
    temporaryPassword = password;
  }

  const passwordHash = await hashPassword(password);

  // Create or promote.
  let user = await findByEmail(email);
  if (user) {
    user = await updateUser(user.id, { role: 'admin', passwordHash });
    console.log(`Existing user promoted to admin: ${email}`);
  } else {
    user = await createUser({
      email,
      passwordHash,
      displayName,
      role: 'admin',
      status: 'active',
      mustChangePassword: Boolean(temporaryPassword),
    });
    console.log(`Admin created: ${email}`);
  }

  // Ensure a primary mailbox exists.
  let mailbox = await findMailboxByEmail(email);
  if (!mailbox) {
    const existing = await listMailboxesForUser(user.id, { includeDisabled: true });
    if (existing.length === 0) {
      mailbox = await createMailbox({
        userId: user.id,
        domainId: domain.id,
        email,
        displayName,
        status: 'active',
        isPrimary: true,
      });
      console.log(`Primary mailbox created: ${email}`);
    } else {
      mailbox = existing[0];
      console.log(`Using existing mailbox: ${mailbox.email}`);
    }
  } else {
    console.log(`Mailbox already exists: ${mailbox.email}`);
  }

  if (temporaryPassword) {
    console.log('\nTemporary password (shown once):');
    console.log(`  ${temporaryPassword}`);
  }

  await query('select 1');
  await closePool().catch(() => {});
}

main().catch((err) => {
  console.error('create-admin failed:', err.message);
  process.exit(1);
});