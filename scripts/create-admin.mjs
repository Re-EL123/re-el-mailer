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
 *   npm run create-admin -- akani@re-el.co.za
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

/**
 * Accept a bare email as the first positional argument too.
 *
 * `npm run create-admin -- akani@re-el.co.za` is what everyone types first, and
 * answering "An email is required" without saying so is a confusing dead end.
 */
function positionalEmail() {
  const skip = (value) => ['--email', '--name', '--password'].includes(value);
  for (let i = 2; i < process.argv.length; i += 1) {
    const value = process.argv[i];
    if (value.startsWith('--')) {
      if (!skip(value)) i += 1;
      continue;
    }
    if (value.includes('@')) return value;
  }
  return null;
}

async function main() {
  const { query, closePool } = await import('../packages/db/pool.js');
  const { createUser, findByEmail, updateUser } = await import('../packages/db/users.js');
  const { hashPassword, generatePassword, checkPasswordPolicy } = await import('../packages/auth/passwords.js');
  const { createMailbox, findDomainByName, findMailboxByEmail, listMailboxesForUser } = await import(
    '../packages/db/mailboxes.js'
  );
  const { mail: mailConfig } = await import('../packages/shared/config.js');

  const email = (arg('email') || positionalEmail() || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const displayName = (arg('name') || process.env.ADMIN_NAME || email.split('@')[0] || 'Administrator').trim();
  let password = arg('password') || process.env.ADMIN_PASSWORD || null;

  if (!email || !email.includes('@')) {
    console.error('An email is required. Example:');
    console.error('  npm run create-admin -- --email akani@re-el.co.za');
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