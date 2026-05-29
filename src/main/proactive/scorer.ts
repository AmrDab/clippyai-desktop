/**
 * proactive/scorer.ts — v0.20.0 "Lumiere" PR-B (Windows port)
 *
 * ProactiveProbabilityScorer — the decision-theoretic core the original
 * Lumiere shipped in research but Office 97 never did (memo §1). Replaces the
 * binary "first regex that matches fires" path with a probability the user
 * actually wants help right now, gated by the cost of interrupting and a
 * user-tunable threshold.
 *
 * Governing principle (memo §7): "if the scorer ever fires above threshold for
 * a state where a thoughtful human teammate would have stayed quiet, that is a
 * P0 bug." So the model leans toward SILENCE: weights are conservative, the
 * default threshold is high (0.55), and the interruption-cost gate can only
 * RAISE the effective bar in busy moments.
 *
 * This module is PURE TypeScript — no Electron, no platform-specific code — so
 * it ports verbatim from the macOS build.
 *
 * Design invariants:
 *   - `score(features) → p ∈ [0,1]` is PURE: features in, probability out.
 *     No Electron, no IO, no clock. This is the unit-tested heart.
 *   - `decide()` composes score + interruption cost + threshold into a verdict.
 *   - Static named exports only (bundle-anchor rule). No learned weights in
 *     v0.20.0 (memo §5) — weights are explainable constants.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Features — the five weighted signals (memo §4 item 2)
// ═══════════════════════════════════════════════════════════════════════════

export interface ScoreFeatures {
  /**
   * (a) STUCK-PAUSE — the Lumiere "introspection" tell: idle > 8s IMMEDIATELY
   * after a typing burst > 30s. REAL signal availability is partial in
   * v0.20.0: idle-after-activity is derivable from the UserEventBus idle
   * transition, but the "typing burst > 30s" precondition needs the keyboard
   * burst event that is STUBBED this milestone — so today the caller passes
   * false unless it can prove the burst. Range expectation: boolean.
   */
  stuckPause: boolean;

  /**
   * (b) INEFFICIENT SEQUENCE — same app refocused ≥3× in 60s, or >2 undo
   * events in 30s. Refocus count is REAL (UserEventBus focus diffs); undo is
   * STUBBED (no hotkey hook this milestone). Caller passes the refocus count.
   */
  refocusCount: number;

  /**
   * (c) ERROR-STATE surface text — regex hits on "error"/"failed"/red-badge in
   * the active window title. REAL (derived from get_active_window title).
   */
  errorState: boolean;

  /**
   * (d) NOVEL CONTEXT — current (app, windowTitle) not seen before. REAL
   * (seen-context.ts). Expertise proxy: unfamiliar ⇒ more likely to need help.
   */
  novelContext: boolean;

  /**
   * (e) RULE PRIOR — confidence of the best-matching contextual-suggestions
   * rule, ∈ [0,1], or 0 if none matched. The macOS build sources this from its
   * rule engine; the Windows build has no rule engine (its proactive path is
   * model-driven), so the caller passes 0 today — see brain.ts shadow hook.
   * The memo gives a flat +0.4 for "a rule matched"; we generalize to the
   * rule's own confidence. Pass 0.4 to reproduce the memo's flat prior exactly.
   */
  rulePrior: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Weights — explainable constants. NO learning in v0.20.0 (memo §5).
// Tuned so that no single weak signal alone clears the 0.55 default threshold;
// firing wants either a strong rule prior OR a stuck-pause combined with
// corroborating evidence. Leaning toward silence is intentional (memo §7).
// ═══════════════════════════════════════════════════════════════════════════

export interface ScorerWeights {
  stuckPause: number;
  refocus: number;       // per refocus beyond the first, capped
  errorState: number;
  novelContext: number;
  rulePrior: number;     // multiplier applied to the rule's own confidence
}

export const DEFAULT_WEIGHTS: ScorerWeights = {
  stuckPause: 0.35,
  refocus: 0.12,         // applied per refocus over the threshold of 3, capped
  errorState: 0.30,
  novelContext: 0.10,
  rulePrior: 0.55,       // rulePrior(0.4) → +0.22 ; a 0.9 rule → ~+0.50
};

/** memo §4 item 2b: oscillation counts only once it reaches 3 in the window. */
export const REFOCUS_TRIGGER = 3;
/** Cap the refocus contribution so a pathological flapper can't dominate. */
export const REFOCUS_CAP = 4;

