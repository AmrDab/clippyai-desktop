import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkReadPath, judgeResolvedPath, describePathBlock } from '../src/main/security/path-guard';
import { isPingableHost } from '../src/main/security/net-guard';

const home = 'C:\\Users\\me';
const env = { home, extraDirs: ['C:\\Users\\me\\AppData\\Roaming\\ClippyAI'] };
const judge = (p: string) => judgeResolvedPath(p, env);

describe('path guard: guarded locations ask (0.24.12 audit #2)', () => {
  it.each([
    ['C:\\Users\\me\\.ssh\\id_rsa', 'secret_path'],
    ['C:\\Users\\me\\.ssh', 'secret_path'],
    ['C:\\Users\\me\\.aws\\credentials', 'secret_path'],
    ['C:\\Users\\me\\.gnupg\\private-keys-v1.d\\x.key', 'secret_path'],
    ['C:\\Users\\me\\.git-credentials', 'secret_path'],
    ['c:\\users\\ME\\.SSH\\config', 'secret_path'],
    ['C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data', 'browser_profile'],
    ['C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 3\\Network\\Cookies', 'browser_profile'],
    ['C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data', 'browser_profile'],
    ['C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Local State', 'browser_profile'],
    ['C:\\Users\\me\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\x.default\\logins.json', 'browser_profile'],
    ['C:\\Users\\me\\AppData\\Local\\Microsoft\\Credentials\\ABCD', 'credential_store'],
    ['C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Protect\\S-1-5-21\\key', 'credential_store'],
    ['C:\\Windows\\System32\\config\\SAM', 'credential_store'],
    ['C:\\Users\\me\\AppData\\Roaming\\ClippyAI\\agent-server.json', 'clippy_config'],
    ['C:\\Users\\me\\AppData\\Roaming\\ClippyAI', 'clippy_config'],
    ['C:\\Users\\me\\.clippyai\\logs\\main.log', 'secret_path'],
    ['\\\\fileserver\\share\\x.txt', 'unc_path'],
    ['//fileserver/share/x.txt', 'unc_path'],
    ['\\\\?\\UNC\\fileserver\\share\\x.txt', 'unc_path'],
    ['\\\\?\\C:\\Users\\me\\.ssh\\id_rsa', 'secret_path'],
  ])('%s -> %s', (p, reason) => {
    const r = judge(p);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe(reason);
    expect(describePathBlock(r)).toBeTruthy();
  });

  it('guards macOS and Linux profile locations', () => {
    const mac = { home: '/Users/me' };
    expect(judgeResolvedPath('/Users/me/.ssh/id_ed25519', mac).allowed).toBe(false);
    expect(judgeResolvedPath('/Users/me/Library/Application Support/Google/Chrome/Default/Cookies', mac).allowed).toBe(false);
    expect(judgeResolvedPath('/Users/me/Library/Keychains/login.keychain-db', mac).allowed).toBe(false);
    expect(judgeResolvedPath('/Users/me/Library/Application Support/ClippyAI/config.json', mac).allowed).toBe(false);
  });
});

describe('path guard: ordinary files read unasked', () => {
  it.each([
    'C:\\Users\\me\\Documents\\notes.txt',
    'C:\\Users\\me\\Downloads\\report.pdf',
    'C:\\Users\\me\\Desktop',
    'C:\\Users\\me',
    'C:\\Users\\me\\AppData\\Local\\Temp\\out.log',
    'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\settings.json',
    'C:\\Users\\me\\.sshnotes\\x.txt',
    'C:\\Users\\me\\.gitconfig',
    'C:\\Users\\me\\projects\\app\\.env.example',
    'D:\\Projects\\User Data\\export.csv',
    'C:\\Program Files\\App\\readme.txt',
    'C:\\Users\\me\\AppData\\Roaming\\ClippyAI-notes.txt',
    '\\\\?\\C:\\Users\\me\\Documents\\notes.txt',
  ])('%s', (p) => {
    expect(judge(p)).toMatchObject({ allowed: true, reason: 'ok' });
  });
});

