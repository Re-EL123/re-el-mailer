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

  it('turns bare URLs, www addresses and emails into safe links', () => {
    const [p] = formatTextBody('See https://ex.co/a?b=1. or www.re-el.co.za, write ada@re-el.co.za');

    const links = [...p.querySelectorAll('a')];
    expect(links.length).toBe(3);
    expect(links[0].getAttribute('href')).toBe('https://ex.co/a?b=1');
    expect(links[0].textContent).toBe('https://ex.co/a?b=1');
    expect(links[1].getAttribute('href')).toBe('https://www.re-el.co.za');
    expect(links[2].getAttribute('href')).toBe('mailto:ada@re-el.co.za');
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toBe('noopener');
    }
  });

  it('unpacks an exporter\'s display<url> suitcase into one clean link', () => {
    const [p] = formatTextBody('mpillay@pro-tech.co.za<mailto:mpillay@pro-tech.co.za> and www.pro-tech.co.za<http://www.pro-tech.co.za/>');

    const links = [...p.querySelectorAll('a')];
    expect(links.length).toBe(2);
    expect(links[0].getAttribute('href')).toBe('mailto:mpillay@pro-tech.co.za');
    expect(links[0].textContent).toBe('mpillay@pro-tech.co.za');
    expect(links[1].getAttribute('href')).toBe('http://www.pro-tech.co.za/');
    expect(links[1].textContent).toBe('www.pro-tech.co.za');
  });

  it('does not linkify through an angle bracket that is not a URL suitcase', () => {
    const [p] = formatTextBody('a < b and c > d, no link here');
    expect(p.querySelectorAll('a').length).toBe(0);
    expect(p.textContent).toBe('a < b and c > d, no link here');
  });

  it('keeps a URL that is the whole paragraph intact', () => {
    const [p] = formatTextBody('http://example.com');
    const link = p.querySelector('a');
    expect(link.getAttribute('href')).toBe('http://example.com');
    expect(link.textContent).toBe('http://example.com');
  });

  it('turns a matching [cid:…] inline image into a hydratable placeholder', () => {
    const image = { id: 'att_1', filename: 'image001.gif', mimeType: 'image/gif', contentId: 'image001.gif@01DD5AF5.56846EF0' };
    const parts = formatTextBody('Here is the file:\n\n[cid:image001.gif]\n\nRegards', [image]);

    const placeholder = parts[1].querySelector('.reader-cid');
    expect(parts[1].textContent).toBe('[cid:image001.gif]');
    expect(placeholder).not.toBeNull();
    expect(placeholder.getAttribute('title')).toBe('image001.gif');
    expect(placeholder.textContent).toBe('[cid:image001.gif]');
  });

  it('leaves a cid reference as text when it is not an image or not present', () => {
    const text = formatTextBody('No image: [cid:logo.eps]', [{ id: 'att_1', filename: 'logo.eps', mimeType: 'application/postscript', contentId: null }]);
    expect(text[0].querySelector('.reader-cid')).toBeNull();
    expect(text[0].textContent).toBe('No image: [cid:logo.eps]');
  });
});