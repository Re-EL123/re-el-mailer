// @vitest-environment jsdom
/**
 * Composer tests.
 *
 * The composer is the one view whose failure modes are silent rather than loud:
 * a formatter that throws leaves a usable textarea, and a send that omits the
 * plain-text alternative still succeeds while delivering an unreadable message to
 * half the recipients. So these tests are mostly about what the form collects and
 * what it sends.
 *
 * The network is stubbed at fetch level, and the editor bundle is stubbed at
 * module level, so both the rich-text and plain-text paths are exercised
 * deliberately rather than depending on which one the environment happens to give.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { audit, describeViolations, fakeMailboxes, fakeUser, resetDom, waitFor } from './helpers/view-harness.js';

vi.mock('../apps/web/js/api.js', () => ({
  api: {
    mail: {
      get: vi.fn(async () => ({ message: null })),
      saveDraft: vi.fn(async () => ({ draft: { id: 'drf_1' } })),
      deleteDraft: vi.fn(async () => ({ ok: true })),
      attachmentUploadUrl: vi.fn(),
      attachmentComplete: vi.fn(),
      labels: vi.fn(async () => ({ labels: [] })),
    },
    send: {
      reply: vi.fn(async () => ({ draft: { to: [], cc: [], bcc: [], subject: 'Re: x' } })),
      forward: vi.fn(async () => ({ draft: { to: [], cc: [], bcc: [], subject: 'Fwd: x' } })),
      suggest: vi.fn(async () => ({ suggestions: [] })),
      send: vi.fn(async () => ({ message: { id: 'msg_1' } })),
    },
  },
}));

/**
 * Fake editor handle with the same surface the real bundle exposes.
 *
 * It builds the same DOM the real ProseMirror view does — a contenteditable
 * div with the editor's classes and ARIA attributes — because the composer's own
 * behaviour depends on that markup existing (it hides the textarea once the
 * editor is up, and the a11y tests audit the result).
 */
function fakeEditor({ text = '', host = null, onChange } = {}) {
  let html = text ? `<p>${text}</p>` : '';
  let current = text;

  if (host) {
    const surface = document.createElement('div');
    surface.className = 'tiptap ProseMirror editor-surface';
    surface.setAttribute('contenteditable', 'true');
    surface.setAttribute('role', 'textbox');
    surface.setAttribute('aria-multiline', 'true');
    surface.setAttribute('aria-label', 'Message body');
    surface.textContent = text;
    host.append(surface);
  }
  const chain = () => {
    const api = {};
    const passthrough = ['focus', 'toggleBold', 'toggleItalic', 'toggleStrike', 'toggleCode', 'toggleBulletList', 'toggleOrderedList', 'toggleBlockquote', 'extendMarkRange', 'setLink', 'unsetLink', 'insertContent'];
    for (const name of passthrough) api[name] = () => api;
    api.run = () => true;
    return api;
  };

  return {
    isActive: () => false,
    getAttributes: () => ({}),
    chain,
    getHTML: () => html,
    getText: () => current,
    focus: vi.fn(),
    on: () => {},
    destroy: vi.fn(),
    /**
     * Simulate typing in the editor: the real editor calls onChange with plain
     * text on every document change, and the composer's mirror is only updated
     * through that callback. So a test that changes the document has to go
     * through onChange too, or it is asserting a state the app never reaches.
     */
    __set(htmlValue, textValue) {
      html = htmlValue;
      current = textValue;
      onChange?.(textValue);
    },
  };
}

let editorInstance;
let editorShouldFail = false;

vi.mock('../apps/web/js/vendor/editor.bundle.js', () => ({
  TOOLBAR: [],
  createEditor: vi.fn(async (host, { content = '', onChange } = {}) => {
    if (editorShouldFail) return null;
    editorInstance = fakeEditor({ text: content, host, onChange });
    return editorInstance;
  }),
}));

const { setState } = await import('../apps/web/js/store.js');
const { api } = await import('../apps/web/js/api.js');
const { renderCompose } = await import('../apps/web/js/views/compose.js');
const { el } = await import('../apps/web/js/ui.js');
// The schemas are the contract. Asserting against them rather than against a
// hand-written expectation is what makes this catch a rename on either side.
const { attachmentUploadUrlSchema, attachmentCompleteSchema } = await import('../packages/validation/schemas.js');

const MB = 'mbx_1';

function host() {
  const node = el('div');
  document.body.append(node);
  return node;
}

beforeEach(() => {
  resetDom();
  editorInstance = null;
  editorShouldFail = false;
  setState({ user: fakeUser(), mailboxes: fakeMailboxes(), activeMailboxId: MB, pageSize: 30 });
  api.send.send.mockClear();
  api.mail.saveDraft.mockClear();
  api.mail.get.mockClear();
  api.send.suggest.mockClear();
});

