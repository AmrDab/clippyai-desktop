/**
 * action-history.ts — persistent ring buffer of the last 50 tool calls.
 *
 * v0.19.0 — PR-5 mac mirror: undo + action log surface.
 *
 * Design: single JSON file in userData, written atomically (temp file +
 * fs.renameSync) so a crash during write can't corrupt the log. The ring
 * buffer is capped at MAX_ENTRIES to bound disk usage. All reads return a
 * copy of the array (most-recent first) so callers can't accidentally
 * mutate the in-memory state.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ActionClass } from './tool-meta';
import type { Receipt } from './receipt';
import { redactArgs } from './logger';
// Bundle-anchor class, 5th recurrence (0.24.7 Mac live test): a lazy require('./x')
// of a module that is also imported statically elsewhere points at a chunk Rollup
// never emits. Import statically; scripts/check-bundle-requires.js now fails the build.
import * as toolMetaMod from './tool-meta';

/** All recognised inverse-action kinds. */
export type InverseAction =
  | { kind: 'restore-file'; trashPath: string; originalPath: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'delete-calendar-event'; eventId: string; calendarId?: string }
  | { kind: 'delete-email-draft'; draftId: string }
  // The text itself stays in memory (tool-undo.ts rememberClipboard): what
  // was on the clipboard can be a password, and this record is a file.
  | { kind: 'restore-clipboard'; clipRef: string }
  | { kind: 'recreate-from-args'; tool: string; args: Record<string, unknown> }
  | { kind: 'noop'; reason: string };

export interface ActionEntry {
  /** UUID for this entry. */
  id: string;
  /** ISO timestamp. */
  ts: string;
  /** Tool name (e.g. "write_file"). */
  tool: string;
  /** Tool tier (from TOOL_META). */
  tier: number;
  /** Action class (from TOOL_META). */
  actionClass: ActionClass | null;
  /** Stringified argument summary (first 120 chars). */
  argsSummary: string;
  /** Tool call outcome. */
  outcome: 'success' | 'failure' | 'unverified' | 'approval_denied' | 'blocked';
  /** First 200 chars of the tool result text. */
  detail: string;
  /** Optional task id for grouping. */
  taskId?: string;
  /** v0.19.0 — inverse action descriptor. Present if the entry is undoable (or noop). */
  inverse?: InverseAction;
  /** v0.19.0 — true once undo has been successfully applied. */
  undone?: boolean;
  /** v0.19.0 — ISO timestamp of when undo was applied. */
  undoneAt?: string;
  /** v0.21 — action receipt (executed / verified evidence). Absent on older entries. */
  receipt?: Receipt;
}

const MAX_ENTRIES = 50;

let _entries: ActionEntry[] = [];
let _historyPath: string | null = null;

function historyPath(): string {
  if (!_historyPath) {
    _historyPath = path.join(app.getPath('userData'), 'action-history.json');
  }
  return _historyPath;
}

function load(): void {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf8');
    _entries = JSON.parse(raw) as ActionEntry[];
    if (!Array.isArray(_entries)) _entries = [];
    // Builds before 0.24.12 wrote the previous clipboard text into this
    // file. Drop it (the undo then reports it is no longer available).
    let scrubbed = false;
    for (const e of _entries) {
      const inv = e?.inverse as (Record<string, unknown> | undefined);
      if (inv && inv.kind === 'restore-clipboard' && 'previousText' in inv) {
        delete inv.previousText;
        if (typeof inv.clipRef !== 'string') inv.clipRef = '';
        scrubbed = true;
      }
      if (typeof e?.argsSummary === 'string' && e.argsSummary.includes('_previousClipboard"')) {
        e.argsSummary = '{}';
        scrubbed = true;
      }
    }
    if (scrubbed) flush();
  } catch {
    _entries = [];
  }
}

function flush(): void {
  const p = historyPath();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(_entries), 'utf8');
    fs.renameSync(tmp, p);
  } catch { /* non-fatal */ }
}

// Lazy-load once
let _loaded = false;
function ensureLoaded(): void {
  if (!_loaded) {
    _loaded = true;
    load();
  }
}

/** Record a tool call in the history ring buffer. */
export function record(opts: {
  tool: string;
  args: Record<string, unknown>;
  outcome: ActionEntry['outcome'];
  detail: string;
  inverse?: InverseAction;
  taskId?: string;
  receipt?: Receipt;
}): ActionEntry {
  ensureLoaded();

  // Derive tier + actionClass from TOOL_META (lazy require avoids circular)
  let tier = 2;
  let actionClass: ActionClass | null = null;
  try {
    const meta = toolMetaMod;
    const m = meta.TOOL_META[opts.tool];
    if (m) {
      tier = m.tier;
      actionClass = m.actionClass ?? null;
    }
  } catch { /* non-fatal */ }

  const entry: ActionEntry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    tool: opts.tool,
    tier,
    actionClass,
    argsSummary: JSON.stringify(redactArgs(opts.args)).substring(0, 120),
    outcome: opts.outcome,
    detail: opts.detail,
    taskId: opts.taskId,
    inverse: opts.inverse,
    ...(opts.receipt ? { receipt: opts.receipt } : {}),
  };

  _entries.unshift(entry);
  if (_entries.length > MAX_ENTRIES) _entries.length = MAX_ENTRIES;
  flush();
  return entry;
}

/** Return all entries (most-recent first). */
export function getAll(): ActionEntry[] {
  ensureLoaded();
  return [..._entries];
}

/** Find an entry by id. Returns undefined if not found. */
export function findById(id: string): ActionEntry | undefined {
  ensureLoaded();
  return _entries.find((e) => e.id === id);
}

/** Mark an entry as undone. */
export function markUndone(id: string): void {
  ensureLoaded();
  const entry = _entries.find((e) => e.id === id);
  if (entry) {
    entry.undone = true;
    entry.undoneAt = new Date().toISOString();
    flush();
  }
}

/** Clear all history. */
export function clear(): void {
  _entries = [];
  flush();
}
