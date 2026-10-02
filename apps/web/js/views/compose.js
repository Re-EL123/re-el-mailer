/**
 * Compose: write a new message, reply, or forward.
 *
 * Drafts autosave to the server so a crash or tab close does not lose work, and
 * attachments upload against the saved draft id. Sending is handled by
 * /api/send, which is the single place a message leaves the system.
 */

import { api } from '../api.js';
import { clear, el, formatBytes, mount, toast } from '../ui.js';
import { activeMailbox, state } from '../store.js';
import { navigate } from '../router.js';

function recipientsField(label, key, form, { single = false } = {}) {
  const input = el('input', { type: 'text', class: 'recipients', placeholder: single ? '' : 'name@example.co.za, …' });
  form.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input));
  return input;
}

export async function renderCompose(container, ctx) {
  const mailboxId = ctx.query.mailbox || state.activeMailboxId;
  const form = el('form', { class: 'compose' });
  const statusNode = el('div', { class: 'compose-status muted small' });

  let draftId = ctx.query.draft || null;
  let seed = { to: [], cc: [], bcc: [], subject: '', html: '', text: '' };

  // Pre-fill from reply/forward.
  if (ctx.query.reply) {
    try {
      const data = await api.send.reply(ctx.query.reply, 'sender', mailboxId);
      seed = data.draft;
    } catch { /* fall through to blank */ }
  } else if (ctx.query.forward) {
    try {
      const data = await api.send.forward(ctx.query.forward, true, mailboxId);
      seed = data.draft;
    } catch { /* fall through to blank */ }
  }

  const toInput = recipientsField('To', 'to', form, { single: true });
  const ccInput = recipientsField('Cc', 'cc', form);
  const bccInput = recipientsField('Bcc', 'bcc', form);
  const subjectInput = el('input', { type: 'text', class: 'subject', placeholder: 'Subject', maxlength: 200 });
  form.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Subject' }), subjectInput));

  const bodyArea = el('textarea', { class: 'compose-body', placeholder: 'Write your message…', rows: 14 });
  form.append(el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Message' }), bodyArea));

  const attachList = el('div', { class: 'attach-list' });
  const fileInput = el('input', { type: 'file', multiple: true, class: 'attach-input' });
  form.append(el('div', { class: 'compose-attachments' }, el('label', { class: 'btn btn-sm', text: '📎 Attach files' }, fileInput), attachList));

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
  const scheduleToggle = el('button', { type: 'button', class: 'btn', text: 'Schedule', onClick: () => {
    // Toggle the wrapper, not just the input: the wrapper carries the label and
    // the minimum-date hint, and hiding only the input leaves an empty gap.
    scheduleWrap.hidden = !scheduleWrap.hidden;
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
  if (seed.quotedText) {
    bodyArea.value = `\n\n${seed.quotedText}`;
  }

  // Attachments already on this draft, tracked so chips accumulate across uploads.
  // The send request itself carries no attachment list: the API falls back to the
  // attachments stored against the draft id, so re-sending ids here would be both
  // redundant and a second place for the two to disagree.
  const attachments = Array.isArray(seed.attachments) ? [...seed.attachments] : [];

  function renderAttachments() {
    mount(
      attachList,
      ...attachments.map((a) =>
        el(
          'span',
          { class: 'attach-chip' },
          el('span', { text: '📎' }),
          el('span', { text: a.filename || a.name || 'attachment' }),
          el('span', { class: 'muted small', text: formatBytes(a.sizeBytes ?? a.size ?? 0) }),
        ),
      ),
    );
  }
  renderAttachments();

  function collect() {
    return {
      // Recipients are typed as free text here; the API's `emailListSchema`
      // parses comma/newline lists server-side, so the raw string is the contract.
      to: toInput.value,
      cc: ccInput.value,
      bcc: bccInput.value,
      subject: subjectInput.value,
      html: bodyArea.value ? `<div>${escapeHtml(bodyArea.value).replace(/\n/g, '<br>')}</div>` : '',
      text: bodyArea.value,
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
    if (subjectInput.value || bodyArea.value) saveDraft();
  }, 5000);
  const cleanup = () => clearInterval(timer);

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const id = draftId || (await saveDraft());
    if (!id) return;
    const formData = new FormData();
    formData.append('draftId', id);
    for (const file of fileInput.files) formData.append('files', file, file.name);
    try {
      const data = await api.mail.uploadAttachment(formData);
      // Append rather than replace: adding a second file used to wipe the chips
      // for everything already attached, which looked like the upload lost them.
      for (const uploaded of data.uploaded || []) {
        attachments.push(uploaded);
      }
      renderAttachments();
      for (const rejected of data.rejected || []) {
        toast(`${rejected.filename}: ${rejected.reason}`, 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
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
    el('h2', { class: 'compose-title', text: ctx.query.reply ? 'Reply' : ctx.query.forward ? 'Forward' : 'New message' }),
    form,
  ));

  return cleanup;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}