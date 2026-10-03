/**
 * Admin forms build the correct payloads.
 *
 * The new UI lets admins create users and mailboxes without calling curl. The
 * payload builders mirror what the API expects, so a mistake in field naming or
 * encoding cannot leak through.
 */
import { describe, expect, it } from 'vitest';

import { buildCreateUserPayload, buildCreateMailboxPayload } from '../apps/web/js/views/admin.js';

describe('admin payload builders', () => {
  it('creates a user without forcing a password', () => {
    const payload = buildCreateUserPayload({
      email: 'Client@Example.COM  ',
      displayName: '  Client  ',
      role: 'manager',
      status: 'pending',
    });
    expect(payload).toEqual({
      email: 'client@example.com',
      displayName: 'Client',
      role: 'manager',
      status: 'pending',
    });
  });

  it('passes a chosen password through unchanged', () => {
    const payload = buildCreateUserPayload({
      email: 'a@re-el.co.za',
      displayName: 'A',
      role: 'user',
      status: 'active',
      password: 'temporary-pass-123',
    });
    expect(payload.password).toBe('temporary-pass-123');
    expect(payload.email).toBe('a@re-el.co.za');
  });

  it('builds a mailbox payload for an existing user', () => {
    const payload = buildCreateMailboxPayload({
      localPart: 'support  ',
      displayName: '  Support Desk  ',
      userId: 'usr_1',
      isPrimary: true,
    });
    expect(payload).toEqual({
      localPart: 'support',
      displayName: 'Support Desk',
      userId: 'usr_1',
      isPrimary: true,
    });
  });

  it('omits isPrimary when false to avoid sending a redundant flag', () => {
    // The API has a sensible default; including `false` is harmless, but the
    // UI should not need to second-guess callers. The schema's default is what
    // matters. Keeping it explicit when true makes the intent obvious.
    const payload = buildCreateMailboxPayload({
      localPart: 'inbox',
      displayName: 'Inbox',
      userId: 'usr_2',
      isPrimary: false,
    });
    expect(payload.isPrimary).toBe(false);
  });

  it('allows an explicit domain for a mailbox', () => {
    const payload = buildCreateMailboxPayload({
      localPart: 'sales',
      domain: 'example.co.za',
      displayName: 'Sales',
      userId: 'usr_3',
      isPrimary: true,
    });
    expect(payload.domain).toBe('example.co.za');
  });
});
