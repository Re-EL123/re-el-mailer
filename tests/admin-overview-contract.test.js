/**
 * Admin dashboard payload contract.
 *
 * The overview tiles rendered "[object Object]" for Users, Mailboxes and
 * Messages, and every activity row read "system" with an "Invalid Date".
 *
 * Two causes, both wiring rather than logic:
 *   - `overview` was the only admin action returning database rows directly.
 *     platformStats() nests its counts ({ users: { total, admins, active } }),
 *     while the console asked for flat scalars, so the tiles were handed an
 *     object for String() to print, and storageBytes/sentToday/receivedToday
 *     existed in neither shape and quietly read as 0.
 *   - recentActivity() selects snake_case columns, but the console read
 *     a.actorEmail and a.createdAt, so every row lost its actor and its date.
 *
 * These tests drive the real platformStats() and recentActivity() shapes through
 * the real handler, so the two shapes cannot drift apart again unnoticed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformStats = vi.fn();
const usageSeries = vi.fn();
const recentActivity = vi.fn();

vi.mock('../packages/db/system.js', () => ({
  platformStats: (...a) => platformStats(...a),
  usageSeries: (...a) => usageSeries(...a),
  recentActivity: (...a) => recentActivity(...a),
  audit: vi.fn(),
  listAuditLogs: vi.fn(),
  countAdmins: vi.fn(),
}));

const admin = await import('../api/admin.js');

/** The shape platformStats() really returns. */
function realPlatformStats() {
  return {
    mailboxes: { total: 4, active: 3, disabled: 1 },
    users: { total: 2, admins: 1, active: 2 },
    messages: { total: 137, bytes: 4096 },
    sentToday: 5,
    receivedToday: 9,
    delivery: { total: 14, delivered: 14, bounced: 0, complained: 0, deferred: 0, sent: 14, queued: 0, ratePct: 100 },
  };
}

/** The snake_case rows recentActivity() really selects. */
function realActivityRows() {
  return [
    {
      id: 'log_1',
      action: 'auth.password_changed',
      entity_type: 'user',
      entity_id: 'usr_1',
      actor_email: 'admin@re-el.co.za',
      metadata: {},
      created_at: '2026-10-02T09:00:00Z',
      actor_name: 'Site Admin',
    },
    {
      id: 'log_2',
      action: 'auth.login',
      entity_type: 'session',
      entity_id: 'ses_1',
      actor_email: null,
      metadata: {},
      created_at: '2026-10-01T08:30:00Z',
      actor_name: null,
    },
  ];
}

function ctx() {
  return {
    session: { user: { id: 'usr_1', email: 'admin@re-el.co.za', role: 'admin', status: 'active' } },
    query: {},
    setHeader: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function overview(query = {}) {
  const context = ctx();
  context.query = query;
  return admin.actions.overview.handler(context);
}

beforeEach(() => {
  vi.resetModules();
  platformStats.mockReset().mockResolvedValue(realPlatformStats());
  usageSeries.mockReset().mockResolvedValue([]);
  recentActivity.mockReset().mockResolvedValue(realActivityRows());
});

describe('admin overview stats', () => {
  it('flattens the nested counts into the scalars the tiles render', async () => {
    const { stats } = await overview();

    expect(stats.users).toBe(2);
    expect(stats.mailboxes).toBe(4);
    expect(stats.messages).toBe(137);
    expect(stats.storageBytes).toBe(4096);
    expect(stats.sentToday).toBe(5);
    expect(stats.receivedToday).toBe(9);
  });

  it('never hands the console an object for String() to print as [object Object]', async () => {
    const { stats } = await overview();

    for (const [key, value] of Object.entries(stats)) {
      expect(typeof value, `stats.${key} must be a scalar`).not.toBe('object');
      expect(String(value)).not.toContain('[object Object]');
    }
  });

  it('reports zero rather than undefined for an empty platform', async () => {
    platformStats.mockResolvedValue({
      mailboxes: { total: 0, active: 0, disabled: 0 },
      users: { total: 0, admins: 0, active: 0 },
      messages: { total: 0, bytes: 0 },
      sentToday: 0,
      receivedToday: 0,
      delivery: {},
    });

    const { stats } = await overview();
    expect(stats.users).toBe(0);
    expect(stats.storageBytes).toBe(0);
  });
});

describe('admin overview activity', () => {
  it('maps snake_case rows to the camelCase fields the view reads', async () => {
    const { activity } = await overview();

    expect(activity[0].actorEmail).toBe('admin@re-el.co.za');
    expect(activity[0].createdAt).toBe('2026-10-02T09:00:00Z');
    expect(activity[0].action).toBe('auth.password_changed');
  });

  it('gives every row a date the view can format', async () => {
    const { activity } = await overview();

    for (const row of activity) {
      // new Date(undefined) is what rendered "Invalid Date".
      expect(Number.isNaN(new Date(row.createdAt).getTime())).toBe(false);
    }
  });

  it('keeps actorEmail null when the row has no actor, so the view can say system', async () => {
    const { activity } = await overview();
    expect(activity[1].actorEmail).toBeNull();
    expect(activity[1].createdAt).toBe('2026-10-01T08:30:00Z');
  });

  it('passes the requested day window through to the usage series', async () => {
    await overview({ days: '30' });
    expect(usageSeries).toHaveBeenCalledWith({ days: 30 });
  });
});