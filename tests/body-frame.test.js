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

import { BODY_SANDBOX, activeTheme, mountMessageFrame } from '../apps/web/js/body-frame.js';

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

describe('theme', () => {
  it('reads the app theme, not the operating system colour scheme', () => {
    document.documentElement.dataset.theme = 'dark';
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(activeTheme()).toBe('dark');
    // The old frame used this media query, which follows the OS. A light OS
    // with the app in dark mode left dark text on a dark page.
    expect(frame.srcdoc).not.toMatch(/prefers-color-scheme/);
    expect(frame.srcdoc).toContain('#e8ebf2');
  });

  it('renders light colours when the app is light', () => {
    document.documentElement.dataset.theme = 'light';
    const { frame } = mountMessageFrame('<p>Hello</p>', host);

    expect(frame.srcdoc).toContain('#1b2233');
    expect(frame.srcdoc).not.toContain('#e8ebf2');
  });

  it('re-renders when the theme changes while the message is open', async () => {
    const { frame } = mountMessageFrame('<p>Hello</p>', host);
    expect(frame.srcdoc).toContain('#1b2233');

    document.documentElement.dataset.theme = 'dark';
    await settle();

    expect(frame.srcdoc).toContain('#e8ebf2');
  });

  it('stops following the theme once destroyed', async () => {
    const { frame, destroy } = mountMessageFrame('<p>Hello</p>', host);
    destroy();

    document.documentElement.dataset.theme = 'dark';
    await settle();

    // Still light: the observer was disconnected.
    expect(frame.srcdoc).toContain('#1b2233');
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