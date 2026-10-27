import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-receipt-'));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp } }));

import {
  makeReceipt, blockedReceipt, statusFromOutcome, verifyWrittenFile, sha256,
  type ReceiptStatus, type VerificationOutcome,
} from '../src/main/receipt';

const STATUSES: ReceiptStatus[] = ['verified', 'unverified', 'blocked', 'stale', 'error'];

describe('Receipt contract', () => {
  it('task_complete is never true, whatever the status', () => {
    for (const status of STATUSES) {
      expect(makeReceipt('smart_click', status, true).task_complete).toBe(false);
    }
    expect(blockedReceipt('smart_click', 'nope').task_complete).toBe(false);
  });

  it('executed null (lost after dispatch) is distinct from false (never ran)', () => {
    const timedOut = makeReceipt('smart_click', 'error', null);
    const blocked = blockedReceipt('smart_click', 'policy');
    expect(timedOut.executed).toBeNull();
    expect(timedOut.executed).not.toBe(false);
    expect(blocked.executed).toBe(false);
    expect(blocked.status).toBe('blocked');
    expect(blocked.evidence.reason).toBe('policy');
  });

  it('carries id, tool, timestamp, evidence and optional execution path', () => {
    const r = makeReceipt('smart_click', 'unverified', true, { target: 'Continue' }, 'uia');
    expect(r.action_id).toMatch(/[0-9a-f-]{36}/);
    expect(r.tool).toBe('smart_click');
    expect(r.execution_path).toBe('uia');
    expect(r.evidence).toEqual({ target: 'Continue' });
    expect(new Date(r.at).getTime()).toBeGreaterThan(0);
    expect('execution_path' in makeReceipt('x', 'error', false)).toBe(false);
  });

  it('tri-state verification maps to a status: only satisfied is verified', () => {
    const map: Record<VerificationOutcome, ReceiptStatus> = { satisfied: 'verified', unsatisfied: 'error', unknown: 'error' };
    for (const [o, s] of Object.entries(map)) expect(statusFromOutcome(o as VerificationOutcome)).toBe(s);
  });
});

describe('verifyWrittenFile', () => {
  const file = (name: string) => path.join(tmp, name);

  it('satisfied when size + sha256 match what was written', async () => {
    const p = file('a.txt');
    fs.writeFileSync(p, 'héllo wörld', 'utf8');
    const v = await verifyWrittenFile(p, 'héllo wörld', 'create');
    expect(v.outcome).toBe('satisfied');
    expect(v.evidence.expected).toEqual({ bytes: Buffer.byteLength('héllo wörld'), sha256: sha256('héllo wörld') });
    expect(v.evidence.observed).toEqual(v.evidence.expected);
  });

  it('unsatisfied when the file on disk differs', async () => {
    const p = file('b.txt');
    fs.writeFileSync(p, 'something else', 'utf8');
    const v = await verifyWrittenFile(p, 'intended', 'overwrite');
    expect(v.outcome).toBe('unsatisfied');
    expect((v.evidence.observed as { sha256: string }).sha256).not.toBe((v.evidence.expected as { sha256: string }).sha256);
  });

  it('unknown when the file cannot be read back', async () => {
    const v = await verifyWrittenFile(file('missing/nope.txt'), 'x', 'create');
    expect(v.outcome).toBe('unknown');
    expect(typeof v.evidence.error).toBe('string');
  });

  it('append compares only the tail', async () => {
    const p = file('c.txt');
    fs.writeFileSync(p, 'line1\n', 'utf8');
    fs.appendFileSync(p, 'line2\n', 'utf8');
    expect((await verifyWrittenFile(p, 'line2\n', 'append')).outcome).toBe('satisfied');
    expect((await verifyWrittenFile(p, 'line3\n', 'append')).outcome).toBe('unsatisfied');
  });
});

describe('action-history persistence with receipts', () => {
  const historyFile = path.join(tmp, 'action-history.json');

  beforeEach(() => {
    vi.resetModules();
    try { fs.unlinkSync(historyFile); } catch { /* fresh */ }
  });

  it('loads a pre-v0.21 history (no receipt field) and round-trips a new entry with one', async () => {
    const old = [{
      id: 'old-1', ts: '2026-01-01T00:00:00.000Z', tool: 'write_file', tier: 2, actionClass: 'destructive_file',
      argsSummary: '{}', outcome: 'success', detail: 'File written', inverse: { kind: 'noop', reason: 'n/a' },
    }];
    fs.writeFileSync(historyFile, JSON.stringify(old), 'utf8');

    const history = await import('../src/main/action-history');
    const before = history.getAll();
    expect(before).toHaveLength(1);
    expect(before[0].receipt).toBeUndefined();

    const receipt = makeReceipt('smart_click', 'unverified', true, { target: 'Continue' }, 'uia');
    history.record({ tool: 'smart_click', args: { target: 'Continue' }, outcome: 'success', detail: 'Clicked', receipt });
    history.record({ tool: 'read_screen', args: {}, outcome: 'success', detail: '…' });

    vi.resetModules();
    const reloaded = await import('../src/main/action-history');
    const rows = reloaded.getAll();
    expect(rows.map((r) => r.tool)).toEqual(['read_screen', 'smart_click', 'write_file']);
    expect(rows[0].receipt).toBeUndefined();          // tools without receipts stay receipt-less
    expect(rows[1].receipt).toEqual(receipt);         // JSON round-trip is lossless
    expect(rows[1].receipt?.task_complete).toBe(false);
    expect(rows[2].receipt).toBeUndefined();          // old entry untouched
    expect(rows[2].inverse).toEqual({ kind: 'noop', reason: 'n/a' });
  });
});
