// @vitest-environment jsdom
/**
 * The message body frame.
 *
 * A message body is sender-controlled. The server sanitises it on ingest and on
 * send, and the reader renders it through an iframe sandbox rather than into the
 * document — so the sandbox is the browser-enforced backstop for the case where
 * the sanitiser is wrong or a new tag slips through.
 *
 * These assertions are deliberately literal about the exact sandbox token list
 * rather than checking for the absence of one token. "allow-scripts is missing"
 * is satisfied by a list that also grants allow-same-origin, which together
 * silently defeat the sandbox; only pinning the whole list catches that.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  defaultRoutes,
  fakeMessage,
  resetDom,
  stubApi,
  waitFor,
} from './helpers/view-harness.js';

const MB = 'mbx_1';

const SAFE_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * Render the reader with a message whose body is `bodyHtml`.
 *
 * `waitFor` is not used for the frame itself: the last case deliberately renders
 * a text-only body, where waiting for a frame that will never appear is a
 * timeout rather than a failure. Callers wait on `.reader-toolbar`, which is
 * rendered either way.
 */
async function mountReader(bodyHtml, overrides = {}) {
  const container = document.createElement('div');
  document.body.append(container);

  stubApi(defaultRoutes({
    'action=get': { message: fakeMessage({ bodyHtml, bodyText: 'fallback', ...overrides }), thread: [] },
  }));

  const { adoptSession } = await import('../apps/web/js/store.js');
  adoptSession({
    user: { id: 'usr_1', email: 'ada@re-el.co.za', displayName: 'Ada Lovelace', role: 'admin', status: 'active' },
    mailboxes: [{ id: MB, email: 'ada@re-el.co.za', isPrimary: true }],
  });

  const { renderMessage } = await import('../apps/web/js/views/message.js');
  await renderMessage(container, { params: ['msg_1'], query: { mailbox: MB } });
  await waitFor('.reader-toolbar', container);

  return { container, frame: container.querySelector('.reader-frame') };
}

beforeEach(() => {
  resetDom();
});

