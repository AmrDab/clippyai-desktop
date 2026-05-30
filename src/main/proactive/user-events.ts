/**
 * proactive/user-events.ts — v0.20.0 "Lumiere" PR-A
 *
 * A passive, bounded rolling event bus that records *user-side* observation
 * signals so the probabilistic scorer (scorer.ts) has an action-sequence
 * stream to reason over — the thing the gap analysis (memo §3) flagged as
 * entirely missing today ("We do not record user-side actions at all").
 *
 * This module is the missing ACTION-SEQUENCE stream from the Lumiere frame.
 *
 * Design invariants (memo §2 PR-A, repo bundle-anchor rule):
 *   - ZERO Electron imports. Pure data structure + pure derivation helpers.
 *     The caller (brain.ts) feeds it the OS signals it already polls
 *     (powerMonitor idle, get_active_window app/title). This keeps the bus
 *     unit-testable from the CJS smoke runner with no Electron stub.
 *   - Static named exports only — `import * as userEvents from './user-events'`
 *     survives Rollup tree-shaking. No dynamic import / lazy require.
 *   - Bounded memory: a ring buffer capped by both count AND age (10 min),
 *     so a long-running session can never leak.
 *
 * ── Signal provenance (REAL vs STUBBED-for-later) ──────────────────────────
 *   REAL (derived from signals the app already has):
 *     - 'focus'  — window-focus change, diffed across the proactive poll's
 *                  get_active_window result. (memo signal: program state /
 *                  focus of attention)
 *     - 'idle'   — idle↔active transition derived from powerMonitor idleSec.
 *                  Crucially we record the transition, which lets the scorer
 *                  compute the Lumiere "sudden pause AFTER activity" tell that
 *                  a raw idleSec snapshot cannot (memo §3 "change-in-state").
 *     - 'active' — the inverse transition (user came back / started moving).
 *   STUBBED-for-later (event TYPES are defined so the schema is stable, but
 *   nothing emits them yet — they need signals we deliberately do NOT collect
 *   in v0.20.0 per the memo §5 restraint list):
 *     - 'typing-burst' — needs the userTakeover keyboard-burst hook wired to
 *                        emit here (memo §4 item 1). Defined now; emitted in a
 *                        later PR. Used by the stuck-pause feature.
 *     - 'undo'         — needs a global Cmd-Z hotkey hook (memo §5 says NO
 *                        global keystroke content; burst-count is allowed
 *                        later but not in this PR). Schema only.
 *     - 'clipboard'    — clipboard mutation. Schema only for now.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type UserEventType =
  | 'focus'        // REAL — active window changed
  | 'idle'         // REAL — user went idle (active → idle transition)
  | 'active'       // REAL — user became active (idle → active transition)
  | 'typing-burst' // STUBBED — keyboard activity burst (not yet emitted)
  | 'undo'         // STUBBED — undo/redo key (not yet emitted)
  | 'clipboard';   // STUBBED — clipboard mutation (not yet emitted)

export interface UserEvent {
  type: UserEventType;
  /** epoch ms */
  ts: number;
  /** active app at the time of the event (best-effort, may be '') */
  app?: string;
  /** active window title at the time of the event (best-effort, may be '') */
  windowTitle?: string;
  /** idleSec reading at the time of the event, when relevant */
  idleSec?: number;
}

/** Default rolling window: 10 minutes (memo §4 item 1). */
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
/** Hard cap on retained events regardless of age — backstop against churn. */
export const DEFAULT_MAX_EVENTS = 600;

// ═══════════════════════════════════════════════════════════════════════════
// UserEventBus — bounded ring buffer
// ═══════════════════════════════════════════════════════════════════════════

export class UserEventBus {
  private events: UserEvent[] = [];
  private readonly windowMs: number;
  private readonly maxEvents: number;

  /** Last sample the bus saw, used to DIFF and synthesize transition events. */
  private lastApp: string | null = null;
  private lastIdleSec: number | null = null;

