/**
 * 0.24.12 audit #17: _path-guard.ps1 judges the real path (8.3 short names,
 * junctions) and blocks the whole browser "User Data" tree.
 *
 * Runs the real script in Windows PowerShell, once, with a throwaway profile
 * folder (USERPROFILE points at a temp dir, so no real file is read).
 * Windows only; elsewhere the suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const guard = path.join(__dirname, '..', 'assets', 'scripts', '_path-guard.ps1');
const isWin = process.platform === 'win32';

interface Verdict { allowed: boolean; resolved: string; reason: string }
let home = '';
let outside = '';
let results: Record<string, Verdict> = {};
let hasJunction = false;
let shortAppData = '';

const cases = (): Record<string, string> => ({
  doc: path.join(home, 'Documents', 'notes.txt'),
  missing: path.join(home, 'Documents', 'not-there.txt'),
  ssh: path.join(home, '.ssh', 'id_rsa'),
  sshDir: path.join(home, '.ssh'),
  sshLookalike: path.join(home, '.sshnotes', 'a.txt'),
  aws: path.join(home, '.aws', 'credentials'),
  gitCreds: path.join(home, '.git-credentials'),
  clippy: path.join(home, 'AppData', 'Roaming', 'ClippyAI', 'agent-server.json'),
  chromeCookies: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Profile 2', 'Network', 'Cookies'),
  chromeRoot: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  edgeState: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Local State'),
  braveLogin: path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Login Data'),
  appDataOther: path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
  unc: '\\\\attacker.example\\share\\x.txt',
  uncSlash: '//attacker.example/share/x.txt',
  uncDevice: '\\\\?\\UNC\\attacker.example\\share\\x.txt',
  devicePrefix: `\\\\?\\${path.join(home, '.ssh', 'id_rsa')}`,
  traversal: path.join(home, 'Documents', '..', '.ssh', 'id_rsa'),
  junction: path.join(home, 'Documents', 'keys', 'id_rsa'),
  junctionChain: path.join(home, 'Documents', 'hop', 'keys2', 'id_rsa'),
  shortName: shortAppData ? path.join(home, shortAppData, 'Roaming', 'ClippyAI', 'agent-server.json') : '',
  windows: 'C:\\Windows\\System32\\config\\SAM',
});

describe.skipIf(!isWin)('_path-guard.ps1 (real PowerShell)', () => {
  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-home-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-out-')));
    for (const d of ['.ssh', 'Documents', path.join('Documents', 'hop'), path.join('AppData', 'Roaming', 'ClippyAI')]) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'k');
    fs.writeFileSync(path.join(home, 'Documents', 'notes.txt'), 'n');
    try {
      fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'Documents', 'keys'), 'junction');
      // A junction to a folder that holds a junction to ~/.ssh.
      fs.symlinkSync(path.join(home, 'Documents', 'keys'), path.join(home, 'Documents', 'hop', 'keys2'), 'junction');
      hasJunction = true;
    } catch { /* no link rights */ }
    // The 8.3 name of AppData, when the volume has short names on.
    try {
      const out = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a:d', home], { encoding: 'utf8' });
      shortAppData = out.split(/\r?\n/).map((l) => l.match(/\s(\S+~\d)\s+AppData\s*$/i)?.[1]).find(Boolean) ?? '';
    } catch { /* leave empty */ }

    const input = path.join(outside, 'cases.json');
    fs.writeFileSync(input, JSON.stringify(cases()), 'utf8');
    const ps = [
      `. '${guard.replace(/'/g, "''")}'`,
      `$c = Get-Content -LiteralPath '${input.replace(/'/g, "''")}' -Raw | ConvertFrom-Json`,
      '$o = @{}',
      'foreach ($p in $c.PSObject.Properties) { if ($p.Value) { $r = Test-PathAllowedForRead $p.Value; $o[$p.Name] = @{ allowed = [bool]$r.allowed; resolved = [string]$r.resolved; reason = [string]$r.reason } } }',
      '$o | ConvertTo-Json -Compress -Depth 4',
    ].join('; ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, USERPROFILE: home },
    });
    results = JSON.parse(out.trim().split(/\r?\n/).pop()!);
  }, 90_000);

  afterAll(() => {
    for (const d of [home, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it.each(['doc', 'missing', 'sshLookalike', 'appDataOther'])('allows an ordinary path: %s', (k) => {
    expect(results[k]).toMatchObject({ allowed: true, reason: 'ok' });
  });

  it.each(['ssh', 'sshDir', 'aws', 'gitCreds', 'clippy', 'traversal', 'devicePrefix'])('blocks a secret location: %s', (k) => {
    expect(results[k].allowed).toBe(false);
    expect(results[k].reason).toMatch(/^user_secret_path/);
  });

  it.each(['chromeCookies', 'chromeRoot', 'edgeState', 'braveLogin'])('blocks the whole browser User Data tree: %s', (k) => {
    expect(results[k]).toMatchObject({ allowed: false, reason: 'browser_profile: User Data' });
  });

  it.each(['unc', 'uncSlash', 'uncDevice'])('refuses a UNC path: %s', (k) => {
    expect(results[k]).toMatchObject({ allowed: false, reason: 'unc_path_blocked' });
  });

  it('still blocks system folders', () => {
    expect(results.windows.allowed).toBe(false);
    expect(results.windows.reason).toMatch(/^system_dir/);
  });

  it('a junction to a secret folder is judged by its target', () => {
    if (!hasJunction) return;
    expect(results.junction.allowed).toBe(false);
    expect(results.junction.reason).toMatch(/^user_secret_path/);
    expect(results.junction.resolved.toLowerCase()).toBe(path.join(home, '.ssh', 'id_rsa').toLowerCase());
    expect(results.junctionChain.allowed).toBe(false);
  });

  it('an 8.3 short name is expanded before the check', () => {
    if (!shortAppData) return; // short names are off on this volume
    expect(results.shortName.allowed).toBe(false);
    expect(results.shortName.reason).toMatch(/^user_secret_path/);
  });

  it('an allowed path comes back as its real, absolute path', () => {
    expect(results.doc.resolved.toLowerCase()).toBe(path.join(home, 'Documents', 'notes.txt').toLowerCase());
  });
});

describe('_path-guard.ps1 (source)', () => {
  const src = fs.readFileSync(guard, 'utf8');
  it('checks for UNC before the first filesystem call', () => {
    const fn = src.slice(src.indexOf('function Test-PathAllowedForRead'));
    expect(fn.indexOf("'unc_path_blocked'")).toBeGreaterThan(-1);
    expect(fn.indexOf("'unc_path_blocked'")).toBeLessThan(fn.indexOf('Resolve-RealPath $resolved'));
  });
  it('is ASCII only (Windows PowerShell 5.1 reads a BOM-less script as ANSI)', () => {
    // eslint-disable-next-line no-control-regex
    expect(src).toMatch(/^[\x00-\x7F]*$/);
  });
});
