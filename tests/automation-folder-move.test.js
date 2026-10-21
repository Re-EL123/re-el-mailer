/**
 * Folder-changing automation actions must go through moveToFolder.
 *
 * Regression: 'move'/'archive'/'trash' used db.update({ folder }) which writes
 * only the folder column. That skipped the trash/spam flag that retention and
 * search rely on, so automation-trashed mail was never purged and
 * automation-filed spam still appeared in search and Starred.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  activeRulesFor: vi.fn(),
  recordRuleRun: vi.fn(),
  moveToFolder: vi.fn(),
  update: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../packages/db/automation.js', async (importOriginal) => ({
  ...(await importOriginal()),
  activeRulesFor: db.activeRulesFor,
  recordRuleRun: db.recordRuleRun,
}));

vi.mock('../packages/db/messages.js', async (importOriginal) => ({
  ...(await importOriginal()),
  moveToFolder: db.moveToFolder,
  update: db.update,
}));

vi.mock('../packages/db/pool.js', async (importOriginal) => ({
  ...(await importOriginal()),
  query: db.query,
}));

const { runInboundAutomation } = await import('../packages/mail/automation.js');

const mailbox = { id: 'mbx_1', email: 'team@re-el.co.za' };
const message = {
  id: 'msg_1',
  fromEmail: 'billing@example.com',
  subject: 'Quarterly invoice',
  folder: 'inbox',
};

function ruleWith(actions, id = 'rul_1') {
  return {
    id,
    is_active: true,
    stop_processing: false,
    conditions: { match: 'all', conditions: [{ field: 'subject', operator: 'contains', value: 'invoice' }] },
    actions,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.recordRuleRun.mockResolvedValue({ id: 'run_1' });
  db.query.mockResolvedValue({ rowCount: 1 });
  db.moveToFolder.mockResolvedValue({ rowCount: 1 });
});

describe('runInboundAutomation folder actions', () => {
  it('files spam and sets the deleted flag via moveToFolder', async () => {
    db.activeRulesFor.mockResolvedValue([ruleWith([{ type: 'move', folder: 'spam' }])]);

    const result = await runInboundAutomation({ mailbox, message });

    expect(db.moveToFolder).toHaveBeenCalledWith(['msg_1'], 'mbx_1', 'spam');
    expect(db.update).not.toHaveBeenCalled();
    expect(result.applied[0].actions[0]).toEqual({ type: 'move', folder: 'spam' });
  });

  it('trash and archive also move through moveToFolder', async () => {
    db.activeRulesFor.mockResolvedValue([
      ruleWith([{ type: 'trash' }, { type: 'archive' }]),
    ]);

    await runInboundAutomation({ mailbox, message });

    expect(db.moveToFolder).toHaveBeenNthCalledWith(1, ['msg_1'], 'mbx_1', 'trash');
    expect(db.moveToFolder).toHaveBeenNthCalledWith(2, ['msg_1'], 'mbx_1', 'archive');
    expect(db.update).not.toHaveBeenCalled();
  });
});
