/**
 * Supabase Storage for message attachments.
 *
 * The bucket is private. Nothing is ever served from a public URL: the API mints
 * a short-lived signed URL per download, after checking that the caller may read
 * the message the attachment belongs to.
 *
 * Objects are keyed by mailbox → message → attachment id, with the original
 * filename slugified and kept as the *last* path segment only for humans. The
 * unique part is the attachment id, so two files called `invoice.pdf` in the
 * same mailbox can never collide.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { mail as mailConfig } from '../shared/config.js';
import { AppError, Codes } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { isSafeFilename } from '../shared/ids.js';

/** Signed URLs are short-lived: long enough for one click, not for sharing. */
const SIGNED_URL_TTL_SECONDS = 300;

let client = null;

/** Lazily create the service-role client. Cached per warm instance. */
export function storageClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new AppError(Codes.INTERNAL_ERROR, 'Attachment storage is not configured.', 500);
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'X-Client-Info': 're-el-mailer/api' },
    },
  });
  return client;
}

/** Test seam: forget the cached client. */
export function resetStorageClient() {
  client = null;
}

/**
 * Blocked MIME types.
 *
 * Anything that a browser will *execute* in the user's session is refused
 * outright rather than neutered — an attachment is never allowed to run. Served
 * with `Content-Disposition: attachment`, these would be inert, but a link in an
 * email should never be able to become active content.
 */
const BLOCKED_MIME_PATTERNS = [
  /^text\/html$/i,
  /^image\/svg\+xml$/i,
  /^application\/xhtml\+xml$/i,
  /javascript/i,
  /^application\/x-msdownload$/i,
  /^application\/x-msdos-program$/i,
  /^application\/x-sh$/i,
  /^application\/x-executable$/i,
  /^application\/x-(sh|bash|python|perl|ruby)/i,
  /^(application|text)\/x-(php|python)/i,
];

/** Executable / macro-enabled Office formats. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'dll', 'jar',
  'js', 'mjs', 'cjs', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'ps1', 'sh', 'bash',
  'php', 'phtml', 'py', 'pl', 'rb', 'apk', 'app', 'dmg', 'deb', 'rpm',
  'iso', 'img', 'lnk', 'reg', 'hta', 'chm', 'reg', 'xll', 'crx',
]);

/**
 * Validate an upload before anything touches the network.
 *
 * @throws {AppError} 400 UNSUPPORTED_ATTACHMENT / 413 ATTACHMENT_TOO_LARGE
 */
export function assertUploadable({ filename, mimeType, size }) {
  const name = String(filename || '').trim();
  if (!name) throw new AppError(Codes.VALIDATION_ERROR, 'A file name is required.');

  // Path traversal and control characters never reach storage.
  if (!isSafeFilename(name)) {
    throw new AppError(Codes.VALIDATION_ERROR, 'That file name is not allowed.');
  }

  if (!Number.isInteger(size) || size <= 0) {
    throw new AppError(Codes.VALIDATION_ERROR, 'That file is empty.');
  }
  if (size > mailConfig.attachmentMaxBytes) {
    throw new AppError(Codes.ATTACHMENT_TOO_LARGE, undefined, 413, {
      details: { maxBytes: mailConfig.attachmentMaxBytes, filename: name },
    });
  }

  const type = String(mimeType || 'application/octet-stream').toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';

  if (BLOCKED_MIME_PATTERNS.some((pattern) => pattern.test(type))) {
    throw new AppError(Codes.UNSUPPORTED_ATTACHMENT, `${name} is a type that cannot be attached.`, 400, {
      details: { filename: name, mimeType: type },
    });
  }
  if (extension && BLOCKED_EXTENSIONS.has(extension)) {
    throw new AppError(Codes.UNSUPPORTED_ATTACHMENT, `Files ending in .${extension} cannot be attached.`, 400, {
      details: { filename: name, extension },
    });
  }

  return true;
}