  constructor(opts: { windowMs?: number; maxEvents?: number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /**
   * Record a raw event directly. Evicts anything older than the window or
   * beyond the count cap. `now` is injectable for deterministic tests.
   */
  record(ev: UserEvent, now: number = Date.now()): void {
    this.events.push(ev);
    this.evict(now);
  }

  /**
   * The primary entry point the proactive loop calls each tick. Feeds the bus
   * a snapshot of the current OS state; the bus DIFFS it against the previous
   * snapshot and synthesizes the appropriate transition events. This is what
   * turns a sequence of get_active_window / idleSec polls into an action
   * stream.
   *
   * `idleThresholdSec` — idleSec at/above which the user is considered idle.
   * Default 8s matches the scorer's stuck-pause definition (memo §4 item 2a).
   */
  observe(
    snapshot: { app: string; windowTitle: string; idleSec: number },
    now: number = Date.now(),
    idleThresholdSec = 8,
  ): void {
    // Focus change — only when we have a previous app to diff against.
    if (this.lastApp !== null && snapshot.app !== this.lastApp) {
      this.record(
        { type: 'focus', ts: now, app: snapshot.app, windowTitle: snapshot.windowTitle, idleSec: snapshot.idleSec },
        now,
      );
    }

    // Idle ↔ active transition. Derived from crossing the threshold, not the
    // raw value — so "just went idle" is a distinct, dateable event.
    if (this.lastIdleSec !== null) {
      const wasIdle = this.lastIdleSec >= idleThresholdSec;
      const isIdle = snapshot.idleSec >= idleThresholdSec;
      if (!wasIdle && isIdle) {
        this.record(
          { type: 'idle', ts: now, app: snapshot.app, windowTitle: snapshot.windowTitle, idleSec: snapshot.idleSec },
          now,
        );
      } else if (wasIdle && !isIdle) {
        this.record(
          { type: 'active', ts: now, app: snapshot.app, windowTitle: snapshot.windowTitle, idleSec: snapshot.idleSec },
          now,
        );
      }
    }

    this.lastApp = snapshot.app;
    this.lastIdleSec = snapshot.idleSec;
  }

  /** Drop events older than the window, then trim to the count cap (oldest first). */
  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    // Events are pushed in time order, so the stale prefix is contiguous.
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** All retained events within the window, oldest → newest. Pruned first. */
  snapshot(now: number = Date.now()): UserEvent[] {
    this.evict(now);
    return this.events.slice();
  }

  /** Events of a given type within the last `withinMs`. */
  recent(type: UserEventType, withinMs: number, now: number = Date.now()): UserEvent[] {
    const cutoff = now - withinMs;
    return this.events.filter((e) => e.type === type && e.ts >= cutoff);
  }

  /** Count of events of a given type within the last `withinMs`. */
  countRecent(type: UserEventType, withinMs: number, now: number = Date.now()): number {
    return this.recent(type, withinMs, now).length;
  }

  /** Most recent event of a type, or null. */
  last(type: UserEventType): UserEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i];
    }
    return null;
  }

  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    this.lastApp = null;
    this.lastIdleSec = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure derivation helpers — consumed by scorer.ts (kept here so the bus and
// its summary live together and both stay Electron-free / unit-testable).
// ═══════════════════════════════════════════════════════════════════════════

export interface EventSummary {
  /** Distinct apps focused within the focus-oscillation window. */
  focusChanges: number;
  /** App-focus oscillations: max times any single app was (re)focused. */
  maxRefocusOfSameApp: number;
  /** Did the user go idle shortly after being active? (stuck-pause precursor) */
  recentIdleEvent: boolean;
}

/**
 * Summarize a window of events into the scalar features the scorer wants.
 * Pure: takes events + now, returns a summary. `oscWindowMs` defaults to 60s
 * per memo §4 item 2b ("same app focused/unfocused ≥3× in 60s").
 */
export function summarize(
  events: UserEvent[],
  now: number = Date.now(),
  oscWindowMs = 60_000,
): EventSummary {
  const cutoff = now - oscWindowMs;
  const inWindow = events.filter((e) => e.ts >= cutoff);

  const focusEvents = inWindow.filter((e) => e.type === 'focus');
  const perApp = new Map<string, number>();
  for (const e of focusEvents) {
    const key = e.app ?? '';
    perApp.set(key, (perApp.get(key) ?? 0) + 1);
  }
  let maxRefocus = 0;
  for (const n of perApp.values()) if (n > maxRefocus) maxRefocus = n;

  const recentIdleEvent = inWindow.some((e) => e.type === 'idle');

  return {
    focusChanges: focusEvents.length,
    maxRefocusOfSameApp: maxRefocus,
    recentIdleEvent,
  };
}
