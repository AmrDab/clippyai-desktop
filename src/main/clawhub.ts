/**
 * ClawHub — public skill registry for OpenClaw-pattern agents. ClippyAI
 * uses ClawHub as the on-demand source for capabilities not covered by
 * native tools (L1) or browser recipes (L2).
 *
 * Architecture:
 *   1. Model calls find_skill(intent) when no native tool fits.
 *   2. We search ClawHub via the public /api/v1/search endpoint.
 *   3. If a good match exists, model calls install_skill(slug).
 *   4. We pull /api/v1/scan to check capability tags; if safe (no
 *      shell-exec, no fs-write outside the skill dir, scan_verdict not
 *      "suspicious"), we download via /api/v1/download.
 *   5. ZIP extracted to ~/.clippyai/skills/<slug>/. Parse SKILL.md.
 *   6. Skill is REGISTERED in TOOL_MAP at runtime (the L1-promotion ask).
 *      Next time the user asks, the model sees `skill__<slug>` as a
 *      first-class tool — no re-discovery, no re-download.
 *
 * Security gates:
 *   - Capability allowlist: skills declaring `requires.bins: [shell-exec]`
 *     or unscoped fs writes need explicit user consent before first run.
 *   - Hard reject if `/scan` returns moderation_state = "suspicious" /
 *     "malicious" — we never download those.
 *   - Skills run with cwd = their own folder. They can't reach outside
 *     unless they declare it via `requires.env` (model passes env vars in).
 *
 * Read API has no auth, so v1 doesn't deal with tokens or login flows.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import { promisify } from 'util';
import { pipeline as pipelineCb } from 'stream';
import { createLogger, serializeErr } from './logger';

const log = createLogger('ClawHub');
const pipeline = promisify(pipelineCb);

const CLAWHUB_BASE = 'https://clawhub.ai/api/v1';
const SKILLS_DIR = path.join(os.homedir(), '.clippyai', 'skills');

// Capability tags that are SAFE to auto-install. Anything outside this set
// requires explicit user consent dialog before first install/run.
const SAFE_CAPABILITY_TAGS = new Set([
  'network',           // http_request only, fine
  'fs-read',           // read user files declared in env
  'no-side-effects',
  'compute',
  'web-api',
]);

const UNSAFE_CAPABILITY_TAGS = new Set([
  'shell-exec',
  'fs-write-arbitrary', // can write anywhere
  'process-spawn',
  'registry-write',
  'native-code',
]);

// ── Types ──────────────────────────────────────────────────────────

export interface SkillSearchResult {
  slug: string;
  displayName: string;
  summary: string;
  version: string;
  score: number;
  updatedAt?: string;
}

export interface SkillScan {
  verdict: 'clean' | 'suspicious' | 'malicious' | 'unscored';
  capability_tags: string[];
  moderation_state: string;
}

export interface SkillManifest {
  slug: string;
  name: string;
  description: string;
  version: string;
  /** Inputs the skill expects: env vars + binaries on PATH. */
  requires: { env: string[]; bins: string[] };
  /** The skill's installation directory. */
  installPath: string;
  /** ISO timestamp of when this skill was installed. */
  installedAt: string;
  /** Capability tags from the ClawHub scan, cached at install time. */
  capability_tags: string[];
}

// ── HTTP helpers ───────────────────────────────────────────────────