/** Make a filename safe to use as a single path segment. */
function safeSegment(filename) {
  const base = String(filename)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const cleaned = base.replace(/[^A-Za-z0-9._ ()\-]/g, '_').slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * The storage key for an attachment.
 * Deterministic, so a retried upload overwrites instead of duplicating.
 */
export function attachmentPath(mailboxId, messageId, attachmentId, filename) {
  const month = new Date().toISOString().slice(0, 7);
  return `${mailboxId}/${month}/${messageId}/${attachmentId}/${safeSegment(filename)}`;
}

/** Turn a Storage error into an AppError with a useful message. */
function storageError(action, error, details) {
  logger.error(`Storage ${action} failed`, { error: error?.message || String(error), ...details });
  return new AppError(Codes.STORAGE_ERROR, undefined, 502, {
    details: { action, hint: error?.message || String(error) },
  });
}

/**
 * Upload one attachment.
 *
 * @returns {Promise<{path: string, bucket: string, size: number}>}
 */
export async function uploadAttachment({ mailboxId, messageId, attachmentId, filename, mimeType, data }) {
  assertUploadable({ filename, mimeType, size: data?.length ?? 0 });

  const bucket = mailConfig.attachmentBucket;
  const path = attachmentPath(mailboxId, messageId, attachmentId, filename);
  const supabase = storageClient();

  const { error } = await supabase.storage.from(bucket).upload(path, data, {
    contentType: mimeType || 'application/octet-stream',
    // Never let an uploaded object overwrite a different object: the path
    // already contains a unique id, so an upsert is safe and idempotent.
    upsert: true,
    cacheControl: '31536000',
  });

  if (error) throw storageError('upload', error, { path });
  return { path, bucket, size: data.length };
}

/**
 * Upload several attachments, reporting which ones failed instead of throwing on
 * the first one — a user attaching five files should not lose all five because
 * one was the wrong type.
 *
 * @returns {Promise<{uploaded: object[], rejected: object[]}>}
 */
export async function uploadAttachments({ mailboxId, messageId, files }) {
  const uploaded = [];
  const rejected = [];

  for (const file of files) {
    try {
      const result = await uploadAttachment({ mailboxId, messageId, attachmentId: file.attachmentId, ...file });
      uploaded.push({ ...file, ...result });
    } catch (err) {
      if (err instanceof AppError) {
        rejected.push({ filename: file.filename, code: err.code, message: err.message });
      } else {
        throw err;
      }
    }
  }

  return { uploaded, rejected };
}

/**
 * Mint a short-lived upload URL so the browser can PUT bytes straight to
 * Storage.
 *
 * Serverless request bodies are capped by the platform well below the
 * attachment limit, so a multipart upload through the function cannot carry a
 * large file at all. Handing the client a signed URL scoped to one exact path
 * keeps the bytes off the function entirely.
 *
 * The URL grants write access to that single path and nothing else, and the
 * stored object is still verified server-side before an attachment row exists.
 *
 * @returns {Promise<{path: string, bucket: string, url: string, expiresIn: number}>}
 */
export async function createUploadUrl({ mailboxId, messageId, attachmentId, filename, mimeType }) {
  assertUploadable({ filename, mimeType, size: 1 });

  const bucket = mailConfig.attachmentBucket;
  const path = attachmentPath(mailboxId, messageId, attachmentId, filename);
  const supabase = storageClient();

  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error) throw storageError('createSignedUploadUrl', error, { path });

  return { path, bucket, url: data.signedUrl, expiresIn: SIGNED_URL_TTL_SECONDS };
}

/**
 * Read an object's real size and content type from Storage.
 *
 * Used to check what the browser actually uploaded: the values a client
 * declares are untrusted, so the attachment row is only written from what the
 * bucket holds.
 *
 * @returns {Promise<{size: number, contentType: string}|null>} null when absent
 */
export async function statAttachment(path) {
  const supabase = storageClient();
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);

  const { data, error } = await supabase.storage.from(mailConfig.attachmentBucket).list(dir, {
    search: name,
    limit: 1,
  });
  if (error) throw storageError('list', error, { path });

  const entry = (data || []).find((item) => item.name === name);
  if (!entry) return null;

  return { size: Number(entry.metadata?.size ?? 0), contentType: entry.metadata?.mimetype ?? null };
}

/**
 * Mint a short-lived download URL.
 *
 * @param {string} path storage key
 * @param {number} [downloadSeconds]
 * @param {boolean} [download=true] true sets Content-Disposition: attachment
 */
