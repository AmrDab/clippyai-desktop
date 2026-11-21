/**
 * 0.24.12 audit #17: _path-guard.ps1 judges the real path (8.3 short names,
 * junctions) and blocks the whole browser "User Data" tree.
 *
 * Runs the real script in Windows PowerShell against a throwaway profile
 * folder (USERPROFILE points at a temp dir, so no real file is read).
 * Windows only; elsewhere the suite is skipped.
 *
 * Every check runs in several layouts, because the profile folder and the
 * path can name the same folder differently (GitHub's Windows runners:
 * USERPROFILE is C:\Users\runneradmin, TEMP is C:\Users\RUNNER~1\...). The
 * guard has to resolve both sides; expectations compare canonical paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shortFormOf } from './helpers/short-path';

const guard = path.join(__dirname, '..', 'assets', 'scripts', '_path-guard.ps1');
const isWin = process.platform === 'win32';

interface Verdict { allowed: boolean; resolved: string; reason: string }
type Results = Record<string, Verdict>;

/** Canonical form for comparing two spellings of one path. */
const canon = (p: string): string => {
  try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); }
};

/** The paths to judge, spelled under `base` (one of the names of the home folder). */
const cases = (base: string, shortAppData: string): Record<string, string> => ({
  doc: path.join(base, 'Documents', 'notes.txt'),
  missing: path.join(base, 'Documents', 'not-there.txt'),
  ssh: path.join(base, '.ssh', 'id_rsa'),
  sshDir: path.join(base, '.ssh'),
  sshUpper: path.join(base.toUpperCase(), '.SSH', 'ID_RSA'),
  sshLookalike: path.join(base, '.sshnotes', 'a.txt'),
  aws: path.join(base, '.aws', 'credentials'),
  gitCreds: path.join(base, '.git-credentials'),
  clippy: path.join(base, 'AppData', 'Roaming', 'ClippyAI', 'agent-server.json'),
  chromeCookies: path.join(base, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Profile 2', 'Network', 'Cookies'),
  chromeRoot: path.join(base, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  edgeState: path.join(base, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Local State'),
  braveLogin: path.join(base, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Login Data'),
  appDataOther: path.join(base, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
  unc: '\\\\attacker.example\\share\\x.txt',
  uncSlash: '//attacker.example/share/x.txt',
  uncDevice: '\\\\?\\UNC\\attacker.example\\share\\x.txt',
  devicePrefix: `\\\\?\\${path.join(base, '.ssh', 'id_rsa')}`,
  traversal: path.join(base, 'Documents', '..', '.ssh', 'id_rsa'),
  junction: path.join(base, 'Documents', 'keys', 'id_rsa'),
  junctionChain: path.join(base, 'Documents', 'hop', 'keys2', 'id_rsa'),
  shortName: shortAppData ? path.join(base, shortAppData, 'Roaming', 'ClippyAI', 'agent-server.json') : '',
  windows: 'C:\\Windows\\System32\\config\\SAM',
});

/** Run the guard once with USERPROFILE = `profile` over every case. */
function runGuard(profile: string, input: Record<string, string>, scratch: string): Results {
  const file = path.join(scratch, `cases-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(input), 'utf8');
  const ps = [
    `. '${guard.replace(/'/g, "''")}'`,
    `$c = Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw | ConvertFrom-Json`,
    '$o = @{}',
    'foreach ($p in $c.PSObject.Properties) { if ($p.Value) { $r = Test-PathAllowedForRead $p.Value; $o[$p.Name] = @{ allowed = [bool]$r.allowed; resolved = [string]$r.resolved; reason = [string]$r.reason } } }',
    '$o | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, USERPROFILE: profile },
  });
  return JSON.parse(out.trim().split(/\r?\n/).pop()!);
}

describe.skipIf(!isWin)('_path-guard.ps1 (real PowerShell)', () => {
  let home = '';       // canonical (long) name of the throwaway profile
  let outside = '';
  let hasJunction = false;
  let shortAppData = '';
  /** layout name -> results. Filled in beforeAll; a layout that this machine can't build is absent. */
  const layouts: Record<string, Results> = {};
  const LAYOUTS = [
    'profile long, path long',
    'profile 8.3, path long',
    'profile long, path 8.3',
    'profile 8.3, path 8.3',
    'profile is a link, path real',
    'profile real, path through the link',
  ];

  beforeAll(() => {
    home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-a-long-profile-name-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pg-out-')));
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

    const short = shortFormOf(home);
    let link = path.join(outside, 'profile-link');
    try { fs.symlinkSync(home, link, 'junction'); } catch { link = ''; }

    layouts[LAYOUTS[0]] = runGuard(home, cases(home, shortAppData), outside);
    if (short) {
      layouts[LAYOUTS[1]] = runGuard(short, cases(home, shortAppData), outside);
      layouts[LAYOUTS[2]] = runGuard(home, cases(short, shortAppData), outside);
      layouts[LAYOUTS[3]] = runGuard(short, cases(short, shortAppData), outside);
    }
    if (link) {
      layouts[LAYOUTS[4]] = runGuard(link, cases(home, shortAppData), outside);
      layouts[LAYOUTS[5]] = runGuard(home, cases(link, shortAppData), outside);
    }
  }, 240_000);

  afterAll(() => {
    try { fs.rmSync(path.join(outside, 'profile-link'), { force: true }); } catch { /* best effort */ }
    for (const d of [home, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  });

  it('this machine can build at least one aliased layout (so the CI case is exercised)', () => {
    expect(Object.keys(layouts).length).toBeGreaterThan(1);
  });

  describe.each(LAYOUTS)('%s', (layout) => {
    const r = (): Results | undefined => layouts[layout];

    it.each(['doc', 'missing', 'sshLookalike', 'appDataOther'])('allows an ordinary path: %s', (k) => {
      if (!r()) return; // layout not available on this machine
      expect(r()![k]).toMatchObject({ allowed: true, reason: 'ok' });
    });

    it.each(['ssh', 'sshDir', 'sshUpper', 'aws', 'gitCreds', 'clippy', 'traversal', 'devicePrefix'])('blocks a secret location: %s', (k) => {
      if (!r()) return;
      expect(r()![k].allowed).toBe(false);
      expect(r()![k].reason).toMatch(/^user_secret_path/);
    });

    it.each(['chromeCookies', 'chromeRoot', 'edgeState', 'braveLogin'])('blocks the whole browser User Data tree: %s', (k) => {
      if (!r()) return;
      expect(r()![k]).toMatchObject({ allowed: false, reason: 'browser_profile: User Data' });
    });

    it.each(['unc', 'uncSlash', 'uncDevice'])('refuses a UNC path: %s', (k) => {
      if (!r()) return;
      expect(r()![k]).toMatchObject({ allowed: false, reason: 'unc_path_blocked' });
    });

    it('still blocks system folders', () => {
      if (!r()) return;
      expect(r()!.windows.allowed).toBe(false);
      expect(r()!.windows.reason).toMatch(/^system_dir/);
    });

    it('a junction to a secret folder is judged by its target', () => {
      if (!r() || !hasJunction) return;
      expect(r()!.junction.allowed).toBe(false);
      expect(r()!.junction.reason).toMatch(/^user_secret_path/);
      expect(canon(r()!.junction.resolved)).toBe(canon(path.join(home, '.ssh', 'id_rsa')));
      expect(r()!.junctionChain.allowed).toBe(false);
    });

    it('an 8.3 short name inside the path is expanded before the check', () => {
      if (!r() || !shortAppData) return; // short names are off on this volume
      expect(r()!.shortName.allowed).toBe(false);
      expect(r()!.shortName.reason).toMatch(/^user_secret_path/);
    });

    it('an allowed path comes back as its real, absolute path', () => {
      if (!r()) return;
      // Canonical on both sides: the guard may answer with the long name
      // where the test spelled the short one (or the link).
      expect(canon(r()!.doc.resolved)).toBe(canon(path.join(home, 'Documents', 'notes.txt')));
      expect(path.isAbsolute(r()!.doc.resolved)).toBe(true);
      expect(r()!.doc.resolved).not.toContain('~');
    });
  });
});

describe('_path-guard.ps1 (source)', () => {
  const src = fs.readFileSync(guard, 'utf8');
  it('checks for UNC before the first filesystem call', () => {
    const fn = src.slice(src.indexOf('function Test-PathAllowedForRead'));
    expect(fn.indexOf("'unc_path_blocked'")).toBeGreaterThan(-1);
    expect(fn.indexOf("'unc_path_blocked'")).toBeLessThan(fn.indexOf('Resolve-RealPath $resolved'));
  });
  it('resolves the profile folder too, and trims its trailing backslash', () => {
    expect(src).toContain('Resolve-RealPath ([System.IO.Path]::GetFullPath($userHome))');
    expect(src).toContain("$userHome = $userHome.TrimEnd('\\')");
    expect(src).not.toContain("TrimEnd('')");
  });
  it('is ASCII only (Windows PowerShell 5.1 reads a BOM-less script as ANSI)', () => {
    // eslint-disable-next-line no-control-regex
    expect(src).toMatch(/^[\x00-\x7F]*$/);
  });
});
