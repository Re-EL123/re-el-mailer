// @vitest-environment jsdom
/**
 * The sandboxed message-body frame.
 *
 * Two things here are load-bearing and easy to break without noticing:
 *
 *   - The frame gets an explicit height. Without `allow-same-origin` this page
 *     cannot read into it, so an unmeasured <iframe> is a 150px strip with a
 *     scrollbar inside it, which is what long messages used to be trapped in.
 *   - The measurement is taken from a *copy* of the body that is neutralised
 *     while still inert. The copy is moved into this document to lay out, so if
 *     the stripping step were ever dropped, sender markup would run in the
 *     app's origin from a hole one function away from where it is rendered.
 *
 * jsdom has no layout engine, so these tests assert that a height is *chosen*
 * and that the process is safe, not that the number is right — the number
 * depends on real layout, which no jsdom test can produce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BODY_SANDBOX, ensureLegible, mountMessageFrame } from '../apps/web/js/body-frame.js';

/** A host to mount into, cleared between tests. */
let host;

/** Let the module's async measurement settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('mountMessageFrame', () => {
  it('gives the frame an explicit height instead of the 150px default', async () => {
    const { frame, element } = mountMessageFrame('<p>Hello</p>', host);

    expect(host.contains(element)).toBe(true);
    await settle();
    expect(frame.style.height).toMatch(/^\d+px$/);
    // jsdom lays nothing out, so this is FALLBACK_HEIGHT rather than a number
    // that came from real layout — the assertion is that a *fallback* was
    // chosen, not the minimum.
    expect(parseInt(frame.style.height, 10)).toBe(320);
  });

  it('applies that height before mount returns', () => {
    // Documented behaviour, and the reason a body never appears inside an
    // empty strip: the first reading is written through synchronously, ahead of
    // the image pass that follows.
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.style.height).toMatch(/^\d+px$/);
  });

  it('does not lose the height when the image pass settles', async () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);
    const first = parseInt(frame.style.height, 10);

    await settle();

    const second = parseInt(frame.style.height, 10);
    expect(frame.style.height).toMatch(/^\d+px$/);
    // The second reading is taken with Math.max, so it can only grow.
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('grants only the documented sandbox tokens', () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(BODY_SANDBOX).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('loads the body through srcdoc, never through a request', () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.srcdoc).toContain('Hello');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('keeps the frame off the accessibility tree', () => {
    const { element } = mountMessageFrame('<p>Hello</p>', host);

    expect(element.className).toBe('reader-html');
    // The frame has a title; the wrapper is purely structural.
    expect(element.getAttribute('role')).toBeNull();
  });
});

describe('canvas', () => {
  it('renders email content on a light canvas, independent of the app theme', () => {
    document.documentElement.dataset.theme = 'dark';
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    // Email content is authored for a light canvas; the app theme must not leak
    // a pale text colour onto the sender's own backgrounds.
    expect(frame.srcdoc).toContain('background: #ffffff');
    expect(frame.srcdoc).toContain('#1b2233');
    expect(frame.srcdoc).not.toContain('#e8ebf2');
  });

  it('uses the same canvas when the app is light', () => {
    document.documentElement.dataset.theme = 'light';
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.srcdoc).toContain('background: #ffffff');
    expect(frame.srcdoc).toContain('#1b2233');
    expect(frame.srcdoc).not.toContain('#e8ebf2');
  });

  it('does not expose the operating system colour scheme to the content', () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.srcdoc).not.toMatch(/prefers-color-scheme/);
  });

  it('keeps the canvas stable when the app theme changes while open', async () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);
    expect(frame.srcdoc).toContain('background: #ffffff');

    document.documentElement.dataset.theme = 'dark';
    await settle();

    expect(frame.srcdoc).toContain('background: #ffffff');
    expect(frame.srcdoc).not.toContain('#e8ebf2');
  });
});

describe('the measurement copy', () => {
  /**
   * Mount and return the hidden measuring host before it is removed.
   *
   * `mountMessageFrame` builds it synchronously and only removes it after its
   * async pass, so the very next statement sees it.
   */
  function mountAndMeasure(html) {
    mountMessageFrame(html, host);
    const box = document.querySelector('[data-message-measurer]');
    expect(box, 'the measuring host must exist while it measures').not.toBeNull();
    // Open shadow root, so it is reachable from the test.
    return box.shadowRoot || box;
  }

  it('carries no script, because it is about to be moved into this document', () => {
    const root = mountAndMeasure('<script>window.__pwned = 1</script><p>Hi</p>');

    expect(root.querySelector('script')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  it('carries no inline event handler', () => {
    const root = mountAndMeasure('<img src="x" onerror="window.__pwned = 1"><p>Hi</p>');

    expect(root.querySelector('[onerror]')).toBeNull();
    for (const node of root.querySelectorAll('*')) {
      for (const attribute of node.attributes) {
        expect(attribute.name.toLowerCase().startsWith('on'), attribute.name).toBe(false);
      }
    }
    expect(window.__pwned).toBeUndefined();
  });

  it('carries no nested frame or stylesheet link, so nothing loads sideways', () => {
    const root = mountAndMeasure(
      '<iframe src="https://evil.example"></iframe>'
      + '<link rel="stylesheet" href="https://evil.example/x.css">'
      + '<p>Hi</p>',
    );

    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('link')).toBeNull();
  });

  it('keeps the email\u2019s own <style>, which is what the height depends on', () => {
    // Layout fidelity: an email that styles its table in the <head> would
    // measure completely wrong without it. Scoped to the shadow root so it
    // cannot reach the app.
    const root = mountAndMeasure('<style>table{width:600px}</style><table><tr><td>x</td></tr></table>');

    const styles = [...root.querySelectorAll('style')];
    // Specifically the email's rule, not the module's own stylesheet.
    expect(styles.some((node) => node.textContent.includes('width:600px'))).toBe(true);
  });

  it('is removed once it has measured, leaving no nodes behind', async () => {
    mountMessageFrame('<p>Hello</p>', host);

    expect(document.querySelector('[data-message-measurer]')).not.toBeNull();
    await settle();
    expect(document.querySelector('[data-message-measurer]')).toBeNull();
  });

  it('is hidden from assistive tech and from the pointer', () => {
    mountMessageFrame('<p>Hello</p>', host);
    const box = document.querySelector('[data-message-measurer]');

    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.style.visibility).toBe('hidden');
    expect(box.style.pointerEvents).toBe('none');
    expect(box.style.left.startsWith('-')).toBe(true);
  });
});

