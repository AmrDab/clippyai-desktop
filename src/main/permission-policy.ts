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
    share_public:         'approve',
    system_control:       'approve',
    browser_navigate:     'approve',
    desktop_input:        'approve',
  },
  standard: {
    destructive_file:     'approve',
    destructive_send:     'approve',
    destructive_purchase: 'approve',
    share_public:         'approve',
    system_control:       'allow',
    browser_navigate:     'allow',
    desktop_input:        'allow',
  },
  trusted: {
    destructive_file:     'allow',
    destructive_send:     'allow',
    // Even in 'trusted' mode, real money is never auto-approved. This is
    // the one hard floor: the policy CAN be overridden per-class via UI,
    // but the default stays opt-in.
    destructive_purchase: 'approve',
    share_public:         'allow',
    system_control:       'allow',
    browser_navigate:     'allow',
    desktop_input:        'allow',
  },
};

const FACTORY_DEFAULT: PermissionPolicy = {
  mode: 'standard',
  classOverrides: {},
};

function policyPath(): string {
  return path.join(app.getPath('userData'), 'permission-policy.json');
}

let cached: PermissionPolicy | null = null;

export function getPolicy(): PermissionPolicy {
  if (cached) return cached;
  try {
    const p = policyPath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Defensive shape check — never load a file we can't trust.
      if (raw && typeof raw.mode === 'string' && (['cautious', 'standard', 'trusted'] as const).includes(raw.mode as Mode)) {
        cached = {
          mode: raw.mode as Mode,
          classOverrides: typeof raw.classOverrides === 'object' && raw.classOverrides ? raw.classOverrides : {},
        };
        return cached;
      }
    }
  } catch (err) {
    log.warn('getPolicy load failed — falling back to defaults', { err: (err as Error).message });
  }
  cached = { ...FACTORY_DEFAULT, classOverrides: { ...FACTORY_DEFAULT.classOverrides } };
  return cached;
}

export function setPolicy(next: Partial<PermissionPolicy>): PermissionPolicy {
  const current = getPolicy();
  const merged: PermissionPolicy = {
    mode: next.mode ?? current.mode,
    classOverrides: { ...current.classOverrides, ...(next.classOverrides ?? {}) },
  };
  cached = merged;
  try {
    fs.writeFileSync(policyPath(), JSON.stringify(merged, null, 2), 'utf8');
    log.info('Policy.update', { mode: merged.mode, overrides: merged.classOverrides });
  } catch (err) {
    log.error('setPolicy write failed', { err: (err as Error).message });
  }
  return merged;
}

/**
 * Decide whether a tool call is allowed under the current policy.
 *
 * Returns:
 *   'allow'   — run the tool. No approval needed.
 *   'approve' — caller must ask the user before running. (The caller wires
 *               the approval dialog; this module never blocks unilaterally.)
 *   'block'   — refuse outright. Tool returns a "(error:policy_blocked) …"
 *               result. Used when a user has explicitly disabled a class.
 *
 * Tools without an actionClass (read-only / harmless) always return 'allow'.
 */
export function decide(toolName: string): ClassDecision {
  const meta = TOOL_META[toolName];
  const cls = meta?.actionClass;
  if (!cls) return 'allow';
  const policy = getPolicy();
  const override = policy.classOverrides[cls];
  if (override) return override;
  return DEFAULTS[policy.mode][cls];
}

export function getDefaultsFor(mode: Mode): Record<ActionClass, ClassDecision> {
  return { ...DEFAULTS[mode] };
}

export function classFor(toolName: string): ActionClass | null {
  return TOOL_META[toolName]?.actionClass ?? null;
}
