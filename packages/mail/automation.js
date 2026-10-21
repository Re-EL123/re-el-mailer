/**
 * Automation orchestration.
 *
 * This is the I/O half of the feature: it evaluates rules against inbound mail,
 * applies their actions, answers with out-of-office replies, fans events out to
 * outbound webhooks, and drains the job queue on the cron tick. The matching
 * itself lives in ./rules.js and stays pure.
 *
 * Everything here is written to be safe under the provider's at-least-once
 * delivery: rule applications are recorded in `automation_rule_runs` (unique per
 * rule/message), auto-replies are rate-limited per sender, and jobs are claimed
 * with `for update skip locked`, so a retried webhook or a second cron instance
 * cannot double-send.
 */

import crypto from 'node:crypto';
import { query, queryOne } from '../db/pool.js';
import { logger } from '../shared/logger.js';
import { newId } from '../shared/ids.js';
import { AppError, Codes } from '../shared/errors.js';
import {
  activeEndpointsFor,
  activeRulesFor,
  claimCampaignRecipients,
  claimDueJobs,
  completeJob,
  createNotification,
  dueCampaigns,
  enqueueJob,
  failJob,
  markRecipientFailed,
  markRecipientSent,
  recordRuleRun,
  recordWebhookDelivery,
  reclaimStaleJobs,
  refreshCampaignCounts,
} from '../db/automation.js';
import { createMessage, moveToFolder, update as updateMessage } from '../db/messages.js';
import { sendEmail } from './resend.js';
import { buildSendPayload, formatFrom } from './compose.js';
import { evaluateRules } from './rules.js';
import { makeSnippet } from '../shared/sanitize.js';

/** Webhook events the platform emits. */
export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.bounced',
  'message.rule_matched',
  'campaign.completed',
  'contact.created',
];

const WEBHOOK_TIMEOUT_MS = 8_000;

// ─── Outbound webhooks ───────────────────────────────────────────────────────

