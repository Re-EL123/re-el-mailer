// @vitest-environment jsdom
/**
 * The plain-text body formatter.
 *
 * Text bodies render as paragraphs when the framing function (or depth of the
 * error) decides there is no safe HTML for the message, and form-submission
 * Key/Value reports — which arrive as "label line, blank line, value line"
 * pairs — are promoted to a table so they read like the HTML the sender
 * intended instead of a wall of text.
 */

import { describe, expect, it } from 'vitest';

import { formatTextBody } from '../apps/web/js/views/message.js';

function types(parts) {
  return parts.map((node) => node.localName);
}

describe('formatTextBody', () => {
  it('renders a plain body as paragraphs, preserving internal line breaks', () => {
    const parts = formatTextBody('Hello Ada.\n\nFirst paragraph\nsecond line inside it.\n\nRegards,\nAda');

    expect(types(parts)).toEqual(['p', 'p', 'p']);
    expect(parts[0].textContent).toBe('Hello Ada.');
    expect(parts[1].textContent).toBe('First paragraph\nsecond line inside it.');
    expect(parts[1].className).toBe('reader-para');
    expect(parts[2].textContent).toBe('Regards,\nAda');
  });

  it('promotes a run of Key/Value pairs to a table after the intro', () => {
    const body = [
      'Someone just submitted your form on https://www.re-el.co.za/.',
      '',
      "Here's what they had to say:",
      '',
      'name',
      'test',
      '',
      'company',
      'dd',
      '',
      'email',
      'akanishibiri4422@gmail.com',
      '',
      'service',
      'Software Development',
      '',
      'Regards',
      '',
    ].join('\n');

    const parts = formatTextBody(body);

    expect(types(parts)).toEqual(['p', 'p', 'table', 'p']);
    const rows = parts[2].querySelectorAll('tr');
    expect(rows.length).toBe(4);
    expect(rows[0].firstElementChild.tagName).toBe('TH');
    expect(rows[0].firstElementChild.textContent).toBe('name');
    expect(rows[0].lastElementChild.tagName).toBe('TD');
    expect(rows[0].lastElementChild.textContent).toBe('test');
    expect(rows[1].lastElementChild.textContent).toBe('dd');
    expect(rows[2].lastElementChild.textContent).toBe('akanishibiri4422@gmail.com');
    expect(rows[3].lastElementChild.textContent).toBe('Software Development');
  });

  it('leaves trailing text after the report rows as a paragraph', () => {
    const parts = formatTextBody('name\nAda\n\nphone\n081 234 5678\n\nLoading… done');

    expect(parts[0].localName).toBe('table');
    expect(parts[0].querySelectorAll('tr').length).toBe(2);
    expect(parts[1].localName).toBe('p');
    expect(parts[1].textContent).toBe('Loading… done');
  });

  it('does not treat a lone pair, or a single wall, as a report', () => {
    expect(types(formatTextBody('name\nAda'))).toEqual(['p']);

    // The value spills onto a second line, so this block is not a pair.
    expect(types(formatTextBody('price\nFirst line\nSecond line'))).toEqual(['p']);
  });

  it('never returns a table for a body with fewer than two pairs', () => {
    expect(types(formatTextBody('Order\n#42\n\nThanks!'))).toEqual(['p', 'p']);
    expect(formatTextBody('Order\n#42\n\nThanks!')[0].textContent).toBe('Order\n#42');
  });

  it('handles an empty or whitespace-only body', () => {
    expect(formatTextBody('')).toEqual([]);
    expect(formatTextBody('   \n  \n')).toEqual([]);
    expect(formatTextBody()).toEqual([]);
  });
});