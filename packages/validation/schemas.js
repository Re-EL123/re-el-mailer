/**
 * Request validation schemas (Zod).
 *
 * Every endpoint body goes through one of these before it reaches business
 * logic. Keeping them together makes the API surface auditable in one file and
 * guarantees the same rules are applied in every code path.
 */

import { z } from 'zod';

// ─── Primitives ──────────────────────────────────────────────────────────────

/** RFC 5322 address, validated (never "repaired"). */
export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Enter an email address.')
  .max(320, 'That email address is too long.')
  .regex(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/,
    'Enter a valid email address.',
  );

/** A comma/newline separated address list, as typed into a compose field. */
export const emailListSchema = z
  .string()
  .trim()
  .max(8000)
  .transform((value) =>
    value
      .split(/[,;\n]/)
      .map((entry) => entry.trim().replace(/^<|>$/g, '').trim())
      .filter(Boolean),
  )
  .pipe(z.array(emailSchema).max(200, 'That is too many recipients.'));

/** Password as typed: never trimmed, never normalised. */
export const passwordSchema = z
  .string()
  .min(1, 'Enter your password.')
  .max(72, 'Use 72 characters or fewer.')
  .refine((value) => value.trim().length === value.length, 'Passwords cannot start or end with a space.');

export const newPasswordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(72, 'Use 72 characters or fewer.');

export const identifierSchema = z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier.');

export const idSchema = z.string().trim().min(1).max(64);

export const roleSchema = z.enum(['admin', 'manager', 'user']);
export const userStatusSchema = z.enum(['active', 'disabled', 'pending']);
export const mailboxStatusSchema = z.enum(['active', 'disabled', 'read_only', 'pending']);
export const folderSchema = z.enum(['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam']);
export const prioritySchema = z.enum(['low', 'normal', 'high']);

export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a hex colour such as #21396A.');

export const domainNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, 'Enter a valid domain name.');

/** HTML fragment: length-bounded, control characters removed downstream. */
export const htmlSchema = z.string().max(400_000, 'That message body is too long.');
export const textSchema = z.string().max(200_000, 'That message body is too long.');

// ─── Attachments ─────────────────────────────────────────────────────────────

export const attachmentSchema = z.object({
  /** base64 payload (from JSON uploads) */
  data: z.string().max(30_000_000).optional(),
  /** storage path of an already-uploaded object (from multipart uploads) */
  storagePath: z.string().max(512).optional(),
  filename: z.string().trim().min(1, 'A file name is required.').max(255),
  mimeType: z.string().trim().max(150).default('application/octet-stream'),
  contentId: z.string().trim().max(255).nullish(),
  inline: z.boolean().default(false),
});

export const attachmentsSchema = z.array(attachmentSchema).max(10, 'Up to 10 attachments per message.');

// ─── Auth ────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  mailboxId: idSchema.nullish(),
  remember: z.boolean().optional().default(true),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: newPasswordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: newPasswordSchema,
  revokeOtherSessions: z.boolean().optional().default(true),
});

export const updatePreferencesSchema = z.object({
  preferences: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      density: z.enum(['comfortable', 'compact']).optional(),
      pageSize: z.number().int().min(10).max(100).optional(),
      language: z.string().max(10).optional(),
      notifications: z.boolean().optional(),
      search: z.enum(['list', 'conversation']).optional(),
      signatureHtml: htmlSchema.optional(),
      signatureText: textSchema.optional(),
    })
    .strict(),
});

// ─── Mail ────────────────────────────────────────────────────────────────────

export const sendSchema = z.object({
  to: emailListSchema,
  cc: emailListSchema.optional().default([]),
  bcc: emailListSchema.optional().default([]),
  replyTo: emailListSchema.optional().default([]),
  subject: z.string().trim().max(200, 'That subject is too long.'),
  html: htmlSchema.optional(),
  text: textSchema.optional(),
  attachments: attachmentsSchema.optional().default([]),
  mailboxId: idSchema.nullish(),
  draftId: idSchema.nullish(),
  priority: prioritySchema.optional().default('normal'),
  scheduledFor: z.string().datetime({ offset: true }).nullish(),
  requestId: z.string().trim().max(100).nullish(),
  inReplyTo: z.string().trim().max(998).nullish(),
  references: z.array(z.string().trim().max(998)).max(40).optional().default([]),
  threadId: z.string().trim().max(64).nullish(),
  // Set when forwarding: the source message whose attachments should travel with
  // this send. Ownership is verified before use; it is never trusted as a path.
  attachmentMessageId: idSchema.nullish(),
});

export const saveDraftSchema = z.object({
  mailboxId: idSchema.nullish(),
  id: idSchema.nullish(),
  to: emailListSchema.optional().default([]),
  cc: emailListSchema.optional().default([]),
  bcc: emailListSchema.optional().default([]),
  subject: z.string().trim().max(200).default(''),
  html: htmlSchema.optional(),
  text: textSchema.optional(),
  attachmentIds: z.array(idSchema).max(10).optional().default([]),
  inReplyTo: z.string().trim().max(998).nullish(),
  references: z.array(z.string().trim().max(998)).max(40).optional().default([]),
  threadId: z.string().trim().max(64).nullish(),
});

