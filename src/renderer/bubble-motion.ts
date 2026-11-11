/**
 * bubble-motion.ts — the pure parts of the bubble's motion (design audit P0-1,
 * P0-5, P1-3), kept free of the DOM so they can be unit-tested.
 */

/** Typewriter: short lines keep their cadence, long replies never take longer than the cap to appear. */
export const TYPE_MS_PER_CHAR = 18;
export const TYPE_MAX_MS = 600;

/** The bubble's exit transition (--dur-fast); the OS window shrinks only after it. */
export const EXIT_MS = 150;

/** Total time a reply takes to type out, in ms. Counts code points, so an emoji is one character. */
export function typeTotalMs(text: string): number {
  return Math.min(TYPE_MAX_MS, Array.from(text).length * TYPE_MS_PER_CHAR);
}

/**
 * The part of `text` visible `elapsedMs` into the typing. Always whole code
 * points (a surrogate pair is never split) and linear in time, so a 400-char
 * reply is complete at TYPE_MAX_MS.
 */
export function typedText(text: string, elapsedMs: number): string {
  const chars = Array.from(text);
  if (chars.length === 0) return '';
  const total = typeTotalMs(text);
  const n = total <= 0 ? chars.length : Math.min(chars.length, Math.ceil((Math.max(0, elapsedMs) / total) * chars.length));
  return chars.slice(0, n).join('');
}

/** Replies with markdown render whole through renderMarkdown (the chat panel shows them that way too); plain lines type. */
export function hasMarkdown(text: string): boolean {
  return /\*\*|`|^\s*[-*]\s/m.test(text);
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Deferred window collapse: hide() schedules it so the exit fade plays before
 * the OS window shrinks; show() cancels it, so a message arriving mid-fade
 * reverses the fade and the window never collapses.
 */
export class DeferredCollapse {
  private timer: Timer | null = null;

  constructor(
    private readonly run: () => void,
    private readonly delayMs: number = EXIT_MS,
    // Wrappers, not bare setTimeout: called as this.setT(...) Chromium's
    // setTimeout gets `this` = the instance and throws "Illegal invocation".
    private readonly setT: (fn: () => void, ms: number) => Timer = (fn, ms) => setTimeout(fn, ms),
    private readonly clearT: (t: Timer) => void = (t) => clearTimeout(t),
  ) {}

  schedule(): void {
    this.cancel();
    const setT = this.setT; // unbound call — see constructor
    this.timer = setT(() => { this.timer = null; this.run(); }, this.delayMs);
  }

  cancel(): void {
    if (this.timer !== null) { const clearT = this.clearT; clearT(this.timer); this.timer = null; }
  }

  get pending(): boolean {
    return this.timer !== null;
  }
}