/** Default surfacing threshold (memo §4 item 3): conservative, silence-biased. */
export const DEFAULT_THRESHOLD = 0.55;
export const MIN_THRESHOLD = 0.3;
export const MAX_THRESHOLD = 0.8;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export interface Verdict {
  /** Raw probability the user wants help, before the cost gate. */
  p: number;
  /** Interruption-cost multiplier that scaled the threshold. */
  costMult: number;
  /** Threshold actually compared against (after the cost gate). */
  effectiveThreshold: number;
  /** The user-configured base threshold. */
  baseThreshold: number;
  /** Final decision: would the live engine be ALLOWED to fire this pass? */
  wouldFire: boolean;
  /** Human-readable dominant reason, for logs / the debug surface. */
  reason: string;
}

export class ProactiveProbabilityScorer {
  private readonly weights: ScorerWeights;

  constructor(weights: ScorerWeights = DEFAULT_WEIGHTS) {
    this.weights = weights;
  }

  /**
   * PURE. Returns p ∈ [0,1]: the probability the user wants help right now.
   * Weighted sum of explainable signals, clamped. Monotonic in every signal:
   * adding evidence can only raise (never lower) p.
   */
  score(f: ScoreFeatures): number {
    const w = this.weights;
    let p = 0;

    if (f.stuckPause) p += w.stuckPause;

    if (f.refocusCount >= REFOCUS_TRIGGER) {
      const over = Math.min(f.refocusCount, REFOCUS_CAP) - (REFOCUS_TRIGGER - 1);
      p += w.refocus * over;
    }

    if (f.errorState) p += w.errorState;
    if (f.novelContext) p += w.novelContext;

    // Rule prior: scale the rule's own confidence by the prior weight.
    p += w.rulePrior * clamp01(f.rulePrior);

    return clamp01(p);
  }

  /** The dominant contributing signal, for explainability in logs. */
  private dominantReason(f: ScoreFeatures): string {
    const w = this.weights;
    const contributions: Array<[string, number]> = [
      ['stuck_pause', f.stuckPause ? w.stuckPause : 0],
      ['error_state', f.errorState ? w.errorState : 0],
      [
        'rule_prior',
        w.rulePrior * clamp01(f.rulePrior),
      ],
      [
        'inefficient_sequence',
        f.refocusCount >= REFOCUS_TRIGGER
          ? w.refocus * (Math.min(f.refocusCount, REFOCUS_CAP) - (REFOCUS_TRIGGER - 1))
          : 0,
      ],
      ['novel_context', f.novelContext ? w.novelContext : 0],
    ];
    contributions.sort((a, b) => b[1] - a[1]);
    return contributions[0][1] > 0 ? contributions[0][0] : 'no_signal';
  }

  /**
   * Compose score + interruption cost + threshold into a fire/skip verdict.
   *
   * Gate (memo §4 item 3): surface only when `p / costMult > threshold`.
   * Equivalently we compare `p` against an EFFECTIVE threshold
   * `threshold * costMult`, which keeps the comparison in p-space for logs.
   * A higher cost ⇒ higher effective threshold ⇒ harder to fire.
   *
   * `baseThreshold` is the user-tunable `proactiveConfidenceThreshold`; the
   * caller reads it from settings (default DEFAULT_THRESHOLD). A threshold of
   * 0 collapses to "always allowed" — the documented kill switch / revert lever
   * (memo §6 PR-B).
   */
  decide(f: ScoreFeatures, costMult: number, baseThreshold: number = DEFAULT_THRESHOLD): Verdict {
    const p = this.score(f);
    const effectiveThreshold = baseThreshold * costMult;
    // Kill switch: threshold 0 ⇒ always allowed (collapse to legacy behavior).
    const wouldFire = baseThreshold <= 0 ? true : p > effectiveThreshold;
    return {
      p,
      costMult,
      effectiveThreshold,
      baseThreshold,
      wouldFire,
      reason: wouldFire ? this.dominantReason(f) : 'below_threshold',
    };
  }
}

/**
 * Read + clamp the user-tunable threshold. Kept here (not in brain.ts) so the
 * default + clamp policy lives next to the scorer. Accepts the raw stored
 * value (possibly undefined for users on older settings) and returns a safe
 * threshold. 0 is preserved (kill switch); other values clamp to [0.3, 0.8].
 */
export function resolveThreshold(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_THRESHOLD;
  if (raw <= 0) return 0; // explicit kill switch
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, raw));
}
