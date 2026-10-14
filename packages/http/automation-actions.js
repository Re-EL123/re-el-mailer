/**
 * Automation API actions.
 *
 * Grouped here rather than inlined into api/mail.js so the large reader/compose
 * surface and the automation surface stay readable, and so the mailbox-scoped
 * guards are applied the same way to every new endpoint. api/mail.js spreads
 * `mailboxAutomationActions` into its action map; api/send.js spreads
 * `campaignActions`.
 */

import { queryBool, queryInt } from './pipeline.js';
import { query, queryOne, queryAll } from '../db/pool.js';
import { AppError, Codes } from '../shared/errors.js';
import { requireMailbox, isManager, assertEntitlement } from '../auth/guard.js';
import { randomToken } from '../shared/ids.js';
import { htmlToText } from '../shared/sanitize.js';
import { logger } from '../shared/logger.js';
import { entitlement } from '../billing/plans.js';
import { countRules, countWebhooks } from '../db/workspaces.js';
import { planForMailbox } from './workspace-views.js';
import {
  addCampaignRecipients,
  createCampaign,
  createNote,
  createRule,
  createTemplate,
  createWebhookEndpoint,
  deleteCampaign,
  deleteNote,
  deleteRule,
  deleteTemplate,
  deleteWebhookEndpoint,
  getCampaign,
  getRule,
  getTemplate,
  getWebhookEndpoint,
  listCampaignRecipients,
  listCampaigns,
  listNotes,
  listNotifications,
  listRuleRuns,
  listRules,
  listTemplates,
  listWebhookDeliveries,
  listWebhookEndpoints,
  markAllNotificationsRead,
  markNotificationRead,
  countUnreadNotifications,
  refreshCampaignCounts,
  updateCampaign,
  updateRule,
  updateTemplate,
  updateWebhookEndpoint,
} from '../db/automation.js';
import { findOwned } from '../db/messages.js';
import { listUsers } from '../db/users.js';
import { runDueJobs } from '../mail/automation.js';
import {
  assignSchema,
  autoReplySchema,
  campaignRecipientsSchema,
  campaignSchema,
  campaignUpdateSchema,
  followUpSchema,
  noteSchema,
  ruleSchema,
  ruleUpdateSchema,
  snoozeSchema,
  templateSchema,
  templateUpdateSchema,
  webhookEndpointSchema,
  webhookEndpointUpdateSchema,
} from '../validation/schemas.js';

/** Resolve the mailbox an action targets, applying the same guard everywhere. */
async function mailboxFor(ctx) {
  return requireMailbox(ctx.session, ctx.query.mailboxId || ctx.body?.mailboxId || null);
}

function ruleView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: Boolean(row.is_active),
    conditions: row.conditions,
    actions: row.actions,
    direction: row.direction,
    stopProcessing: Boolean(row.stop_processing),
    runOrder: Number(row.run_order ?? 100),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templateView(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteView(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    authorId: row.author_id,
    authorEmail: row.author_email,
    body: row.body,
    createdAt: row.created_at,
  };
}

function webhookView(row) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    url: row.url,
    description: row.description,
    events: row.events ?? [],
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assigneeView(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? null,
    role: row.role,
  };
}

