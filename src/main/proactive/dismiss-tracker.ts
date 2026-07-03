/**
 * proactive/dismiss-tracker.ts — v0.20.0 "Lumiere" PR-A (SCHEMA ONLY)
 *
 * The habituation loop (memo §4 item 5). Per the memo's restraint list (§6),
 * the SCHEMA lands in v0.20.0 but the decay-into-scorer wire-up is DEFERRED to
 * v0.20.1 — "Don't compute decay from noise"; we need ~1 week of real dismiss
 * data before letting it influence `p`. So this module deliberately:
 *   - defines the outcome record + a pure recorder,
 *   - exposes a pure `dismissedCount(ruleId, windowMs)` query,
 *   - does NOT yet feed the scorer (scorer.ts ignores it; see TODO there).
 *
 * Dismissal definition (memo §4 item 5): the user generates input within 15s
 * of a suggestion WITHOUT engaging Clippy (no click, no chat). Computing that
 * requires the brain's emit path + user-event timing, which is a later PR — so
 * for now `record()` accepts an already-classified outcome.
 *
 * Design invariants: pure data structure, injected persistence, static named
 * exports, bundle-anchor safe.
 */

export interface SuggestionOutcome {
  /** rule id, or a stable hash for model-driven tips */
  id: string;
  /** epoch ms when the suggestion was emitted */
  ts: number;
  /** null = unknown/not yet classified; true = dismissed; false = engaged */
  dismissed: boolean | null;
}

export type OutcomeStore = SuggestionOutcome[];

export const DEFAULT_DISMISS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** memo §4 item 5: 3 dismissals in 7 days → decay (NOT hard-suppress). */
export const DISMISS_DECAY_THRESHOLD = 3;
/** Multiplicative score decay applied once the threshold is crossed. */
export const DISMISS_DECAY_FACTOR = 0.5;

export class DismissTracker {
  private outcomes: OutcomeStore;

  constructor(initial: OutcomeStore = []) {
    this.outcomes = initial.slice();
  }

  record(o: SuggestionOutcome): void {
    this.outcomes.push(o);
  }

  /** Count dismissals of `id` within the trailing window. */
  dismissedCount(id: string, now: number = Date.now(), windowMs: number = DEFAULT_DISMISS_WINDOW_MS): number {
    const cutoff = now - windowMs;
    return this.outcomes.filter((o) => o.id === id && o.dismissed === true && o.ts >= cutoff).length;
  }

  /**
   * The decay multiplier the scorer WILL apply in v0.20.1. Exposed + unit-test
   * friendly now so the wiring is a one-line change later. Returns 1.0 (no
   * decay) until the dismissal threshold is crossed.
   *
   * TODO(v0.20.1): call this from ProactiveProbabilityScorer.score() once we
   * have a week of real outcome data. Intentionally NOT wired today.
   */
  decayFor(id: string, now: number = Date.now()): number {
    return this.dismissedCount(id, now) >= DISMISS_DECAY_THRESHOLD ? DISMISS_DECAY_FACTOR : 1.0;
  }

  toJSON(): OutcomeStore {
    return this.outcomes.slice();
  }
}
