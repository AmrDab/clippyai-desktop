// input-summarizer.ts — PURE heuristic distiller for the typing sense
// (input awareness Phase 2, design: docs/superpowers/specs/2026-05-28).
//
// Turns the redacted rolling keystroke buffer into a single compact
// `[typing]` context line for the brain's screen-context block. This is the
// ONLY representation of the user's typing that is eligible to leave the
// machine — the raw buffer never does (see input-triggers.ts RollingBuffer:
// snapshots are already secret-redacted; we keep only a short tail here).
//
// Deliberately ZERO imports, same as input-triggers.ts: pure + unit-testable
// via the smoke layer-1 esbuild harness. The Apple FoundationModels on-device
// distiller from the design memo can replace the heuristic later behind the
// same function signature.

/** Don't emit anything for fewer than this many typed chars — noise gate. */
const MIN_CHARS = 12;

/** Max chars of the (already-redacted) typing tail quoted into context. */
const TAIL_CHARS = 280;

export interface TypingSummaryInput {
  /** Active app/process name, if known (e.g. "Pages", "Google Chrome"). */
  app?: string;
  /** Redacted snapshot from RollingBuffer.snapshot() — last ~30s of typing. */
  recent: string;
}

/**
 * Distill recent typing into one context line, or '' when there is nothing
 * meaningful to say. Output shape (single line, no raw newlines):
 *
 *   [typing] User is currently typing in Pages (~24 words in the last 30s).
 *   Recent text (secret-redacted): "...the actual tail of what they wrote"
 */
export function summarizeTyping(input: TypingSummaryInput): string {
  // Collapse all whitespace runs; the buffer records chars, not layout.
  const text = (input.recent || '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_CHARS) return '';

  const words = text.split(' ').filter((w) => w.length > 0).length;
  const tail = text.length > TAIL_CHARS ? `…${text.slice(-TAIL_CHARS)}` : text;
  const where = input.app ? ` in ${input.app}` : '';

  return (
    `[typing] User is currently typing${where} (~${words} words in the last 30s). ` +
    `Recent text (secret-redacted): "${tail}"`
  );
}
