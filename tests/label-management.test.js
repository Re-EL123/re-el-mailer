/**
 * Label management contract.
 *
 * Labels had complete server support — create, rename, recolour, delete,
 * assign — and no way to reach any of it from the app. The sidebar could list
 * labels and filter by them, but a label could only come into existence by
 * seeding the database, `update-label` had no client method at all, and nothing
 * in the reader ever called `set-labels`.
 *
 * Two smaller gaps are pinned here too, because both would have made the new UI
 * look broken rather than wrong:
 *
 *   - listLabels() returned raw rows, so `message_count` arrived snake_case
 *     while the sidebar read camelCase everywhere. It never showed up while the
 *     sidebar only read id/name/color, which is exactly the trap.
 *   - updateLabel() returns null both for "nothing to change" and "not found",
 *     so a client that sent {} would have been told the label was missing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listLabels = vi.fn();
const createLabel = vi.fn();
const updateLabel = vi.fn();
const deleteLabel = vi.fn();
const listMessageLabels = vi.fn();
const setMessageLabels = vi.fn();
const findMailboxById = vi.fn();
const findOwned = vi.fn();
const listAttachments = vi.fn();
const listThread = vi.fn();
const markMessage = vi.fn();
const rememberContacts = vi.fn();

vi.mock('../packages/db/mailboxes.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listLabels: (...a) => listLabels(...a),
    createLabel: (...a) => createLabel(...a),
    updateLabel: (...a) => updateLabel(...a),
    deleteLabel: (...a) => deleteLabel(...a),
    listMessageLabels: (...a) => listMessageLabels(...a),
    setMessageLabels: (...a) => setMessageLabels(...a),
    findMailboxById: (...a) => findMailboxById(...a),
    rememberContacts: (...a) => rememberContacts(...a),
  };
});

vi.mock('../packages/db/messages.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findOwned: (...a) => findOwned(...a),
    listAttachments: (...a) => listAttachments(...a),
    listThread: (...a) => listThread(...a),
    update: (...a) => markMessage(...a),
  };
});

const mail = await import('../api/mail.js');

/** The raw snake_case row listLabels() really returns. */
function rawLabel(over = {}) {
  return {
    id: 'label_1',
    mailbox_id: 'mbx_1',
    name: 'Work',
    color: '#21396A',
    slug: 'work',
    sort_order: 100,
    message_count: 7,
    ...over,
  };
}

function ctx(query = {}, body = {}) {
  return {
    session: { user: { id: 'usr_1', email: 'a@re-el.co.za', role: 'user', status: 'active' } },
    query,
    body,
    setHeader: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const MAILBOX = { id: 'mbx_1', user_id: 'usr_1', email: 'a@re-el.co.za', status: 'active', auto_read: false };

/** The row findOwned() really returns for an unread inbound message. */
function rawMessage(over = {}) {
  return {
    id: 'msg_1',
    mailbox_id: 'mbx_1',
    thread_id: 'thr_1',
    direction: 'inbound',
    from_email: 'bob@example.com',
    from_name: 'Bob',
    to_emails: ['a@re-el.co.za'],
    subject: 'Hello',
    snippet: 'Hi',
    folder: 'inbox',
    is_read: false,
    is_starred: false,
    is_draft: false,
    has_attachments: false,
    size_bytes: 100,
    priority: 'normal',
    delivery_status: 'unknown',
    received_at: '2026-10-02T09:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const fn of [listLabels, createLabel, updateLabel, deleteLabel, listMessageLabels, setMessageLabels,
    findMailboxById, findOwned, listAttachments, listThread, markMessage, rememberContacts]) {
    fn.mockReset();
  }
  findMailboxById.mockResolvedValue(MAILBOX);
  findOwned.mockResolvedValue(rawMessage());
  markMessage.mockImplementation(async (id) => rawMessage({ id, is_read: true }));
  listAttachments.mockResolvedValue([]);
  listThread.mockResolvedValue([]);
  listLabels.mockResolvedValue([rawLabel()]);
  createLabel.mockImplementation(async ({ name, color }) => rawLabel({ id: 'label_new', name, color, message_count: '0' }));
  updateLabel.mockImplementation(async (id, _mailboxId, patch) => rawLabel({ id, ...patch }));
  deleteLabel.mockResolvedValue(true);
  listMessageLabels.mockResolvedValue([]);
  rememberContacts.mockResolvedValue(undefined);
});

