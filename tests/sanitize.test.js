/**
 * HTML sanitisation and address parsing.
 *
 * Message HTML is sanitised on ingest (storing unsafe markup would make every
 * reader a stored-XSS vector) and again on the way out. These tests pin the
 * cases that matter.
 */

import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  htmlToText,
  isSafeUrl,
  makeSnippet,
  sanitizeHtml,
  slugify,
  baseSubject,
} from '../packages/shared/sanitize.js';
import { parseAddress, parseAddressList } from '../packages/shared/email-address.js';

describe('sanitizeHtml', () => {
  it('removes script tags and their contents', () => {
    const result = sanitizeHtml('<p>Hello</p><script>alert(1)</script>');
    expect(result).not.toContain('script');
    expect(result).toContain('Hello');
  });

  it('strips inline event handlers', () => {
    const result = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(result).not.toContain('onerror');
  });

  it('removes javascript: URLs', () => {
    const result = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('keeps safe formatting', () => {
    const result = sanitizeHtml('<p><strong>bold</strong> and <em>italic</em></p>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
  });

  it('keeps tables and lists, which business mail actually uses', () => {
    const result = sanitizeHtml('<table><tr><td>cell</td></tr></table><ul><li>item</li></ul>');
    expect(result).toContain('<table>');
    expect(result).toContain('<li>item</li>');
  });

  it('neutralises iframes and objects', () => {
    const result = sanitizeHtml('<iframe src="https://evil.example"></iframe><object data="x"></object>');
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('<object');
  });

  it('does not choke on unclosed or malformed markup', () => {
    expect(() => sanitizeHtml('<div><p>unclosed')).not.toThrow();
    expect(() => sanitizeHtml('<<>><script')).not.toThrow();
  });

  it('handles empty input', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml(null)).toBe('');
  });
});

describe('isSafeUrl', () => {
  it('allows http and https', () => {
    expect(isSafeUrl('https://re-el.co.za')).toBe(true);
    expect(isSafeUrl('http://re-el.co.za')).toBe(true);
  });

  it('rejects javascript and data URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
  });

  it('allows inline images by default so mail renders', () => {
    expect(isSafeUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isSafeUrl('data:text/html,x', { allowDataImage: false })).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes the dangerous characters', () => {
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });
});

describe('htmlToText', () => {
  it('converts paragraphs to lines', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toContain('One');
    expect(htmlToText('<p>One</p><p>Two</p>')).toContain('Two');
  });

  it('keeps the link text but not the href', () => {
    // The text part of a mail body should not become a bare URL the user did not
    // write; links are only meaningful in the HTML part.
    const result = htmlToText('<a href="https://re-el.co.za">Site</a>');
    expect(result).toContain('Site');
    expect(result).not.toContain('href');
  });

  it('turns list items into bullets and cells into tabs', () => {
    expect(htmlToText('<ul><li>One</li><li>Two</li></ul>')).toContain('• One');
    expect(htmlToText('<table><tr><td>a</td><td>b</td></tr></table>')).toContain('a\tb');
  });

  it('drops script contents', () => {
    expect(htmlToText('<script>alert(1)</script><p>Text</p>')).not.toContain('alert');
  });
});

describe('makeSnippet', () => {
  it('truncates to the requested length', () => {
    expect(makeSnippet('x'.repeat(500), 100).length).toBeLessThanOrEqual(140);
  });

  it('collapses whitespace so a snippet is one line', () => {
    expect(makeSnippet('a\n\n   b\t c', 160)).toBe('a b c');
  });

  it('handles empty input', () => {
    expect(makeSnippet('', 160)).toBe('');
    expect(makeSnippet(null, 160)).toBe('');
  });
});

describe('baseSubject', () => {
  it('strips reply and forward prefixes repeatedly', () => {
    expect(baseSubject('Re: Fwd: Re: Hello')).toBe('Hello');
    expect(baseSubject('RE: Hello')).toBe('Hello');
    expect(baseSubject('Re[2]: Hello')).toBe('Hello');
  });

  it('leaves a normal subject alone', () => {
    expect(baseSubject('Budget Q3')).toBe('Budget Q3');
  });
});

describe('slugify', () => {
  it('produces a lowercase url-safe slug', () => {
    expect(slugify('Client Feedback')).toBe('client-feedback');
  });

  it('caps the length', () => {
    expect(slugify('x'.repeat(100), 40).length).toBeLessThanOrEqual(40);
  });
});

