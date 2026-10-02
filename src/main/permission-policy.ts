/**
 * Permission policy — the structural chokepoint that decides whether Clippy
 * is allowed to call any given tool. Read once at process start, mutated by
 * Settings → Guardrails IPC. Lives in license-store (same JSON file as the
 * rest of user prefs) so policy survives restarts.
 *
 * Design rationale: the request "make Clippy secured, add guardrails" can
 * be satisfied with one-off prompts inside each destructive tool — but
 * that scales linearly with the tool count, and every new destructive tool
 * shipped without remembering the guardrail is a security regression. This
 * module makes guardrails a property of the tool's metadata (actionClass)
 * rather than its implementation. One enforcement gate, every tool, forever.
 *
 * Three policy modes:
 *   - 'cautious' — REQUIRE_APPROVAL for every actionClass (popup before each
 *                  call). For new users who want to watch every action.
 *   - 'standard' — REQUIRE_APPROVAL for destructive_*  + share_public;
 *                  ALLOW for system_control / browser_navigate /
 *                  desktop_input. The default.
 *   - 'trusted'  — ALLOW everything except actionClasses explicitly blocked
 *                  in `classOverrides`. For power users.
 *
 * Per-class overrides take precedence over the mode default. Example:
 *   { mode: 'trusted', classOverrides: { 'destructive_purchase': 'block' } }
 * means "trust Clippy for everything except never let him spend money."
 *
 * The approval dialog itself is the renderer's responsibility (Clippy emits
 * `approval-request`, the bubble shows a Yes/No, the renderer IPCs back
 * the answer). This module just decides whether to ASK.
 *
 * Mac port note: identical to clippyai-desktop/src/main/permission-policy.ts
 * (v0.19.0 PR-5). Storage path resolves to
 * ~/Library/Application Support/ClippyAI/permission-policy.json on macOS.
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ActionClass } from './tool-meta';
import { TOOL_META } from './tool-meta';
import { createLogger } from './logger';

const log = createLogger('Policy');

export type Mode = 'cautious' | 'standard' | 'trusted';
export type ClassDecision = 'allow' | 'approve' | 'block';

/**
 * Runtime allow-list of valid ClassDecision string values. Kept adjacent to
 * the type above so the two never drift: if a member is added to the union,
 * it must be added here too (and the type-cast below makes a stale set a
 * compile error). Used to reject junk override values fed in via IPC or a
 * tampered on-disk policy file.
 */
const VALID_DECISIONS: ReadonlySet<ClassDecision> = new Set<ClassDecision>(['allow', 'approve', 'block']);

export interface PermissionPolicy {
  mode: Mode;
  /** Per-class overrides — only honored when present. */
  classOverrides: Partial<Record<ActionClass, ClassDecision>>;
}

const DEFAULTS: Record<Mode, Record<ActionClass, ClassDecision>> = {
  cautious: {
    destructive_file:     'approve',
    destructive_send:     'approve',
    destructive_purchase: 'approve',
    destructive_exec:     'approve',
    destructive_web:      'approve',
    share_public:         'approve',
    system_control:       'approve',
    browser_navigate:     'approve',
    desktop_input:        'approve',
    read_only:            'allow',
  },
  standard: {
    destructive_file:     'approve',
    destructive_send:     'approve',
    destructive_purchase: 'approve',
    destructive_exec:     'approve',
    destructive_web:      'approve',
    share_public:         'approve',
    system_control:       'allow',
    browser_navigate:     'allow',
    desktop_input:        'allow',
    read_only:            'allow',
  },
  trusted: {
    destructive_file:     'allow',
    destructive_send:     'allow',
    // Even in 'trusted' mode, real money is never auto-approved. This is
    // the one hard floor: the policy CAN be overridden per-class via UI,
    // but the default stays opt-in.
    destructive_purchase: 'approve',
    destructive_exec:     'allow',
    destructive_web:      'allow',
    share_public:         'allow',
    system_control:       'allow',
    browser_navigate:     'allow',
    desktop_input:        'allow',
    read_only:            'allow',
  },
};

/**
 * Runtime allow-list of valid ActionClass keys, derived from the SOURCE OF
 * TRUTH (the DEFAULTS map maps every ActionClass under each mode). We read
 * the keys of one mode's record rather than hardcoding the union members, so
 * adding a new ActionClass to tool-meta + DEFAULTS automatically extends this
 * set with no second edit site.
 */
const VALID_ACTION_CLASSES: ReadonlySet<ActionClass> =
  new Set(Object.keys(DEFAULTS.standard) as ActionClass[]);

