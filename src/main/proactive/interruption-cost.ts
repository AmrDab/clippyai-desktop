/**
 * proactive/interruption-cost.ts — v0.20.0 "Lumiere" PR-B
 *
 * Pure cost-of-interruption model (memo §4 item 3). Returns a multiplier that
 * SCALES the surfacing threshold: surface only when `p / interruptionCost >
 * threshold`. A HIGH cost (busy moment) raises the bar; a LOW cost (user idle
 * on a stable app) lowers it.
 *
 * This encodes the load-bearing principle from the memo's governing sentence:
 * the dominant action of a proactive engine is SILENCE, and "is *this moment*
 * expensive to interrupt" is a first-class variable — not something baked into
 * a time-based cooldown.
 *
 * Design invariants:
 *   - Pure: state in → number out. No Electron, no IO. Unit-testable.
 *   - Static named exports only (bundle-anchor rule).
 *   - Output clamped to [MIN_COST, MAX_COST] = [0.2, 1.5] (memo §4 item 3).
 *
 * ── Signal provenance ──────────────────────────────────────────────────────
 *   REAL today (caller can populate from existing polls):
 *     - busy/full-screen/call app — matched from the active app NAME, which we
 *       already read via get_active_window. (Heuristic by app identity, not by
 *       a true NSWindow fullscreen query — see STUBBED below.)
 *     - recentTypingMs — derivable from idleSec (idleSec*1000 ≈ ms since last
 *       input); a small idleSec means the user just typed/moved.
 *     - idleSec — REAL (powerMonitor).
 *   STUBBED-for-later (fields accepted so the signature is stable, but the
 *   caller passes undefined in v0.20.0; memo §5 restraint list):
 *     - doNotDisturb — macOS Focus mode via `defaults read`. Not wired yet.
 *     - trueFullscreen — actual NSWindow fullscreen state. Not wired; we
 *       approximate with the app-name allowlist below.
 */

export const MIN_COST = 0.2;
export const MAX_COST = 1.5;
/** Neutral baseline — a normal app, user mildly active. */
export const BASE_COST = 1.0;

/**
 * Apps where an interruption is almost always expensive: presentations, video
 * calls, immersive/full-screen media. Matched against the active app name.
 * This is the REAL stand-in for a true fullscreen query until that's wired.
 */
const HIGH_COST_APPS = [
  /^Keynote$/i,
  /^Microsoft PowerPoint$/i,
  /^zoom\.us$/i,
  /^Zoom$/i,
  /^Microsoft Teams$/i,
  /^Google Meet$/i,
  /^Webex/i,
  /^FaceTime$/i,
  /^QuickTime Player$/i,
  /^VLC$/i,
  /^Final Cut Pro$/i,
  /^DaVinci Resolve$/i,
];

export interface InterruptionState {
  /** Active app name (REAL — get_active_window). */
  app: string;
  /** powerMonitor idleSec (REAL). */
  idleSec: number;
  /**
   * Milliseconds since the user's last keyboard activity, if known.
   * REAL-derivable from idleSec; pass undefined if you only have idleSec
   * (the cost fn will fall back to idleSec).
   */
  recentTypingMs?: number;
  /** STUBBED — macOS Focus / Do Not Disturb. undefined in v0.20.0. */
  doNotDisturb?: boolean;
  /** STUBBED — true NSWindow fullscreen state. undefined in v0.20.0. */
  trueFullscreen?: boolean;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the interruption-cost multiplier for the current moment.
 *
 * Higher = more expensive to interrupt = the scorer's `p` must be higher to
 * fire. The pieces are multiplicative so any single strong "do not disturb"
 * signal can dominate, then we clamp.
 */
export function currentInterruptionCost(state: InterruptionState): number {
  let cost = BASE_COST;

  // ── Hard "leave them alone" signals ───────────────────────────────────────
  // DND / Focus mode is the strongest explicit signal a user can give.
  if (state.doNotDisturb === true) cost *= 1.5;

  // Full-screen / presentation / call context.
  const inHighCostApp =
    state.trueFullscreen === true ||
    HIGH_COST_APPS.some((re) => re.test(state.app));
  if (inHighCostApp) cost *= 1.4;

  // ── Active-typing burst ───────────────────────────────────────────────────
  // "Best way to help is to leave them alone when they're in the zone."
  // recentTypingMs preferred; else approximate from idleSec.
  const sinceInputMs = state.recentTypingMs ?? state.idleSec * 1000;
  if (sinceInputMs < 5_000) {
    cost *= 1.3; // typed within the last 5s — actively working, expensive
  }

  // ── Low-cost: user has stepped back ───────────────────────────────────────
  // A clearly idle user on a stable app is the cheapest moment to surface a
  // gentle tip. Only discount when NOT in a high-cost app (don't undo a call).
  if (!inHighCostApp && state.doNotDisturb !== true) {
    if (state.idleSec >= 30) {
      cost *= 0.5; // stepped away — cheap to leave a note for when they return
    } else if (state.idleSec >= 8 && sinceInputMs >= 5_000) {
      cost *= 0.75; // paused, not typing — moderately cheap (the stuck moment)
    }
  }

  return clamp(cost, MIN_COST, MAX_COST);
}
