/**
 * Memory subsystem (v0.11.22) — local-only, electron-store backed.
 *
 * Persists two things across restarts:
 *   1. Per-app learned workflows. After a task succeeds, distill the
 *      action sequence into a kebab-case key + step string, scoped by
 *      active process. Mirrors ClawdCursor's saveLesson() pattern.
 *      Capped at 20 workflows per process, FIFO eviction.
 *   2. (deferred to v0.12+) Free-form preferences captured via a `remember`
 *      tool. Stub left in place; not yet wired through the brain.
 *
 * Storage: %APPDATA%\ClippyAI\clippy-memory.json (electron-store, atomic
 * writes). Schema-versioned; old shapes are silently dropped on upgrade.
 *
 * Privacy: enabled by default. Memory never leaves the machine *except*
 * when injected into the same prompt that already goes to api.clippyai.app
 * — which the user already trusts with their screen text. Workflow steps
 * are a strict subset of that data class. User can disable + forget all
 * via Settings → Memory (IPC handlers exposed below).
 */

import Store from 'electron-store';
import { createLogger } from './logger';

const log = createLogger('Memory');

const SCHEMA_VERSION = 1;
const MAX_WORKFLOWS_PER_APP = 20;
const MAX_HINT_CHARS = 320;
const MIN_SCORE_TO_INJECT = 0.4;

interface LearnedWorkflow {
  steps: string;
  lastUsed: number;
  successCount: number;
}

interface MemoryFile {
  schemaVersion: number;
  enabled: boolean;
  workflows: Record<string, Record<string, LearnedWorkflow>>;
}

const store = new Store<MemoryFile>({
  name: 'clippy-memory',
  defaults: {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    workflows: {},
  },
});

// One-time schema migration on first run after upgrade
const onDiskVersion = (store as unknown as { get: (k: string, d: number) => number }).get('schemaVersion', 0);
if (onDiskVersion < SCHEMA_VERSION) {
  log.info('Migrating memory schema', { from: onDiskVersion, to: SCHEMA_VERSION });
  store.set('schemaVersion', SCHEMA_VERSION);
  if (!(store as unknown as { has: (k: string) => boolean }).has('workflows')) {
    store.set('workflows', {});
  }
}

export function isEnabled(): boolean {
  return store.get('enabled', true) as boolean;
}

export function setEnabled(enabled: boolean): void {
  store.set('enabled', enabled);
  log.info('Memory toggled', { enabled });
}

/**
 * Convert a free-form task description into a stable storage key.
 * "Send Bob a meeting summary" → "send_bob_a_meeting_summary"
 */
function taskKey(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);
}

/** Cheap word-overlap match: ratio of query tokens that appear in the key. */
function similarity(query: string, key: string): number {
  const qWords = query.toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
  if (qWords.length === 0) return 0;
  const kWords = new Set(key.split(/[_\s]+/));
  let hits = 0;
  for (const w of qWords) if (kWords.has(w)) hits++;
  return hits / qWords.length;
}

/**
 * Look up the best-matching learned workflow for a given user message
 * inside the active app. Returns null if memory is disabled, no app
 * matches, no workflows recorded for this app, or no key crosses the
 * MIN_SCORE_TO_INJECT threshold.
 */
export function lookupWorkflow(processName: string, userText: string): {
  key: string;
  steps: string;
  successCount: number;
  score: number;
} | null {
  if (!isEnabled()) return null;
  if (!processName || !userText) return null;
  const allWorkflows = store.get('workflows', {}) as Record<string, Record<string, LearnedWorkflow>>;
  const appWorkflows = allWorkflows[processName.toLowerCase()];
  if (!appWorkflows) return null;

  let best: { key: string; w: LearnedWorkflow; score: number } | null = null;
  for (const [key, w] of Object.entries(appWorkflows)) {
    const score = similarity(userText, key);
    if (score > 0 && (!best || score > best.score)) best = { key, w, score };
  }
  if (!best || best.score < MIN_SCORE_TO_INJECT) return null;
  return {
    key: best.key,
    steps: best.w.steps.substring(0, MAX_HINT_CHARS),
    successCount: best.w.successCount,
    score: best.score,
  };
}

/**
 * Format a hint string ready for prompt injection. Empty string if no
 * matching workflow, so callers can unconditionally append it.
 */
