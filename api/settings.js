/**
 * /api/settings — application settings and self-service mailbox preferences.
 *
 *   app              — public, unauthenticated app/company settings (login page).
 *   list             — every setting + its definition (admin).
 *   update           — bulk update app settings (admin).
 *   mailbox          — the caller's mailboxes and their send-as settings.
 *   update-mailbox   — a caller edits their own signature / reply-to / auto-read.
 *   disconnect       — sign out every other session.
 *
 * Division of labour, so nothing overlaps confusingly:
 *   • auth.js  owns account-level preferences (theme, density, page size) and
 *     credentials, because those live on the `users` row.
 *   • admin.js owns creating and administering other people's mailboxes.
 *   • settings.js owns *this* deployment's configuration and a user's own
 *     signature/reply-to, which is the one mailbox field a non-admin may edit.
 */

import { createHandler } from '../packages/http/pipeline.js';
import { AppError, Codes } from '../packages/shared/errors.js';
import { requireAdmin, requireMailbox, requireRole } from '../packages/auth/guard.js';
import {
  getSettings,
  listSettingDefinitions,
  revokeAllSessions,
  setSetting,
} from '../packages/db/system.js';
import { listMailboxesForUser, updateMailbox } from '../packages/db/mailboxes.js';
import { settingsUpdateSchema, updateMailboxSchema } from '../packages/validation/schemas.js';

/**
 * Settings safe to expose without a session: branding and contact details only.
 * Anything operational (retention windows, limits, feature flags) is withheld.
 */
const PUBLIC_SETTING_PREFIXES = ['company.', 'branding.', 'app.'];

function publicSettings(all) {
  const out = {};
  for (const [key, value] of Object.entries(all)) {
    if (PUBLIC_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

/** Shape a mailbox's self-service fields. */
function mailboxSettings(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    signatureHtml: row.signature_html ?? '',
    signatureText: row.signature_text ?? '',
    replyTo: row.reply_to ?? null,
    autoRead: Boolean(row.auto_read),
    isPrimary: Boolean(row.is_primary),
  };
}

// Held in a named object rather than inlined into createHandler() so the action
// map can be exported, the same seam api/admin.js and api/mail.js use. The admin
// settings panel needed a testable path: `settings.list` and `settings.update`
// had no UI caller at all, so nothing could check what the console would send.
const handlerSpec = {
  name: 'settings',
  audit: {
    update: { action: 'settings.update', entityType: 'settings' },
    'update-mailbox': { action: 'settings.mailbox.update', entityType: 'mailbox' },
    disconnect: { action: 'settings.disconnect', entityType: 'session' },
  },

  actions: {
    // ── Public app settings ─────────────────────────────────────────────────
    app: {
      method: 'GET',
      auth: 'none',
      handler: async () => {
        const all = await getSettings();
        return { settings: publicSettings(all) };
      },
    },

    // ── Admin: read every setting ───────────────────────────────────────────
    list: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        requireRole(ctx.session, ['admin', 'manager']);
        const [values, definitions] = await Promise.all([getSettings(), listSettingDefinitions()]);
        return { settings: values, definitions };
      },
    },

    // ── Admin: update app settings ──────────────────────────────────────────
    update: {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      schema: settingsUpdateSchema,
      handler: async (ctx) => {
        requireAdmin(ctx.session);

        // Setting keys are fixed by the bootstrap migration; only their values
        // are editable, and each is written as jsonb.
        const keys = new Set((await listSettingDefinitions()).map((row) => row.key));
        const rejected = Object.keys(ctx.body.settings).filter((key) => !keys.has(key));
        if (rejected.length) {
          throw new AppError(Codes.VALIDATION_ERROR, 'Unknown setting key.', 400, { details: { keys: rejected } });
        }

        const updated = {};
        for (const [key, value] of Object.entries(ctx.body.settings)) {
          if (value === null) {
            await setSetting(key, null, ctx.session.user.id);
            updated[key] = null;
          } else {
            const row = await setSetting(key, value, ctx.session.user.id);
            updated[key] = row.value;
          }
        }

        ctx.auditEntity = { type: 'settings', id: null };
        ctx.auditData = { keys: Object.keys(updated) };
        return { settings: updated };
      },
    },

    // ── The caller's own mailboxes and their settings ───────────────────────
    mailbox: {
      method: 'GET',
      auth: 'session',
      handler: async (ctx) => {
        const rows = await listMailboxesForUser(ctx.session.user.id, { includeDisabled: true });
        return { mailboxes: rows.map(mailboxSettings) };
      },
    },

    // ── A caller edits their own signature / reply-to / auto-read ────────────
    'update-mailbox': {
      method: 'PUT',
      body: 'json',
      auth: 'session',
      // Only the fields a mailbox owner may change are accepted; status, quota
      // and role changes stay behind admin.js.
      schema: updateMailboxSchema
        .pick({ signatureHtml: true, signatureText: true, replyTo: true, autoRead: true })
        .strict(),
      handler: async (ctx) => {
        const mailbox = await requireMailbox(ctx.session, ctx.query.mailboxId || null);

        const updated = await updateMailbox(mailbox.id, {
          signatureHtml: ctx.body.signatureHtml ?? null,
          signatureText: ctx.body.signatureText ?? null,
          replyTo: ctx.body.replyTo ?? null,
          autoRead: ctx.body.autoRead ?? mailbox.auto_read,
        });

        ctx.auditEntity = { type: 'mailbox', id: mailbox.id };
        return { mailbox: mailboxSettings(updated) };
      },
    },

    // ── Sign out every other session ────────────────────────────────────────
    disconnect: {
      method: 'POST',
      auth: 'session',
      handler: async (ctx) => {
        // Revoke every session except the one making this request, so the
        // caller stays signed in here and nowhere else.
        const { rowCount } = await revokeAllSessions(ctx.session.user.id, 'user_disconnect', ctx.session.sessionId);
        ctx.auditEntity = { type: 'session', id: ctx.session.sessionId };
        ctx.auditData = { revoked: rowCount };
        return { revoked: rowCount };
      },
    },
  },
};

export const actions = handlerSpec.actions;

export default createHandler(handlerSpec);