describe('ensureLegible', () => {
  it('forces light text onto a dark inline background when the email left no text colour', () => {
    // The classic "styled square with no text": the background survives
    // sanitisation, the sheet that carried the matching text colour does not.
    const result = ensureLegible('<table><tr><td style="background:#1f2430">Dark</td></tr></table>');
    expect(result).toContain('background:#1f2430');
    expect(result).toContain('color:#ffffff');
  });

  it('walks up to the background of an enclosing cell for nested text', () => {
    const result = ensureLegible('<table><tr><td style="background:#1f2430"><p>Dark</p></td></tr></table>');
    expect(result).toContain('<p style="color:#ffffff">Dark</p>');
  });

  it('sees the bgcolor attribute, which classic email HTML still uses', () => {
    const result = ensureLegible('<table bgcolor="#1f2430"><tr><td>Dark</td></tr></table>');
    expect(result).toContain('<td style="color:#ffffff">Dark</td>');
  });

  it('leaves a readable pair alone', () => {
    const result = ensureLegible('<table><tr><td style="background:#111111;color:#ffffff">ok</td></tr></table>');
    expect(result).toContain('style="background:#111111;color:#ffffff"');
    expect(result).not.toContain('color:#ffffff;color');
  });

  it('leaves plain text on the light canvas alone', () => {
    expect(ensureLegible('<p>Plain</p>')).toBe('<p>Plain</p>');
  });

  it('forces dark text when the email paints white text on white', () => {
    const result = ensureLegible('<table><tr><td style="background:#ffffff;color:#ffffff">white</td></tr></table>');
    expect(result).toContain('color:#ffffff;color:#1b2233');
  });

  it('repairs an explicit black-on-black pair', () => {
    const result = ensureLegible('<table><tr><td style="background:#000000;color:#000000">x</td></tr></table>');
    expect(result).toContain('color:#ffffff');
  });

  it('fixes links on dark backgrounds without breaking the href', () => {
    const result = ensureLegible('<a href="https://re-el.co.za" style="background:#1f2430">Link</a>');
    expect(result).toContain('href="https://re-el.co.za"');
    expect(result).toContain('color:#ffffff');
  });

  it('never touches a stylesheet, whose text is CSS not content', () => {
    const result = ensureLegible('<style>.dark { color: #fff }</style>');
    expect(result).toContain('.dark { color: #fff }');
    expect(result).not.toContain('color:#ffffff;');
  });

  it('changes nothing but the colour: layout markup passes through untouched', () => {
    const result = ensureLegible('<table><tr><td style="background:#1f2430">Dark</td></tr></table>');
    expect(result).toContain('<td style="background:#1f2430;color:#ffffff">Dark</td>');
  });
});

describe('mountMessageFrame readability', () => {
  it('renders forced-readable text in the frame', () => {
    const { frame } = mountMessageFrame('<table><tr><td style="background:#1f2430">Dark</td></tr></table>', host);
    expect(frame.srcdoc).toContain('color:#ffffff');
    expect(frame.srcdoc).toContain('>Dark<');
  });

  it('measures the same forced-readable copy, so heights and colours agree', () => {
    mountMessageFrame('<table><tr><td style="background:#1f2430">Dark</td></tr></table>', host);
    const root = document.querySelector('[data-message-measurer]');
    expect(root).not.toBeNull();
    const body = (root.shadowRoot || root).querySelector('body');
    expect(body.innerHTML).toContain('color:#ffffff');
    expect(body.innerHTML).toContain('>Dark<');
  });
});

describe('teardown', () => {
  it('removes the measuring host it left behind', async () => {
    const { destroy } = mountMessageFrame('<p>Hello</p>', host);
    destroy();
    await settle();

    expect(document.querySelector('[data-message-measurer]')).toBeNull();
  });

  it('does not throw when destroyed twice', () => {
    const { destroy } = mountMessageFrame('<p>Hello</p>', host);
    expect(() => { destroy(); destroy(); }).not.toThrow();
  });

  it('applies no further height once destroyed', async () => {
    const { frame, destroy } = mountMessageFrame('<p>Hello</p>', host);
    const before = frame.style.height;
    destroy();

    // A pending measurement from before the destroy must not land afterwards.
    await settle();
    expect(frame.style.height).toBe(before);
  });
});