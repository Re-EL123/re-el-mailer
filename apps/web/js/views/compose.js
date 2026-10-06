/**
 * Rich-text composer.
 *
 * Formatting is handled by TipTap, built into js/vendor/editor.bundle.js by
 * scripts/build-editor.mjs. That bundle is the only bundled file in the app;
 * everything else is still served as plain ES modules.
 *
 * Two rules govern the markup this produces:
 *
 *   1. The plain-text alternative is not optional. Roughly half of all mail is
 *      read in a client that ignores or sanitises HTML, so text is generated
 *      alongside html on every change and sent in both fields. Getting this
 *      wrong is how a formatted message arrives as one enormous run-on line.
 *
 *   2. The HTML is sanitised server-side on send (packages/shared/sanitize.js).
 *      This side never inserts editor output as markup into the page, and never
 *      trusts it either — it only sends it.
 */

import { api } from '../api.js';
import { clear, el, formatBytes, mount, toast } from '../ui.js';
import { icon } from '../icons.js';
import { activeMailbox, state } from '../store.js';
import { navigate } from '../router.js';
import { pushShortcuts } from '../keys.js';

export async function renderCompose(container, ctx) {
  const mailboxId = ctx.query.mailbox || state.activeMailboxId;
  let draftId = ctx.query.draft || null;
  let seed = { to: [], cc: [], bcc: [], subject: '', html: '', text: '' };

  // Pre-fill from reply/forward.
  if (ctx.query.reply) {
    try {
      // The server has supported `mode=all` all along, but nothing in the client
      // ever sent it, so a reply-all was unreachable from the UI.
      const mode = ctx.query.mode === 'all' ? 'all' : 'sender';
      const data = await api.send.reply(ctx.query.reply, mode, mailboxId);
      seed = data.draft;
    } catch { /* fall through to blank */ }
  } else if (ctx.query.forward) {
    try {
      const data = await api.send.forward(ctx.query.forward, true, mailboxId);
      seed = data.draft;
    } catch { /* fall through to blank */ }
  } else if (ctx.query.draft) {
    // Resuming a draft, not replying: the message is loaded and its every field
    // put back, so closing the composer and reopening it later is lossless. The
    // isDraft guard keeps an ordinary message id from being loaded here, which
    // would turn "read this mail" into "quietly resend its contents".
    try {
      const data = await api.mail.get(ctx.query.draft, mailboxId);
      const draft = data?.message;
      if (!draft?.isDraft) throw new Error('That message is not a draft.');
      draftId = draft.id;
      seed = {
        to: draft.to || [],
        cc: draft.cc || [],
        bcc: draft.bcc || [],
        subject: draft.subject || '',
        // The HTML is what the editor should open with; the text is what the
        // fallback textarea holds and what a plain-text client gets.
        html: draft.bodyHtml || '',
        text: draft.bodyText || '',
        attachments: draft.attachments || [],
        threadId: draft.threadId || null,
        inReplyTo: draft.inReplyTo || null,
        references: draft.references || [],
      };
    } catch {
      // Nothing to resume: start blank. draftId must be cleared too, or the
      // composer would keep saving ("updating") against the id that failed to
      // load — for a message that is not a draft that means editing an id the
      // server will keep rejecting.
      draftId = null;
    }
  }

  const form = el('form', { class: 'compose-form', novalidate: true });

  /**
   * A recipient field with inline suggestions.
   *
   * The field holds a comma/newline list; the active token is the text after the
   * last separator. Suggestions come from the `suggest` endpoint, which merges
   * stored contacts with the frequent inbound senders, for the token being
   * typed. Selecting one replaces that token, keeps the addresses already in the
   * field, and leaves the caret ready for the next recipient.
   */
  function recipientsField(label, name, parent, { single = false } = {}) {
    const input = el('input', {
      type: 'text',
      name,
      class: 'compose-recipients',
      // The raw string is the contract: the API's emailListSchema parses
      // comma/newline lists server-side.
      placeholder: single ? 'name@example.com' : 'name@example.com, other@example.com',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      // Combobox pattern: the input names the popup it controls, so a screen
      // reader hears the list open and which option is active, not a bare text
      // field the suggestions appear "beside".
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-controls': `${name}-suggest`,
      'aria-expanded': 'false',
    });

    const list = el('div', { class: 'recipient-suggest', role: 'listbox', id: `${name}-suggest` });
    list.hidden = true;

    const wrapper = el('div', { class: 'recipient-field' });
    wrapper.append(input, list);
    parent.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), wrapper));

    let suggestions = [];
    let active = -1;
    let suggestTimer = null;

    /** Index just past the last separator: where the token the user is typing starts. */
    function tokenStart() {
      const value = input.value;
      const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('\n'));
      return cut === -1 ? 0 : cut + 1;
    }

    function tokenText() {
      return input.value.slice(tokenStart()).trim();
    }

    function close() {
      suggestions = [];
      active = -1;
      list.hidden = true;
      // Cancel a pending request so a field that was focused then blurred (or
      // had an address picked) never pops the list back open behind the user.
      clearTimeout(suggestTimer);
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function select(index) {
      const choice = suggestions[index];
      if (!choice) return;
      const value = input.value;
      // Cut before the last separator, so the chosen address replaces that
      // token and the separator is written fresh after it.
      const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('\n'));
      const kept = cut === -1 ? '' : value.slice(0, cut).trimEnd();
      input.value = `${kept}${kept ? ', ' : ''}${choice.email}, `;
      input.setSelectionRange(input.value.length, input.value.length);
      // The field is already focused — the list only opens in response to the
      // focus/typing it is watching — so refocusing and its focus handler
      // would reopen the recents the moment an address was picked.
      close();
    }

    function render() {
      mount(
        list,
        ...suggestions.map((entry, index) =>
          el('div', {
            id: `${list.id}-${index}`,
            role: 'option',
            'aria-selected': String(index === active),
            class: `recipient-option${index === active ? ' active' : ''}`,
            text: entry.name && entry.name !== entry.email ? `${entry.name} <${entry.email}>` : entry.email,
            // mousedown, not click: click on a blurred input is preceded by blur,
            // which closes the list before the selection lands. preventingDefault
            // keeps focus here so the address is picked and the caret stays in.
            onMousedown: (event) => {
              event.preventDefault();
              select(index);
            },
          }),
        ),
      );
      const open = suggestions.length > 0;
      list.hidden = !open;
      input.setAttribute('aria-expanded', String(open));
      if (open && active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      else input.removeAttribute('aria-activedescendant');
    }

    async function request(query) {
      try {
        const data = await api.send.suggest(query, mailboxId);
        suggestions = (data && data.suggestions) || [];
      } catch {
        // An unreachable suggestions endpoint must not take the composer down
        // with it: recipients are still typed and sent as before.
        suggestions = [];
      }
      render();
    }

    const scheduleSuggest = (query) => {
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => request(query), 160);
    };

    input.addEventListener('focus', () => {
      active = -1;
      scheduleSuggest(tokenText());
    });
    input.addEventListener('input', () => {
      active = -1;
      const query = tokenText();
      if (!query) {
        close();
        return;
      }
      scheduleSuggest(query);
    });
    input.addEventListener('blur', () => close());
    input.addEventListener('keydown', (event) => {
      if (list.hidden) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        active = (active + 1) % suggestions.length;
        render();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active - 1 + suggestions.length) % suggestions.length;
        render();
      } else if (event.key === 'Enter') {
        if (active >= 0) {
          event.preventDefault();
          select(active);
        }
      } else if (event.key === 'Tab') {
        // Select first, then let the default tab behaviour move on: after a
        // completion the caret has no next token to type.
        if (active >= 0) select(active);
        close();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    return input;
  }

  const toInput = recipientsField('To', 'to', form, { single: true });
  const ccInput = recipientsField('Cc', 'cc', form);
  const bccInput = recipientsField('Bcc', 'bcc', form);
  const subjectInput = el('input', { type: 'text', name: 'subject', class: 'compose-subject', autocomplete: 'off' });
  form.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Subject' }), subjectInput));

  const attachList = el('div', { class: 'attach-list' });
  const fileInput = el('input', { type: 'file', multiple: true, class: 'attach-input' });
  form.append(el('div', { class: 'compose-attachments' }, el('label', { class: 'btn btn-sm' }, icon('paperclip', { size: 14 }), el('span', { text: 'Attach files' }), fileInput), attachList));

  const statusNode = el('div', { class: 'compose-status', role: 'status', 'aria-live': 'polite' });

  /**
   * The editor, with a textarea behind it.
   *
   * The textarea is not a fallback in the abstract: it is the element that is
   * always present, and the editor is layered over it only once it has loaded.
   * If the bundle 404s, the user is left with a working plain-text composer
   * rather than an empty box they cannot type into.
   */
  const editorHost = el('div', { class: 'editor-host' });
  const fallbackArea = el('textarea', {
    class: 'compose-body',
    // A plain textarea cannot show formatting, so it is labelled as such rather
    // than pretending to be a rich-text field.
    'aria-label': 'Message body (plain text)',
    placeholder: 'Write your message…',
    rows: 14,
  });

  const toolbar = el('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Text formatting' });
  form.append(
    el('div', { class: 'field editor-field' },
      el('span', { class: 'field-label', text: 'Message' }),
      editorHost,
      fallbackArea,
    ),
    toolbar,
  );

  let editor = null;
  let usingRichText = false;

  // Plain-text value is tracked separately: when the editor is active it owns the
  // content, and the textarea is only a placeholder underneath it.
  let plainText = '';

  function setPlainText(value) {
    plainText = value;
    // Guarded: the editor writes back on every keystroke, and assigning the same
    // value to a focused textarea moves the caret to the end mid-word.
    if (fallbackArea.value !== value) fallbackArea.value = value;
  }

  // The fallback textarea is not just a static placeholder: if the editor never
  // starts, it is the only way to write a message, so typing in it has to reach
  // the same plainText mirror the editor writes to. Without this, `collect()`
  // would send an empty body while the user could plainly see their text on
  // screen.
  fallbackArea.addEventListener('input', () => {
    if (editor && usingRichText) return;
    plainText = fallbackArea.value;
  });

  function buildToolbar() {
    if (!editor) {
      mount(toolbar);
      return;
    }

    const button = (name, { label, isActive, run, iconName }) =>
      el(
        'button',
        {
          type: 'button',
          class: `editor-btn${isActive() ? ' on' : ''}`,
          // aria-pressed is what carries the toggle state; the class only carries
          // it visually, and colour alone would not be perceivable.
          'aria-pressed': String(isActive()),
          'aria-label': label,
          title: label,
          onClick: run,
          onMousedown: (event) => event.preventDefault(),
        },
        icon(iconName, { size: 15 }),
      );

    const controls = [
      button('bold', { label: 'Bold', iconName: 'bold', isActive: () => editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() }),
      button('italic', { label: 'Italic', iconName: 'italic', isActive: () => editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() }),
      button('strike', { label: 'Strikethrough', iconName: 'strike', isActive: () => editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() }),
      button('code', { label: 'Inline code', iconName: 'code', isActive: () => editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() }),
      button('bulletList', { label: 'Bulleted list', iconName: 'listBullet', isActive: () => editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() }),
      button('orderedList', { label: 'Numbered list', iconName: 'listOrdered', isActive: () => editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() }),
      button('blockquote', { label: 'Quote', iconName: 'quote', isActive: () => editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() }),
      button('link', { label: 'Insert link', iconName: 'link', isActive: () => editor.isActive('link'), run: () => setLink() }),
      button('undo', { label: 'Undo', iconName: 'undo', isActive: () => false, run: () => editor.chain().focus().undo().run() }),
      button('redo', { label: 'Redo', iconName: 'redo', isActive: () => false, run: () => editor.chain().focus().redo().run() }),
    ];

    mount(toolbar, ...controls);
  }

  /**
   * Insert or edit a link.
   *
   * Built in-page rather than with prompt(): a native dialog cannot be styled,
   * cannot be focused programmatically, and is not reachable from a test.
   *
   * The protocol check is the security-relevant part. A `javascript:` or `data:`
   * URL stored in a message becomes a live script or a phishing page in every
   * recipient's client, so it is refused here rather than left to the server's
   * sanitiser to catch.
   */
  function setLink() {
    if (!editor) return;

    const existing = editor.getAttributes('link')?.href || '';
    const input = el('input', {
      type: 'url',
      class: 'link-input',
      placeholder: 'https://example.com',
      value: existing,
      'aria-label': 'Link address',
    });

    const prompt = el(
      'div',
      { class: 'modal-backdrop', id: 'link-prompt' },
      el(
        'div',
        {
          class: 'modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'link-prompt-title',
        },
        el('h3', { class: 'modal-title', id: 'link-prompt-title', text: existing ? 'Edit link' : 'Insert link' }),
        input,
        el(
          'div',
          { class: 'modal-actions' },
          el('button', {
            class: 'btn',
            text: 'Cancel',
            onClick: () => {
              prompt.remove();
              document.removeEventListener('keydown', onEscape, true);
              editor.focus();
            },
          }),
          el('button', {
            class: 'btn btn-primary',
            text: 'Apply',
            onClick: () => {
              const value = input.value.trim();
              prompt.remove();
              document.removeEventListener('keydown', onEscape, true);

              if (!value) {
                // An emptied field means remove the link, not store an empty href.
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                return;
              }

              if (!/^https?:\/\//i.test(value)) {
                toast('Links must start with http:// or https://', 'error');
                editor.focus();
                return;
              }

              editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run();
            },
          }),
        ),
      ),
    );

    const onEscape = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      prompt.remove();
      document.removeEventListener('keydown', onEscape, true);
      editor.focus();
    };

    prompt.addEventListener('click', (event) => {
      if (event.target === prompt) onEscape(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    document.addEventListener('keydown', onEscape, true);
    document.body.append(prompt);
    input.focus();
    input.select();
  }

  /**
   * Bring the editor up.
   *
   * A failure here is not an error the user needs to see: the textarea is
   * already usable and holds their content. Reporting "rich text unavailable"
   * would be noise, so this stays silent and just leaves the plain composer.
   */
  async function enableRichText() {
    try {
      // Paths are module-rooted so a deep import is never written relative to the
        // view: 'js/vendor/...' resolves the same from any directory, which is
        // what lets this file move without breaking the build.
        const { createEditor } = await import('../vendor/editor.bundle.js');

      editor = await createEditor(editorHost, {
        content: initialHtml || plainText || seed.text || '',
        placeholder: 'Write your message…',
        onChange: (text) => setPlainText(text),
      });

      if (!editor) return;

      usingRichText = true;
      // The textarea is hidden rather than removed: it stays the accessible
      // fallback and holds the value if the editor is torn down.
      fallbackArea.hidden = true;
      form.classList.add('rich-text');
      buildToolbar();
      editor.focus();
    } catch {
      editor = null;
      usingRichText = false;
      fallbackArea.hidden = false;
    }
  }

  const scheduleInput = el('input', { type: 'datetime-local', class: 'schedule' });
  const scheduleWrap = el('label', { class: 'schedule-wrap', hidden: true }, scheduleInput);
  const sendBtn = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Send' });
  const discardBtn = el('button', {
    type: 'button',
    class: 'btn',
    text: 'Discard',
    onClick: async () => {
      // Discard means discard: an autosaved draft would otherwise stay in the
      // drafts folder with its uploaded attachments still attached.
      if (draftId) {
        try {
          await api.mail.deleteDraft(draftId, mailboxId);
        } catch {
          /* already gone, or nothing to remove */
        }
      }
      navigate('inbox');
    },
  });
  const scheduleToggle = el('button', { type: 'button', class: 'btn', text: 'Schedule', 'aria-expanded': 'false', onClick: () => {
    // Toggle the wrapper, not just the input: the wrapper carries the label and
    // the minimum-date hint, and hiding only the input leaves an empty gap.
    scheduleWrap.hidden = !scheduleWrap.hidden;
    scheduleToggle.setAttribute('aria-expanded', String(!scheduleWrap.hidden));
    if (!scheduleWrap.hidden) {
      // datetime-local needs a value no earlier than now.
      const soon = new Date(Date.now() + 60_000);
      soon.setSeconds(0, 0);
      scheduleInput.min = soon.toISOString().slice(0, 16);
      scheduleInput.focus();
    } else {
      scheduleInput.value = '';
    }
  } });
  form.append(el('div', { class: 'compose-actions' }, sendBtn, scheduleToggle, scheduleWrap, discardBtn), statusNode);

  // Seed values.
  toInput.value = Array.isArray(seed.to) ? seed.to.join(', ') : '';
  ccInput.value = Array.isArray(seed.cc) ? seed.cc.join(', ') : '';
  bccInput.value = Array.isArray(seed.bcc) ? seed.bcc.join(', ') : '';
  subjectInput.value = seed.subject || '';

  // Quoted history is appended as text and stays plain: threading it through the
  // editor would make a quote style the rest of the message.
  const quoted = seed.quotedText
    ? `\n\n${seed.quotedText}`
    : seed.text || '';
  setPlainText(quoted.trim() ? quoted : '');

  // A resumed draft is reopened as it was stored: the HTML goes to the editor
  // and the text alternative stays in plainText. Reply and forward drafts never
  // set seed.html, so their quoted history still starts plain.
  const initialHtml = seed.html || '';

  // Attachments already on this draft, tracked so chips accumulate across uploads.
  // The send request itself carries no attachment list: the API falls back to the
  // attachments stored against the draft id, so re-sending ids here would be both
  // redundant and, for a new draft, wrong.
  const attachments = [...(seed.attachments || [])];

  function renderAttachments() {
    mount(
      attachList,
      ...attachments.map((a) =>
        el(
          'span',
          { class: 'attach-chip' },
          icon('paperclip', { size: 14 }),
          el('span', { text: a.filename || a.name || 'attachment' }),
          el('span', { class: 'muted small', text: formatBytes(a.sizeBytes ?? a.size ?? 0) }),
        ),
      ),
    );
  }
  renderAttachments();

  /** Editor HTML for the current document, or '' when the editor is not up. */
  function richHtml() {
    if (!editor || !usingRichText) return '';
    try {
      return editor.getHTML();
    } catch {
      // If the HTML cannot be produced, sending the plain text alone is better
      // than sending an empty body.
      return '';
    }
  }

  function collect() {
    return {
      // Recipients are typed as free text here; the API's `emailListSchema`
      // parses comma/newline lists server-side, so the raw string is the contract.
      to: toInput.value,
      cc: ccInput.value,
      bcc: bccInput.value,
      subject: subjectInput.value,
      html: richHtml() || (plainText ? `<div>${escapeHtml(plainText).replace(/\n/g, '<br>')}</div>` : ''),
      text: plainText,
      mailboxId: activeMailbox()?.id,
    };
  }

  async function saveDraft() {
    try {
      const data = await api.mail.saveDraft({ ...collect(), id: draftId, mailboxId });
      draftId = data.draft.id;
      statusNode.textContent = `Draft saved ${new Date().toLocaleTimeString()}`;
      return draftId;
    } catch (err) {
      statusNode.textContent = err.message;
      return draftId;
    }
  }

  // Autosave (best-effort) every few seconds once there is content.
  let timer = setInterval(() => {
    if (subjectInput.value || plainText) saveDraft();
  }, 5000);
  const popShortcuts = pushShortcuts('compose', {
    'mod+enter': () => form.requestSubmit(),
  });

  // Attachments go straight to storage: the file bytes never pass through the
  // API, which caps request bodies far below our attachment limit.
  async function uploadFile(draft, file) {
    const mimeType = file.type || 'application/octet-stream';
    // Field names are the server's, not this view's: attachment-upload-url and
    // attachment-complete are validated by attachmentUploadUrlSchema and
    // attachmentCompleteSchema, which strip anything they do not recognise. An
    // `id` where a `draftId` is expected reads as "not provided" rather than
    // "wrong", so the request fails with a missing-field error that says nothing
    // about the name that caused it.
    const ticket = await api.mail.attachmentUploadUrl({
      draftId: draft,
      filename: file.name,
      mimeType,
      size: file.size,
      mailboxId,
    });

    const response = await fetch(ticket.url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: file,
    });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);

    // Storage is not readable until the API confirms the object, so this call is
    // what turns an upload into a message attachment. It names the file and type
    // again because the server re-verifies them against the stored object rather
    // than trusting the ticket.
    const done = await api.mail.attachmentComplete({
      draftId: draft,
      attachmentId: ticket.attachmentId,
      filename: file.name,
      mimeType,
      mailboxId,
    });
    return done.attachment;
  }

  fileInput.addEventListener('change', async () => {
    try {
      // A draft must exist before an attachment can point at it.
      const id = draftId || (await saveDraft());
      // One at a time: a failed file must not discard the ones already stored.
      for (const file of [...fileInput.files]) {
        try {
          attachments.push(await uploadFile(id, file));
        } catch (err) {
          toast(err.message, 'error');
        }
        renderAttachments();
      }
    } finally {
      fileInput.value = '';
      statusNode.textContent = draftId ? `Draft saved ${new Date().toLocaleTimeString()}` : '';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    try {
      // Scheduling is opt-in: no chosen time means send now, even if the picker
      // was opened and closed again.
      const scheduledFor = !scheduleWrap.hidden && scheduleInput.value
        ? new Date(scheduleInput.value).toISOString()
        : null;

      const data = await api.send.send({
        ...collect(),
        mailboxId,
        draftId,
        scheduledFor,
        threadId: seed.threadId || null,
        inReplyTo: seed.inReplyTo || null,
        references: seed.references || [],
        // Only meaningful for a forward: the API resolves the source message's
        // attachments and verifies ownership before reading any bytes.
        attachmentMessageId: ctx.query.forward || null,
      });
      toast(data.scheduled ? 'Message scheduled.' : 'Message sent.', 'success');
      navigate('sent');
    } catch (err) {
      toast(err.message, 'error');
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
  });

  mount(container, el('div', { class: 'compose-wrap' },
    el('h2', {
      class: 'compose-title',
      text: ctx.query.reply
        ? ctx.query.mode === 'all' ? 'Reply all' : 'Reply'
        : ctx.query.forward ? 'Forward'
        : draftId ? 'Edit draft'
        : 'New message',
    }),
    form,
  ));

  await enableRichText();

  return () => {
    clearInterval(timer);
    popShortcuts();
    editor?.destroy?.();
    clear(container);
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}