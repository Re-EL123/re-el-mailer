/**
 * Unit tests for the pure halves of the automation feature: rule matching, the
 * out-of-office decision, placeholder rendering and webhook signing. All of
 * these are dependency-free on purpose, so they can be pinned without a database
 * or a network.
 */

import { describe, expect, it } from 'vitest';
import { evaluateRules, fieldValue, ruleMatches, testCondition } from '../packages/mail/rules.js';
import { renderAutoReply, shouldAutoReply, signOutboundWebhook } from '../packages/mail/automation.js';

const message = {
  fromEmail: 'Billing@Example.com',
  fromName: 'Billing Team',
  to: ['admin@re-el.co.za'],
  cc: [],
  subject: 'Quarterly INVOICE attached',
  bodyText: 'Please find the invoice attached.',
  hasAttachments: true,
  sizeBytes: 2048,
  folder: 'inbox',
  priority: 'normal',
};

const rule = (conditions, overrides = {}) => ({
  id: 'rul_1',
  is_active: true,
  conditions: { match: 'all', conditions },
  ...overrides,
});

describe('fieldValue', () => {
  it('reads camelCase message fields', () => {
    expect(fieldValue(message, 'from')).toBe('billing@example.com');
    expect(fieldValue(message, 'subject')).toBe('quarterly invoice attached');
    expect(fieldValue(message, 'has_attachment')).toBe(true);
    expect(fieldValue(message, 'size')).toBe(2048);
  });

  it('reads snake_case database rows too', () => {
    const row = { from_email: 'X@Y.com', to_emails: ['a@b.c'], body_text: 'Hi' };
    expect(fieldValue(row, 'from')).toBe('x@y.com');
    expect(fieldValue(row, 'to')).toBe('a@b.c');
    expect(fieldValue(row, 'body')).toBe('hi');
  });

  it('returns null for an unknown field instead of throwing', () => {
    expect(fieldValue(message, 'made_up_field')).toBe(null);
  });
});

describe('testCondition', () => {
  it('matches operators case-insensitively', () => {
    expect(testCondition({ field: 'from', operator: 'equals', value: 'billing@example.com' }, message)).toBe(true);
    expect(testCondition({ field: 'subject', operator: 'contains', value: 'invoice' }, message)).toBe(true);
    expect(testCondition({ field: 'subject', operator: 'starts_with', value: 'quarterly' }, message)).toBe(true);
    expect(testCondition({ field: 'subject', operator: 'ends_with', value: 'attached' }, message)).toBe(true);
    expect(testCondition({ field: 'subject', operator: 'matches', value: 'quar.*inv' }, message)).toBe(true);
  });

  it('handles numeric and boolean predicates', () => {
    expect(testCondition({ field: 'size', operator: 'gt', value: 1000 }, message)).toBe(true);
    expect(testCondition({ field: 'size', operator: 'lt', value: 1000 }, message)).toBe(false);
    expect(testCondition({ field: 'has_attachment', operator: 'is_true' }, message)).toBe(true);
    expect(testCondition({ field: 'cc', operator: 'is_empty' }, message)).toBe(true);
    expect(testCondition({ field: 'subject', operator: 'is_not_empty' }, message)).toBe(true);
  });

  it('returns false for an invalid regular expression rather than throwing', () => {
    expect(testCondition({ field: 'subject', operator: 'matches', value: '(' }, message)).toBe(false);
  });
});

describe('ruleMatches', () => {
  it('requires every condition with match=all', () => {
    const r = rule([
      { field: 'subject', operator: 'contains', value: 'invoice' },
      { field: 'from', operator: 'contains', value: 'example.com' },
    ]);
    expect(ruleMatches(r, message)).toBe(true);
  });

  it('accepts any condition with match=any', () => {
    const r = rule(
      [
        { field: 'subject', operator: 'contains', value: 'not-present' },
        { field: 'from', operator: 'contains', value: 'example.com' },
      ],
      {
        conditions: {
          match: 'any',
          conditions: [
            { field: 'subject', operator: 'contains', value: 'not-present' },
            { field: 'from', operator: 'contains', value: 'example.com' },
          ],
        },
      },
    );
    expect(ruleMatches(r, message)).toBe(true);
  });

  it('never matches a rule with no conditions', () => {
    expect(ruleMatches(rule([]), message)).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('returns matches in order and respects stop_processing', () => {
    const first = rule([{ field: 'subject', operator: 'contains', value: 'invoice' }], { id: 'rul_a', stop_processing: true });
    const second = rule([{ field: 'from', operator: 'contains', value: 'example.com' }], { id: 'rul_b' });
    const matched = evaluateRules([first, second], message);
    expect(matched.map((r) => r.id)).toEqual(['rul_a']);
  });

  it('skips inactive rules', () => {
    const disabled = rule([{ field: 'subject', operator: 'contains', value: 'invoice' }], { is_active: false });
    expect(evaluateRules([disabled], message)).toEqual([]);
  });
});

describe('shouldAutoReply', () => {
  const base = {
    auto_reply_enabled: true,
    auto_reply_body: 'Out of office',
    auto_reply_interval_min: 1440,
    auto_reply_log: {},
  };

  it('refuses when disabled or unconfigured', () => {
    expect(shouldAutoReply({ ...base, auto_reply_enabled: false }, 'x@y.com').reason).toBe('disabled');
    expect(shouldAutoReply({ auto_reply_enabled: true }, 'x@y.com').reason).toBe('no_template');
  });

  it('honours the active window', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect(shouldAutoReply({ ...base, auto_reply_start: future }, 'x@y.com').reason).toBe('before_window');
    expect(shouldAutoReply({ ...base, auto_reply_end: past }, 'x@y.com').reason).toBe('after_window');
  });

  it('rate-limits per sender', () => {
    const log = { 'x@y.com': new Date().toISOString() };
    expect(shouldAutoReply({ ...base, auto_reply_log: log }, 'X@Y.com').reason).toBe('already_replied');
    const stale = { 'x@y.com': new Date(Date.now() - 2 * 86_400_000).toISOString() };
    expect(shouldAutoReply({ ...base, auto_reply_log: stale }, 'x@y.com').send).toBe(true);
  });
});

describe('renderAutoReply', () => {
  it('substitutes the subject and sender placeholders', () => {
    expect(renderAutoReply('Re: {{subject}} from {{sender}}', { subject: 'Hi', sender: 'Thandi' })).toBe('Re: Hi from Thandi');
  });
});

describe('signOutboundWebhook', () => {
  it('is a deterministic HMAC over the timestamp and body', () => {
    const a = signOutboundWebhook('secret', 1234, '{"a":1}');
    const b = signOutboundWebhook('secret', 1234, '{"a":1}');
    const c = signOutboundWebhook('secret', 1235, '{"a":1}');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
