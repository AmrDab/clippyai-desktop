/**
 * bubble-motion.ts — the pure parts of the bubble's motion (design audit P0-1,
 * P0-5, P1-3), kept free of the DOM so they can be unit-tested.
 */

/** Typewriter: short lines keep their cadence, long replies never take longer than the cap to appear. */
export const TYPE_MS_PER_CHAR = 18;
export const TYPE_MAX_MS = 600;

/** The bubble's exit transition (--dur-fast); the OS window shrinks only after it. */
export const EXIT_MS = 150;

/** The recoil into Clippy (click on him, minimize, idle): a little longer than the plain exit. */
export const RECOIL_MS = 180;

export interface IdleState {
  /** ms since the last pointer / key activity on the surface, or since it last changed. */
  idleMs: number;
  /** Settings → bubbleAutoHideMs; 0 = manual (never). */
  autoHideMs: number;
  pinned: boolean;
  hover: boolean;
  /** The text field has the caret and the window has focus. */
  fieldFocused: boolean;
  draft: string;
  /** A task is running, or the mic is recording. */
  busy: boolean;
  /** A prompt that waits for the user (approval, an agent's question). */
  waitingForUser: boolean;
}

/** An open surface minimizes itself only when nothing shows the user is using it. */
export function shouldAutoMinimize(s: IdleState): boolean {
  if (s.autoHideMs <= 0 || s.pinned) return false;
  if (s.hover || s.fieldFocused || s.draft.trim() !== '' || s.busy || s.waitingForUser) return false;
  return s.idleMs >= s.autoHideMs;
}

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

/**
 * A prompt with buttons shows as a notification banner: a bold title line and a
 * body line. The title is the first line, or else the first sentence when it is
 * short. Never splits inside **bold** or `code`, or leaves a body with no words.
 */
export function splitBanner(text: string): { title: string; body: string } {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const m = nl > 0 ? [t, t.slice(0, nl).trim(), t.slice(nl + 1).trim()] : t.match(/^(.{1,80}?[.!?])\s+(\S[\s\S]*)$/);
  if (!m) return { title: t, body: '' };
  const [, title, body] = m;
  const unclosed = (s: string, mark: string): boolean => s.split(mark).length % 2 === 0;
  if (unclosed(title, '**') || unclosed(title, '`') || !/[\p{L}\p{N}]/u.test(body)) return { title: t, body: '' };
  return { title, body };
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
