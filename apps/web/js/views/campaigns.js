/**
 * Bulk send (campaigns).
 *
 * A campaign is created and then sent: recipient rows and progress live on the
 * server, and the cron tick drains batches in the background, so this view only
 * needs to start a campaign, pause one in flight, and show how far it has got.
 */

import { api } from '../api.js';
import { el, mount, toast } from '../ui.js';
import { state } from '../store.js';

const STATUS_LABEL = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  sent: 'Sent',
  paused: 'Paused',
  cancelled: 'Cancelled',
};

/**
 * Parse the recipients textarea.
 *
 * One recipient per line, as either `name@example.com` or
 * `name@example.com, Display Name`. The server re-validates every address, so
 * anything unparseable here is simply dropped rather than sent as junk.
 */
export function parseRecipients(text) {
  const recipients = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [address, ...rest] = line.split(',');
    const email = address.trim();
    if (!email.includes('@')) continue;
    recipients.push({ email, name: rest.join(',').trim() || null });
  }
  return recipients;
}

function mailboxPicker(onChange) {
  const select = el('select', {}, ...state.mailboxes.map((mb) => el('option', { value: mb.id, text: mb.email })));
  select.value = state.activeMailboxId || state.mailboxes[0]?.id || '';
  if (onChange) select.addEventListener('change', () => onChange(select.value));
  return select;
}

function progress(campaign) {
  const total = campaign.totalRecipients || 0;
  const sent = campaign.sentCount || 0;
  const failed = campaign.failedCount || 0;
  return `${sent} sent${failed ? `, ${failed} failed` : ''} of ${total}`;
}

export async function renderCampaigns(container) {
  const app = el('div', { class: 'campaigns' });
  let current = state.activeMailboxId || state.mailboxes[0]?.id || '';

  const list = el('div', { class: 'setting-rows' });

  const name = el('input', { class: 'field', placeholder: 'Campaign name', maxlength: 120 });
  const subject = el('input', { class: 'field', placeholder: 'Subject', maxlength: 200 });
  const bodyText = el('textarea', { class: 'field', rows: 5, placeholder: 'Write the message…' });
  const recipients = el('textarea', { class: 'field', rows: 5, placeholder: 'name@example.com\nother@example.com, Display Name' });
  const schedule = el('input', { type: 'datetime-local', class: 'field' });
  const batchSize = el('input', { type: 'number', class: 'field', min: '1', max: '500', value: '50' });

  async function refresh() {
    let campaigns = [];
    try {
      campaigns = (await api.send.campaigns(current)).campaigns || [];
    } catch (err) {
      mount(list, el('p', { class: 'muted small', text: err.message }));
      return;
    }

    mount(list, ...(campaigns.length
      ? campaigns.map((campaign) => {
          const canSend = ['draft', 'scheduled', 'paused'].includes(campaign.status);
          const canPause = campaign.status === 'sending';
          return el('div', { class: 'campaign-row' },
            el('div', { class: 'campaign-body' },
              el('span', { class: 'campaign-name', text: campaign.name }),
              el('span', { class: 'muted small', text: campaign.subject }),
              el('span', { class: 'muted small', text: progress(campaign) }),
            ),
            el('span', { class: `pill status-${campaign.status}`, text: STATUS_LABEL[campaign.status] || campaign.status }),
            el('div', { class: 'row-actions' },
              canSend ? el('button', { class: 'btn btn-sm btn-primary', text: 'Send now', onClick: async () => {
                try {
                  await api.send.sendCampaign(campaign.id, current);
                  toast('Campaign sending.', 'success');
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              } }) : null,
              canPause ? el('button', { class: 'btn btn-sm', text: 'Pause', onClick: async () => {
                try {
                  await api.send.pauseCampaign(campaign.id, current);
                  toast('Campaign paused.', 'success');
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              } }) : null,
              el('button', { class: 'btn btn-sm', text: 'Delete', onClick: async () => {
                if (!confirm(`Delete the campaign "${campaign.name}"?`)) return;
                try {
                  await api.send.deleteCampaign(campaign.id, current);
                  toast('Campaign deleted.', 'success');
                  await refresh();
                } catch (err) { toast(err.message, 'error'); }
              } }),
            ),
          );
        })
      : [el('p', { class: 'muted small', text: 'No campaigns yet.' })]));
  }

  async function create() {
    if (!name.value.trim() || !subject.value.trim()) {
      toast('A campaign needs a name and a subject.', 'error');
      return;
    }
    const parsed = parseRecipients(recipients.value);
    if (!parsed.length) {
      toast('Add at least one recipient address.', 'error');
      return;
    }
    try {
      await api.send.createCampaign({
        mailboxId: current,
        name: name.value.trim(),
        subject: subject.value.trim(),
        bodyText: bodyText.value,
        recipients: parsed,
        scheduledFor: schedule.value ? new Date(schedule.value).toISOString() : null,
        batchSize: Number(batchSize.value) || 50,
      });
      name.value = '';
      subject.value = '';
      bodyText.value = '';
      recipients.value = '';
      schedule.value = '';
      toast('Campaign created.', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  app.append(
    el('section', { class: 'card' },
      el('h3', { class: 'card-title', text: 'New campaign' }),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Mailbox' }),
        mailboxPicker(async (id) => { current = id; await refresh(); })),
      el('div', { class: 'setting-grid' },
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Campaign name' }), name),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Subject' }), subject),
      ),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Message' }), bodyText),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Recipients (one per line)' }), recipients),
      el('div', { class: 'setting-grid' },
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Send at (optional)' }), schedule),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: 'Batch size' }), batchSize),
      ),
      el('p', { class: 'setting-note', text: 'Recipients receive the message in batches; a scheduled campaign starts on its own.' }),
      el('button', { class: 'btn btn-primary', text: 'Create campaign', onClick: create }),
    ),
    el('section', { class: 'card' },
      el('h3', { class: 'card-title', text: 'Campaigns' }),
      list,
    ),
  );

  mount(container, app);
  await refresh();
}