export const updateMessageSchema = z.object({
  ids: z.array(idSchema).min(1).max(200),
  folder: folderSchema.optional(),
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  labelIds: z.array(idSchema).max(20).optional(),
});

export const markSchema = z.object({
  folder: folderSchema.optional().default('inbox'),
  ids: z.array(idSchema).min(1).max(200).optional(),
});

export const attachmentUploadSchema = z.object({
  mailboxId: idSchema.nullish(),
  files: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        mimeType: z.string().trim().max(150).default('application/octet-stream'),
        data: z.string().min(1, 'The file is empty.').max(30_000_000),
      }),
    )
    .min(1, 'Choose at least one file.')
    .max(10, 'Up to 10 files at a time.'),
});

export const labelSchema = z.object({
  name: z.string().trim().min(1, 'Enter a label name.').max(40),
  color: hexColorSchema.default('#21396A'),
});

export const labelUpdateSchema = labelSchema.partial().extend({
  sortOrder: z.number().int().min(0).max(999).optional(),
  // Declared so the handler's `ctx.body.id` fallback survives Zod, which
  // otherwise strips unrecognised keys.
  id: idSchema.optional(),
});

export const contactSchema = z.object({
  email: emailSchema,
  name: z.string().trim().max(120).optional(),
});

// ─── Admin ───────────────────────────────────────────────────────────────────

export const createMailboxSchema = z.object({
  email: emailSchema.optional(),
  localPart: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9._+-]*[a-z0-9])?$/, 'Use letters, numbers, dots, dashes or plus signs.'),
  domain: domainNameSchema.optional(),
  displayName: z.string().trim().min(1, 'Enter a display name.').max(120),
  password: z.string().min(8).max(72).optional(),
  userId: idSchema.nullish(),
  createUser: z.boolean().optional().default(false),
  role: roleSchema.optional().default('user'),
  quotaBytes: z.number().int().min(104_857_600).max(109_951_162_7776).optional(),
  dailySendLimit: z.number().int().min(0).max(100_000).nullish(),
  hourlySendLimit: z.number().int().min(0).max(10_000).nullish(),
  isPrimary: z.boolean().optional().default(true),
  status: mailboxStatusSchema.optional().default('active'),
  mustChangePassword: z.boolean().optional().default(true),
});

export const updateMailboxSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  status: mailboxStatusSchema.optional(),
  quotaBytes: z.number().int().min(0).max(109_951_162_7776).optional(),
  dailySendLimit: z.number().int().min(0).max(100_000).nullish(),
  hourlySendLimit: z.number().int().min(0).max(10_000).nullish(),
  isPrimary: z.boolean().optional(),
  autoRead: z.boolean().optional(),
  signatureHtml: htmlSchema.nullish(),
  signatureText: textSchema.nullish(),
  replyTo: emailSchema.nullish(),
  domainId: idSchema.optional(),
});

export const createUserSchema = z.object({
  email: emailSchema,
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(72).optional(),
  role: roleSchema.optional().default('user'),
  status: userStatusSchema.optional().default('active'),
  mustChangePassword: z.boolean().optional().default(true),
});

export const updateUserSchema = z.object({
  // The handler reads the id from the query string or the body; declare it here
  // too, or Zod strips it and the fallback path can never work.
  id: idSchema.optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
  role: roleSchema.optional(),
  status: userStatusSchema.optional(),
  password: z.string().min(8).max(72).optional(),
  unlock: z.boolean().optional(),
});

export const resetPasswordAdminSchema = z.object({
  password: z.string().min(8).max(72).optional(),
  mustChangePassword: z.boolean().optional().default(true),
});

export const domainSchema = z.object({
  name: domainNameSchema,
  status: z.enum(['pending', 'active', 'suspended']).optional().default('pending'),
  notes: z.string().trim().max(2000).nullish(),
});

export const dnsRecordSchema = z.object({
  type: z.enum(['MX', 'TXT', 'CNAME', 'A', 'AAAA', 'CAA']),
  name: z.string().trim().max(255),
  value: z.string().trim().max(2048),
  priority: z.number().int().min(0).max(65535).nullish(),
  ttl: z.number().int().min(60).max(604_800).optional().default(3600),
  purpose: z.string().trim().max(120).nullish(),
  published: z.boolean().optional().default(false),
});

export const routeSchema = z.object({
  pattern: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9*+._-]+$/, 'Use a local-part pattern such as support or sales+*.'),
  mailboxId: idSchema.nullish(),
  action: z.enum(['deliver', 'reject', 'bounce', 'discard']).optional().default('deliver'),
  priority: z.number().int().min(0).max(1000).optional().default(100),
  note: z.string().trim().max(500).nullish(),
});

export const settingsUpdateSchema = z.object({
  settings: z.record(
    z.string().max(80),
    z.union([z.string().max(4000), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]),
  ),
});

export const maintenanceSchema = z.object({
  task: z.enum(['purge', 'sessions', 'rate-limits', 'audit', 'all']).optional().default('all'),
  trashDays: z.number().int().min(1).max(365).optional(),
  spamDays: z.number().int().min(1).max(365).optional(),
});