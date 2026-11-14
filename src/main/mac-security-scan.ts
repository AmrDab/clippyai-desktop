/**
 * mac-security-scan.ts — macOS counterpart of assets/scripts/security-scan.ps1
 * (security_sweep). Read-only second opinion on the places software can
 * auto-start or hide on a Mac: LaunchAgents/LaunchDaemons, login items, the
 * user's crontab, configuration profiles, running programs in odd places,
 * /etc/hosts and shell startup files that pipe a download into a shell.
 *
 * Never modifies anything, never uses sudo, never builds shell strings:
 * every command is execFile with explicit args. The analysis is pure and
 * takes collected facts, so it is unit-tested with fixtures
 * (tests/mac-security-scan.test.ts). Output mirrors the Windows script's
 * shape (verdict, summary, sections, findings, notes).
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { redactSecrets } from './input-triggers'; // the app's existing secret masker (keys, long digit/hex runs)
import pathMod from 'path';
const path = pathMod.posix; // macOS paths, whatever the host running the unit tests

export type MacSection = 'autoruns' | 'tasks' | 'services' | 'processes' | 'system';
export const MAC_SECTIONS: MacSection[] = ['autoruns', 'tasks', 'services', 'processes', 'system'];

export type Severity = 'high' | 'medium' | 'low';

export interface Signal { code: string; why: string }
export interface Finding {
  severity: Severity;
  title: string;
  name: string;
  source: string;
  location: string;
  path?: string;
  signer?: string;
  signatureStatus?: string;
  plainEnglish: string;
  signals: Signal[];
  recommendation: string;
}

/** A launchd job / login item / cron line / running process, as collected. */
export interface Entry {
  source: 'LaunchAgent' | 'LaunchDaemon' | 'LoginItem' | 'Cron' | 'Process';
  location: string; // plist path, "crontab", ...
  name: string;     // label / app name
  program?: string; // executable path
  args?: string[];
  runAtLoad?: boolean;
  keepAlive?: boolean;
}

export interface SigInfo { status: 'signed' | 'unsigned' | 'unknown'; signer?: string; apple?: boolean }

export interface MacFacts {
  entries: Entry[];
  /** Per executable path. Missing key = not checked. */
  signatures: Record<string, SigInfo>;
  /** Paths that no longer exist on disk (program checked with fs.existsSync). */
  missing: Set<string>;
  hosts?: string;
  rcFiles?: Array<{ file: string; text: string }>;
  profiles?: string;
  systemJobCounts?: { agents: number; daemons: number };
  notes: string[];
  sections: MacSection[];
}

/**
 * Command text only ever leaves this scanner redacted: URL userinfo and
 * query/fragment, Authorization headers and Bearer tokens, NAME=value
 * assignments and --token style flags, then the app's shared masker, then any
 * long high-entropy token. Only high-severity findings (curl|sh) quote any
 * command text at all.
 */
export function redactCommand(text: string): string {
  const s = text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"']*@/gi, '$1')            // user:pass@host -> host
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']*)[?#][^\s"']*/gi, '$1')  // ?query / #fragment
    .replace(/authorization\s*:\s*[^"'\n]*/gi, 'Authorization: [redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(--?[\w-]*(?:token|secret|key|pass|pwd|auth|cookie)[\w-]*)(?:=|\s+)(?!-)\S+/gi, '$1=[redacted]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=[redacted]');
  return redactSecrets(s)
    .replace(/(?<![\w/.~-])(?=[A-Za-z0-9_+=-]*\d)(?=[A-Za-z0-9_+=-]*[A-Za-z])[A-Za-z0-9_+=-]{24,}(?![\w/-])/g, '[redacted-token]');
}

const HOME_RE = (home: string) => new RegExp('^' + home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'python', 'python3', 'perl', 'ruby', 'osascript', 'curl', 'wget', 'node', 'nc', 'ncat']);

/** Where installed software normally lives. */
function isStandardLocation(p: string, home: string): boolean {
  return /^(\/System\/|\/usr\/(?!local\/tmp)|\/bin\/|\/sbin\/|\/Applications\/|\/Library\/(?!Caches)|\/opt\/homebrew\/|\/usr\/local\/)/.test(p)
    || HOME_RE(home).test(p) && /^\/[^/]+\/[^/]+\/(Applications|Library\/Application Support)\//.test(p);
}