export function campaignView(row) {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    name: row.name,
    subject: row.subject,
    bodyHtml: row.body_html,
    bodyText: row.body_text,
    status: row.status,
    scheduledFor: row.scheduled_for,
    batchSize: Number(row.batch_size ?? 50),
    totalRecipients: Number(row.total_recipients ?? 0),
    sentCount: Number(row.sent_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ─── Mailbox-scoped actions ──────────────────────────────────────────────────

export const mailboxAutomationActions = {
  // ── Canned responses ────────────────────────────────────────────────────
  templates: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      return { templates: (await listTemplates(mailbox.id)).map(templateView) };
    },
  },

  template: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await getTemplate(String(ctx.query.id || ''), mailbox.id);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Template not found.');
      return { template: templateView(row) };
    },
  },

  'create-template': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: templateSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await createTemplate({
        mailboxId: mailbox.id,
        name: ctx.body.name,
        subject: ctx.body.subject ?? null,
        bodyHtml: ctx.body.bodyHtml ?? null,
        bodyText: ctx.body.bodyText ?? null,
        sortOrder: ctx.body.sortOrder ?? 0,
        createdBy: ctx.session.user.id,
      });
      return { template: templateView(row) };
    },
  },

  'update-template': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: templateUpdateSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await updateTemplate(ctx.body.id, mailbox.id, ctx.body);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Template not found.');
      return { template: templateView(row) };
    },
  },

  'delete-template': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A template id is required.');
      await deleteTemplate(id, mailbox.id);
      return { deleted: true };
    },
  },

  // ── Internal notes ──────────────────────────────────────────────────────
  notes: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const messageId = String(ctx.query.messageId || '').trim();
      if (!messageId) throw new AppError(Codes.VALIDATION_ERROR, 'A message id is required.');
      if (!(await findOwned(messageId, mailbox.id))) {
        throw new AppError(Codes.NOT_FOUND, 'Message not found.');
      }
      return { notes: (await listNotes(messageId, mailbox.id)).map(noteView) };
    },
  },

  'create-note': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: noteSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const messageId = String(ctx.body.messageId || '').trim();
      if (!messageId) throw new AppError(Codes.VALIDATION_ERROR, 'A message id is required.');
      if (!(await findOwned(messageId, mailbox.id))) {
        throw new AppError(Codes.NOT_FOUND, 'Message not found.');
      }
      const row = await createNote({
        messageId,
        mailboxId: mailbox.id,
        authorId: ctx.session.user.id,
        authorEmail: ctx.session.user.email,
        body: ctx.body.body,
      });
      return { note: noteView(row) };
    },
  },

  'delete-note': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A note id is required.');
      await deleteNote(id, mailbox.id);
      return { deleted: true };
    },
  },

  // ── Assignment, snooze, follow-up ───────────────────────────────────────
  'assignable-users': {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      // A mailbox is owned by one user, so "the team" only exists for managers
      // and admins. A regular owner can only assign to themselves, and seeing
      // the whole directory would leak who else has an account, so it is
      // narrowed to the caller rather than refused.
      if (!isManager(ctx.session.user)) {
        return { users: [assigneeView(ctx.session.user)] };
      }
      await mailboxFor(ctx);
      const users = await listUsers({ status: 'active', limit: 200 });
      return { users: users.map(assigneeView) };
    },
  },

  assign: {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: assignSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const userId = ctx.body.userId ?? null;
      let updated = 0;
      for (const id of ctx.body.ids) {
        if (!(await findOwned(id, mailbox.id))) continue;
        await query(
          `update public.messages
           set assigned_to = $3, assigned_at = case when $3 is null then null else now() end
           where id = $1 and mailbox_id = $2`,
          [id, mailbox.id, userId],
        );
        updated += 1;
      }
      // Notify the assignee once, not once per message.
      if (userId && updated > 0) {
        await query(
          `insert into public.notifications (id, user_id, mailbox_id, kind, title, body, entity_type, entity_id)
           select 'ntf_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, 'assignment',
                  'Messages were assigned to you', $3, 'mailbox', $2`,
          [userId, mailbox.id, `${updated} message(s)`],
        ).catch(() => {});
      }
      return { assigned: updated, userId };
    },
  },

  snooze: {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: snoozeSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      let until = ctx.body.until ? new Date(ctx.body.until) : null;
      if (!until) {
        const minutes = Number(ctx.body.minutes) || 60;
        until = new Date(Date.now() + minutes * 60_000);
      }
      if (until.getTime() <= Date.now()) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Pick a time in the future.');
      }
      const iso = until.toISOString();
      let updated = 0;
      for (const id of ctx.body.ids) {
        if (!(await findOwned(id, mailbox.id))) continue;
        await query(
          `update public.messages set snoozed_until = $3 where id = $1 and mailbox_id = $2`,
          [id, mailbox.id, iso],
        );
        await query(
          `insert into public.jobs (id, kind, mailbox_id, payload, run_at, dedupe_key)
           values ('job_' || replace(gen_random_uuid()::text, '-', ''), 'snooze', $1, $2::jsonb, $3, $4)
           on conflict (dedupe_key) where dedupe_key is not null do nothing`,
          [mailbox.id, JSON.stringify({ messageId: id }), iso, `snooze:${id}`],
        ).catch(() => {});
        updated += 1;
      }
      return { snoozed: updated, until: iso };
    },
  },

  unsnooze: {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: assignSchema.pick({ ids: true }),
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      let updated = 0;
      for (const id of ctx.body.ids) {
        const row = await queryOne(
          `update public.messages set snoozed_until = null
           where id = $1 and mailbox_id = $2 returning id`,
          [id, mailbox.id],
        );
        if (row) updated += 1;
        await query('delete from public.jobs where dedupe_key = $1', [`snooze:${id}`]).catch(() => {});
      }
      return { unsnoozed: updated };
    },
  },

  snoozed: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const rows = await queryAll(
        `select id, subject, from_email, from_name, snoozed_until
         from public.messages
         where mailbox_id = $1 and snoozed_until is not null
         order by snoozed_until asc limit 100`,
        [mailbox.id],
      );
      return { messages: rows };
    },
  },

  'follow-up': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: followUpSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      let at = ctx.body.at ? new Date(ctx.body.at) : null;
      if (!at) at = new Date(Date.now() + (Number(ctx.body.days) || 3) * 86_400_000);
      const iso = at.toISOString();
      let updated = 0;
      for (const id of ctx.body.ids) {
        if (!(await findOwned(id, mailbox.id))) continue;
        await query(
          `update public.messages set follow_up_at = $3, follow_up_sent = false where id = $1 and mailbox_id = $2`,
          [id, mailbox.id, iso],
        );
        await query(
          `insert into public.jobs (id, kind, mailbox_id, payload, run_at, dedupe_key)
           values ('job_' || replace(gen_random_uuid()::text, '-', ''), 'follow_up', $1, $2::jsonb, $3, $4)
           on conflict (dedupe_key) where dedupe_key is not null do nothing`,
          [mailbox.id, JSON.stringify({ messageId: id }), iso, `follow_up:${id}`],
        ).catch(() => {});
        updated += 1;
      }
      return { scheduled: updated, at: iso };
    },
  },

  // ── Notifications (the signed-in user's own) ────────────────────────────
  notifications: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const rows = await listNotifications(ctx.session.user.id, {
        unreadOnly: queryBool(ctx, 'unread'),
        limit: queryInt(ctx, 'limit', { min: 1, max: 100, fallback: 50 }),
        offset: queryInt(ctx, 'offset', { min: 0, max: 100_000, fallback: 0 }),
      });
      return {
        notifications: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          body: row.body,
          entityType: row.entity_type,
          entityId: row.entity_id,
          url: row.url,
          isRead: Boolean(row.is_read),
          createdAt: row.created_at,
        })),
        unread: await countUnreadNotifications(ctx.session.user.id),
      };
    },
  },

  'notifications-read': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    handler: async (ctx) => {
      const id = String(ctx.body?.id || '').trim();
      if (id && id !== 'all') {
        await markNotificationRead(id, ctx.session.user.id);
        return { read: 1 };
      }
      const { rowCount } = await markAllNotificationsRead(ctx.session.user.id);
      return { read: rowCount };
    },
  },

  'notifications-count': {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => ({ unread: await countUnreadNotifications(ctx.session.user.id) }),
  },

  // ── Rules ───────────────────────────────────────────────────────────────
  rules: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      return { rules: (await listRules(mailbox.id)).map(ruleView) };
    },
  },

  rule: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await getRule(String(ctx.query.id || ''), mailbox.id);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Rule not found.');
      return { rule: ruleView(row) };
    },
  },

  'create-rule': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: ruleSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const gate = await planForMailbox(mailbox);
      if (gate.workspaceId) {
        assertEntitlement(
          entitlement({
            plan: gate.effective,
            used: await countRules(gate.workspaceId),
            limit: gate.effective.rules,
            key: 'rules',
          }),
        );
      }
      const row = await createRule({
        mailboxId: mailbox.id,
        name: ctx.body.name,
        description: ctx.body.description ?? null,
        conditions: ctx.body.conditions,
        actions: ctx.body.actions,
        direction: ctx.body.direction,
        stopProcessing: ctx.body.stopProcessing,
        runOrder: ctx.body.runOrder,
        createdBy: ctx.session.user.id,
      });
      return { rule: ruleView(row) };
    },
  },

  'update-rule': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: ruleUpdateSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await updateRule(ctx.body.id, mailbox.id, ctx.body);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Rule not found.');
      return { rule: ruleView(row) };
    },
  },

  'delete-rule': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A rule id is required.');
      await deleteRule(id, mailbox.id);
      return { deleted: true };
    },
  },

  'rule-runs': {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!(await getRule(id, mailbox.id))) throw new AppError(Codes.NOT_FOUND, 'Rule not found.');
      return { runs: await listRuleRuns(id, { limit: 50 }) };
    },
  },

  // ── Out-of-office auto-reply ────────────────────────────────────────────
  'auto-reply': {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      return {
        autoReply: {
          enabled: Boolean(mailbox.auto_reply_enabled),
          subject: mailbox.auto_reply_subject,
          body: mailbox.auto_reply_body,
          start: mailbox.auto_reply_start,
          end: mailbox.auto_reply_end,
          intervalMinutes: Number(mailbox.auto_reply_interval_min ?? 1440),
        },
      };
    },
  },

  'set-auto-reply': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: autoReplySchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const sets = [];
      const params = [mailbox.id];
      const map = {
        enabled: 'auto_reply_enabled',
        subject: 'auto_reply_subject',
        body: 'auto_reply_body',
        start: 'auto_reply_start',
        end: 'auto_reply_end',
        intervalMinutes: 'auto_reply_interval_min',
      };
      for (const [key, column] of Object.entries(map)) {
        if (ctx.body[key] === undefined) continue;
        params.push(ctx.body[key]);
        sets.push(`${column} = $${params.length}`);
      }
      if (sets.length === 0) throw new AppError(Codes.VALIDATION_ERROR, 'Nothing to change.');
      const row = await queryOne(
        `update public.mailboxes set ${sets.join(', ')} where id = $1 returning *`,
        params,
      );
      return {
        autoReply: {
          enabled: Boolean(row.auto_reply_enabled),
          subject: row.auto_reply_subject,
          body: row.auto_reply_body,
          start: row.auto_reply_start,
          end: row.auto_reply_end,
          intervalMinutes: Number(row.auto_reply_interval_min ?? 1440),
        },
      };
    },
  },

  // ── Outbound webhooks ───────────────────────────────────────────────────
  webhooks: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      return { webhooks: (await listWebhookEndpoints(mailbox.id)).map(webhookView) };
    },
  },

  'create-webhook': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: webhookEndpointSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const gate = await planForMailbox(mailbox);
      if (gate.workspaceId) {
        assertEntitlement(
          entitlement({
            plan: gate.effective,
            used: await countWebhooks(gate.workspaceId),
            limit: gate.effective.webhooks,
            key: 'webhooks',
          }),
        );
      }
      // The signing secret is returned once, on creation, so the operator can
      // store it. It is never echoed by the list endpoint afterwards.
      const secret = ctx.body.secret || randomToken(24);
      const row = await createWebhookEndpoint({
        mailboxId: mailbox.id,
        url: ctx.body.url,
        secret,
        description: ctx.body.description ?? null,
        events: ctx.body.events ?? [],
        createdBy: ctx.session.user.id,
      });
      return { webhook: webhookView(row), secret };
    },
  },

  'update-webhook': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: webhookEndpointUpdateSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await updateWebhookEndpoint(ctx.body.id, mailbox.id, ctx.body);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Webhook not found.');
      return { webhook: webhookView(row) };
    },
  },

  'delete-webhook': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A webhook id is required.');
      await deleteWebhookEndpoint(id, mailbox.id);
      return { deleted: true };
    },
  },

  'webhook-deliveries': {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!(await getWebhookEndpoint(id, mailbox.id))) {
        throw new AppError(Codes.NOT_FOUND, 'Webhook not found.');
      }
      return { deliveries: await listWebhookDeliveries(id, { limit: 50 }) };
    },
  },

  // ── Job queue (managers and admins) ─────────────────────────────────────
  'run-jobs': {
    method: 'POST',
    auth: 'session',
    roles: ['admin', 'manager'],
    handler: async () => runDueJobs({ limit: 50, workerId: `manual:${Date.now()}` }),
  },
};