describe('the plain-text fallback', () => {
  it('renders a usable textarea when the editor cannot start', async () => {
    // This is the failure that matters: the bundle 404s on a deploy, and the user
    // must still be able to write and send mail.
    editorShouldFail = true;
    const container = host();
    await renderCompose(container, { query: {} });

    const area = container.querySelector('textarea.compose-body');
    expect(area).toBeTruthy();
    expect(area.hidden).toBe(false);
  });

  it('hides the textarea and shows a toolbar when the editor does start', async () => {
    const container = host();
    await renderCompose(container, { query: {} });

    await waitFor('.editor-surface', container);
    const area = container.querySelector('textarea.compose-body');
    expect(area.hidden).toBe(true);
    expect(container.querySelector('.editor-toolbar')).toBeTruthy();
  });

  it('keeps both a rich-text and a plain-text value for the same document', async () => {
    const container = host();
    await renderCompose(container, { query: {} });
    await waitFor('.editor-surface', container);

    editorInstance.__set('<p>Hello there</p>', 'Hello there');

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(api.send.send).toHaveBeenCalled());

    const sent = api.send.send.mock.calls[0][0];
    expect(sent.html).toContain('Hello there');
    // A client that renders no HTML must still show a readable message.
    expect(sent.text).toBe('Hello there');
  });
});

describe('the send request', () => {
  it('sends text alongside html, never html alone', async () => {
    editorShouldFail = true;
    const container = host();
    await renderCompose(container, { query: {} });

    const area = container.querySelector('textarea.compose-body');
    area.value = 'Plain only';
    // A real keystroke fires input after changing value; assigning value alone
    // does not, which is exactly the distinction this test exists to pin.
    area.dispatchEvent(new Event('input', { bubbles: true }));

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(api.send.send).toHaveBeenCalled());

    const sent = api.send.send.mock.calls[0][0];
    expect(sent.text).toBe('Plain only');
    expect(sent.html).toContain('Plain only');
  });

  it('escapes markup typed into the plain-text path', async () => {
    // The plain-text fallback wraps its value in a div by hand, so anything the
    // user typed is unescaped and would otherwise become live HTML.
    editorShouldFail = true;
    const container = host();
    await renderCompose(container, { query: {} });

    const area = container.querySelector('textarea.compose-body');
    area.value = '<script>alert(1)</script>';
    area.dispatchEvent(new Event('input', { bubbles: true }));

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(api.send.send).toHaveBeenCalled());

    const sent = api.send.send.mock.calls[0][0];
    expect(sent.html).not.toContain('<script>');
    expect(sent.html).toContain('&lt;script&gt;');
  });

  it('only schedules when a time has actually been chosen', async () => {
    const container = host();
    await renderCompose(container, { query: {} });

    // Open the picker, then close it without choosing: the message must go now.
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Schedule');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(api.send.send).toHaveBeenCalled());
    expect(api.send.send.mock.calls[0][0].scheduledFor).toBeNull();
  });

  it('passes an ISO timestamp once a schedule time is set', async () => {
    const container = host();
    await renderCompose(container, { query: {} });

    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Schedule');
    toggle.click();
    const input = container.querySelector('.schedule');
    // A fixed date rather than now+1h: the assertion is about the format, and a
    // relative date makes the expected value drift.
    input.value = '2030-01-02T09:30';

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(api.send.send).toHaveBeenCalled());

    const { scheduledFor } = api.send.send.mock.calls[0][0];
    expect(scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(Date.parse(scheduledFor))).toBe(false);
  });

  it('recovers the send button when the send fails', async () => {
    api.send.send.mockRejectedValueOnce(new Error('Recipient rejected'));
    const container = host();
    await renderCompose(container, { query: {} });

    container.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(container.querySelector('.compose-status, .toast')).toBeTruthy());

    const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send' || b.textContent === 'Sending…');
    expect(sendBtn.disabled).toBe(false);
    expect(sendBtn.textContent).toBe('Send');
  });
});

describe('reply-all', () => {
  it('asks the server for every recipient, excluding the sender', async () => {
    // The server has supported mode=all all along; nothing in the client sent it
    // until now, so this is the assertion that keeps it working.
    const container = host();
    await renderCompose(container, { query: { reply: 'msg_1', mode: 'all', mailbox: MB } });

    expect(api.send.reply).toHaveBeenCalledWith('msg_1', 'all', MB);
    expect(container.querySelector('.compose-title').textContent).toBe('Reply all');
  });

  it('defaults to replying to the sender only', async () => {
    const container = host();
    await renderCompose(container, { query: { reply: 'msg_1', mailbox: MB } });

    expect(api.send.reply).toHaveBeenCalledWith('msg_1', 'sender', MB);
    expect(container.querySelector('.compose-title').textContent).toBe('Reply');
  });
});

