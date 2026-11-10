/**
 * screen-context.ts — pure planning for the screen context sent with each user
 * turn (active window + a short UIA/OCR dump).
 *
 * Why this exists (data-review F6): on one real machine every task paid 6-9 s
 * before a ~2 s model call. The old path (a) ran get_active_window and
 * read_screen together, raced them against 2.5 s but never cancelled the loser,
 * then (b) called get_active_window AGAIN, untimed. The PowerShell host runs one
 * request at a time, so that second call queued behind the read_screen still
 * running in the background (up to its 10 s timeout). Fix: one window call with
 * a tight deadline, the heavy dump only with what is left of a small budget and
 * a short script timeout, no duplicate call, a 3 s cache, and a circuit breaker
 * so a machine where it keeps failing is not slowed at all.
 *
 * No Electron / tool imports: brain.ts executes the plan.
 */

export type ScreenCtxOutcome = 'ok' | 'partial' | 'timeout' | 'off';

/** Active-window call: normally tens of ms in the host; this is the fail-fast cap. */
export const WINDOW_DEADLINE_MS = 1_200;
/** Extra wait for the UIA/OCR dump once the window is known. Never blocks past this. */
export const HEAVY_DEADLINE_MS = 700;
/** Hard cap on the whole capture. */
export const TOTAL_BUDGET_MS = 1_800;
/** A capture this recent is reused (quick follow-up messages, the name exchange). */
export const CTX_CACHE_MS = 3_000;
/** After this many timeouts in a row, skip the capture for a while. */
export const PAUSE_AFTER_TIMEOUTS = 3;
export const PAUSE_MS = 60_000;

export interface CtxCache { text: string; process: string; at: number }
export interface CtxState {
  consecutiveTimeouts: number;
  pausedUntil: number;
  cache: CtxCache | null;
}

export function newCtxState(): CtxState {
  return { consecutiveTimeouts: 0, pausedUntil: 0, cache: null };
}

export type CtxPlan =
  | { kind: 'cached'; cache: CtxCache }
  | { kind: 'skip' }
  | { kind: 'capture'; windowMs: number; heavyMs: number };

export function planCapture(state: CtxState, now: number): CtxPlan {
  if (state.cache && now - state.cache.at <= CTX_CACHE_MS) return { kind: 'cached', cache: state.cache };
  if (now < state.pausedUntil) return { kind: 'skip' };
  return { kind: 'capture', windowMs: WINDOW_DEADLINE_MS, heavyMs: HEAVY_DEADLINE_MS };
}

/** Remaining time for the heavy dump given how long the window call took. */
export function heavyBudgetMs(plan: { heavyMs: number }, windowElapsedMs: number): number {
  return Math.max(0, Math.min(plan.heavyMs, TOTAL_BUDGET_MS - windowElapsedMs));
}

export function recordOutcome(state: CtxState, outcome: ScreenCtxOutcome, cache: CtxCache | null, now: number): CtxState {
  if (outcome === 'timeout') {
    const n = state.consecutiveTimeouts + 1;
    return { consecutiveTimeouts: n, pausedUntil: n >= PAUSE_AFTER_TIMEOUTS ? now + PAUSE_MS : state.pausedUntil, cache: state.cache };
  }
  if (outcome === 'off') return state;
  return { consecutiveTimeouts: 0, pausedUntil: 0, cache: cache ?? state.cache };
}

/**
 * The window tool returns JSON, "(no active window)" when nothing has focus
 * (not a failure), or an error line / sentinel when the call itself failed.
 */
export function windowCallFailed(text: string | undefined | null): boolean {
  const s = (text ?? '').trim();
  return !s || s.startsWith('<') || /^\((could not|error|get_active_window error)/i.test(s);
}

/** Process name from the window JSON ({processName} on Windows, {app} from the macOS bridge). */
export function extractProcessName(windowJson: string): string {
  try {
    const p = JSON.parse(windowJson) as { processName?: unknown; app?: unknown };
    if (typeof p.processName === 'string' && p.processName) return p.processName;
    if (typeof p.app === 'string' && p.app) return p.app;
  } catch { /* not JSON */ }
  return '';
}

export type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

/** Resolve with the value, or `{timedOut:true}` after ms. The timer is always cleared. */
export function raceDeadline<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
    p.then(
      (value) => { clearTimeout(timer); resolve({ timedOut: false, value }); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
