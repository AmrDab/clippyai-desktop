/**
 * games-logic.ts — v0.21
 *
 * Pure helpers for the local mini-games (no Electron imports so vitest can
 * load them directly). The stateful manager lives in games.ts.
 */

export type GameKind = 'catch' | 'hide' | 'rps';

export type GameIntent =
  | { kind: 'start'; game: GameKind }
  | { kind: 'menu' }
  | { kind: 'stop' };

/**
 * Client-side phrase routing for typed/voice input. Mirrors the follow-me
 * regex routing in brain.ts: cheap, deterministic, runs BEFORE any network
 * turn. `gameActive` gates the stop phrases so a plain "stop" outside a game
 * still reaches the model.
 */
export function parseGameIntent(text: string, gameActive: boolean): GameIntent | null {
  const t = text.trim();
  if (!t) return null;
  const play = /\b(play|playing|let'?s|wanna|want to|can we|start)\b/i;

  if (/\bhide[\s-]*(and|&|n|'n')[\s-]*seek\b/i.test(t) && play.test(t)) return { kind: 'start', game: 'hide' };
  if (/\brock[\s,]*paper[\s,]*scissors\b/i.test(t) || /\brps\b/i.test(t)) return { kind: 'start', game: 'rps' };
  if ((/\bcatch\b/i.test(t) || /\bfetch\b/i.test(t)) && play.test(t)) return { kind: 'start', game: 'catch' };
  if (/\b(play|playing|let'?s play|wanna play|want to play)\b.{0,8}\b(a |some )?games?\b/i.test(t)) return { kind: 'menu' };

  if (gameActive) {
    if (/\b(stop|end|quit|exit|enough)\b/i.test(t) && /\b(game|playing|it|this)\b/i.test(t)) return { kind: 'stop' };
    if (/^\s*(stop|quit|enough|done|i give up|give up|you win)\s*[.!]*\s*$/i.test(t)) return { kind: 'stop' };
    if (/\bgive up\b/i.test(t)) return { kind: 'stop' };
  }
  return null;
}

// ── Rock-paper-scissors ──────────────────────────────────────────────────────

export type RpsPick = 'rock' | 'paper' | 'scissors';
export const RPS_PICKS: RpsPick[] = ['rock', 'paper', 'scissors'];
export const RPS_EMOJI: Record<RpsPick, string> = { rock: '✊', paper: '✋', scissors: '✌️' };

/** Outcome from the USER's point of view. */
export function rpsOutcome(user: RpsPick, clippy: RpsPick): 'win' | 'lose' | 'tie' {
  if (user === clippy) return 'tie';
  const beats: Record<RpsPick, RpsPick> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return beats[user] === clippy ? 'win' : 'lose';
}

/** Best of 3: the series ends when someone reaches 2 wins or 3 rounds were played. */
export function rpsSeriesOver(score: { user: number; clippy: number; rounds: number }): boolean {
  return score.user >= 2 || score.clippy >= 2 || score.rounds >= 3;
}

// ── Geometry (all values in DIP, screen space) ───────────────────────────────

export interface Rect { x: number; y: number; width: number; height: number }

/** Clamp a window rect into a work area by shifting it (never shrinking). */
export function clampRect(rect: Rect, wa: Rect): Rect {
  const x = Math.min(Math.max(rect.x, wa.x), wa.x + wa.width - rect.width);
  const y = Math.min(Math.max(rect.y, wa.y), wa.y + wa.height - rect.height);
  return { x: Math.round(x), y: Math.round(y), width: rect.width, height: rect.height };
}

/**
 * Window origin that puts Clippy's sprite anchor (the window's BOTTOM-RIGHT
 * corner — see window.ts) at `anchor`, clamped so the window stays inside
 * the work area. Works for any current window size (bubble open or not).
 */
export function originForAnchor(anchor: { x: number; y: number }, size: { width: number; height: number }, wa: Rect): Rect {
  return clampRect({ x: anchor.x - size.width, y: anchor.y - size.height, ...size }, wa);
}

/** One easing step toward a target; returns the new position and whether it arrived. */
export function easeStep(cur: { x: number; y: number }, target: { x: number; y: number }, factor: number): { x: number; y: number; arrived: boolean } {
  const x = cur.x + (target.x - cur.x) * factor;
  const y = cur.y + (target.y - cur.y) * factor;
  const arrived = Math.abs(target.x - x) < 1.5 && Math.abs(target.y - y) < 1.5;
  return arrived ? { x: target.x, y: target.y, arrived } : { x, y, arrived };
}

/**
 * Hide-and-seek spot: a random point along a work-area edge (or a corner)
 * where the 140×110 sprite window is partially off-screen so only a slice
 * of Clippy peeks out. `rng` is injectable for tests. Never picks the top
 * edge — Electron/macOS push windows back below the menu bar there, and
 * the bubble needs room to open above him when he's found.
 */
export function pickHideSpot(wa: Rect, size: { width: number; height: number }, rng: () => number = Math.random): Rect {
  const edge = (['left', 'right', 'bottom', 'corner'] as const)[Math.floor(rng() * 4)];
  const peekW = Math.round(size.width * (0.3 + rng() * 0.25)); // 30–55 % visible
  const peekH = Math.round(size.height * (0.35 + rng() * 0.25));
  const spanY = Math.max(0, wa.height - size.height);
  const spanX = Math.max(0, wa.width - size.width);
  const randY = wa.y + Math.floor(rng() * spanY);
  const randX = wa.x + Math.floor(rng() * spanX);
  switch (edge) {
    case 'left': return { x: wa.x - (size.width - peekW), y: randY, ...size };
    case 'right': return { x: wa.x + wa.width - peekW, y: randY, ...size };
    case 'bottom': return { x: randX, y: wa.y + wa.height - peekH, ...size };
    default: { // tucked into a bottom corner, peeking diagonally
      const left = rng() < 0.5;
      return {
        x: left ? wa.x - (size.width - peekW) : wa.x + wa.width - peekW,
        y: wa.y + wa.height - peekH,
        ...size,
      };
    }
  }
}

/** Hide-and-seek reaction keyed by how long the search took. */
export function hideReaction(elapsedMs: number): { text: string; animate: string } {
  const s = elapsedMs / 1000;
  if (s < 4) return { text: `Found in ${s.toFixed(1)}s?! You've got eagle eyes! 📎`, animate: 'Congratulate' };
  if (s < 12) return { text: `${s.toFixed(1)}s — nice find! 📎`, animate: 'Wave' };
  return { text: `${Math.round(s)}s… I almost grew roots back there! 📎`, animate: 'GestureDown' };
}

/** Catch reaction keyed by the current streak (escalates at 5 / 10). */
export function catchReaction(streak: number): { text: string; animate: string } {
  if (streak > 0 && streak % 10 === 0) return { text: `${streak} in a row! I'm unstoppable! 📎`, animate: 'Congratulate' };
  if (streak > 0 && streak % 5 === 0) return { text: `${streak} catches! We're on a roll! 📎`, animate: 'Congratulate' };
  const lines = ['Got it! Throw again! 📎', 'Mine! Again, again! 📎', 'Caught it! 📎', 'Easy. Give me a tough one! 📎'];
  return { text: `${lines[streak % lines.length]} (streak ${streak})`, animate: 'Wave' };
}