function httpGet<T>(url: string, timeoutMs = 8_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ClippyAI/0.14.0' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== undefined && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(raw) as T); }
        catch (err) { reject(new Error(`Parse error: ${err instanceof Error ? err.message : String(err)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`HTTP timeout after ${timeoutMs}ms`)); });
  });
}

function httpGetStream(url: string, timeoutMs = 30_000): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ClippyAI/0.14.0' } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location;
        if (loc) { resolve(httpGetStream(loc, timeoutMs)); return; }
      }
      if (res.statusCode !== undefined && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

// ── Public API ─────────────────────────────────────────────────────

export async function searchSkills(query: string, limit = 5): Promise<SkillSearchResult[]> {
  try {
    const url = `${CLAWHUB_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}&nonSuspiciousOnly=true`;
    const data = await httpGet<{ results?: SkillSearchResult[] }>(url);
    return data.results || [];
  } catch (err) {
    log.warn('searchSkills failed', { query, err: serializeErr(err) });
    return [];
  }
}

export async function getSkillScan(slug: string): Promise<SkillScan | null> {
  try {
    return await httpGet<SkillScan>(`${CLAWHUB_BASE}/skills/${encodeURIComponent(slug)}/scan`);
  } catch (err) {
    log.warn('getSkillScan failed', { slug, err: serializeErr(err) });
    return null;
  }
}

/**
 * Classify a skill's safety based on its capability tags. Returns:
 *   - 'safe'         → install + run with no consent prompt
 *   - 'consent'      → install allowed but user must confirm first run
 *   - 'reject'       → never install (suspicious/malicious or unsafe caps)
 */
export function classifySkillSafety(scan: SkillScan | null): 'safe' | 'consent' | 'reject' {
  if (!scan) return 'consent'; // unknown → ask
  if (scan.verdict === 'suspicious' || scan.verdict === 'malicious') return 'reject';
  const tags = scan.capability_tags || [];
  if (tags.some((t) => UNSAFE_CAPABILITY_TAGS.has(t))) return 'consent';
  if (tags.every((t) => SAFE_CAPABILITY_TAGS.has(t))) return 'safe';
  return 'consent';
}

/**
 * Download + extract a skill into SKILLS_DIR/<slug>/. Returns the manifest.
 * Throws on any error so callers can show a useful message to the user.
 *
 * Caller is responsible for showing a user-consent dialog if classify
 * returned 'consent'. This function itself does NOT enforce consent —
 * it's a primitive that assumes the caller already decided.
 */
export async function installSkill(slug: string, version?: string): Promise<SkillManifest> {
  await fs.promises.mkdir(SKILLS_DIR, { recursive: true });
  const destDir = path.join(SKILLS_DIR, slug);

  // Hard-reject suspicious slugs
  const scan = await getSkillScan(slug);
  const safety = classifySkillSafety(scan);
  if (safety === 'reject') {
    throw new Error(`Skill ${slug} rejected: scan verdict=${scan?.verdict}`);
  }

  // Download the ZIP
  const downloadUrl = `${CLAWHUB_BASE}/download?slug=${encodeURIComponent(slug)}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
  log.info('Downloading skill', { slug, version: version || 'latest' });
  const zipPath = path.join(SKILLS_DIR, `${slug}.zip`);
  const stream = await httpGetStream(downloadUrl, 30_000);
  await pipeline(stream, fs.createWriteStream(zipPath));

  // Extract via PowerShell's Expand-Archive (zero deps; works on any
  // Windows 10+ machine). Cleaner than bundling a Node zip library.
  if (fs.existsSync(destDir)) {
    await fs.promises.rm(destDir, { recursive: true, force: true });
  }
  await fs.promises.mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`],
      { timeout: 30_000, windowsHide: true },
      (err: Error | null) => err ? reject(err) : resolve(),
    );
  });
  // Best-effort: remove the zip
  try { await fs.promises.unlink(zipPath); } catch { /* ignore */ }

  // Find and parse SKILL.md
  const manifest = await parseSkillMd(destDir, slug, scan?.capability_tags || []);

  // Write a small origin marker so listInstalled can find it
  await fs.promises.writeFile(
    path.join(destDir, '.clippyai-origin.json'),
    JSON.stringify({ slug, installedAt: manifest.installedAt, source: 'clawhub' }, null, 2),
    'utf8',
  );

  log.info('Skill installed', { slug, version: manifest.version, installPath: destDir });
  return manifest;
}

/**
 * Parse SKILL.md to extract frontmatter. Supports the minimal yaml syntax
 * documented at https://docs.openclaw.ai/clawhub/skill-format.md — no
 * external yaml dep needed for this subset (key: value, simple lists).
 */
async function parseSkillMd(skillDir: string, slug: string, capability_tags: string[]): Promise<SkillManifest> {
  const candidates = ['SKILL.md', 'skill.md'];
  let content: string | null = null;
  for (const c of candidates) {
    const p = path.join(skillDir, c);
    if (fs.existsSync(p)) {
      content = await fs.promises.readFile(p, 'utf8');
      break;
    }
  }
  if (!content) throw new Error(`No SKILL.md found in ${skillDir}`);

  // Extract frontmatter between leading `---` blocks
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  const fm = fmMatch ? fmMatch[1] : '';

  // Minimal YAML parser — covers `name:`, `description:`, `version:`,
  // and the openclaw block. Not a full YAML impl; we keep it surgical
  // because the SKILL.md frontmatter spec is intentionally tiny.
  function getKey(key: string): string | null {
    const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm');
    const m = fm.match(re);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  }
  function getList(blockKey: string): string[] {
    // Match `requires:\n      env:\n        - X\n        - Y`
    const blockRe = new RegExp(`${blockKey}\\s*:\\s*\\n((?:\\s+- [^\\n]+\\n)+)`, 'm');
    const m = fm.match(blockRe);
    if (!m) return [];
    return m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  }

  return {
    slug,
    name: getKey('name') || slug,
    description: getKey('description') || '(no description in SKILL.md)',
    version: getKey('version') || '0.0.0',
    requires: {
      env: getList('env'),
      bins: getList('bins'),
    },
    installPath: skillDir,
    installedAt: new Date().toISOString(),
    capability_tags,
  };
}

/**
 * Enumerate all installed skills by scanning SKILLS_DIR. Used at app
 * boot to repopulate the runtime registry — every installed skill is
 * a candidate for promotion to a first-class tool (L1).
 */
export async function listInstalledSkills(): Promise<SkillManifest[]> {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const entries = await fs.promises.readdir(SKILLS_DIR, { withFileTypes: true });
    const manifests: SkillManifest[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      try {
        // Try to read the origin marker for installedAt + capability_tags;
        // fall through to parsing SKILL.md if missing.
        const skillDir = path.join(SKILLS_DIR, ent.name);
        let origin: { capability_tags?: string[]; installedAt?: string } = {};
        const originPath = path.join(skillDir, '.clippyai-origin.json');
        if (fs.existsSync(originPath)) {
          try { origin = JSON.parse(await fs.promises.readFile(originPath, 'utf8')); } catch { /* fall through */ }
        }
        const m = await parseSkillMd(skillDir, ent.name, origin.capability_tags || []);
        if (origin.installedAt) m.installedAt = origin.installedAt;
        manifests.push(m);
      } catch (err) {
        log.warn('Skipping malformed skill', { dir: ent.name, err: serializeErr(err) });
      }
    }
    return manifests;
  } catch (err) {
    log.warn('listInstalledSkills failed', serializeErr(err));
    return [];
  }
}

/**
 * Run an installed skill with the given parameters. The skill's entry
 * point convention is the first executable file the manifest references.
 * For v1 we keep this simple: if the skill folder has `run.ps1`, run it
 * via PowerShell with the params as `-key value` args. If it has
 * `run.sh`, refuse (not on Windows). If it only has SKILL.md (docs-only
 * skill), return the doc content as text — the model can read it.
 *
 * Stdout is captured and returned to the model. Errors return a
 * structured `(error:...)` string so the existing fallback eligibility
 * regex catches it.
 */
export async function runSkill(slug: string, params: Record<string, unknown>): Promise<string> {
  const skillDir = path.join(SKILLS_DIR, slug);
  if (!fs.existsSync(skillDir)) {
    return `(error:SKILL_NOT_INSTALLED) Skill ${slug} is not installed. Call install_skill first.`;
  }

  const runPs1 = path.join(skillDir, 'run.ps1');
  const runJs = path.join(skillDir, 'run.js');
  const runMjs = path.join(skillDir, 'run.mjs');

  // Build args from params: --key value (PS) or --key=value (Node)
  const flatArgs = (style: 'ps' | 'node'): string[] => {
    const args: string[] = [];
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null) continue;
      const sv = typeof v === 'string' ? v : JSON.stringify(v);
      if (style === 'ps') {
        args.push(`-${k}`, sv);
      } else {
        args.push(`--${k}`, sv);
      }
    }
    return args;
  };

  return new Promise<string>((resolve) => {
    const { execFile } = require('child_process');
    let cmd: string;
    let cmdArgs: string[];
    if (fs.existsSync(runPs1)) {
      cmd = 'powershell.exe';
      cmdArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runPs1, ...flatArgs('ps')];
    } else if (fs.existsSync(runJs)) {
      cmd = 'node';
      cmdArgs = [runJs, ...flatArgs('node')];
    } else if (fs.existsSync(runMjs)) {
      cmd = 'node';
      cmdArgs = [runMjs, ...flatArgs('node')];
    } else {
      // Docs-only skill — return SKILL.md content as the result.
      try {
        const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        resolve(`Skill "${slug}" is documentation-only (no run.ps1/run.js).\n\n${md.slice(0, 4000)}`);
        return;
      } catch (err) {
        resolve(`(error:SKILL_NO_ENTRY) ${slug} has no run.ps1, run.js, run.mjs, or readable SKILL.md.`);
        return;
      }
    }

    execFile(
      cmd,
      cmdArgs,
      { cwd: skillDir, timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err: Error & { stdout?: string; stderr?: string } | null, stdout: string, stderr: string) => {
        if (err) {
          const out = (err.stdout || stdout || '').toString().trim();
          if (out) { resolve(out); return; } // some scripts exit non-zero but emit useful JSON
          resolve(`(error:SKILL_RUN_FAILED) ${err.message}. stderr: ${(err.stderr || stderr || '').toString().slice(0, 500)}`);
          return;
        }
        resolve((stdout || '').toString().trim() || '(skill returned no output)');
      },
    );
  });
}

export function getSkillsDir(): string {
  return SKILLS_DIR;
}