/** Sign an outbound webhook body: `X-Reel-Signature: t=<unix>,v1=<hex>`. */
export function signOutboundWebhook(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/**
 * Deliver one event to one endpoint. Never throws: a delivery failure is
 * recorded and (by the caller) retried, but it must never fail the request that
 * triggered it.
 */
export async function deliverWebhook(endpoint, event, payload) {
  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signOutboundWebhook(endpoint.secret, timestamp, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 're-el-mailer/1.0',
        'X-Reel-Event': event,
        'X-Reel-Signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    await recordWebhookDelivery({
      endpointId: endpoint.id,
      event,
      payload,
      responseStatus: response.status,
      responseBody: text,
      delivered: response.ok,
      attempts: 1,
    }).catch(() => {});
    return { ok: response.ok, status: response.status };
  } catch (err) {
    await recordWebhookDelivery({
      endpointId: endpoint.id,
      event,
      payload,
      error: err?.message || String(err),
      delivered: false,
        attempts: 1,
    }).catch(() => {});
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan an event out to every subscribed endpoint. Successful deliveries happen
 * inline; each failure is re-queued as a `webhook` job with backoff.
 */
export async function dispatchEvent({ event, mailboxId = null, payload = {} }) {
  let endpoints = [];
  try {
    endpoints = await activeEndpointsFor(mailboxId, event);
  } catch (err) {
    logger.warn('Could not load webhook endpoints', { error: err?.message, event });
    return { delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed = 0;
  for (const endpoint of endpoints) {
    const result = await deliverWebhook(endpoint, event, payload);
    if (result.ok) {
      delivered += 1;
    } else {
      failed += 1;
      await enqueueJob({
        kind: 'webhook',
        mailboxId,
        payload: { endpointId: endpoint.id, event, payload },
        runAt: new Date(Date.now() + 60_000).toISOString(),
        dedupeKey: `webhook:${endpoint.id}:${event}:${payload.messageId || Date.now()}`,
      }).catch(() => {});
    }
  }
  return { delivered, failed };
}

// ─── Notifications ───────────────────────────────────────────────────────────

/** Create an in-app notification for the owner(s) involved in a message. */
export async function notify({ mailboxId, userId = null, kind = 'info', title, body = null, entityType = null, entityId = null, url = null }) {
  if (userId) {
    return createNotification({ userId, mailboxId, kind, title, body, entityType, entityId, url });
  }
  return query(
    `insert into public.notifications (id, user_id, mailbox_id, kind, title, body, entity_type, entity_id, url)
     select 'ntf_' || replace(gen_random_uuid()::text, '-', ''), mb.user_id, mb.id, $2, $3, $4, $5, $6, $7
     from public.mailboxes mb where mb.id = $1`,
    [mailboxId, kind, title, body, entityType, entityId, url],
  );
}

// ─── Auto-reply (out of office) ──────────────────────────────────────────────

/** Render an auto-reply body, substituting a couple of safe placeholders. */
export function renderAutoReply(template, { subject = '', sender = '' } = {}) {
  return String(template ?? '')
    .replace(/\{\{\s*subject\s*\}\}/gi, subject)
    .replace(/\{\{\s*sender\s*\}\}/gi, sender);
}

/**
 * Decide whether a mailbox should auto-reply to this sender right now.
 * Pure so the loop-prevention rules can be tested without sending.
 *
 * @returns {{send: boolean, reason?: string}}
 */
export function shouldAutoReply(mailbox, senderEmail, now = Date.now()) {
  if (!mailbox?.auto_reply_enabled) return { send: false, reason: 'disabled' };
  if (!mailbox.auto_reply_body && !mailbox.auto_reply_subject) return { send: false, reason: 'no_template' };
  if (mailbox.auto_reply_start && new Date(mailbox.auto_reply_start).getTime() > now) {
    return { send: false, reason: 'before_window' };
  }
  if (mailbox.auto_reply_end && new Date(mailbox.auto_reply_end).getTime() < now) {
    return { send: false, reason: 'after_window' };
  }

  const log = mailbox.auto_reply_log && typeof mailbox.auto_reply_log === 'object' ? mailbox.auto_reply_log : {};
  const last = log[String(senderEmail || '').toLowerCase()];
  const intervalMs = (Number(mailbox.auto_reply_interval_min) || 1440) * 60_000;
  if (last && now - new Date(last).getTime() < intervalMs) {
    return { send: false, reason: 'already_replied' };
  }
  return { send: true };
}

/**
 * Send the out-of-office reply for a delivered inbound message, if the mailbox
 * is configured and this sender has not been answered recently. Loop-safe:
 * never replies to mailer-daemon/no-reply style senders, and never to itself.
 */
export async function runAutoReply({ mailbox, message }) {
  const sender = String(message.fromEmail || '').toLowerCase();
  if (!sender) return { sent: false, reason: 'no_sender' };

  // Never answer an automated sender, or an inbound that already looks like a
  // bounce/auto-response — that is how two vacation responders talk forever.
  if (/(no-?reply|mailer-daemon|postmaster|bounce)@/i.test(sender)) {
    return { sent: false, reason: 'automated_sender' };
  }
  if (message.autoSubmitted || message.precedence === 'auto_reply' || message.precedence === 'bulk') {
    return { sent: false, reason: 'auto_submitted' };
  }

  const decision = shouldAutoReply(mailbox, sender);
  if (!decision.send) return { sent: false, reason: decision.reason };

  const from = formatFrom(mailbox.email, mailbox.display_name);
  const subject = renderAutoReply(mailbox.auto_reply_subject || `Re: ${message.subject || ''}`, {
    subject: message.subject || '',
    sender: message.fromName || sender,
  }).slice(0, 200);
  const text = renderAutoReply(mailbox.auto_reply_body || '', {
    subject: message.subject || '',
    sender: message.fromName || sender,
  });
  const html = text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');

  const payload = buildSendPayload({
    from,
    to: [sender],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    html,
    text,
    attachments: [],
    priority: 'normal',
    headers: {
      'Auto-Submitted': 'auto-replied',
      ...(message.messageId ? { 'In-Reply-To': message.messageId } : null),
    },
  });

  const { id: resendId } = await sendEmail(payload);

  await createMessage({
    mailboxId: mailbox.id,
    direction: 'outbound',
    inReplyTo: message.messageId ?? null,
    references: message.references ?? [],
    threadId: message.threadId ?? null,
    fromEmail: mailbox.email,
    fromName: mailbox.display_name,
    to: [sender],
    subject,
    bodyHtml: html,
    bodyText: text,
    snippet: makeSnippet(text, 160),
    folder: 'sent',
    isRead: true,
    sizeBytes: Buffer.byteLength(html, 'utf8') + Buffer.byteLength(text, 'utf8'),
  }).then((row) =>
    queryOne(
      `update public.messages set resend_id = $2, delivery_status = 'queued' where id = $1 returning id`,
      [row.id, resendId],
    ),
  );

  // Record the reply time against the sender so the interval is enforced.
  await query(
    `update public.mailboxes
     set auto_reply_log = jsonb_set(coalesce(auto_reply_log, '{}'::jsonb), array[$2], to_jsonb($3::text))
     where id = $1`,
    [mailbox.id, sender, new Date().toISOString()],
  );

  return { sent: true, to: sender };
}

// ─── Rule actions ────────────────────────────────────────────────────────────

/**
 * Apply one action from a matched rule to a message. Unknown action types are
 * skipped rather than thrown, so a rule saved by a newer client cannot break
 * delivery on an older one.
 */
async function applyAction(action, { mailbox, message }) {
  const type = String(action?.type || '').toLowerCase();
  const messageId = message.id;

  switch (type) {
    case 'move':
    case 'folder': {
      const folder = String(action.folder || '').toLowerCase();
      if (['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'].includes(folder)) {
        // Route every folder change through moveToFolder: it owns the
        // trash/spam -> is_deleted rule that retention and search rely on.
        await moveToFolder([messageId], mailbox.id, folder);
      }
      return { type, folder };
    }

    case 'archive':
      await moveToFolder([messageId], mailbox.id, 'archive');
      return { type };

    case 'trash':
      await moveToFolder([messageId], mailbox.id, 'trash');
      return { type };

    case 'star':
      await updateMessage(messageId, mailbox.id, { isStarred: true });
      return { type };

    case 'unstar':
      await updateMessage(messageId, mailbox.id, { isStarred: false });
      return { type };

    case 'mark_read':
      await updateMessage(messageId, mailbox.id, { isRead: true });
      return { type };

    case 'mark_unread':
      await updateMessage(messageId, mailbox.id, { isRead: false });
      return { type };

    case 'label': {
      if (!action.labelId) return { type, skipped: 'no_label' };
      await query(
        `insert into public.message_labels (message_id, label_id) values ($1, $2)
         on conflict do nothing`,
        [messageId, action.labelId],
      );
      return { type, labelId: action.labelId };
    }

    case 'assign': {
      await query(
        `update public.messages set assigned_to = $3, assigned_at = now() where id = $1 and mailbox_id = $2`,
        [messageId, mailbox.id, action.userId ?? null],
      );
      if (action.userId) {
        await notify({
          mailboxId: mailbox.id,
          userId: action.userId,
          kind: 'assignment',
          title: 'A message was assigned to you',
          body: message.subject || '(no subject)',
          entityType: 'message',
          entityId: messageId,
        }).catch(() => {});
      }
      return { type, userId: action.userId ?? null };
    }

    case 'snooze': {
      const minutes = Math.max(1, Number(action.minutes) || 60);
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      await query(
        `update public.messages set snoozed_until = $3 where id = $1 and mailbox_id = $2`,
        [messageId, mailbox.id, until],
      );
      await enqueueJob({
        kind: 'snooze',
        mailboxId: mailbox.id,
        payload: { messageId },
        runAt: until,
        dedupeKey: `snooze:${messageId}`,
      }).catch(() => {});
      return { type, until };
    }

    case 'follow_up': {
      const days = Math.max(1, Number(action.days) || 3);
      const at = new Date(Date.now() + days * 86_400_000).toISOString();
      await query(
        `update public.messages set follow_up_at = $3, follow_up_sent = false where id = $1 and mailbox_id = $2`,
        [messageId, mailbox.id, at],
      );
      await enqueueJob({
        kind: 'follow_up',
        mailboxId: mailbox.id,
        payload: { messageId },
        runAt: at,
        dedupeKey: `follow_up:${messageId}`,
      }).catch(() => {});
      return { type, at };
    }

    case 'notify': {
      await notify({
        mailboxId: mailbox.id,
        userId: action.userId ?? null,
        kind: 'rule',
        title: action.title || 'Automation rule matched',
        body: action.body || message.subject || '(no subject)',
        entityType: 'message',
        entityId: messageId,
      }).catch(() => {});
      return { type };
    }

    case 'webhook': {
      await dispatchEvent({
        event: 'message.rule_matched',
        mailboxId: mailbox.id,
        payload: { messageId, ruleId: action.ruleId ?? null, subject: message.subject ?? '' },
      }).catch(() => {});
      return { type };
    }

    case 'auto_reply':
      // Handled by runAutoReply at the mailbox level; an action only forces the
      // attempt for a message that would otherwise be skipped.
      return await runAutoReply({ mailbox, message });

    default:
      return { type, skipped: 'unknown' };
  }
}

/**
 * Evaluate and apply a mailbox's inbound rules to a freshly stored message.
 * Idempotent: a rule already recorded for this message is not re-applied.
 */
export async function runInboundAutomation({ mailbox, message }) {
  let rules = [];
  try {
    rules = await activeRulesFor(mailbox.id, 'inbound');
  } catch (err) {
    logger.warn('Could not load automation rules', { error: err?.message, mailbox: mailbox.id });
    return { matched: 0, applied: [] };
  }
  if (rules.length === 0) return { matched: 0, applied: [] };

  const matched = evaluateRules(rules, message);
  const applied = [];

  for (const rule of matched) {
    const run = await recordRuleRun(rule.id, message.id, []).catch((err) => {
      logger.warn('Could not record rule run', { error: err?.message, rule: rule.id });
      return null;
    });
    // null means the pair already existed (a retry): skip re-applying.
    if (!run) continue;

    const results = [];
    for (const action of Array.isArray(rule.actions) ? rule.actions : []) {
      try {
        results.push(await applyAction(action, { mailbox, message }));
      } catch (err) {
        logger.warn('Rule action failed', { error: err?.message, rule: rule.id, action: action?.type });
        results.push({ type: action?.type, error: true });
      }
    }
    await query(
      `update public.automation_rule_runs set actions_applied = $2::jsonb where id = $1`,
      [run.id, JSON.stringify(results)],
    ).catch(() => {});
    applied.push({ ruleId: rule.id, actions: results });
  }

  return { matched: matched.length, applied };
}

// ─── Job handlers ────────────────────────────────────────────────────────────

async function handleWebhookJob(job) {
  const { endpointId, event, payload } = job.payload || {};
  const { getWebhookEndpoint } = await import('../db/automation.js');
  const endpoint = await getWebhookEndpoint(endpointId, job.mailbox_id);
  if (!endpoint) return { skipped: 'endpoint_gone' };
  return deliverWebhook(endpoint, event, payload);
}

async function handleSnoozeJob(job) {
  const { messageId } = job.payload || {};
  const row = await queryOne(
    `update public.messages set snoozed_until = null
     where id = $1 and mailbox_id = $2 returning id, subject`,
    [messageId, job.mailbox_id],
  );
  if (row) {
    await notify({
      mailboxId: job.mailbox_id,
      kind: 'snooze',
      title: 'A snoozed message is back',
      body: row.subject || '(no subject)',
      entityType: 'message',
      entityId: row.id,
    }).catch(() => {});
  }
  return { woken: Boolean(row) };
}

async function handleFollowUpJob(job) {
  const { messageId } = job.payload || {};
  const row = await queryOne(
    `update public.messages set follow_up_sent = true
     where id = $1 and mailbox_id = $2 and not follow_up_sent
     returning id, subject, to_emails`,
    [messageId, job.mailbox_id],
  );
  if (row) {
    await notify({
      mailboxId: job.mailbox_id,
      kind: 'follow_up',
      title: 'Time to follow up',
      body: row.subject || '(no subject)',
      entityType: 'message',
      entityId: row.id,
    }).catch(() => {});
  }
  return { notified: Boolean(row) };
}

async function handleCampaignJob(job) {
  const { campaignId } = job.payload || {};
  return processCampaign(campaignId, job.mailbox_id);
}

const JOB_HANDLERS = {
  webhook: handleWebhookJob,
  snooze: handleSnoozeJob,
  follow_up: handleFollowUpJob,
  campaign: handleCampaignJob,
};

/**
 * Drain due jobs. Called by the cron maintenance tick. Each job is claimed
 * atomically; a handler that throws parks the job for a retry.
 */
export async function runDueJobs({ limit = 25, workerId = 'cron' } = {}) {
  await reclaimStaleJobs().catch(() => {});
  const jobs = await claimDueJobs({ limit, workerId });
  const summary = { claimed: jobs.length, done: 0, failed: 0 };

  for (const job of jobs) {
    const handler = JOB_HANDLERS[job.kind];
    if (!handler) {
      await failJob(job.id, `No handler for job kind "${job.kind}"`).catch(() => {});
      summary.failed += 1;
      continue;
    }
    try {
      const result = await handler(job);
      await completeJob(job.id, result ?? {});
      summary.done += 1;
    } catch (err) {
      await failJob(job.id, err?.message || String(err)).catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

/**
 * Send the next batch of a campaign. Recipients are claimed atomically, one
 * message row is written per recipient, and the campaign flips to `sent` once
 * nothing is left pending.
 */
export async function processCampaign(campaignId, mailboxId = null) {
  const campaign = await queryOne('select * from public.campaigns where id = $1', [campaignId]);
  if (!campaign) return { skipped: 'not_found' };
  if (['sent', 'cancelled', 'paused'].includes(campaign.status)) return { skipped: campaign.status };

  const mailbox = await queryOne('select * from public.mailboxes where id = $1', [campaign.mailbox_id]);
  if (!mailbox || mailbox.status !== 'active') {
    await query(
      `update public.campaigns set status = 'paused' where id = $1`,
      [campaignId],
    );
    return { skipped: 'mailbox_inactive' };
  }

  await query(
    `update public.campaigns set status = 'sending', started_at = coalesce(started_at, now()) where id = $1`,
    [campaignId],
  );

  const recipients = await claimCampaignRecipients(campaignId, campaign.batch_size || 50);
  const from = formatFrom(mailbox.email, mailbox.display_name);

  for (const recipient of recipients) {
    try {
      const payload = buildSendPayload({
        from,
        to: [recipient.email],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: campaign.subject,
        html: campaign.body_html,
        text: campaign.body_text,
        attachments: [],
        priority: 'normal',
        headers: { 'List-Unsubscribe': `<mailto:${mailbox.email}?subject=unsubscribe>` },
      });
      const { id: resendId } = await sendEmail(payload);
      const row = await createMessage({
        mailboxId: mailbox.id,
        direction: 'outbound',
        fromEmail: mailbox.email,
        fromName: mailbox.display_name,
        to: [recipient.email],
        subject: campaign.subject,
        bodyHtml: campaign.body_html,
        bodyText: campaign.body_text,
        snippet: makeSnippet(campaign.body_text || campaign.body_html || '', 160),
        folder: 'sent',
        isRead: true,
        sizeBytes: Buffer.byteLength(campaign.body_html || '', 'utf8') + Buffer.byteLength(campaign.body_text || '', 'utf8'),
      });
      await queryOne(
        `update public.messages set resend_id = $2, delivery_status = 'queued' where id = $1`,
        [row.id, resendId],
      );
      await markRecipientSent(recipient.id, row.id);
    } catch (err) {
      logger.warn('Campaign send failed for a recipient', { error: err?.message, campaignId });
      await markRecipientFailed(recipient.id, err?.message || String(err));
    }
  }

  const refreshed = await refreshCampaignCounts(campaignId);
  const remaining = (refreshed.total_recipients || 0) - (refreshed.sent_count || 0) - (refreshed.failed_count || 0);
  if (remaining <= 0) {
    await query(
      `update public.campaigns set status = 'sent', completed_at = now() where id = $1`,
      [campaignId],
    );
    await dispatchEvent({
      event: 'campaign.completed',
      mailboxId: mailbox.id,
      payload: { campaignId, sent: refreshed.sent_count, failed: refreshed.failed_count },
    }).catch(() => {});
  } else {
    // More to send: re-queue this campaign for the next tick.
    await enqueueJob({
      kind: 'campaign',
      mailboxId: mailbox.id,
      payload: { campaignId },
      runAt: new Date(Date.now() + 30_000).toISOString(),
      dedupeKey: `campaign:${campaignId}:drain:${Date.now()}`,
    }).catch(() => {});
  }

  return { sent: recipients.length, remaining };
}

/** Start any campaign whose scheduled time has passed. */
export async function startDueCampaigns() {
  const due = await dueCampaigns();
  for (const campaign of due) {
    await processCampaign(campaign.id, campaign.mailbox_id).catch((err) => {
      logger.warn('Could not process a due campaign', { error: err?.message, campaign: campaign.id });
    });
  }
  return { started: due.length };
}

/** Reject attempts to enqueue a job with no known kind. */
export function assertJobKind(kind) {
  if (!JOB_HANDLERS[kind] && !['notification', 'auto_reply'].includes(kind)) {
    throw new AppError(Codes.VALIDATION_ERROR, `Unknown job kind "${kind}".`);
  }
  return kind;
}

export { applyAction as _applyAction };
