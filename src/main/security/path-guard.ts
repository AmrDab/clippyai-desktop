/**
 * path-guard.ts — which paths a read tool may open without asking.
 *
 * TypeScript port of assets/scripts/_path-guard.ps1 (Test-PathAllowedForRead)
 * for the fs-based read_file / list_files / search_files_content, which had no
 * guard at all (0.24.12 audit #2), and for attachment paths.
 *
 * A guarded path is not refused: assessRisk (tools.ts) turns it into an
 * approval, so the user can still say yes. Everything else reads unasked.
 *
 * The check runs on the REAL path: symlinks, junctions and Windows 8.3 short
 * names (C:\Users\me\APPDAT~1) are resolved first, so an alias of a guarded
 * folder is guarded too. The guarded roots (home, userData) are resolved the
 * same way, and the comparison ignores case. UNC paths are guarded: opening one makes Windows
 * authenticate to a server the path names.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface PathCheck {
  allowed: boolean;
  /** The real path that was judged ('' when it could not be resolved). */
  resolved: string;
  /** 'ok', or why it is guarded: unc_path, secret_path, browser_profile, credential_store, clippy_config. */
  reason: string;
}

export interface PathGuardEnv {
  home?: string;
  platform?: NodeJS.Platform;
  /** Extra guarded directories (the app's userData dir). */
  extraDirs?: string[];
  /** Injected for tests; defaults to fs.promises.realpath (native: resolves 8.3 names). */
  realpath?: (p: string) => Promise<string>;
}

const isUnc = (p: string) => /^[\\/]{2}(?![?.][\\/][a-z]:)/i.test(p);
/** `\\?\C:\x` and `\\.\C:\x` are local paths with a prefix; drop it. */
const stripDevicePrefix = (p: string) => p.replace(/^[\\/]{2}[?.][\\/](?=[a-z]:)/i, '');

/** Lower-case, forward slashes, no trailing slash: one form for comparisons. */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function under(p: string, dir: string): boolean {
  const d = norm(dir);
  return !!d && (p === d || p.startsWith(d + '/'));
}

// Relative to the home directory.
const HOME_SECRETS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.config/gh', '.config/gcloud',
  '.git-credentials', '.netrc', '.docker/config.json',
  '.clawdcursor', '.clippyai',
];
const HOME_CREDENTIAL_STORES = [
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Credentials',
  'AppData/Local/Microsoft/Vault',
  'AppData/Roaming/Microsoft/Vault',
  'AppData/Roaming/Microsoft/Protect',
  'AppData/Roaming/Microsoft/Windows/Recent/CustomDestinations',
  'Library/Keychains',
  'Library/Cookies',
];
const HOME_BROWSER_PROFILES = [
  'AppData/Roaming/Mozilla/Firefox/Profiles',
  'AppData/Roaming/Opera Software',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Firefox/Profiles',
  'Library/Application Support/Arc/User Data',
  'Library/Safari',
  '.config/google-chrome',
  '.config/chromium',
  '.config/microsoft-edge',
  '.mozilla/firefox',
];
const HOME_CLIPPY_CONFIG = [
  'AppData/Roaming/ClippyAI',
  'Library/Application Support/ClippyAI',
  '.config/ClippyAI',
];
// Absolute, Windows only: the SAM / SECURITY hives and the machine DPAPI keys.
const SYSTEM_CREDENTIAL_STORES = [
  'C:/Windows/System32/config',
  'C:/ProgramData/Microsoft/Crypto',
  'C:/ProgramData/Microsoft/Vault',
];

