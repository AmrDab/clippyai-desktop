import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkReadPath, judgeResolvedPath, describePathBlock } from '../src/main/security/path-guard';
import { isPingableHost } from '../src/main/security/net-guard';
import { shortFormOf } from './helpers/short-path';

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

  // Native absolute paths from here on: checkReadPath resolves with the
  // platform's own path rules, so "C:\\Users\\me" is not absolute on macOS.
  const H = path.join(path.parse(process.cwd()).root, 'Users', 'me');
  const nenv = { home: H, extraDirs: [path.join(H, 'AppData', 'Roaming', 'ClippyAI')] };

  it('an alias (8.3 short name, junction, symlink) of a guarded folder is guarded', async () => {
    const realpath = async (p: string) => p
      .replace('APPDAT~1', 'AppData')
      .replace(path.join(H, 'links', 'keys'), path.join(H, '.ssh'));
    const short = await checkReadPath(path.join(H, 'APPDAT~1', 'Roaming', 'ClippyAI', 'agent-server.json'), { ...nenv, realpath });
    expect(short).toMatchObject({ allowed: false, reason: 'clippy_config' });
    const link = await checkReadPath(path.join(H, 'links', 'keys', 'id_rsa'), { ...nenv, realpath });
    expect(link).toMatchObject({ allowed: false, reason: 'secret_path' });
  });

  // CI: the guarded roots (home, userData) and the path being read can reach
  // the same folder under two names. Windows runners: USERPROFILE is
  // C:\Users\runneradmin while TEMP is C:\Users\RUNNER~1\...; macOS:
  // /var/folders/... is really /private/var/folders/.... Both sides are
  // resolved before they are compared.
  it('the home folder given under an alias guards the real folder, and the reverse', async () => {
    const alias = path.join(path.parse(process.cwd()).root, 'var', 'home-alias');
    const real = path.join(path.parse(process.cwd()).root, 'private', 'var', 'home-real');
    const realpath = async (p: string) => (p.startsWith(alias) ? real + p.slice(alias.length) : p);
    // home is the alias; the file is named by its real path.
    expect(await checkReadPath(path.join(real, '.ssh', 'id_rsa'), { home: alias, realpath })).toMatchObject({ allowed: false, reason: 'secret_path' });
    // home is the real path; the file is named through the alias.
    expect(await checkReadPath(path.join(alias, '.ssh', 'id_rsa'), { home: real, realpath })).toMatchObject({ allowed: false, reason: 'secret_path' });
    // extraDirs (Clippy's userData) under an alias.
    expect(await checkReadPath(path.join(real, 'userData', 'agent-server.json'), { home: alias, extraDirs: [path.join(alias, 'userData')], realpath }))
      .toMatchObject({ allowed: false, reason: 'clippy_config' });
    // Ordinary files stay readable either way.
    expect((await checkReadPath(path.join(real, 'Documents', 'a.txt'), { home: alias, realpath })).allowed).toBe(true);
    expect((await checkReadPath(path.join(alias, 'Documents', 'a.txt'), { home: real, realpath })).allowed).toBe(true);
  });

  it('a guarded path that does not exist yet is resolved from its deepest existing folder', async () => {
    const alias = path.join(path.parse(process.cwd()).root, 'var', 'home-alias');
    const real = path.join(path.parse(process.cwd()).root, 'private', 'var', 'home-real');
    // Only the home folder itself exists; everything below it throws ENOENT.
    const realpath = async (p: string) => {
      if (p === alias || p === real) return real;
      if (p === path.dirname(alias) || p === path.dirname(real)) return path.dirname(real);
      throw new Error('ENOENT');
    };
    expect(await checkReadPath(path.join(alias, '.aws', 'credentials'), { home: real, realpath })).toMatchObject({ allowed: false, reason: 'secret_path' });
    expect(await checkReadPath(path.join(real, '.aws', 'credentials'), { home: alias, realpath })).toMatchObject({ allowed: false, reason: 'secret_path' });
    expect((await checkReadPath(path.join(alias, 'Documents', 'new.txt'), { home: real, realpath })).allowed).toBe(true);
  });

  it('a path that resolves to a network share is guarded', async () => {
    const r = await checkReadPath(path.join(H, 'mapped', 'x.txt'), { home: H, realpath: async () => '\\\\nas\\share\\x.txt' });
    expect(r).toMatchObject({ allowed: false, reason: 'unc_path' });
  });

  it('a guarded path that does not exist yet is still guarded; a missing ordinary file is not', async () => {
    const realpath = async (p: string) => { if (/missing|id_rsa/.test(p)) throw new Error('ENOENT'); return p; };
    expect((await checkReadPath(path.join(H, '.ssh', 'id_rsa'), { ...nenv, realpath })).allowed).toBe(false);
    expect((await checkReadPath(path.join(H, 'Documents', 'missing.txt'), { ...nenv, realpath })).allowed).toBe(true);
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

  describe('on disk: the home folder under another name', () => {
    /** A home with .ssh/id_rsa and Documents/a.txt; returns its canonical path. */
    function makeHome(prefix: string): string {
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
      fs.mkdirSync(path.join(dir, '.ssh'));
      fs.mkdirSync(path.join(dir, 'Documents'));
      fs.writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'k');
      fs.writeFileSync(path.join(dir, 'Documents', 'a.txt'), 'a');
      return dir;
    }

    it('home reached through a link (macOS: /var is a link to /private/var)', async () => {
      const real = makeHome('pg-real-home-');
      const link = `${real}-link`;
      let linked = false;
      try { fs.symlinkSync(real, link, 'junction'); linked = true; } catch { /* no link rights */ }
      if (linked) {
        // home = the link, file named by the real path.
        expect((await checkReadPath(path.join(real, '.ssh', 'id_rsa'), { home: link })).allowed).toBe(false);
        expect((await checkReadPath(path.join(real, '.aws', 'credentials'), { home: link })).allowed).toBe(false); // does not exist
        // home = the real path, file named through the link.
        expect((await checkReadPath(path.join(link, '.ssh', 'id_rsa'), { home: real })).allowed).toBe(false);
        expect((await checkReadPath(path.join(link, '.aws', 'credentials'), { home: real })).allowed).toBe(false);
        // userData under the link.
        expect((await checkReadPath(path.join(real, 'Documents', 'a.txt'), { home: real, extraDirs: [path.join(link, 'Documents')] })).allowed).toBe(false);
        // Ordinary files still read, and come back as the canonical path.
        const ok = await checkReadPath(path.join(link, 'Documents', 'a.txt'), { home: real });
        expect(ok.allowed).toBe(true);
        expect(ok.resolved).toBe(fs.realpathSync.native(path.join(real, 'Documents', 'a.txt')));
        fs.rmSync(link, { recursive: false, force: true });
      }
      fs.rmSync(real, { recursive: true, force: true });
    });

    it('home given as an 8.3 short name (Windows CI: USERPROFILE long, TEMP short)', async () => {
      const long = makeHome('pg-a-long-home-folder-name-');
      const short = shortFormOf(long);
      if (short) {
        expect(short).not.toBe(long);
        // home short, file long.
        expect((await checkReadPath(path.join(long, '.ssh', 'id_rsa'), { home: short })).allowed).toBe(false);
        expect((await checkReadPath(path.join(long, '.aws', 'credentials'), { home: short })).allowed).toBe(false);
        // home long, file short.
        expect((await checkReadPath(path.join(short, '.ssh', 'id_rsa'), { home: long })).allowed).toBe(false);
        // both short (what the old code already handled).
        expect((await checkReadPath(path.join(short, '.ssh', 'id_rsa'), { home: short })).allowed).toBe(false);
        // ~ expands against the short home and is still guarded.
        expect((await checkReadPath('~/.ssh/id_rsa', { home: short })).allowed).toBe(false);
        // Different case on a case-insensitive volume.
        expect((await checkReadPath(path.join(long.toUpperCase(), '.SSH', 'ID_RSA'), { home: short })).allowed).toBe(false);
        const ok = await checkReadPath(path.join(short, 'Documents', 'a.txt'), { home: long });
        expect(ok.allowed).toBe(true);
        expect(ok.resolved).toBe(fs.realpathSync.native(path.join(long, 'Documents', 'a.txt')));
      }
      fs.rmSync(long, { recursive: true, force: true });
    });
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