describe('recipient suggestions', () => {
  const suggestions = [
    { email: 'alice@example.com', name: 'Alice Akpan' },
    { email: 'bob@example.com', name: 'Bob Nkosi' },
  ];

  const makeField = async () => {
    const container = host();
    await renderCompose(container, { query: { mailbox: MB } });
    return {
      container,
      input: container.querySelector('input[name="to"]'),
    };
  };

  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const waitForSug = (input) => waitFor('.recipient-suggest:not([hidden])', input.parentElement);

  it('asks the server for matches as the user types the active token', async () => {
    api.send.suggest.mockResolvedValueOnce({ suggestions });
    const { input } = await makeField();

    type(input, 'bob@example.com, ali');

    const list = await waitForSug(input);
    expect(api.send.suggest).toHaveBeenCalledWith('ali', MB);
    expect(list.querySelectorAll('.recipient-option')).toHaveLength(2);
    expect(list.textContent).toContain('Alice Akpan <alice@example.com>');
  });

  it('shows recent contacts when the field is focused empty', async () => {
    api.send.suggest.mockResolvedValueOnce({ suggestions });
    const { input } = await makeField();

    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));

    await waitForSug(input);
    expect(api.send.suggest).toHaveBeenCalledWith('', MB);
  });

  it('replaces only the active token when an option is chosen with the keyboard', async () => {
    api.send.suggest.mockResolvedValueOnce({ suggestions });
    const { input } = await makeField();

    type(input, 'bob@example.com, ali');
    await waitForSug(input);

    const move = (key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    move('ArrowDown'); // first option becomes active
    move('Enter');

    expect(input.value).toBe('bob@example.com, alice@example.com, ');
    expect(api.send.suggest).toHaveBeenCalledWith('ali', MB);
  });

  it('inserts the address from a mouse click and keeps the field focused', async () => {
    api.send.suggest.mockResolvedValueOnce({ suggestions });
    const { input } = await makeField();

    type(input, 'ali');
    const list = await waitForSug(input);

    list.querySelector('.recipient-option').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(input.value).toBe('alice@example.com, ');
  });

  it('closes the list on Escape and stops announcing it', async () => {
    api.send.suggest.mockResolvedValueOnce({ suggestions });
    const { input } = await makeField();

    type(input, 'ali');
    await waitForSug(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.parentElement.querySelector('.recipient-suggest').hidden).toBe(true);
  });

  it('never disables the composer when the suggestions endpoint fails', async () => {
    api.send.suggest.mockRejectedValueOnce(new Error('suggestions down'));
    const { container, input } = await makeField();

    type(input, 'ali');
    // Let the debounce and the failed request settle; the field must carry on.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(input.parentElement.querySelector('.recipient-suggest').hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('form')).toBeTruthy();
  });

  it('does not query again after the list is cleared', async () => {
    api.send.suggest.mockResolvedValue({ suggestions });
    const { input } = await makeField();

    type(input, '');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.send.suggest).not.toHaveBeenCalled();
  });
});