/** Judge an already-resolved absolute path. Pure. */
export function judgeResolvedPath(resolved: string, env: PathGuardEnv = {}): PathCheck {
  const real = stripDevicePrefix(resolved);
  if (isUnc(real)) return { allowed: false, resolved: real, reason: 'unc_path' };
  const p = norm(real);
  const home = env.home ?? os.homedir();
  const inHome = (rel: string) => under(p, path.posix.join(norm(home), rel));

  if (HOME_SECRETS.some(inHome)) return { allowed: false, resolved: real, reason: 'secret_path' };
  // Chromium keeps every profile (cookies, saved logins, session tokens) under
  // a folder named "User Data" below the per-user app-data folder.
  if (/\/(appdata|application support|\.config)\/.*\/user data(\/|$)/.test(p) || HOME_BROWSER_PROFILES.some(inHome)) {
    return { allowed: false, resolved: real, reason: 'browser_profile' };
  }
  if (HOME_CREDENTIAL_STORES.some(inHome) || SYSTEM_CREDENTIAL_STORES.some((d) => under(p, d))) {
    return { allowed: false, resolved: real, reason: 'credential_store' };
  }
  if (HOME_CLIPPY_CONFIG.some(inHome) || (env.extraDirs ?? []).some((d) => under(p, d))) {
    return { allowed: false, resolved: real, reason: 'clippy_config' };
  }
  return { allowed: true, resolved: real, reason: 'ok' };
}

/** `~` and `~/x` to the home directory. */
export function expandHomePath(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/**
 * The real path of `abs`: the nearest existing ancestor is resolved (links,
 * 8.3 names) and the part that does not exist yet is appended unchanged.
 */
async function realPathOf(abs: string, realpath: (p: string) => Promise<string>): Promise<string> {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The guard env with its roots (home, extraDirs) resolved the same way a
 * candidate path is: links followed, 8.3 names expanded, a folder that does
 * not exist yet resolved from its deepest existing ancestor.
 *
 * Both sides must be canonical or they do not match: on a Windows CI runner
 * the profile is C:\Users\runneradmin while TEMP is C:\Users\RUNNER~1\...,
 * and on macOS /var/folders/... is really /private/var/folders/....
 */
export async function canonicalGuardEnv(env: PathGuardEnv = {}): Promise<PathGuardEnv> {
  const realpath = env.realpath ?? ((p: string) => fs.promises.realpath(p));
  const canon = async (p: string): Promise<string> => {
    if (!p || isUnc(p)) return p; // never touch a network path
    try { return await realPathOf(path.resolve(stripDevicePrefix(p)), realpath); } catch { return p; }
  };
  return {
    ...env,
    home: await canon(env.home ?? os.homedir()),
    extraDirs: await Promise.all((env.extraDirs ?? []).map(canon)),
  };
}

/** Resolve `rawPath` to its real location and judge it. Never throws. */
export async function checkReadPath(rawPath: string, env: PathGuardEnv = {}): Promise<PathCheck> {
  const raw = String(rawPath ?? '').trim();
  if (!raw) return { allowed: false, resolved: '', reason: 'empty_path' };
  // Before any filesystem call: resolving a UNC path already contacts the server.
  if (isUnc(raw)) return { allowed: false, resolved: raw, reason: 'unc_path' };
  const home = env.home ?? os.homedir();
  const abs = path.resolve(expandHomePath(stripDevicePrefix(raw), home));
  const written: PathGuardEnv = { ...env, home };
  // Judge the path as written too: a guarded name must not pass because the
  // lookup failed.
  const asWritten = judgeResolvedPath(abs, written);
  if (!asWritten.allowed) return asWritten;
  const real = await realPathOf(abs, env.realpath ?? ((p) => fs.promises.realpath(p)));
  // Real path against the real roots, and each against the other form, so an
  // alias on either side (or both) cannot slip between them.
  const canonical = await canonicalGuardEnv(written);
  for (const [p, e] of [[real, canonical], [real, written], [abs, canonical]] as const) {
    const verdict = judgeResolvedPath(p, e);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true, resolved: stripDevicePrefix(real), reason: 'ok' };
}

const REASON_TEXT: Record<string, string> = {
  unc_path: 'a network share',
  secret_path: 'a folder that holds keys or credentials',
  browser_profile: 'a browser profile (cookies, saved logins)',
  credential_store: 'a Windows or macOS credential store',
  clippy_config: "Clippy's own settings and keys",
  empty_path: 'an empty path',
};

/** One line for the approval card. */
export function describePathBlock(check: PathCheck): string {
  return REASON_TEXT[check.reason] ?? 'a protected location';
}
