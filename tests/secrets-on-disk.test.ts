/**
 * 0.24.12 audit #35: the previous clipboard text stays in memory, and the
 * license key is not sent to the onboarding window.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-secrets-'));
const writeText = vi.fn();
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => tmp }, clipboard: { writeText: (t: string) => writeText(t) } }));

import { TOOL_UNDO, rememberClipboard, takeClipboard } from '../src/main/tool-undo';
import { applyInverse } from '../src/main/undo';

const SECRET = 'hunter2-my-bank-password';
const historyFile = path.join(tmp, 'action-history.json');

beforeEach(() => { writeText.mockClear(); vi.resetModules(); try { fs.rmSync(historyFile, { force: true }); } catch { /* none */ } });

describe('write_clipboard undo', () => {
  it('the history entry holds a reference, never the text', async () => {
    const ref = rememberClipboard(SECRET);
    const inverse = TOOL_UNDO.write_clipboard({ text: 'new', _previousClipboardRef: ref }, { text: 'ok' });
    expect(inverse).toEqual({ kind: 'restore-clipboard', clipRef: ref });
    expect(JSON.stringify(inverse)).not.toContain(SECRET);

    const history = await import('../src/main/action-history');
    history.record({ tool: 'write_clipboard', args: { text: 'new', _previousClipboardRef: ref }, outcome: 'success', detail: 'Copied', inverse: inverse! });
    const onDisk = fs.readFileSync(historyFile, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain(ref);
  });

  it('undo restores the text from memory, once', async () => {
    const ref = rememberClipboard(SECRET);
    expect(await applyInverse({ kind: 'restore-clipboard', clipRef: ref })).toEqual({ ok: true, detail: 'Clipboard restored.' });
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(takeClipboard(ref)).toBeUndefined();
  });

  it('after a restart (nothing in memory) the undo says so instead of failing oddly', async () => {
    const r = await applyInverse({ kind: 'restore-clipboard', clipRef: 'clip-from-last-run' });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/memory only/);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('no previous clipboard: no undo button', () => {
    expect(TOOL_UNDO.write_clipboard({ text: 'new' }, { text: 'ok' })).toMatchObject({ kind: 'noop' });
  });

  it('memory is bounded', () => {
    const refs = Array.from({ length: 30 }, (_, i) => rememberClipboard(`t${i}`));
    expect(takeClipboard(refs[0])).toBeUndefined();
    expect(takeClipboard(refs[29])).toBe('t29');
  });

  it('an older history file is scrubbed of clipboard text on load', async () => {
    fs.writeFileSync(historyFile, JSON.stringify([
      { id: 'a', ts: '2026-11-19T10:00:00Z', tool: 'write_clipboard', tier: 2, actionClass: 'desktop_input',
        argsSummary: `{"text":{"len":3},"_previousClipboard":"${SECRET}"}`, outcome: 'success', detail: 'Copied',
        inverse: { kind: 'restore-clipboard', previousText: SECRET } },
      { id: 'b', ts: '2026-11-19T10:01:00Z', tool: 'write_file', tier: 2, actionClass: 'destructive_file',
        argsSummary: '{"path":"a.txt"}', outcome: 'success', detail: 'Wrote a.txt' },
    ]), 'utf8');
    const history = await import('../src/main/action-history');
    const rows = history.getAll();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(fs.readFileSync(historyFile, 'utf8')).not.toContain(SECRET);
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ argsSummary: '{"path":"a.txt"}', detail: 'Wrote a.txt' });
  });
});

describe('license key stays in main', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
  it('the activation-result payload carries no key', () => {
    const src = read('main', 'index.ts');
    const sends = src.match(/send\('activation-result',[^\n]*/g) ?? [];
    expect(sends.length).toBeGreaterThan(0);
    for (const s of sends) expect(s).not.toMatch(/licenseKey/);
  });
  it('the onboarding window does not expect one', () => {
    expect(read('renderer', 'onboarding.ts')).not.toMatch(/r\.licenseKey/);
    expect(read('preload', 'index.ts')).not.toMatch(/onActivationResult[^\n]*licenseKey/);
  });
});
