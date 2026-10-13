/**
 * Rule matching — pure and dependency-free so it can be unit-tested without a
 * database.
 *
 * A rule has a `conditions` object of the shape
 *   { match: 'all' | 'any', conditions: [{ field, operator, value }] }
 * and the message is reduced to a small set of comparable fields here. Keeping
 * this function pure means a webhook retry, an admin "test rule" button and a
 * unit test all evaluate a message the same way.
 */

/** Read a comparable value out of a message, tolerating snake_case rows. */
export function fieldValue(message, field) {
  const pick = (...names) => {
    for (const name of names) {
      if (message?.[name] !== undefined && message?.[name] !== null) return message[name];
    }
    return null;
  };

  switch (String(field || '').toLowerCase()) {
    case 'from':
    case 'from_email':
      return String(pick('fromEmail', 'from_email') ?? '').toLowerCase();
    case 'from_name':
      return String(pick('fromName', 'from_name') ?? '').toLowerCase();
    case 'to':
    case 'to_email':
      return (pick('to', 'to_emails') ?? []).join(' ').toLowerCase();
    case 'cc':
      return (pick('cc', 'cc_emails') ?? []).join(' ').toLowerCase();
    case 'recipient':
      return [...(pick('to', 'to_emails') ?? []), ...(pick('cc', 'cc_emails') ?? [])]
        .join(' ')
        .toLowerCase();
    case 'subject':
      return String(pick('subject') ?? '').toLowerCase();
    case 'body':
    case 'body_text':
      return String(pick('bodyText', 'body_text') ?? '').toLowerCase();
    case 'has_attachment':
    case 'has_attachments':
      return Boolean(pick('hasAttachments', 'has_attachments'));
    case 'folder':
      return String(pick('folder') ?? '').toLowerCase();
    case 'priority':
      return String(pick('priority') ?? 'normal').toLowerCase();
    case 'direction':
      return String(pick('direction') ?? 'inbound').toLowerCase();
    case 'size':
    case 'size_bytes':
      return Number(pick('sizeBytes', 'size_bytes') ?? 0);
    case 'label':
    case 'labels':
      return (pick('labelSlugs', 'label_slugs') ?? []).join(' ').toLowerCase();
    default:
      // An unknown field makes the condition false rather than throwing: a rule
      // saved against a field a later version removed must not break inbound.
      return null;
  }
}

/** Compare a single condition against a message. */
export function testCondition(condition, message) {
  if (!condition || typeof condition !== 'object') return false;
  const { field, operator, value } = condition;
  const actual = fieldValue(message, field);

  switch (String(operator || '').toLowerCase()) {
    case 'equals':
    case 'is':
      return String(actual).toLowerCase() === String(value ?? '').toLowerCase();
    case 'not_equals':
    case 'is_not':
      return String(actual).toLowerCase() !== String(value ?? '').toLowerCase();
    case 'contains':
      return String(actual).includes(String(value ?? '').toLowerCase());
    case 'not_contains':
      return !String(actual).includes(String(value ?? '').toLowerCase());
    case 'starts_with':
      return String(actual).startsWith(String(value ?? '').toLowerCase());
    case 'ends_with':
      return String(actual).endsWith(String(value ?? '').toLowerCase());
    case 'matches':
      try {
        return new RegExp(String(value ?? ''), 'i').test(String(actual));
      } catch {
        return false;
      }
    case 'gt':
      return Number(actual) > Number(value);
    case 'lt':
      return Number(actual) < Number(value);
    case 'is_empty':
      return actual === null || actual === '' || actual === false;
    case 'is_not_empty':
      return !(actual === null || actual === '' || actual === false);
    case 'is_true':
      return actual === true;
    case 'is_false':
      return actual === false;
    default:
      return false;
  }
}

/** True when every (or any) condition holds, per the rule's `match` mode. */
export function ruleMatches(rule, message) {
  const conditions = Array.isArray(rule?.conditions?.conditions) ? rule.conditions.conditions : [];
  if (conditions.length === 0) return false;
  const mode = rule.conditions.match === 'any' ? 'any' : 'all';
  const results = conditions.map((condition) => testCondition(condition, message));
  return mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Evaluate an ordered list of rules, returning the ones that matched.
 *
 * A matched rule whose `stop_processing` is set ends evaluation, which is how
 * an early, specific rule shields later catch-alls. The returned entries carry
 * the rule row so the caller can apply its actions in the same order.
 */
export function evaluateRules(rules, message) {
  const matched = [];
  for (const rule of rules || []) {
    if (!rule || rule.is_active === false) continue;
    if (!ruleMatches(rule, message)) continue;
    matched.push(rule);
    if (rule.stop_processing) break;
  }
  return matched;
}

export { fieldValue as _fieldValue };
