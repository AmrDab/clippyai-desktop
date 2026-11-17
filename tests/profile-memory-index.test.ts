import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = vi.hoisted(() => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-mem-'));
});
vi.mock('electron', () => ({ app: { getPath: () => dir, isPackaged: false } }));
const indexMemoryBestEffort = vi.hoisted(() => vi.fn());
const reindexAll = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/main/memory-recall', () => ({
  indexMemoryBestEffort,
  reindexAll,
  needsMigration: () => false,
  clearMigrationFlag: () => {},
  indexSize: () => 0,
  recallSupported: () => true,
  shouldReindex: (o: { flagged: boolean; indexSize: number; bulletCount: number }) => o.bulletCount > 0 && (o.flagged || o.indexSize === 0),
  recallTopK: async () => [],
  renderRecallBlock: () => '',
}));

import { appendMemory, loadProfileBundle } from '../src/main/profile';

describe('profile memory indexing', () => {
  it('appendMemory writes the bullet and hands it to the indexer', () => {
    appendMemory('prefers Apple Mail');
    expect(fs.readFileSync(path.join(dir, 'profile', 'MEMORY.md'), 'utf-8')).toContain('prefers Apple Mail');
    expect(indexMemoryBestEffort).toHaveBeenCalledWith(expect.objectContaining({ text: 'prefers Apple Mail' }));
  });
  it('loading the bundle reindexes existing MEMORY.md bullets when the index is empty', async () => {
    await loadProfileBundle({ userText: 'hi' });
    expect(reindexAll).toHaveBeenCalledTimes(1);
    expect(reindexAll.mock.calls[0][0]).toEqual([expect.objectContaining({ text: 'prefers Apple Mail' })]);
  });
});