export function formatWorkflowHint(processName: string, userText: string): string {
  const m = lookupWorkflow(processName, userText);
  if (!m) return '';
  return `\n--- LEARNED WORKFLOW (this user, this app — succeeded ${m.successCount}× before) ---\nMatched task: ${m.key}\nSteps: ${m.steps}\n--- END LEARNED ---`;
}

/**
 * Record a successful task's action sequence under the active process.
 * Called from brain.ts on `task_complete` (or equivalent success signal).
 *
 * `actions` is the list of tool calls that ran during the successful loop.
 * We boil them down to a one-liner like:
 *   "Press Ctrl+N. Type recipient. Press Tab. Type subject. Press Tab. Type body. Press Ctrl+Enter."
 */
export function recordWorkflow(
  processName: string,
  taskDescription: string,
  actions: Array<{ name: string; args: Record<string, unknown> }>,
): void {
  if (!isEnabled()) return;
  if (!processName || !taskDescription || actions.length === 0) return;

  // Skip noise tools — they're observation, not action.
  const NOISE = new Set([
    'read_screen', 'ocr_read_screen', 'desktop_screenshot', 'get_active_window',
    'get_windows', 'get_focused_element', 'wait', 'cdp_page_context',
    'cdp_read_text', 'cdp_list_tabs',
  ]);

  const steps = actions
    .filter((a) => !NOISE.has(a.name))
    .map((a) => describeAction(a))
    .filter(Boolean)
    .join('. ')
    .substring(0, MAX_HINT_CHARS);

  if (!steps) return;

  const allWorkflows = store.get('workflows', {}) as Record<string, Record<string, LearnedWorkflow>>;
  const appKey = processName.toLowerCase();
  const appWorkflows = allWorkflows[appKey] || {};
  const key = taskKey(taskDescription);
  const existing = appWorkflows[key];

  appWorkflows[key] = {
    steps,
    lastUsed: Date.now(),
    successCount: (existing?.successCount || 0) + 1,
  };

  // FIFO cap
  const keys = Object.keys(appWorkflows);
  if (keys.length > MAX_WORKFLOWS_PER_APP) {
    // Drop the oldest by lastUsed
    const sorted = keys.sort((a, b) => (appWorkflows[a].lastUsed || 0) - (appWorkflows[b].lastUsed || 0));
    delete appWorkflows[sorted[0]];
  }

  allWorkflows[appKey] = appWorkflows;
  store.set('workflows', allWorkflows);
  log.info('Recorded workflow', { app: appKey, key, successCount: appWorkflows[key].successCount, stepsLen: steps.length });
}

function describeAction(a: { name: string; args: Record<string, unknown> }): string {
  switch (a.name) {
    case 'open_app':       return `Open ${a.args.name}`;
    case 'focus_window':   return `Focus ${a.args.processName || a.args.title}`;
    case 'smart_click':    return `Click "${a.args.target}"`;
    case 'smart_type':     return `Type into "${a.args.target}"`;
    case 'mouse_click':    return `Click at (${a.args.x},${a.args.y})`;
    case 'type_text':      return `Type text`;
    case 'key_press':      return `Press ${a.args.key || a.args.combo}`;
    case 'navigate_browser': return `Navigate to URL`;
    case 'cdp_click':      return `Click ${a.args.selector || a.args.text}`;
    case 'cdp_type':       return `Type into ${a.args.selector || 'field'}`;
    case 'outlook_send_email': return `Send Outlook email`;
    case 'excel_write':    return `Write to Excel`;
    case 'excel_read':     return `Read Excel cells`;
    case 'create_reminder': return `Create reminder`;
    default:               return `${a.name}`;
  }
}

/** Settings UI helpers — used by ipc handlers. */

export function listAppsWithMemory(): Array<{ app: string; workflowCount: number }> {
  const all = store.get('workflows', {}) as Record<string, Record<string, LearnedWorkflow>>;
  return Object.entries(all)
    .map(([app, ws]) => ({ app, workflowCount: Object.keys(ws).length }))
    .sort((a, b) => b.workflowCount - a.workflowCount);
}

export function forgetApp(processName: string): void {
  const all = store.get('workflows', {}) as Record<string, Record<string, LearnedWorkflow>>;
  const appKey = processName.toLowerCase();
  if (all[appKey]) {
    delete all[appKey];
    store.set('workflows', all);
    log.info('Forgot app memory', { app: appKey });
  }
}

export function forgetAll(): void {
  store.set('workflows', {});
  log.info('Forgot all memory');
}