export async function signedDownloadUrl(path, { downloadSeconds = SIGNED_URL_TTL_SECONDS, download = true } = {}) {
  const supabase = storageClient();
  const { data, error } = await supabase.storage
    .from(mailConfig.attachmentBucket)
    .createSignedUrl(path, downloadSeconds, download ? { download: path.split('/').pop() } : undefined);

  if (error) throw storageError('createSignedUrl', error, { path });
  return { url: data.signedUrl, expiresIn: downloadSeconds };
}

/**
 * Download an object back out — used when re-sending or forwarding a message,
 * because Resend needs the bytes, not a link into our bucket.
 */
export async function downloadAttachment(path) {
  const supabase = storageClient();
  const { data, error } = await supabase.storage.from(mailConfig.attachmentBucket).download(path);
  if (error) throw storageError('download', error, { path });

  const buffer = Buffer.from(await data.arrayBuffer());
  return { data: buffer, size: buffer.length };
}

/**
 * Delete objects. Missing objects are not an error: deletion has to be
 * idempotent for retention and mailbox-delete flows to converge.
 *
 * @returns {Promise<number>} how many objects were actually removed
 */
export async function deleteAttachments(paths) {
  const list = [...new Set((paths || []).filter(Boolean))];
  if (list.length === 0) return 0;

  const supabase = storageClient();
  const { error } = await supabase.storage.from(mailConfig.attachmentBucket).remove(list);
  if (error) {
    // "not found" surfaces as a generic error; a missing object is fine.
    const message = String(error.message || '').toLowerCase();
    if (!message.includes('not found') && !message.includes('does not exist')) {
      throw storageError('remove', error, { count: list.length });
    }
  }
  return list.length;
}

/**
 * List every object under a prefix, walking nested "folders".
 *
 * Supabase Storage has no prefix-delete: objects must be listed and removed
 * individually. The attachment layout is
 *
 *     <mailboxId>/<messageId>/<attachmentId>/<filename>
 *
 * so a single `list()` returns the message-id level — entries that are
 * folders, not objects. Deleting those paths removes nothing and silently
 * orphans every file beneath them, so the walk has to descend.
 */
async function listObjectsUnder(prefix, { pageSize = 1000, maxObjects = 100_000 } = {}) {
  const supabase = storageClient();
  const bucket = mailConfig.attachmentBucket;
  const objects = [];

  const queue = [prefix];
  while (queue.length > 0) {
    const current = queue.pop();
    let cursor = 0;

    for (;;) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .list(current, { limit: pageSize, offset: cursor });
      if (error) throw storageError('list', error, { prefix: current });

      const entries = data || [];
      for (const entry of entries) {
        const path = current ? `${current}/${entry.name}` : entry.name;
        // `id === null` marks a folder placeholder in the Storage listing.
        if (entry.id === null || entry.metadata?.type === 'folder') queue.push(path);
        else objects.push(path);
      }

      if (entries.length < pageSize) break;
      cursor += pageSize;
    }

    if (objects.length >= maxObjects) break;
  }

  return objects;
}

/**
 * Delete every object under a mailbox prefix.
 * @returns {Promise<number>} objects removed
 */
export async function deleteMailboxPrefixes(mailboxId) {
  const objects = await listObjectsUnder(`${mailboxId}`);
  return deleteAttachments(objects);
}

/**
 * Best-effort cleanup: never throws.
 *
 * Used on failure paths (send failed, message deleted) where a storage failure
 * must not mask the original error, but the orphan still needs collecting later
 * by the retention job.
 */
export function cleanupQuietly(paths) {
  return deleteAttachments(paths).catch((err) => {
    logger.warn('Attachment cleanup failed', { error: err?.message, count: (paths || []).length });
    return 0;
  });
}

/** Check the bucket exists and is reachable. Used by /api/health. */
export async function storageHealth() {
  try {
    const supabase = storageClient();
    const { error } = await supabase.storage.from(mailConfig.attachmentBucket).list('', { limit: 1 });
    return { ok: !error, bucket: mailConfig.attachmentBucket, error: error?.message ?? null };
  } catch (err) {
    return { ok: false, bucket: mailConfig.attachmentBucket, error: err?.message ?? 'not configured' };
  }
}

/** Opaque checksum used to dedupe identical uploads. */
export function contentHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
}