/**
 * v0.24.12 — delete_file / move_file / rename_file: across drives (EXDEV),
 * no silent overwrite, the same path guards as write_file. Real files in a
 * temp folder; the home folder is the suite's throwaway one (vitest.config).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => process.cwd() },
  clipboard: {}, BrowserWindow: class {}, screen: {}, shell: {}, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));

import { executeTool } from '../src/main/tools';
import { moveAcrossDevices } from '../src/main/file-move';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-file-tools-'));
const p = (...parts: string[]) => path.join(root, ...parts);
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
let n = 0;
let dir = '';
beforeEach(() => { dir = p(`case${++n}`); fs.mkdirSync(dir, { recursive: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** An fs whose rename always fails the way a cross-drive rename does. */
const exdevFs = {
  ...fs,
  renameSync: () => { throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }); },
};

describe('moveAcrossDevices', () => {
  it('same volume: a plain rename', () => {
    const a = write(path.join(dir, 'a.txt'), 'one');
    expect(moveAcrossDevices(a, path.join(dir, 'b.txt'))).toBe('renamed');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('one');
    expect(fs.existsSync(a)).toBe(false);
  });

  it('EXDEV on a file: copied, then the source is removed', () => {
    const a = write(path.join(dir, 'a.txt'), 'two');
    expect(moveAcrossDevices(a, path.join(dir, 'b.txt'), exdevFs)).toBe('copied');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('two');
    expect(fs.existsSync(a)).toBe(false);
  });

  it('EXDEV on a folder: the whole tree moves', () => {
    write(path.join(dir, 'src', 'deep', 'x.txt'), 'three');
    expect(moveAcrossDevices(path.join(dir, 'src'), path.join(dir, 'dst'), exdevFs)).toBe('copied');
    expect(fs.readFileSync(path.join(dir, 'dst', 'deep', 'x.txt'), 'utf8')).toBe('three');
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(false);
  });

  it('EXDEV never replaces an existing destination, and keeps the source', () => {
    const a = write(path.join(dir, 'a.txt'), 'new');
    const b = write(path.join(dir, 'b.txt'), 'old');
    expect(() => moveAcrossDevices(a, b, exdevFs)).toThrow();
    expect(fs.readFileSync(b, 'utf8')).toBe('old');
    expect(fs.readFileSync(a, 'utf8')).toBe('new');
  });

  it('any other error is passed on', () => {
    expect(() => moveAcrossDevices(path.join(dir, 'missing.txt'), path.join(dir, 'b.txt'))).toThrow(/ENOENT/);
  });
});

describe.each(['move_file', 'rename_file'] as const)('%s', (tool) => {
  it('moves a file', async () => {
    const a = write(path.join(dir, 'a.txt'), 'hello');
    const b = path.join(dir, 'b.txt');
    const r = await executeTool(tool, { from: a, to: b });
    expect(r.text).toMatch(/^(Moved|Renamed): /);
    expect(fs.readFileSync(b, 'utf8')).toBe('hello');
    expect(fs.existsSync(a)).toBe(false);
  });

  it('refuses to replace an existing destination unless asked', async () => {
    const a = write(path.join(dir, 'a.txt'), 'new');
    const b = write(path.join(dir, 'b.txt'), 'precious');
    const r = await executeTool(tool, { from: a, to: b });
    expect(r.text).toMatch(/^\(error:DEST_EXISTS\) .* already exists and was left alone/);
    expect(fs.readFileSync(b, 'utf8')).toBe('precious');
    expect(fs.readFileSync(a, 'utf8')).toBe('new');
  });

  it('overwrite:true replaces it, and the old file goes to the Clippy trash', async () => {
    const a = write(path.join(dir, 'a.txt'), 'new');
    const b = write(path.join(dir, 'b.txt'), 'precious');
    const r = await executeTool(tool, { from: a, to: b, overwrite: true });
    expect(fs.readFileSync(b, 'utf8')).toBe('new');
    const trashed = /Clippy trash: (.*)\)$/.exec(r.text)?.[1];
    expect(trashed && fs.readFileSync(trashed, 'utf8')).toBe('precious');
  });

  it('an existing folder as destination is not replaced, even with overwrite', async () => {
    const a = write(path.join(dir, 'a.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'folder'));
    const r = await executeTool(tool, { from: a, to: path.join(dir, 'folder'), overwrite: true });
    expect(r.text).toMatch(/^\(error:DEST_EXISTS\) .* is an existing folder/);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('refuses .. and system paths, source or destination', async () => {
    const a = write(path.join(dir, 'a.txt'), 'x');
    const sys = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
    expect((await executeTool(tool, { from: a, to: `${dir}${path.sep}..${path.sep}escaped.txt` })).text).toMatch(/^\(error:PROTECTED_PATH\) path traversal/);
    expect((await executeTool(tool, { from: a, to: sys })).text).toMatch(/^\(error:PROTECTED_PATH\) .* refuses to touch system path/);
    expect((await executeTool(tool, { from: sys, to: path.join(dir, 'hosts') })).text).toMatch(/^\(error:PROTECTED_PATH\)/);
    expect(fs.existsSync(a)).toBe(true);
  });

  it('a missing source says so', async () => {
    expect((await executeTool(tool, { from: path.join(dir, 'nope.txt'), to: path.join(dir, 'b.txt') })).text).toMatch(/^\(error:FILE_NOT_FOUND\)/);
  });
});

describe('delete_file', () => {
  it('moves the file to the Clippy trash and records where, for Undo', async () => {
    const a = write(path.join(dir, 'a.txt'), 'bye');
    const params: Record<string, unknown> = { path: a };
    const r = await executeTool('delete_file', params);
    expect(r.text).toMatch(/^Trashed /);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.readFileSync(String(params._clippyTrashPath), 'utf8')).toBe('bye');
  });

  it('refuses .. and system paths', async () => {
    const sys = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    expect((await executeTool('delete_file', { path: `${dir}${path.sep}..${path.sep}x.txt` })).text).toMatch(/^\(error:PROTECTED_PATH\) path traversal/);
    expect((await executeTool('delete_file', { path: sys })).text).toMatch(/^\(error:PROTECTED_PATH\) delete_file refuses to touch system path/);
  });
});

describe('Undo of a file operation', () => {
  it('restores a deleted file and moves a moved file back', async () => {
    const { applyInverse } = await import('../src/main/undo');
    const { TOOL_UNDO } = await import('../src/main/tool-undo');
    const a = write(path.join(dir, 'a.txt'), 'keep me');
    const del: Record<string, unknown> = { path: a };
    const delResult = await executeTool('delete_file', del);
    expect((await applyInverse(TOOL_UNDO.delete_file(del, delResult)!)).ok).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('keep me');

    const mv: Record<string, unknown> = { from: a, to: path.join(dir, 'b.txt') };
    const mvResult = await executeTool('move_file', mv);
    expect((await applyInverse(TOOL_UNDO.move_file(mv, mvResult)!)).ok).toBe(true);
    expect(fs.readFileSync(a, 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
  });
});