describe('resuming a draft', () => {
  const draft = () => ({
    id: 'drf_1',
    isDraft: true,
    to: ['alice@example.com'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    subject: 'Notes',
    bodyHtml: '<p>Hello <strong>draft</strong></p>',
    bodyText: 'Hello draft',
    threadId: 'thr_9',
    inReplyTo: '<x@example.com>',
    references: ['<a@example.com>'],
    attachments: [{ id: 'att_1', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 }],
  });

  it('puts every field of the draft back into the composer', async () => {
    api.mail.get.mockResolvedValueOnce({ message: draft() });
    const container = host();
    await renderCompose(container, { query: { draft: 'drf_1', mailbox: MB } });

    expect(api.mail.get).toHaveBeenCalledWith('drf_1', MB);
    // Resuming is an edit, not a new message: the heading has to say so.
    expect(container.querySelector('.compose-title').textContent).toBe('Edit draft');

    const [toInput, ccInput, bccInput] = container.querySelectorAll('.compose-recipients');
    expect(toInput.value).toBe('alice@example.com');
    expect(ccInput.value).toBe('cc@example.com');
    expect(bccInput.value).toBe('bcc@example.com');
    expect(container.querySelector('.compose-subject').value).toBe('Notes');

    // Attachments already stored against the draft are listed, not re-uploaded.
    expect(container.querySelector('.attach-chip').textContent).toContain('a.pdf');
  });

  it('opens the editor with the stored HTML, not a flattened copy', async () => {
    api.mail.get.mockResolvedValueOnce({ message: draft() });
    const container = host();
    await renderCompose(container, { query: { draft: 'drf_1', mailbox: MB } });
    await waitFor('.editor-surface', container);

    // Passing the HTML through the seed means a resumed draft keeps its
    // formatting; the getText() here is the composer's content argument.
    expect(editorInstance.getText()).toBe('<p>Hello <strong>draft</strong></p>');
  });

  it('keeps the plain-text body reachable when the editor cannot start', async () => {
    editorShouldFail = true;
    api.mail.get.mockResolvedValueOnce({ message: draft() });
    const container = host();
    await renderCompose(container, { query: { draft: 'drf_1', mailbox: MB } });

    const area = container.querySelector('textarea.compose-body');
    expect(area.hidden).toBe(false);
    expect(area.value).toBe('Hello draft');
  });

  it('refuses to load a message that is not a draft', async () => {
    api.mail.get.mockResolvedValueOnce({
      message: { id: 'msg_9', isDraft: false, to: ['alice@example.com'], subject: 'Sent mail' },
    });
    const container = host();
    await renderCompose(container, { query: { draft: 'msg_9', mailbox: MB } });

    // A plain message is read-only; it must not become an editable draft.
    expect(container.querySelector('.compose-title').textContent).toBe('New message');
    expect(container.querySelector('.compose-recipients').value).toBe('');
  });
});

describe('accessibility', () => {
  it('has no detectable violations in the plain-text state', async () => {
    editorShouldFail = true;
    const container = host();
    await renderCompose(container, { query: {} });

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('has no detectable violations in the rich-text state', async () => {
    const container = host();
    await renderCompose(container, { query: {} });
    await waitFor('.editor-surface', container);

    const { violations } = await audit(container);
    expect(violations, describeViolations(violations)).toEqual([]);
  });

  it('exposes the formatting toolbar with an accessible name', async () => {
    const container = host();
    await renderCompose(container, { query: {} });
    await waitFor('.editor-toolbar', container);

    const bar = container.querySelector('.editor-toolbar');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.getAttribute('aria-label')).toBe('Text formatting');
  });

  it('reports the expanded state of the schedule picker', async () => {
    const container = host();
    await renderCompose(container, { query: {} });

    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Schedule');
    // Without aria-expanded there is no way to know the picker is now open.
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('teardown', () => {
  it('destroys the editor so its DOM listeners do not leak', async () => {
    const container = host();
    const cleanup = await renderCompose(container, { query: {} });
    await waitFor('.editor-surface', container);

    expect(editorInstance.destroy).not.toHaveBeenCalled();
    cleanup();
    // A leaked ProseMirror view keeps a MutationObserver on the document.
    expect(editorInstance.destroy).toHaveBeenCalled();
  });
});

describe('attachments', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    api.mail.attachmentUploadUrl.mockReset();
    api.mail.attachmentComplete.mockReset();
  });

  it('sends the field names the upload schemas actually validate', async () => {
    api.mail.attachmentUploadUrl.mockResolvedValue({
      draftId: 'drf_1',
      attachmentId: 'att_1',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      size: 3,
      url: 'https://storage.example/signed',
      path: 'p',
    });
    api.mail.attachmentComplete.mockResolvedValue({
      attachment: { id: 'att_1', filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    });
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 }));

    const container = host();
    await renderCompose(container, { query: {} });
    await waitFor('.attach-input', container);

    const input = container.querySelector('.attach-input');
    const file = new File(['pdf'], 'a.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(api.mail.attachmentUploadUrl).toHaveBeenCalled());

    // Both requests are validated server-side before the handler runs, so a name
    // the server does not recognise is reported as a missing field. Parsing the
    // captured payloads against the shipped schemas fails here instead, at the
    // exact place the drift happened.
    const ticketArgs = api.mail.attachmentUploadUrl.mock.calls[0][0];
    expect(() => attachmentUploadUrlSchema.parse(ticketArgs)).not.toThrow();
    expect(ticketArgs).toMatchObject({ draftId: 'drf_1', filename: 'a.pdf', mimeType: 'application/pdf', size: 3 });

    await vi.waitFor(() => expect(api.mail.attachmentComplete).toHaveBeenCalled());
    const completeArgs = api.mail.attachmentComplete.mock.calls[0][0];
    expect(() => attachmentCompleteSchema.parse(completeArgs)).not.toThrow();
    expect(completeArgs).toMatchObject({
      draftId: 'drf_1',
      attachmentId: 'att_1',
      filename: 'a.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('keeps a failed upload from dropping the files already stored', async () => {
    api.mail.attachmentUploadUrl.mockRejectedValueOnce(new Error('nope'));
    const container = host();
    await renderCompose(container, { query: {} });
    await waitFor('.attach-input', container);

    const input = container.querySelector('.attach-input');
    const file = new File(['pdf'], 'a.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(api.mail.attachmentUploadUrl).toHaveBeenCalled());
    // The composer toasts rather than throwing, so the view is still usable.
    expect(container.querySelector('form')).toBeTruthy();
    expect(api.mail.attachmentComplete).not.toHaveBeenCalled();
  });
});
