/**
 * Action history — a persistent ring buffer of the last N tool calls
 * Clippy executed. Shown in Settings → Guardrails → Activity. Purpose:
 *
 *   1. Trust-builder. Users see exactly what Clippy did, including any
 *      destructive actions, so "what did he just do?" never goes
 *      unanswered.
 *   2. Bug-report aid. The audit log + the support-report log-bundle
 *      together let us reconstruct any action sequence in retrospect.
 *   3. Tier-violation forensics. Tier + actionClass are stored alongside
 *      each row so we can see at a glance when Clippy fell back to T5
 *      without warrant.
 *
 * Storage: a single JSON file at userData/action-history.json, capped at
 * MAX_ENTRIES rows (newest first), atomic-write with temp file + rename.
 * The cap is intentionally small (50) — this isn't a forensics datastore,
 * it's a recent-actions panel. Larger history lives in the per-task log
 * files written by the existing logger.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { TOOL_META } from './tool-meta';
import type { ActionClass } from './tool-meta';
import { createLogger } from './logger';

const log = createLogger('ActionHistory');

const MAX_ENTRIES = 50;

/**
 * Describes how to undo a tool call. This union is intentionally OPEN — add
 * new kinds as new tools become undoable. The undo executor (undo.ts) switches
 * on `kind` and applies the inverse.
 *
 * Trust budget: if we're unsure, use `noop` with an honest reason. Never mark
 * something undoable that isn't — that's the worst trust failure.
 */
export type InverseAction =
  | { kind: 'restore-file'; trashPath: string; originalPath: string }
  | { kind: 'rename'; fromPath: string; toPath: string }      // back-rename: move fromPath → toPath
  | { kind: 'move'; fromPath: string; toPath: string }        // back-move (POSIX rename)
  | { kind: 'delete-calendar-event'; provider: string; eventId: string }
  | { kind: 'delete-email-draft'; provider: string; draftId: string }
  | { kind: 'restore-clipboard'; previousValue: string | null }
  | { kind: 'recreate-from-args'; tool: string; args: Record<string, unknown> }  // generic last-resort
  | { kind: 'noop'; reason: string };                          // explicit "can't undo"

export interface ActionEntry {
  id: string;             // uuid
  ts: string;             // ISO timestamp
  tool: string;           // canonical tool name
  tier: number;           // T1–T5 from TOOL_META
  actionClass: ActionClass | null;
  argsSummary: string;    // short, redacted, max 200 chars
  outcome: 'success' | 'failure' | 'unverified' | 'approval_denied' | 'blocked';
  detail: string;         // brief outcome detail or error code, max 200 chars
  taskId?: string;        // task correlation id
  /** Inverse-action descriptor. Present → entry is undoable (or noop with reason). */
  inverse?: InverseAction;
  /** True once undo has been successfully applied. */
  undone?: boolean;
  /** ISO timestamp of when undo was applied. */
  undoneAt?: string;
}

function historyPath(): string {
  return path.join(app.getPath('userData'), 'action-history.json');
}

let cache: ActionEntry[] | null = null;

function load(): ActionEntry[] {
  if (cache) return cache;
  try {
    const p = historyPath();
    if (!fs.existsSync(p)) { cache = []; return cache; }
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(arr)) {
      cache = arr.slice(0, MAX_ENTRIES);
      return cache;
    }
  } catch (err) {
    log.warn('load failed (corrupt history?) — starting empty', { err: (err as Error).message });
  }
  cache = [];
  return cache;
}

function flush(): void {
  try {
    const p = historyPath();
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache ?? [], null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    log.warn('flush failed (non-fatal)', { err: (err as Error).message });
  }
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  try {
    const pairs: string[] = [];
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      // Redact obvious-secret-shaped keys (defense-in-depth — admins shouldn't
      // see arbitrary user-supplied tokens in the history viewer).
      const lk = k.toLowerCase();
      if (lk.includes('password') || lk.includes('token') || lk.includes('secret') || lk.includes('api_key')) {
        pairs.push(`${k}=***`);
        continue;
      }
      // Skip smuggled side-channel fields (prefixed with _) used by undo factories.
      if (k.startsWith('_')) continue;
      const sv = typeof v === 'string' ? v : JSON.stringify(v);
      pairs.push(`${k}=${(sv ?? '').toString().slice(0, 50)}`);
    }
    return pairs.join(' ').slice(0, 200);
  } catch {
    return '';
  }
}

export function record(entry: Omit<ActionEntry, 'id' | 'ts' | 'tier' | 'actionClass' | 'argsSummary'> & {
  args?: unknown;
}): void {
  const list = load();
  const meta = TOOL_META[entry.tool];
  const row: ActionEntry = {
    id: cryptoRandomId(),
    ts: new Date().toISOString(),
    tool: entry.tool,
    tier: meta?.tier ?? 0,
    actionClass: meta?.actionClass ?? null,
    argsSummary: summarizeArgs(entry.args),
    outcome: entry.outcome,
    detail: (entry.detail || '').slice(0, 200),
    taskId: entry.taskId,
    // v0.19.0 — undo surface. Only present when the tool declared an inverse.
    inverse: entry.inverse,
  };
  list.unshift(row);
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
  flush();
}

export function getAll(): ActionEntry[] {
  return [...load()]; // defensive copy — callers shouldn't mutate cache
}

/**
 * Find a single entry by id. Returns null if not found. Used by the undo IPC
 * handler before calling applyInverse.
 */
export function findById(id: string): ActionEntry | null {
  const list = load();
  return list.find((e) => e.id === id) ?? null;
}

/**
 * Mark an entry as undone in-place and persist. Called after applyInverse
 * succeeds. Mutates the cache entry directly so subsequent getAll() calls
 * reflect the change without a reload.
 */
export function markUndone(id: string): boolean {
  const list = load();
  const entry = list.find((e) => e.id === id);
  if (!entry) return false;
  entry.undone = true;
  entry.undoneAt = new Date().toISOString();
  flush();
  return true;
}

export function clear(): void {
  cache = [];
  flush();
}

// Tiny non-crypto id — enough to disambiguate concurrent rows. Avoids a
// dependency on crypto.randomUUID for Node 14 fallback paths.
function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
