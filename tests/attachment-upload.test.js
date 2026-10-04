/**
 * Direct-to-storage attachment upload.
 *
 * Attachment bytes no longer pass through the API: the platform caps a function
 * request body well below the attachment limit, so a multipart upload could
 * never carry a large file. The client gets a signed URL scoped to one path,
 * PUTs the bytes to Storage itself, and reports back for verification.
 *
 * What matters is that nothing is trusted: the path is rebuilt server-side, the
 * stored object's real size and type decide whether an attachment row exists,
 * and an object that turns out to be unusable is deleted rather than orphaned.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  assertUploadable,
  attachmentPath,
  createUploadUrl,
  statAttachment,
} from '../packages/storage/attachments.js';
import { attachmentCompleteSchema, attachmentUploadUrlSchema } from '../packages/validation/schemas.js';

const MAILBOX = 'mbx_test';
const MESSAGE = 'msg_test';
const ATTACHMENT = 'attachment_test';

/** Stand in for the Supabase client with just the two calls these helpers make. */
function stubStorage({ uploadUrl, listing } = {}) {
  const calls = { signedUpload: [], list: [], upload: [], remove: [] };
  const client = {
    storage: {
      from: () => ({
        createSignedUploadUrl: async (path) => {
          calls.signedUpload.push(path);
          return uploadUrl === null ? { data: null, error: { message: 'nope' } } : { data: { signedUrl: `https://storage.test/upload?token=sig&path=${path}` }, error: null };
        },
        list: async (dir, options) => {
          calls.list.push({ dir, options });
          return listing === null ? { data: null, error: { message: 'denied' } } : { data: listing, error: null };
        },
        remove: async (paths) => {
          calls.remove.push(...paths);
          return { data: paths, error: null };
        },
      }),
    },
  };
  return { client, calls };
}

async function withStorage(stub) {
  vi.resetModules();
  vi.doMock('@supabase/supabase-js', () => ({ createClient: () => stub.client }));
  return import('../packages/storage/attachments.js');
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('@supabase/supabase-js');
  process.env.SUPABASE_URL ||= 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'service-role-test-key';
});

describe('attachmentPath', () => {
  it('scopes every object to its mailbox, month, message and attachment id', () => {
    const path = attachmentPath(MAILBOX, MESSAGE, ATTACHMENT, 'invoice.pdf');
    expect(path.startsWith(`${MAILBOX}/`)).toBe(true);
    expect(path).toContain(`/${MESSAGE}/`);
    expect(path).toContain(`/${ATTACHMENT}/`);
    expect(path.endsWith('invoice.pdf')).toBe(true);
  });

  it('gives two same-named files in one message distinct keys', () => {
    const a = attachmentPath(MAILBOX, MESSAGE, 'attachment_a', 'invoice.pdf');
    const b = attachmentPath(MAILBOX, MESSAGE, 'attachment_b', 'invoice.pdf');
    expect(a).not.toBe(b);
  });
});

describe('createUploadUrl', () => {
  it('signs exactly the one path the attachment will occupy', async () => {
    const stub = stubStorage();
    const mod = await withStorage(stub);

    const target = await mod.createUploadUrl({
      mailboxId: MAILBOX,
      messageId: MESSAGE,
      attachmentId: ATTACHMENT,
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
    });

    const expected = attachmentPath(MAILBOX, MESSAGE, ATTACHMENT, 'invoice.pdf');
    expect(target.path).toBe(expected);
    expect(stub.calls.signedUpload).toEqual([expected]);
    expect(target.url).toContain('token=');
  });

  it('refuses a blocked type before any URL is signed', async () => {
    const stub = stubStorage();
    const mod = await withStorage(stub);

    await expect(
      mod.createUploadUrl({
        mailboxId: MAILBOX,
        messageId: MESSAGE,
        attachmentId: ATTACHMENT,
        filename: 'payload.exe',
        mimeType: 'application/octet-stream',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ATTACHMENT' });
    expect(stub.calls.signedUpload).toEqual([]);
  });

  it('surfaces a storage failure as a 502 rather than a silent empty URL', async () => {
    const stub = stubStorage({ uploadUrl: null });
    const mod = await withStorage(stub);

    await expect(
      mod.createUploadUrl({
        mailboxId: MAILBOX,
        messageId: MESSAGE,
        attachmentId: ATTACHMENT,
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('statAttachment', () => {
  const path = attachmentPath(MAILBOX, MESSAGE, ATTACHMENT, 'invoice.pdf');

  it('reads the size and type the bucket actually holds', async () => {
    const stub = stubStorage({
      listing: [{ name: 'invoice.pdf', metadata: { size: 2048, mimetype: 'application/pdf' } }],
    });
    const mod = await withStorage(stub);

    expect(await mod.statAttachment(path)).toEqual({ size: 2048, contentType: 'application/pdf' });
  });

  it('returns null when the object was never written', async () => {
    const stub = stubStorage({ listing: [] });
    const mod = await withStorage(stub);
    expect(await mod.statAttachment(path)).toBeNull();
  });

  it('ignores a same-prefix entry that is not this object', async () => {
    const stub = stubStorage({ listing: [{ name: 'other.pdf', metadata: { size: 10 } }] });
    const mod = await withStorage(stub);
    expect(await mod.statAttachment(path)).toBeNull();
  });

  it('does not treat a missing object as a silent success', async () => {
    const stub = stubStorage({ listing: null });
    const mod = await withStorage(stub);
    await expect(mod.statAttachment(path)).rejects.toMatchObject({ status: 502 });
  });
});

describe('assertUploadable', () => {
  it('rejects a size over the configured limit', () => {
    expect(() =>
      assertUploadable({ filename: 'big.bin', mimeType: 'application/octet-stream', size: 10_485_761 }),
    ).toThrow();
  });

  it('rejects an empty file', () => {
    expect(() => assertUploadable({ filename: 'empty.txt', mimeType: 'text/plain', size: 0 })).toThrow();
  });

  it('rejects active content that a browser would execute', () => {
    expect(() => assertUploadable({ filename: 'page.html', mimeType: 'text/html', size: 10 })).toThrow();
    expect(() => assertUploadable({ filename: 'logo.svg', mimeType: 'image/svg+xml', size: 10 })).toThrow();
  });
});

describe('attachment upload schemas', () => {
  it('accepts a well-formed request', () => {
    expect(
      attachmentUploadUrlSchema.parse({ draftId: 'msg_1', filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }),
    ).toMatchObject({ draftId: 'msg_1', filename: 'a.pdf' });
  });

  it('requires a positive declared size', () => {
    expect(() =>
      attachmentUploadUrlSchema.parse({ draftId: 'msg_1', filename: 'a.pdf', size: 0 }),
    ).toThrow();
    expect(() =>
      attachmentUploadUrlSchema.parse({ draftId: 'msg_1', filename: 'a.pdf', size: 'big' }),
    ).toThrow();
  });

  it('does not let a client carry its own storage path', () => {
    // The path is rebuilt server-side, so it must not survive validation as an
    // accepted field on completion.
    const parsed = attachmentCompleteSchema.parse({
      draftId: 'msg_1',
      attachmentId: 'attachment_1',
      filename: 'a.pdf',
      path: 'somebody-elses-mailbox/evil.pdf',
    });
    expect(parsed.path).toBeUndefined();
  });

  it('requires the draft and attachment ids', () => {
    expect(() => attachmentCompleteSchema.parse({ filename: 'a.pdf' })).toThrow();
    expect(() => attachmentCompleteSchema.parse({ draftId: 'msg_1', filename: 'a.pdf' })).toThrow();
  });
});