// spatial-presence.ts — PURE decision logic for Clippy's "lives on your
// desktop" body language.
//
// window-follow.ts already moves Clippy to whatever window the user settles
// in (awake only). This module decides what Clippy DOES on arrival so the
// glide reads as presence instead of teleportation:
//
//   • gazeToward()             — which Look* animation faces the window he
//                                just moved toward (direction of travel).
//   • ambientAnimationForApp() — an occasional, app-flavored acknowledgment
//                                (code → GetTechy, browser → Searching,
//                                design → GetArtsy …).
//   • AmbientThrottle          — the silence-keeper. Lumiere's lesson is that
//                                the dominant action of a proactive engine is
//                                SILENCE; that goes for body language too. One
//                                ambient flourish per global window, one per
//                                app per longer window — gaze glances are the
//                                everyday default, flourishes are rare.
//
// All ANIMATION ONLY — no text, no sound, nothing for the user to dismiss.
// Deliberately ZERO imports (no Electron, no Node) so the smoke layer-1
// esbuild harness exercises the real module, same as input-triggers.ts.

export type GazeAnimation = 'LookLeft' | 'LookRight' | 'LookUp' | 'LookDown';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Which way should Clippy glance to acknowledge the window he just glided
 * toward? Compares centers; the dominant axis wins. Returns null when the
 * distance is too small to read as a direction (he's basically on it).
 */
export function gazeToward(clippy: Rect, target: Rect, minDistance = 48): GazeAnimation | null {
  const dx = (target.x + target.width / 2) - (clippy.x + clippy.width / 2);
  const dy = (target.y + target.height / 2) - (clippy.y + clippy.height / 2);
  if (Math.abs(dx) < minDistance && Math.abs(dy) < minDistance) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'LookLeft' : 'LookRight';
  return dy < 0 ? 'LookUp' : 'LookDown';
}

/**
 * App-flavored acknowledgment animation, keyed by process/app-name substring
 * (lowercased). Returns null for apps with no obvious flavor — the gaze
 * glance is the default, and null keeps unknown apps quiet rather than
 * generic. Media players are deliberately null: don't perform over someone's
 * music or movie.
 */
const APP_FLAVORS: Array<{ match: string[]; animation: string }> = [
  { match: ['code', 'cursor', 'terminal', 'iterm', 'warp', 'xcode', 'intellij', 'pycharm'], animation: 'GetTechy' },
  { match: ['chrome', 'safari', 'firefox', 'arc', 'edge', 'brave'], animation: 'Searching' },
  { match: ['figma', 'sketch', 'photoshop', 'illustrator', 'pixelmator', 'affinity'], animation: 'GetArtsy' },
  { match: ['word', 'pages', 'notes', 'obsidian', 'notion', 'textedit', 'bear', 'craft'], animation: 'Writing' },
  { match: ['mail', 'outlook', 'spark', 'mimestream'], animation: 'CheckingSomething' },
  { match: ['excel', 'numbers', 'sheets'], animation: 'CheckingSomething' },
  { match: ['slack', 'discord', 'messages', 'telegram', 'whatsapp'], animation: 'Wave' },
];

export function ambientAnimationForApp(app: string): string | null {
  const a = (app || '').toLowerCase();
  if (!a) return null;
  for (const flavor of APP_FLAVORS) {
    if (flavor.match.some((m) => a.includes(m))) return flavor.animation;
  }
  return null;
}

/**
 * Rate-limiter for ambient flourishes. Two windows, BOTH must be open:
 *   • global  — at most one flourish per `globalMs` across all apps, so
 *     rapid window-hopping produces at most one performance.
 *   • per-app — the same app doesn't get re-acknowledged for `perAppMs`,
 *     so bouncing between editor and browser doesn't become a loop of
 *     GetTechy/Searching/GetTechy/Searching.
 * Callers pass `now` explicitly (testability; no Date.now in pure code).
 */
export class AmbientThrottle {
  private lastGlobal = 0;
  private lastPerApp = new Map<string, number>();

  constructor(
    private readonly globalMs = 90_000,
    private readonly perAppMs = 300_000,
  ) {}

  /** True if an ambient flourish for `app` is allowed at `now` — and if so,
   *  records it (allow-then-commit in one step, matching call-site use). */
  allow(app: string, now: number): boolean {
    const key = (app || '').toLowerCase();
    if (!key) return false;
    if (now - this.lastGlobal < this.globalMs) return false;
    const last = this.lastPerApp.get(key) ?? 0;
    if (now - last < this.perAppMs) return false;
    this.lastGlobal = now;
    this.lastPerApp.set(key, now);
    return true;
  }

  /** Wipe history — e.g. on wake, so the first settle of a session lands. */
  reset(): void {
    this.lastGlobal = 0;
    this.lastPerApp.clear();
  }
}