// ─── Campaign actions (merged into api/send.js) ──────────────────────────────

export const campaignActions = {
  campaigns: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      return { campaigns: (await listCampaigns(mailbox.id)).map(campaignView) };
    },
  },

  campaign: {
    method: 'GET',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await getCampaign(String(ctx.query.id || ''), mailbox.id);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Campaign not found.');
      return {
        campaign: campaignView(row),
        recipients: await listCampaignRecipients(row.id, {
          status: ctx.query.status ? String(ctx.query.status) : null,
          limit: queryInt(ctx, 'limit', { min: 1, max: 500, fallback: 200 }),
        }),
      };
    },
  },

  'create-campaign': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: campaignSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const gate = await planForMailbox(mailbox);
      if (gate.workspaceId && !gate.effective.campaigns) {
        throw new AppError(Codes.FORBIDDEN, 'Campaigns are not included in your plan.', 402);
      }
      const row = await createCampaign({
        mailboxId: mailbox.id,
        name: ctx.body.name,
        subject: ctx.body.subject,
        bodyHtml: ctx.body.bodyHtml ?? (ctx.body.bodyText ? htmlToText(ctx.body.bodyText) : null),
        bodyText: ctx.body.bodyText ?? null,
        scheduledFor: ctx.body.scheduledFor ?? null,
        batchSize: ctx.body.batchSize ?? 50,
        createdBy: ctx.session.user.id,
      });
      if (ctx.body.recipients?.length) {
        await addCampaignRecipients(row.id, ctx.body.recipients);
      }
      const fresh = await getCampaign(row.id, mailbox.id);
      return { campaign: campaignView(fresh) };
    },
  },

  'update-campaign': {
    method: 'PUT',
    body: 'json',
    auth: 'session',
    schema: campaignUpdateSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const row = await updateCampaign(ctx.body.id, mailbox.id, ctx.body);
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Campaign not found.');
      return { campaign: campaignView(row) };
    },
  },

  'delete-campaign': {
    method: 'DELETE',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.query.id || '').trim();
      if (!id) throw new AppError(Codes.VALIDATION_ERROR, 'A campaign id is required.');
      await deleteCampaign(id, mailbox.id);
      return { deleted: true };
    },
  },

  'campaign-recipients': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    schema: campaignRecipientsSchema,
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const campaign = await getCampaign(ctx.body.id, mailbox.id);
      if (!campaign) throw new AppError(Codes.NOT_FOUND, 'Campaign not found.');
      const added = await addCampaignRecipients(campaign.id, ctx.body.recipients);
      const fresh = await refreshCampaignCounts(campaign.id);
      return { added, campaign: campaignView(fresh) };
    },
  },

  'send-campaign': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.body?.id || ctx.query.id || '').trim();
      const campaign = await getCampaign(id, mailbox.id);
      if (!campaign) throw new AppError(Codes.NOT_FOUND, 'Campaign not found.');
      if (campaign.total_recipients === 0) {
        throw new AppError(Codes.VALIDATION_ERROR, 'Add at least one recipient before sending.');
      }
      // Kick the first batch immediately; the cron tick drains the rest.
      const { processCampaign } = await import('../mail/automation.js');
      const result = await processCampaign(campaign.id, mailbox.id);
      logger.info('Campaign send started', { campaign: campaign.id, sent: result.sent });
      return { started: true, ...result };
    },
  },

  'pause-campaign': {
    method: 'POST',
    body: 'json',
    auth: 'session',
    handler: async (ctx) => {
      const mailbox = await mailboxFor(ctx);
      const id = String(ctx.body?.id || ctx.query.id || '').trim();
      const row = await updateCampaign(id, mailbox.id, { status: 'paused' });
      if (!row) throw new AppError(Codes.NOT_FOUND, 'Campaign not found.');
      return { campaign: campaignView(row) };
    },
  },
};

export default { mailboxAutomationActions, campaignActions };
