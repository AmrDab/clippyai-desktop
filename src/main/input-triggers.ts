// input-triggers.ts — PURE trigger / rolling-buffer / redaction logic for the
// input monitor.
//
// Deliberately ZERO imports: no Electron, no Node, no logger. That keeps this
// the unit-testable core (smoke layer 1 transpiles the real source and
// exercises it) and keeps the privacy-sensitive matching logic small enough
// to read in one sitting. The process/IPC plumbing lives in input-monitor.ts.

/** A trigger the matcher can fire from the keystroke stream. */
export type Trigger =
  | { kind: 'summon'; phrase: string }
  | { kind: 'escape' };

/**
 * Matches the typed-character stream against wake phrases (e.g. "hello clippy")
 * and surfaces ESC. Backed by a tiny rolling, lowercased buffer that is capped
 * to `maxLen` and NEVER persisted — it exists only to detect a trailing wake
 * phrase, not to record what the user types.
 */
export class TriggerMatcher {
  private buf = '';
  private readonly phrases: string[];
  private readonly maxLen: number;

  constructor(phrases: string[] = ['hello clippy'], maxLen = 64) {
    this.phrases = phrases
      .map((p) => p.toLowerCase().replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);
    const longest = this.phrases.reduce((m, p) => Math.max(m, p.length), 0);
    this.maxLen = Math.max(maxLen, longest);
  }

  /** Feed one typed character. Returns a Trigger if one just fired. */
  pushChar(ch: string): Trigger | null {
    if (!ch) return null;
    // Any whitespace collapses to a single space for phrase matching.
    const norm = /\s/.test(ch) ? ' ' : ch.toLowerCase();
    this.buf = (this.buf + norm).slice(-this.maxLen);
    for (const p of this.phrases) {
      if (p && this.buf.endsWith(p)) {
        this.buf = '';
        return { kind: 'summon', phrase: p };
      }
    }
    return null;
  }

  /** Feed a named non-text key. ESC fires + resets; enter/tab reset the buffer. */
  pushSpecial(key: string): Trigger | null {
    if (key === 'escape') {
      this.buf = '';
      return { kind: 'escape' };
    }
    if (key === 'return' || key === 'tab') {
      this.buf = '';
    }
    return null;
  }

  reset(): void {
    this.buf = '';
  }
}

/** "hey clippy" / "hi clippy" (space optional) at the end of the buffer, with a
 *  word boundary on the left so "they clippy" does not count. */
const WAKE_RE = /(?:^| )h(?:ey|i) ?clippy$/;
const WAKE_MAX = 12;

/**
 * The "hey clippy" wake phrase. Separate from TriggerMatcher and RollingBuffer
 * on purpose: this buffer holds at most 12 lowercase letters/spaces, lives in
 * memory only, and is never read by anything but the match below, so the wake
 * stream can never reach a request.
 */
export class WakeMatcher {
  private buf = '';
  private lastKeyAt = 0;
  private lastFiredAt = -Infinity;

  constructor(
    private readonly idleMs = 4_000,
    private readonly minGapMs = 2_000,
  ) {}

  /** Feed one typed character. True when the wake phrase was just typed. */
  pushChar(ch: string, now: number = Date.now()): boolean {
    if (now - this.lastKeyAt > this.idleMs) this.buf = '';
    this.lastKeyAt = now;
    // Backspace (the macOS full stream sends it as DEL).
    if (ch === '\b' || ch === '\x7f') {
      this.buf = this.buf.slice(0, -1);
      return false;
    }
    const c = ch.toLowerCase();
    if (!/^[a-z ]$/.test(c)) return false;
    this.buf = (this.buf + c).slice(-WAKE_MAX);
    if (!WAKE_RE.test(this.buf)) return false;
    this.buf = '';
    if (now - this.lastFiredAt < this.minGapMs) return false;
    this.lastFiredAt = now;
    return true;
  }

  /** Backspace removes a char; any other named key (arrows, Enter, Tab, Esc) clears. */
  pushSpecial(key: string): void {
    if (key === 'backspace' || key === 'delete') this.buf = this.buf.slice(0, -1);
    else this.buf = '';
  }

  reset(): void {
    this.buf = '';
  }
}

/**
 * Redact obvious secrets from a text snapshot before it could ever be used as
 * distillation input. Conservative by design — over-redacting a snapshot that
 * never leaves the device raw anyway is the safe failure mode.
 */
export function redactSecrets(text: string): string {
  return text
    // 9+ digit runs with optional space/hyphen separators: cards, SSNs,
    // account numbers, OTP codes, long phone numbers.
    .replace(/\d(?:[ -]?\d){8,}/g, '[redacted-number]')
    // common API-key shapes
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]')
    .replace(/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g, '[redacted-key]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted-key]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '[redacted-key]')
    // long hex/base64-ish bearer tokens
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]');
}

/**
 * A short, time-bounded, redacted window of recent typing. In-memory only;
 * callers MUST clear() on app/field switch and on sleep/eyes-closed. The
 * snapshot — the only thing ever eligible for distillation — is always
 * redacted.
 */
export class RollingBuffer {
  private events: Array<{ ch: string; ts: number }> = [];

  constructor(
    private readonly windowMs = 30_000,
    private readonly maxChars = 2_000,
  ) {}

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++;
    if (drop > 0) this.events.splice(0, drop);
    if (this.events.length > this.maxChars) {
      this.events.splice(0, this.events.length - this.maxChars);
    }
  }

  push(ch: string, now: number = Date.now()): void {
    if (!ch) return;
    this.events.push({ ch, ts: now });
    this.evict(now);
  }

  /** Redacted text of the recent window. */
  snapshot(now: number = Date.now()): string {
    this.evict(now);
    return redactSecrets(this.events.map((e) => e.ch).join(''));
  }

  clear(): void {
    this.events = [];
  }

  get size(): number {
    return this.events.length;
  }
}