describe('checkReadPath: judges the real path', () => {
  it('refuses a UNC path before touching the filesystem', async () => {
    let called = false;
    const r = await checkReadPath('\\\\attacker.example\\share\\x', { home, realpath: async (p) => { called = true; return p; } });
    expect(r).toMatchObject({ allowed: false, reason: 'unc_path' });
    expect(called).toBe(false);
  });

  it('an alias (8.3 short name, junction, symlink) of a guarded folder is guarded', async () => {
    const realpath = async (p: string) => p
      .replace(/APPDAT~1/i, 'AppData')
      .replace(/C:\\Users\\me\\links\\keys/i, 'C:\\Users\\me\\.ssh');
    const short = await checkReadPath('C:\\Users\\me\\APPDAT~1\\Roaming\\ClippyAI\\agent-server.json', { ...env, realpath });
    expect(short).toMatchObject({ allowed: false, reason: 'clippy_config' });
    const link = await checkReadPath('C:\\Users\\me\\links\\keys\\id_rsa', { ...env, realpath });
    expect(link).toMatchObject({ allowed: false, reason: 'secret_path' });
  });

  it('a path that resolves to a network share is guarded', async () => {
    const r = await checkReadPath('C:\\Users\\me\\mapped\\x.txt', { home, realpath: async () => '\\\\nas\\share\\x.txt' });
    expect(r).toMatchObject({ allowed: false, reason: 'unc_path' });
  });

  it('a guarded path that does not exist yet is still guarded; a missing ordinary file is not', async () => {
    const realpath = async (p: string) => { if (/missing|id_rsa/.test(p)) throw new Error('ENOENT'); return p; };
    expect((await checkReadPath('C:\\Users\\me\\.ssh\\id_rsa', { ...env, realpath })).allowed).toBe(false);
    expect((await checkReadPath('C:\\Users\\me\\Documents\\missing.txt', { ...env, realpath })).allowed).toBe(true);
  });

  it('expands ~ and resolves a real symlink on disk', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    const fakeHome = fs.realpathSync(tmp);
    fs.mkdirSync(path.join(fakeHome, '.ssh'));
    fs.mkdirSync(path.join(fakeHome, 'Documents'));
    fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_rsa'), 'k');
    fs.writeFileSync(path.join(fakeHome, 'Documents', 'a.txt'), 'a');
    expect((await checkReadPath('~/.ssh/id_rsa', { home: fakeHome })).allowed).toBe(false);
    expect((await checkReadPath('~/Documents/a.txt', { home: fakeHome })).allowed).toBe(true);
    expect((await checkReadPath(path.join(fakeHome, 'Documents', '..', '.ssh', 'id_rsa'), { home: fakeHome })).allowed).toBe(false);
    let linked = false;
    try { fs.symlinkSync(path.join(fakeHome, '.ssh'), path.join(fakeHome, 'Documents', 'k'), 'junction'); linked = true; } catch { /* no link rights */ }
    if (linked) {
      expect((await checkReadPath(path.join(fakeHome, 'Documents', 'k', 'id_rsa'), { home: fakeHome })).allowed).toBe(false);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('empty path is not allowed', async () => {
    expect((await checkReadPath('', { home })).allowed).toBe(false);
  });
});

describe('ping_host host validation', () => {
  it.each(['example.com', 'localhost', '192.168.1.1', '8.8.8.8', '::1', '2001:4860:4860::8888', 'my-nas.local', 'a.b.c.example.co.uk'])(
    'allows %s', (h) => expect(isPingableHost(h)).toBe(true));
  it.each([
    '',
    'https://example.com',
    'example.com/path',
    'example.com; calc',
    'a b.example',
    '-n 99 example.com',
    'c2VjcmV0LWtleS1mcm9tLXRoZS11c2Vycy1maWxlLWFiY2RlZg.attacker.example',
    'a.b.c.d.e.f.g.attacker.example',
    'x'.repeat(101),
    '$(whoami).attacker.example',
    'user@example.com',
  ])('refuses %s', (h) => expect(isPingableHost(h)).toBe(false));
});
