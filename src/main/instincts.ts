/**
 * instincts.ts — Clippy's learned self-corrections.
 *
 * Inspired by the ECC repo's "Homunculus" instincts pattern. Each
 * instinct is a soft rule with a regex trigger, a domain tag, a
 * confidence weight, an action sentence the model should follow,
 * and (optionally) one line of evidence recording why the rule
 * exists.
 *
 * The flow:
 *   1. On first call, seed `<userData>/profile/instincts/global.yaml`
 *      from the bundled template if it doesn't exist.
 *   2. `loadInstincts()` reads + caches the parsed rules. The cache
 *      invalidates when the file mtime changes, so manual YAML edits
 *      take effect on the next turn without restart.
 *   3. `matchInstincts(text)` scores each rule against the user's
 *      turn input and returns the top-N (default 6).
 *   4. `renderInstinctsBlock(matches)` formats them into a section
 *      block that profile.ts splices into the worker prompt.
 *
 * v1 intentionally ships WITHOUT:
 *   - automatic extraction from chat (no /learn)
 *   - project-level overlays (<cwd>/.clippy/instincts/)
 *   - tools for the model to mutate the list at runtime
 *   - a Settings UI
 * Those land in alpha.14+.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger';

const log = createLogger('Instincts');

// @ts-expect-error — Vite ?raw has no TS type
import INSTINCTS_TPL from './profile/templates/instincts.yaml.tpl?raw';

export interface Instinct {
  id: string;
  trigger: string;
  domain: string;
  confidence: number;
  action: string;
  evidence?: string;
  /** Compiled regex — cached at parse time so matchInstincts stays cheap. */
  _re?: RegExp;
}

interface CacheEntry {
  mtimeMs: number;
  instincts: Instinct[];
}

const fileCache = new Map<string, CacheEntry>();

function getInstinctsDir(): string {
  return path.join(app.getPath('userData'), 'profile', 'instincts');
}

function getGlobalPath(): string {
  return path.join(getInstinctsDir(), 'global.yaml');
}

function getProjectPath(): string {
  // v1: project.yaml is NOT auto-discovered from cwd; we only honour a
  // sibling file under the same userData/profile/instincts/ dir. Project
  // overlays from <cwd>/.clippy/ are deferred to alpha.14.
  return path.join(getInstinctsDir(), 'project.yaml');
}

