/**
 * proactive/interruption-cost.ts — v0.20.0 "Lumiere" PR-B (Windows port)
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
 * ── WINDOWS ADAPTATION ──────────────────────────────────────────────────────
 * The macOS build matched HIGH_COST_APPS against macOS *app display names*
 * (e.g. "Keynote", "zoom.us"). On Windows, get_active_window
 * (get-foreground-window.ps1) returns `processName` — the EXE base name without
 * extension (e.g. "POWERPNT", "Zoom", "Teams", "msedge"). So the allowlist is
 * re-expressed against Windows process names. The matcher tries both the
 * passed app string (which the caller wires from processName) so it is robust.
 *
 * ── Signal provenance (Windows) ─────────────────────────────────────────────
 *   REAL today (caller populates from existing polls):
 *     - busy/full-screen/call app — matched from the active processName, which
 *       we already read via get_active_window. (Heuristic by process identity,
 *       not a true Win32 fullscreen query — see STUBBED below.)
 *     - recentTypingMs — derivable from idleSec (idleSec*1000 ≈ ms since last
 *       input).
 *     - idleSec — REAL (Electron powerMonitor.getSystemIdleTime(), cross-
 *       platform; the brain.ts hook reads it there).
 *   STUBBED-for-later (fields accepted so the signature is stable, but the
 *   caller passes undefined in v0.20.0; memo §5 restraint list):
 *     - doNotDisturb — Windows Focus Assist / Quiet Hours state. Not wired yet.
 *     - trueFullscreen — actual Win32 fullscreen state (query foreground window
 *       rect vs monitor rect). Not wired; approximated via the process-name
 *       allowlist below.
 */

export const MIN_COST = 0.2;
export const MAX_COST = 1.5;
/** Neutral baseline — a normal app, user mildly active. */
export const BASE_COST = 1.0;

/**
 * Apps where an interruption is almost always expensive: presentations, video
 * calls, immersive/full-screen media. Matched against the active app string,
 * which the Windows caller wires from get_active_window's `processName`.
 *
 * Windows process names (EXE base, no extension), with a few display-name
 * fallbacks kept so the matcher also works if a caller passes a friendly name:
 *   PowerPoint slideshow → POWERPNT ; Zoom → Zoom ; Teams → Teams / ms-teams ;
 *   Webex → CiscoCollabHost/webexmta ; media players → wmplayer/vlc ;
 *   editors → Adobe Premiere Pro / Resolve.
 */
const HIGH_COST_APPS = [
  /^POWERPNT$/i,            // Microsoft PowerPoint
  /^Microsoft PowerPoint$/i,
  /^Zoom$/i,                // Zoom client
  /^zoom\.us$/i,
  /^Teams$/i,               // classic Teams
  /^ms-teams$/i,            // new Teams
  /^Microsoft Teams$/i,
  /^CiscoCollabHost$/i,     // Webex
  /^webexmta$/i,
  /^Webex/i,
  /^wmplayer$/i,            // Windows Media Player
  /^vlc$/i,                 // VLC
  /^VLC$/i,
  /^mpc-hc(64)?$/i,         // MPC-HC
  /^Adobe Premiere Pro$/i,
  /^Resolve$/i,             // DaVinci Resolve
  /^obs(64)?$/i,            // OBS (likely streaming/recording)
];

export interface InterruptionState {
  /** Active app string — Windows caller wires this from get_active_window's processName (REAL). */
  app: string;
  /** powerMonitor idleSec (REAL). */
  idleSec: number;
  /**
   * Milliseconds since the user's last keyboard activity, if known.
   * REAL-derivable from idleSec; pass undefined if you only have idleSec
   * (the cost fn will fall back to idleSec).
   */
  recentTypingMs?: number;
  /** STUBBED — Windows Focus Assist / Quiet Hours. undefined in v0.20.0. */
  doNotDisturb?: boolean;
  /** STUBBED — true Win32 fullscreen state. undefined in v0.20.0. */
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
  // DND / Focus Assist is the strongest explicit signal a user can give.
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