/** Temp, Downloads and hidden folders: nothing legitimate installs itself to auto-start from there. */
function oddLocation(p: string, home: string): string | null {
  if (/^(\/private)?\/(tmp|var\/tmp|var\/folders)\//.test(p)) return 'a temporary folder';
  if (p.startsWith(path.join(home, 'Downloads') + '/')) return 'your Downloads folder';
  if (p.startsWith('/Users/Shared/')) return 'the shared Users folder';
  if (/\/\.[^/.][^/]*\//.test(p.replace(home, ''))) return 'a hidden folder';
  return null;
}

function launcherNote(e: Entry): { code: string; why: string } | null {
  const prog = e.program ? path.basename(e.program) : '';
  if (!INTERPRETERS.has(prog)) return null;
  const joined = (e.args ?? []).join(' ');
  if (/(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(joined)) {
    return { code: 'launcher_download_and_run', why: `It starts through ${prog} and downloads a script straight into a shell: "${redactCommand(joined).slice(0, 120)}".` };
  }
  if (/(^|\s)-(c|e)\b/.test(joined) || /base64\s+(-d|--decode)/.test(joined)) {
    return { code: 'launcher_inline_command', why: `It runs an inline ${prog} command rather than an installed program.` };
  }
  return null;
}

function makeFinding(e: Entry, severity: Severity, title: string, signals: Signal[], sig: SigInfo | undefined, recommendation: string): Finding {
  return {
    severity,
    title,
    name: e.name,
    source: e.source,
    location: e.location,
    path: e.program,
    signer: sig?.signer,
    signatureStatus: sig?.status,
    plainEnglish: signals.map((s) => s.why).join(' '),
    signals,
    recommendation,
  };
}

const REC_CHECK = 'If you do not recognise it, check which app installed it before deciding anything. Clippy has not changed or removed anything.';

export interface MacScanResult {
  ok: true;
  readOnly: true;
  platform: 'macOS';
  verdict: string;
  summary: { high: number; medium: number; low: number; checked: number; trusted: number };
  sections: MacSection[];
  findings: Finding[];
  trusted: Array<{ name: string; source: string; path?: string; signer?: string }>;
  notes: string[];
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function analyzeMac(facts: MacFacts, home: string = os.homedir(), maxFindings = 50): MacScanResult {
  const findings: Finding[] = [];
  const trusted: MacScanResult['trusted'] = [];
  let checked = 0;

  for (const e of facts.entries) {
    checked++;
    const signals: Signal[] = [];
    let severity: Severity = 'low';
    const bump = (s: Severity) => { if (SEV_ORDER[s] < SEV_ORDER[severity]) severity = s; };
    const prog = e.program ?? '';
    const sig = prog ? facts.signatures[prog] : undefined;
    const userScope = e.location.startsWith(home) || e.source === 'LoginItem' || e.source === 'Cron';

    if (/^com\.apple\./i.test(e.name) && (e.source === 'LaunchAgent' || e.source === 'LaunchDaemon')
      && !e.location.startsWith('/System/')) {
      signals.push({ code: 'name_mimics_apple', why: `It is called "${e.name}", the naming used by macOS itself, but it was installed outside the system folders. Malware borrows these names to blend in.` });
      bump('high');
    }
    const odd = prog ? oddLocation(prog, home) : null;
    if (odd) {
      // A running program is not an auto-start item. From a hidden folder it is
      // usually a developer tool (~/.nvm, ~/.pyenv, ~/.cargo), so medium there;
      // temp/Downloads stay high (Mac test report, item 11).
      const proc = e.source === 'Process';
      signals.push({ code: 'unusual_location', why: proc
        ? `It is running from ${odd} (${prog}). Developer tools often live in hidden folders; other software rarely runs from there.`
        : `It starts automatically from ${odd} (${prog}). Installed software does not normally auto-start from there.` });
      bump(proc && odd === 'a hidden folder' ? 'medium' : 'high');
    }
    const launcher = launcherNote(e);
    if (launcher) {
      signals.push(launcher);
      bump(launcher.code === 'launcher_download_and_run' ? 'high' : 'medium');
    }
    if (prog && facts.missing.has(prog)) {
      signals.push({ code: 'target_missing', why: `It points to "${prog}", which does not exist any more. Usually a leftover from an uninstalled app, but it shows something was set to auto-start.` });
      bump('low');
    }
    if (sig && sig.status === 'unsigned' && !isStandardLocation(prog, home) && !odd) {
      signals.push({ code: 'unsigned', why: 'The program is not code-signed, so macOS cannot say who made it.' });
      bump('medium');
    }
    if (e.source === 'Cron') {
      const cronText = (e.args ?? []).join(' ');
      const cronHigh = /(curl|wget)\b[^|;]*\|\s*(ba|z)?sh\b/.test(cronText);
      signals.push({ code: 'cron_entry', why: cronHigh
        ? `Your crontab downloads and runs code on a schedule: "${redactCommand(cronText).slice(0, 120)}".`
        : `Your crontab runs "${e.name}" on a schedule. Few people use cron on a Mac today, so it is worth knowing it is there.` });
      bump(cronHigh ? 'high' : 'low');
    }
    if (e.source === 'LoginItem' && prog && !isStandardLocation(prog, home) && !sig) {
      signals.push({ code: 'login_item_unusual_path', why: `A login item starts from "${prog}", outside the usual app folders.` });
      bump('medium');
    }

    if (signals.length === 0) {
      trusted.push({ name: e.name, source: e.source, path: e.program, signer: sig?.signer });
      continue;
    }
    const title = signals[0].code === 'name_mimics_apple' ? 'Pretends to be part of macOS'
      : signals[0].code === 'target_missing' ? 'Leftover start-up entry'
      : signals[0].code === 'cron_entry' ? 'Scheduled command in your crontab'
      : e.source === 'Process' ? 'Program running from an unusual place'
      : 'Unusual item that starts by itself';
    findings.push(makeFinding(e, severity, title, signals, sig, REC_CHECK));
  }

  // Hijack points: /etc/hosts
  if (facts.hosts !== undefined) {
    checked++;
    for (const raw of facts.hosts.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const [ip, ...names] = line.split(/\s+/);
      if (!names.length) continue;
      const loop = ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === 'fe80::1%lo0' || ip === '255.255.255.255';
      const standard = names.every((n) => ['localhost', 'broadcasthost'].includes(n.toLowerCase()));
      if (standard) continue;
      const redirect = !loop;
      findings.push({
        severity: redirect ? 'medium' : 'low',
        title: redirect ? 'A website is redirected in /etc/hosts' : 'A website is blocked in /etc/hosts',
        name: names.join(', '), source: 'hosts', location: '/etc/hosts',
        plainEnglish: redirect
          ? `/etc/hosts sends ${names.join(', ')} to ${ip} instead of the real server. Malware uses this to impersonate sites; some people do it on purpose.`
          : `/etc/hosts blocks ${names.join(', ')} (points it at this Mac). Ad blockers and some tools do this on purpose.`,
        signals: [{ code: redirect ? 'hosts_redirect' : 'hosts_block', why: line }],
        recommendation: 'Only matters if you did not add it or do not use a tool that does. Clippy has not changed the file.',
      });
    }
  }

  // Hijack points: shell startup files
  for (const rc of facts.rcFiles ?? []) {
    checked++;
    const hits = rc.text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')
      && (/(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(l)
        || /base64\s+(-d|--decode)[^|]*\|\s*(ba|z)?sh\b/.test(l)
        || /\beval\s+["'`$(]*\s*(curl|wget)\b/.test(l)));
    if (hits.length) {
      findings.push({
        severity: 'high',
        title: 'A shell startup file downloads and runs code',
        name: path.basename(rc.file), source: 'ShellStartup', location: rc.file,
        plainEnglish: `${rc.file} runs downloaded code every time Terminal opens: "${redactCommand(hits[0].trim()).slice(0, 140)}". Some installers add lines like this on purpose, but it is a common way for malware to persist.`,
        signals: [{ code: 'rc_download_and_run', why: redactCommand(hits[0].trim()).slice(0, 200) }],
        recommendation: 'If you did not add the line yourself or through a tool you trust, look at it before opening Terminal again. Clippy has not changed the file.',
      });
    }
  }

  // Configuration profiles
  if (facts.profiles !== undefined) {
    checked++;
    const names = [...facts.profiles.matchAll(/profileIdentifier:\s*(\S+)/gi)].map((m) => m[1]);
    if (names.length) {
      findings.push({
        severity: 'medium',
        title: `${names.length} configuration profile(s) installed`,
        name: names.slice(0, 5).join(', '), source: 'Profiles', location: 'System Settings → Privacy & Security → Profiles',
        plainEnglish: `Configuration profiles can set proxies, certificates and restrictions on this Mac. Found: ${names.slice(0, 5).join(', ')}. Normal on a work or school Mac; unexpected on a personal one.`,
        signals: [{ code: 'profiles_present', why: `${names.length} profile(s) installed` }],
        recommendation: 'On a personal Mac, open System Settings → Privacy & Security → Profiles and check you recognise them.',
      });
    }
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const notes = [...facts.notes];
  if (facts.systemJobCounts) notes.push(`macOS itself ships ${facts.systemJobCounts.agents} launch agents and ${facts.systemJobCounts.daemons} launch daemons in /System/Library; those are not listed.`);
  let shown = findings;
  if (findings.length > maxFindings) { shown = findings.slice(0, maxFindings); notes.push(`Showing ${maxFindings} of ${findings.length} findings.`); }

  const summary = {
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    checked, trusted: trusted.length,
  };
  let verdict = 'No warning signs found. Everything that starts by itself is signed or lives where installed software belongs.';
  if (summary.high > 0) verdict = `${summary.high} item(s) need a closer look. Read the explanations below; if you do not recognise them, consider running a malware scan.`;
  else if (summary.medium > 0) verdict = `${summary.medium} item(s) are unusual but not necessarily harmful. Check whether you recognise them.`;
  else if (summary.low > 0) verdict = 'Only minor notes (leftover entries or informational items). Nothing looks harmful.';

  return { ok: true, readOnly: true, platform: 'macOS', verdict, summary, sections: facts.sections, findings: shown, trusted, notes };
}

// ── Collection (execFile only; injectable for tests) ──────────────────

export interface CollectDeps {
  home: string;
  /** execFile with explicit args; resolves stdout+stderr, rejects with .stdout/.stderr on failure. */
  run(cmd: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  readdir(dir: string): string[];
  readFile(file: string, maxBytes?: number): string | null;
  exists(p: string): boolean;
}

export const realDeps: CollectDeps = {
  home: os.homedir(),
  run: (cmd, args, timeoutMs = 8000) => new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  }),
  readdir: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
  readFile: (f, max = 256 * 1024) => { try { return fs.readFileSync(f, 'utf8').slice(0, max); } catch { return null; } },
  exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
};

async function readPlist(deps: CollectDeps, file: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await deps.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file], 4000);
    const j = JSON.parse(stdout) as unknown;
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch { return null; }
}

async function launchEntries(deps: CollectDeps, dir: string, source: 'LaunchAgent' | 'LaunchDaemon', notes: string[]): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const f of deps.readdir(dir).filter((n) => n.endsWith('.plist')).slice(0, 300)) {
    const file = path.join(dir, f);
    const p = await readPlist(deps, file);
    if (!p) { notes.push(`Could not read ${file}.`); continue; }
    const pa = Array.isArray(p.ProgramArguments) ? (p.ProgramArguments as unknown[]).map(String) : [];
    const program = typeof p.Program === 'string' ? p.Program : pa[0];
    out.push({
      source, location: file, name: typeof p.Label === 'string' ? p.Label : f.replace(/\.plist$/, ''),
      program, args: typeof p.Program === 'string' ? pa : pa.slice(1),
      runAtLoad: p.RunAtLoad === true, keepAlive: p.KeepAlive === true,
    });
  }
  return out;
}

export async function signatureOf(deps: CollectDeps, file: string): Promise<SigInfo> {
  try {
    const r = await deps.run('/usr/bin/codesign', ['-d', '--verbose=2', '--', file], 4000);
    return parseCodesign(r.stderr || r.stdout);
  } catch (err) {
    const text = String((err as { stderr?: string }).stderr ?? '');
    if (/not signed at all/i.test(text)) return { status: 'unsigned' };
    if (/Authority=/.test(text)) return parseCodesign(text);
    return { status: 'unknown' };
  }
}

export function parseCodesign(text: string): SigInfo {
  const auth = [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1].trim());
  if (auth.length === 0) return /not signed at all/i.test(text) ? { status: 'unsigned' } : { status: 'unknown' };
  const apple = auth.some((a) => /^(Software Signing|Apple Code Signing Certification Authority|Apple Root CA)$/.test(a));
  return { status: 'signed', signer: auth[0], apple };
}

/** The program a crontab line runs (basename of its first command word), for display. */
export function cronProgramName(line: string): string {
  const fields = line.trim().startsWith('@') ? line.trim().split(/\s+/).slice(1) : line.trim().split(/\s+/).slice(5);
  const cmd = fields.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? '';
  return path.basename(cmd.replace(/^["']|["']$/g, '')) || 'scheduled command';
}

export async function collectMac(sections: MacSection[], deps: CollectDeps = realDeps): Promise<MacFacts> {
  const notes: string[] = [];
  const entries: Entry[] = [];
  const want = (s: MacSection) => sections.includes(s);
  const facts: MacFacts = { entries, signatures: {}, missing: new Set(), notes, sections };
  const H = deps.home;

  if (want('autoruns')) {
    entries.push(...await launchEntries(deps, path.join(H, 'Library/LaunchAgents'), 'LaunchAgent', notes));
    entries.push(...await launchEntries(deps, '/Library/LaunchAgents', 'LaunchAgent', notes));
    try {
      const { stdout } = await deps.run('/usr/bin/osascript', ['-e', 'tell application "System Events" to get the name of every login item'], 5000);
      for (const n of stdout.split(',').map((s) => s.trim()).filter(Boolean)) {
        entries.push({ source: 'LoginItem', location: 'Login Items', name: n });
      }
    } catch { notes.push('Login items could not be read (macOS may ask for permission to control System Events; nothing was changed).'); }
    facts.systemJobCounts = {
      agents: deps.readdir('/System/Library/LaunchAgents').length,
      daemons: deps.readdir('/System/Library/LaunchDaemons').length,
    };
  }
  if (want('services')) {
    entries.push(...await launchEntries(deps, '/Library/LaunchDaemons', 'LaunchDaemon', notes));
  }
  if (want('tasks')) {
    try {
      const { stdout } = await deps.run('/usr/bin/crontab', ['-l'], 4000);
      for (const l of stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))) {
        entries.push({ source: 'Cron', location: 'crontab', name: cronProgramName(l), args: [l] });
      }
    } catch { /* "no crontab for user" exits 1 — nothing scheduled */ }
  }
  if (want('processes')) {
    try {
      const { stdout } = await deps.run('/bin/ps', ['-axo', 'pid=,comm='], 5000);
      const seen = new Set<string>();
      for (const l of stdout.split('\n')) {
        const m = l.trim().match(/^(\d+)\s+(\/.+)$/);
        if (!m || seen.has(m[2])) continue;
        seen.add(m[2]);
        if (oddLocation(m[2], H)) entries.push({ source: 'Process', location: `pid ${m[1]}`, name: path.basename(m[2]), program: m[2] });
      }
    } catch { notes.push('Running programs could not be listed.'); }
  }
  if (want('system')) {
    facts.hosts = deps.readFile('/etc/hosts') ?? undefined;
    facts.rcFiles = ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bash_profile', '.bashrc', '.profile']
      .map((f) => path.join(H, f)).map((file) => ({ file, text: deps.readFile(file) })).filter((x): x is { file: string; text: string } => x.text !== null);
    try {
      const { stdout } = await deps.run('/usr/bin/profiles', ['list'], 5000);
      facts.profiles = stdout;
    } catch { notes.push('Configuration profiles could not be listed without administrator rights; skipped.'); }
  }

  // Signatures for programs we will judge (bounded: each codesign is a process).
  const progs = [...new Set(entries.map((e) => e.program).filter((p): p is string => !!p))].slice(0, 60);
  for (const p of progs) {
    if (!deps.exists(p)) { facts.missing.add(p); continue; }
    facts.signatures[p] = await signatureOf(deps, p);
  }
  return facts;
}

export async function runMacSecurityScan(sections: MacSection[], deps: CollectDeps = realDeps, maxFindings = 50): Promise<MacScanResult> {
  const facts = await collectMac(sections, deps);
  return analyzeMac(facts, deps.home, maxFindings);
}

/** The model-facing tool takes the Windows section names; map them (defender has no Mac equivalent). */
export function parseMacSections(raw: string): MacSection[] {
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase());
  const out = MAC_SECTIONS.filter((s) => wanted.includes(s));
  return out.length ? out : ['autoruns', 'system'];
}