function ensureDir(): void {
  const dir = getInstinctsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function seedTemplateIfMissing(): void {
  ensureDir();
  const p = getGlobalPath();
  if (!fs.existsSync(p)) {
    try {
      fs.writeFileSync(p, INSTINCTS_TPL as string, 'utf-8');
      log.info('Seeded global.yaml from template', { path: p });
    } catch (err) {
      log.warn('Failed to seed instincts template (non-fatal)', err);
    }
  }
}

/**
 * Tiny YAML parser for the flat block-shape we ship. Handles:
 *   - top-level list of `- id: foo` entries
 *   - quoted ("..." or '...') and unquoted scalar values
 *   - `#` line comments and blank lines
 *
 * Does NOT handle: anchors, aliases, nested maps, multi-line scalars,
 * flow style. The Instincts schema is deliberately restricted so we
 * never need a real YAML lib.
 */
export function parseInstinctsYaml(src: string): Instinct[] {
  const lines = src.split(/\r?\n/);
  const out: Instinct[] = [];
  let cur: Partial<Instinct> | null = null;

  const flush = (): void => {
    if (!cur) return;
    if (typeof cur.id === 'string' && typeof cur.trigger === 'string' && typeof cur.action === 'string') {
      const inst: Instinct = {
        id: cur.id,
        trigger: cur.trigger,
        domain: typeof cur.domain === 'string' ? cur.domain : 'general',
        confidence: typeof cur.confidence === 'number' ? cur.confidence : 0.5,
        action: cur.action,
        evidence: typeof cur.evidence === 'string' ? cur.evidence : undefined,
      };
      try {
        inst._re = new RegExp(inst.trigger, 'i');
      } catch (err) {
        log.warn('Skipping instinct with bad trigger regex', { id: inst.id, err: String(err) });
        cur = null;
        return;
      }
      out.push(inst);
    }
    cur = null;
  };

  const unquote = (raw: string): string => {
    const t = raw.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    return t;
  };

  const coerce = (key: string, raw: string): string | number | undefined => {
    const v = unquote(raw);
    if (v === '') return undefined;
    if (key === 'confidence') {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return v;
  };

  for (const rawLine of lines) {
    // Strip trailing CR/whitespace but keep leading indent for shape detection.
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // List item start: `- id: value`
    const listStart = line.match(/^-\s+(\w+):\s*(.*)$/);
    if (listStart) {
      flush();
      cur = {};
      const v = coerce(listStart[1], listStart[2]);
      if (v !== undefined) (cur as Record<string, unknown>)[listStart[1]] = v;
      continue;
    }

    // Continuation: `  key: value` while inside the current item
    const kv = line.match(/^\s{2,}(\w+):\s*(.*)$/);
    if (kv && cur) {
      const v = coerce(kv[1], kv[2]);
      if (v !== undefined) (cur as Record<string, unknown>)[kv[1]] = v;
      continue;
    }
    // Anything else is ignored (keeps parser forgiving toward stray text).
  }
  flush();
  return out;
}

function loadFile(p: string): Instinct[] {
  if (!fs.existsSync(p)) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return [];
  }
  const cached = fileCache.get(p);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.instincts;
  let parsed: Instinct[] = [];
  try {
    const body = fs.readFileSync(p, 'utf-8');
    parsed = parseInstinctsYaml(body);
  } catch (err) {
    log.warn(`Failed to load instincts from ${p} (non-fatal)`, err);
    parsed = [];
  }
  fileCache.set(p, { mtimeMs: stat.mtimeMs, instincts: parsed });
  return parsed;
}

/**
 * Load all instincts from global + project YAMLs. Project entries
 * override global entries with the same `id`. Cached per-file with
 * mtime invalidation so hand-edits take effect next turn.
 *
 * First call seeds <userData>/profile/instincts/global.yaml from the
 * bundled template if it doesn't exist.
 */
export function loadInstincts(): Instinct[] {
  try {
    seedTemplateIfMissing();
  } catch (err) {
    log.warn('seedTemplateIfMissing threw (non-fatal)', err);
  }
  const global = loadFile(getGlobalPath());
  const project = loadFile(getProjectPath());
  if (project.length === 0) return global;
  const byId = new Map<string, Instinct>();
  for (const g of global) byId.set(g.id, g);
  for (const p of project) byId.set(p.id, p); // project wins on id collision
  return Array.from(byId.values());
}

/**
 * Score each instinct against the user's turn text and return the
 * top-N by `confidence * match_score`. Score is the count of regex
 * matches against the text (capped at 5 so a chatty user can't drown
 * out a high-confidence rule with a single weak keyword hit).
 */
export function matchInstincts(userText: string, max: number = 6): Instinct[] {
  if (!userText || typeof userText !== 'string') return [];
  const all = loadInstincts();
  if (all.length === 0) return [];
  type Scored = { inst: Instinct; score: number };
  const scored: Scored[] = [];
  for (const inst of all) {
    if (!inst._re) continue;
    const matches = userText.match(new RegExp(inst._re.source, inst._re.flags.includes('g') ? inst._re.flags : inst._re.flags + 'g'));
    const hits = matches ? Math.min(matches.length, 5) : 0;
    if (hits === 0) continue;
    scored.push({ inst, score: inst.confidence * hits });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.inst);
}

/**
 * Format the matched instincts as a prompt block. Returns the empty
 * string if no matches, so callers can blindly concatenate.
 */
export function renderInstinctsBlock(matches: Instinct[]): string {
  if (!matches || matches.length === 0) return '';
  const lines: string[] = ['=== INSTINCTS ==='];
  for (const m of matches) {
    // One line per instinct keeps the block scannable; the model only
    // needs the action + confidence to apply the rule.
    lines.push(`- [${m.domain} · ${m.confidence.toFixed(2)}] ${m.action}`);
  }
  return lines.join('\n');
}

/**
 * Convenience wrapper used by profile.loadProfileBundle when the
 * brain passes in the current user turn text.
 */
export function renderInstinctsForUserText(userText: string, max: number = 6): string {
  return renderInstinctsBlock(matchInstincts(userText, max));
}

/** Test/debug hook — clear the mtime cache. */
export function _clearCache(): void {
  fileCache.clear();
}