describe('parseAddressList', () => {
  it('parses a comma-separated list', () => {
    const result = parseAddressList('a@b.co, c@d.co');
    expect(result).toHaveLength(2);
  });

  it('splits on commas but not inside angle brackets', () => {
    // "Ada Lovelace <ada@example.com>" is one address, not two.
    const result = parseAddressList('Ada Lovelace <ada@example.com>, b@example.com');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(result[1].email).toBe('b@example.com');
  });

  it('treats an unquoted comma inside a display name as part of the name', () => {
    // "Lovelace, Ada <ada@example.com>" is ambiguous. Preferring the angle-bracket
    // form avoids inventing a bogus address called "Lovelace".
    expect(parseAddressList('Lovelace, Ada <ada@example.com>')).toHaveLength(1);
  });

  it('extracts the address from a display-name form', () => {
    expect(parseAddress('Ada Lovelace <ada@example.com>').email).toBe('ada@example.com');
    expect(parseAddress('ada@example.com').email).toBe('ada@example.com');
  });

  it('tolerates empty input', () => {
    expect(parseAddressList('')).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
  });

  it('does not treat a newline as a new header', () => {
    const result = parseAddressList('a@b.co\r\nBcc: victim@x.com');
    expect(result.join(' ')).not.toContain('Bcc:');
  });
});

describe('sanitizeHtml style blocks', () => {
  it('keeps a safe <style> sheet, which emails depend on for text colour', () => {
    const result = sanitizeHtml('<p class="body">hi</p><style>.body { color: #333; }</style>');
    expect(result).toContain('<style>.body { color: #333; }</style>');
    expect(result).toContain('hi');
  });

  it('keeps the sheet when it lives inside <head>', () => {
    const result = sanitizeHtml('<html><head><style>td { padding: 4px; }</style></head><body><p>x</p></body></html>');
    expect(result).toContain('<style>td { padding: 4px; }</style>');
    // The tag elements themselves are still dropped, only their content style
    // survives, so no <head>/<body> wrappers leak through.
    expect(result).not.toMatch(/<head>|<body>/i);
  });

  it('still drops <script> around a kept style block', () => {
    const result = sanitizeHtml('<style>p { color: red }</style><script>alert(1)</script>');
    expect(result).toContain('<style>p { color: red }</style>');
    expect(result).not.toContain('script');
  });

  it('removes comments and @import from the sheet', () => {
    const result = sanitizeHtml('<style>/* note */ @import url("https://evil.example/x.css"); p { color: red }</style>');
    expect(result).not.toContain('@import');
    expect(result).not.toContain('/*');
    expect(result).not.toContain('evil.example');
    expect(result).toContain('p { color: red }');
  });

  it('drops the sheet entirely if it needs expression() or behaviour bindings', () => {
    const expression = sanitizeHtml('<style>a { width: expression(alert(1)) }</style>');
    expect(expression).not.toContain('<style');

    const binding = sanitizeHtml('<style>a { -moz-binding: url(#x) }</style>');
    expect(binding).not.toContain('<style');
  });

  it('neutralises a javascript: url() inside the sheet', () => {
    const result = sanitizeHtml('<style>a { background: url(javascript:alert(1)) }</style>');
    // The url is replaced with the inert keyword `none`; no live scheme remains
    // anywhere in the output (the sheet itself is kept, as it is now inert).
    expect(result).not.toContain('javascript:');
    expect(result).toContain('<style>a { background: none) }</style>');
  });

  it('cuts the sheet at a smuggled close tag so nothing after it leaks as markup', () => {
    const result = sanitizeHtml('<style>p::before { content: "</style><script>alert(1)</script>" }</style>');
    // Text inside <style> ends at the first </style>, as in a browser; what
    // follows that boundary is parsed normally and the <script> is dropped with
    // its contents, so nothing from the attacker's tail survives as markup.
    expect(result).not.toContain('<script');
    expect(result).toBe('<style>p::before { content: "</style>');
  });

  it('keeps remote image urls but nulls anything that is not http(s)/data:image', () => {
    const result = sanitizeHtml('<style>a { background: url("https://cdn.example/bg.png") top; border: 1px solid red }</style>');
    expect(result).toContain('url("https://cdn.example/bg.png")');
    expect(result).toContain('border: 1px solid red');
  });

  it('never leaks the sheet into the plain-text view', () => {
    const result = sanitizeHtml('<p>Hello</p><style>.body { color: red }</style>');
    expect(htmlToText(result)).not.toContain('.body');
    expect(htmlToText(result)).toContain('Hello');
  });

  it('keeps legitimate @media colour swaps for dark mode', () => {
    const result = sanitizeHtml('<style>@media (prefers-color-scheme: dark) { body { background: #000; } }</style>');
    expect(result).toContain('@media (prefers-color-scheme: dark)');
  });

  it('never leaks the sheet into the plain-text view', () => {
    const result = sanitizeHtml('<p>Hello</p><style>.body { color: red }</style>');
    expect(htmlToText(result)).not.toContain('.body');
    expect(htmlToText(result)).toContain('Hello');
  });
});