describe('label responses are shaped for the client', () => {
  it('labels are camelCased, including the count the new UI displays', async () => {
    const { labels } = await mail.actions.labels.handler(ctx({ mailboxId: MAILBOX.id }));

    expect(labels).toHaveLength(1);
    expect(labels[0]).toEqual({
      id: 'label_1',
      name: 'Work',
      color: '#21396A',
      slug: 'work',
      sortOrder: 100,
      messageCount: 7,
    });
    // A count read in snake_case would render as 0 / undefined in the UI.
    expect(labels[0].message_count).toBeUndefined();
  });

  it('a string message_count from Postgres is coerced to a number', async () => {
    listLabels.mockResolvedValue([rawLabel({ message_count: '12' })]);
    const { labels } = await mail.actions.labels.handler(ctx({ mailboxId: MAILBOX.id }));

    expect(labels[0].messageCount).toBe(12);
    expect(typeof labels[0].messageCount).toBe('number');
  });

  it('a created label comes back shaped too', async () => {
    const { label } = await mail.actions['create-label'].handler(
      ctx({ mailboxId: MAILBOX.id }, { name: 'Work', color: '#ff0000' }),
    );

    expect(label).toMatchObject({ name: 'Work', color: '#ff0000', sortOrder: 100, messageCount: 0 });
  });

  it('a renamed label comes back shaped too', async () => {
    const { label } = await mail.actions['update-label'].handler(
      ctx({ mailboxId: MAILBOX.id, id: 'label_1' }, { name: 'Office' }),
    );

    expect(label).toMatchObject({ id: 'label_1', name: 'Office' });
    expect(updateLabel).toHaveBeenCalledWith('label_1', MAILBOX.id, expect.objectContaining({ name: 'Office' }));
  });
});

describe('update-label distinguishes "nothing to change" from "not found"', () => {
  it('rejects an empty patch as a validation error, not a missing label', async () => {
    await expect(
      mail.actions['update-label'].handler(ctx({ mailboxId: MAILBOX.id, id: 'label_1' }, {})),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // The confusing path: a no-op patch must not reach the database layer.
    expect(updateLabel).not.toHaveBeenCalled();
  });

  it('reports a genuinely missing label as not found', async () => {
    updateLabel.mockResolvedValue(null);

    await expect(
      mail.actions['update-label'].handler(ctx({ mailboxId: MAILBOX.id, id: 'label_gone' }, { name: 'X' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the reader can see which labels are applied', () => {
  it('detail items carry the applied labels', async () => {
    listMessageLabels.mockResolvedValue([{ id: 'label_1', name: 'Work', color: '#21396A', slug: 'work' }]);

    const { message } = await mail.actions.get.handler(
      ctx({ mailboxId: MAILBOX.id, id: 'msg_1' }),
    );

    expect(message.labels).toEqual([
      { id: 'label_1', name: 'Work', color: '#21396A', slug: 'work' },
    ]);
  });

  it('an unlabelled message reports an empty list rather than undefined', async () => {
    listMessageLabels.mockResolvedValue([]);

    const { message } = await mail.actions.get.handler(
      ctx({ mailboxId: MAILBOX.id, id: 'msg_1' }),
    );

    expect(message.labels).toEqual([]);
  });
});

describe('the client exposes every label action the server offers', () => {
  it('api.mail has methods for create, update, delete and assign', async () => {
    const { api } = await import('../apps/web/js/api.js');

    for (const method of ['labels', 'createLabel', 'updateLabel', 'deleteLabel', 'setLabels', 'messagesByLabel']) {
      expect(typeof api.mail[method], `api.mail.${method} is missing`).toBe('function');
    }
  });
});