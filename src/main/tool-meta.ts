/**
 * Tool tier metadata.
 *
 * Tier 1 — local artifact generation (file output, no GUI). Cheapest.
 * Tier 2 — OS / shell direct (PowerShell, system info, screenshots, file I/O).
 * Tier 3 — Application APIs: COM (3a), web service (3b), URL schemes (3c).
 * Tier 4 — Browser automation via CDP.
 * Tier 5 — Desktop UI automation (clawdcursor / nut.js / UIA bridge). Last resort.
 *
 * Brain should prefer the lowest-tier tool that fits the task. Tier 5 is only
 * picked when no API/COM/CDP equivalent exists.
 *
 * NOTE on system-prompt wiring: ClippyAI's system prompt + tool schema live
 * server-side in clippyai-api (`/v1/turn`). The orchestrator consumes
 * TOOL_META from this file when building the function-declaration list and
 * is responsible for prepending `[T<tier>]` to descriptions and adding the
 * "prefer lowest tier" line to the system prompt. See the brain.ts header
 * comment for the client/server split.
 */

export interface ToolMeta {
  tier: 1 | 2 | 3 | 4 | 5;
  /** Hint for the router: 'cheap' = sub-100ms; 'medium' = 1-3s; 'expensive' = 5s+ */
  cost: 'cheap' | 'medium' | 'expensive';
  /** Brief task-level description shown to the model in the tier-aware prompt */
  description: string;
  /** Optional: alternate names of the same conceptual tool at higher tiers (for fallback) */
  fallback_alternative?: string;
}

/**
 * Source-of-truth registry. Every key here MUST match a key in TOOL_MAP
 * (src/main/tools.ts) and vice versa. The Layer-1 smoke test enforces this.
 *
 * Entries are populated in a follow-up commit so this scaffold can land
 * with a clean, reviewable diff.
 */
export const TOOL_META: Record<string, ToolMeta> = {};

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_META[name];
}

export function tierOf(name: string): number | undefined {
  return TOOL_META[name]?.tier;
}