describe('message body iframe', () => {
  it('is sandboxed with exactly the intended tokens', async () => {
    const { frame } = await mountReader('<p>Hello</p>');

    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe(SAFE_SANDBOX);
  });

  it('never grants script execution', async () => {
    const { frame } = await mountReader('<p>Hello</p>');

    // The specific thing an injected <script> or an onerror= handler needs.
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('never grants same-origin access alongside popups', async () => {
    const { frame } = await mountReader('<p>Hello</p>');

    // allow-same-origin would let the framed document reach into this page's
    // origin and read the session; on its own it also does nothing useful
    // without scripts, but the combination is what the sandbox exists to stop.
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('never grants forms, top-level navigation or pointer capture', async () => {
    const { frame } = await mountReader('<p>Hello</p>');
    const sandbox = frame.getAttribute('sandbox');

    for (const forbidden of [
      'allow-same-origin',
      'allow-scripts',
      'allow-forms',
      'allow-top-navigation',
      'allow-modals',
      'allow-pointer-lock',
      'allow-downloads',
    ]) {
      expect(sandbox).not.toContain(forbidden);
    }
  });

  it('sets srcdoc rather than a src, so the body never becomes a request', async () => {
    const { frame } = await mountReader('<p>Hello</p>');

    expect(frame.getAttribute('src')).toBeNull();
    expect(frame.srcdoc).toContain('Hello');
  });

  it('does not leak the referring URL to the framed document', async () => {
    const { frame } = await mountReader('<p>Hello</p>');

    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.srcdoc).toContain('name="referrer" content="no-referrer"');
  });

  it('loads remote images without any referrer or script capability', async () => {
    const { frame } = await mountReader('<p><img src="https://tracker.example/pixel.gif"></p><p>Hi</p>');

    // The server sanitiser is what should have stripped this; the frame is the
    // backstop, and the referrer policy is what keeps the request from carrying
    // the account's origin.
    expect(frame.getAttribute('sandbox')).toBe(SAFE_SANDBOX);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('falls back to text, not a frame, when there is no HTML body', async () => {
    const { container, frame } = await mountReader(null);

    // A body that is only ever text should not load a document at all.
    expect(frame).toBeNull();
    expect(container.querySelector('.reader-body').textContent).toContain('fallback');
  });

  it('falls back to the text body when the HTML body was stripped empty', async () => {
    // Mail stored by the old sanitiser keeps its full element structure (a
    // styled table with empty cells) but no text. The reader must not show a
    // frame full of painted squares; the plain-text body is the readable part.
    const stripped = '<table><tr><td style="background:#354d91"><strong></strong></td></tr></table><p></p>';
    const { container, frame } = await mountReader(stripped, { bodyText: 'Someone just submitted your form…' });

    expect(frame).toBeNull();
    expect(container.querySelector('.reader-body').textContent).toContain('Someone just submitted your form…');
  });

  it('keeps the frame when the HTML body has its own text', async () => {
    const { frame } = await mountReader('<p style="background:#354d91;color:white">Welcome</p>');

    expect(frame).not.toBeNull();
    expect(frame.srcdoc).toContain('Welcome');
  });
});

describe('the identity headers', () => {
  const valueOf = (container, label) => {
    const headers = [...container.querySelectorAll('.hdr')];
    const line = headers.find((hdr) => hdr.querySelector('.hdr-label')?.textContent === label);
    return line ? line.querySelector('.hdr-value').textContent : null;
  };

  it('shows the address alongside the sender name', async () => {
    const { container } = await mountReader('<p>Hello</p>');

    // displayName alone would render "Bob Nkosi" with no way to verify who
    // actually sent it; the header is where that verification happens.
    expect(valueOf(container, 'From')).toBe('Bob Nkosi <bob@example.com>');
  });

  it('falls back to the bare address when the sender has no name', async () => {
    const { container } = await mountReader('<p>Hello</p>', {
      from: { email: 'noreply@example.com', name: '' },
    });

    expect(valueOf(container, 'From')).toBe('noreply@example.com');
  });

  it('lists every recipient on the To line', async () => {
    const { container } = await mountReader('<p>Hello</p>', {
      to: [{ email: 'ada@re-el.co.za' }, { email: 'second@example.com' }],
    });

    expect(valueOf(container, 'To')).toBe('ada@re-el.co.za, second@example.com');
  });

  it('renders a Cc line when there is one, and omits it when there is not', async () => {
    const { container } = await mountReader('<p>Hello</p>', {
      cc: [{ email: 'cc@example.com', name: 'Cee Cee' }],
    });

    expect(valueOf(container, 'Cc')).toBe('Cee Cee <cc@example.com>');
  });

  it('keeps the From line honest when the display name is outbound', async () => {
    const { container } = await mountReader('<p>Hello</p>', {
      direction: 'outbound',
      from: { email: 'ada@re-el.co.za', name: 'Ada Lovelace' },
      to: ['alice@example.com'],
    });

    expect(valueOf(container, 'From')).toBe('Ada Lovelace <ada@re-el.co.za>');
    expect(valueOf(container, 'To')).toBe('alice@example.com');
  });
});

describe('editing a draft from the reader', () => {
  it('offers an edit button on a draft, and nothing on sent mail', async () => {
    const draftView = await mountReader('<p>Hello</p>', {
      isDraft: true,
      direction: 'outbound',
      to: ['alice@example.com'],
    });
    expect(draftView.container.querySelector('.reader-toolbar [aria-label="Edit draft"]')).toBeTruthy();

    const sentView = await mountReader('<p>Hello</p>', { isDraft: false });
    expect(sentView.container.querySelector('.reader-toolbar [aria-label="Edit draft"]')).toBeNull();
  });
});