/**
 * Sanitize a caller-supplied classOverrides object: drop any entry whose KEY
 * is not a known ActionClass or whose VALUE is not a valid ClassDecision.
 * Lenient by design — never throws; invalid entries are silently dropped and
 * logged at warn so a fat-fingered UI payload or a tampered policy file can't
 * inject arbitrary keys or downgrade a guardrail class to an unknown/junk
 * decision. `source` is purely for the warn log.
 */
function sanitizeClassOverrides(
  raw: unknown,
  source: string,
): Partial<Record<ActionClass, ClassDecision>> {
  const clean: Partial<Record<ActionClass, ClassDecision>> = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_ACTION_CLASSES.has(key as ActionClass)) {
      log.warn('Dropped classOverride with unknown ActionClass key', { source, key });
      continue;
    }
    if (typeof value !== 'string' || !VALID_DECISIONS.has(value as ClassDecision)) {
      log.warn('Dropped classOverride with invalid ClassDecision value', { source, key, value });
      continue;
    }
    clean[key as ActionClass] = value as ClassDecision;
  }
  return clean;
}

const FACTORY_DEFAULT: PermissionPolicy = {
  mode: 'standard',
  classOverrides: {},
};

let _policy: PermissionPolicy | null = null;
let _policyPath: string | null = null;

function policyPath(): string {
  if (!_policyPath) {
    _policyPath = path.join(app.getPath('userData'), 'permission-policy.json');
  }
  return _policyPath;
}

function load(): PermissionPolicy {
  try {
    const raw = fs.readFileSync(policyPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PermissionPolicy>;
    return {
      mode: (['cautious', 'standard', 'trusted'] as const).includes(parsed.mode as Mode)
        ? (parsed.mode as Mode)
        : FACTORY_DEFAULT.mode,
      classOverrides: sanitizeClassOverrides(parsed.classOverrides, 'disk'),
    };
  } catch {
    return { ...FACTORY_DEFAULT };
  }
}

function flush(p: PermissionPolicy): void {
  const fp = policyPath();
  const tmp = fp + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(p), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (err) {
    log.warn('policy flush failed', { err });
  }
}

function ensureLoaded(): PermissionPolicy {
  if (!_policy) _policy = load();
  return _policy;
}

/** Return the current policy (lazy-loaded). */
export function getPolicy(): PermissionPolicy {
  return { ...ensureLoaded(), classOverrides: { ...ensureLoaded().classOverrides } };
}

/** Merge a partial update into the current policy and persist. */
export function setPolicy(next: Partial<PermissionPolicy>): PermissionPolicy {
  const current = ensureLoaded();
  if (next.mode && (['cautious', 'standard', 'trusted'] as const).includes(next.mode)) {
    current.mode = next.mode;
  }
  if (next.classOverrides && typeof next.classOverrides === 'object') {
    current.classOverrides = {
      ...current.classOverrides,
      ...sanitizeClassOverrides(next.classOverrides, 'ipc'),
    };
  }
  _policy = current;
  flush(current);
  log.info('Policy updated', { mode: current.mode });
  return getPolicy();
}

/** Decide what to do with a given tool call. */
export function decide(toolName: string, args?: Record<string, unknown>): ClassDecision {
  const policy = ensureLoaded();
  const cls = classFor(toolName, args);
  // Per-class override wins
  if (cls in policy.classOverrides) {
    return policy.classOverrides[cls]!;
  }
  return DEFAULTS[policy.mode][cls];
}

const warnedUnclassed = new Set<string>();

/**
 * Return the actionClass for a tool call. Phase 3: never "no class".
 *   - skill__* (runtime ClawHub skills run arbitrary code) → destructive_exec
 *   - windows_service_control with action 'status' → read_only
 *   - anything without a TOOL_META class → destructive_exec (prompts in
 *     standard mode), with a one-time warn so the gap gets fixed.
 */
export function classFor(toolName: string, args?: Record<string, unknown>): ActionClass {
  if (toolName.startsWith('skill__')) return 'destructive_exec';
  if (toolName === 'windows_service_control' && String(args?.action ?? 'status') === 'status') return 'read_only';
  const cls = TOOL_META[toolName]?.actionClass;
  if (cls) return cls;
  if (!warnedUnclassed.has(toolName)) {
    warnedUnclassed.add(toolName);
    log.warn('Tool has no actionClass — treating as destructive_exec', { tool: toolName });
  }
  return 'destructive_exec';
}
