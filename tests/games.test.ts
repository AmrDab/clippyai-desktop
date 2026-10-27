import { describe, it, expect } from 'vitest';
import {
  parseGameIntent, rpsOutcome, rpsSeriesOver, clampRect, originForAnchor, easeStep,
  pickHideSpot, hideReaction, catchReaction,
} from '../src/main/games-logic';
import {
  flingVelocity, capSpeed, stepBall, isAtRest, clampBall, isWeakThrow, DEFAULT_PHYSICS, REDUCED_PHYSICS, Ball,
} from '../src/renderer/game-physics';

describe('parseGameIntent — client-side phrase routing', () => {
  it('starts each game from natural phrasing', () => {
    expect(parseGameIntent("let's play catch", false)).toEqual({ kind: 'start', game: 'catch' });
    expect(parseGameIntent('wanna play fetch?', false)).toEqual({ kind: 'start', game: 'catch' });
    expect(parseGameIntent('play hide and seek', false)).toEqual({ kind: 'start', game: 'hide' });
    expect(parseGameIntent("Let's play hide-and-seek!", false)).toEqual({ kind: 'start', game: 'hide' });
    expect(parseGameIntent('rock paper scissors', false)).toEqual({ kind: 'start', game: 'rps' });
    expect(parseGameIntent('rock, paper, scissors?', false)).toEqual({ kind: 'start', game: 'rps' });
  });
  it('offers the menu for a generic "play a game"', () => {
    expect(parseGameIntent('play a game', false)).toEqual({ kind: 'menu' });
    expect(parseGameIntent("let's play a game", false)).toEqual({ kind: 'menu' });
    expect(parseGameIntent('wanna play some games?', false)).toEqual({ kind: 'menu' });
  });
  it('does not hijack unrelated messages', () => {
    expect(parseGameIntent('catch me up on my emails', false)).toBeNull();
    expect(parseGameIntent('fetch the latest sales report', false)).toBeNull();
    expect(parseGameIntent('play some music', false)).toBeNull();
    expect(parseGameIntent('open the game settings', false)).toBeNull();
    expect(parseGameIntent('follow me', false)).toBeNull();
  });
  it('stop phrases only route while a game is active', () => {
    expect(parseGameIntent('stop', true)).toEqual({ kind: 'stop' });
    expect(parseGameIntent('stop the game', true)).toEqual({ kind: 'stop' });
    expect(parseGameIntent('I give up', true)).toEqual({ kind: 'stop' });
    expect(parseGameIntent('stop', false)).toBeNull();
    expect(parseGameIntent('stop the game', false)).toBeNull();
    expect(parseGameIntent('I give up', false)).toBeNull(); // play-tag still owns it
  });
});

describe('rock-paper-scissors', () => {
  it('scores every pairing from the user\'s side', () => {
    expect(rpsOutcome('rock', 'scissors')).toBe('win');
    expect(rpsOutcome('paper', 'rock')).toBe('win');
    expect(rpsOutcome('scissors', 'paper')).toBe('win');
    expect(rpsOutcome('rock', 'paper')).toBe('lose');
    expect(rpsOutcome('paper', 'scissors')).toBe('lose');
    expect(rpsOutcome('scissors', 'rock')).toBe('lose');
    expect(rpsOutcome('rock', 'rock')).toBe('tie');
  });
  it('best of 3 ends at two wins or three rounds', () => {
    expect(rpsSeriesOver({ user: 1, clippy: 1, rounds: 2 })).toBe(false);
    expect(rpsSeriesOver({ user: 2, clippy: 0, rounds: 2 })).toBe(true);
    expect(rpsSeriesOver({ user: 0, clippy: 2, rounds: 3 })).toBe(true);
    expect(rpsSeriesOver({ user: 1, clippy: 1, rounds: 3 })).toBe(true); // ties count as rounds
  });
});

describe('window geometry', () => {
  const wa = { x: 100, y: 50, width: 1000, height: 700 };
  it('clampRect shifts a rect inside the work area without shrinking', () => {
    expect(clampRect({ x: 0, y: 0, width: 140, height: 110 }, wa)).toEqual({ x: 100, y: 50, width: 140, height: 110 });
    expect(clampRect({ x: 5000, y: 5000, width: 140, height: 110 }, wa)).toEqual({ x: 960, y: 640, width: 140, height: 110 });
  });
  it('originForAnchor keeps the sprite anchor (bottom-right) on the target for any window size', () => {
    const o = originForAnchor({ x: 600, y: 500 }, { width: 140, height: 110 }, wa);
    expect([o.x + o.width, o.y + o.height]).toEqual([600, 500]);
    const big = originForAnchor({ x: 600, y: 500 }, { width: 380, height: 420 }, wa);
    expect([big.x + big.width, big.y + big.height]).toEqual([600, 500]);
    const edge = originForAnchor({ x: 120, y: 60 }, { width: 140, height: 110 }, wa);
    expect(edge).toEqual({ x: 100, y: 50, width: 140, height: 110 });
  });
  it('easeStep converges and snaps on arrival', () => {
    let cur = { x: 0, y: 0 };
    let n = 0;
    while (n++ < 200) {
      const s = easeStep(cur, { x: 300, y: -120 }, 0.16);
      cur = { x: s.x, y: s.y };
      if (s.arrived) break;
    }
    expect(cur).toEqual({ x: 300, y: -120 });
    expect(n).toBeLessThan(80);
  });
  it('pickHideSpot leaves only a slice of Clippy inside the work area, never on the top edge', () => {
    const size = { width: 140, height: 110 };
    for (let i = 0; i < 200; i++) {
      const r = pickHideSpot(wa, size);
      const visW = Math.min(r.x + r.width, wa.x + wa.width) - Math.max(r.x, wa.x);
      const visH = Math.min(r.y + r.height, wa.y + wa.height) - Math.max(r.y, wa.y);
      expect(visW).toBeGreaterThan(0);
      expect(visH).toBeGreaterThan(0);
      expect(visW * visH).toBeLessThan(size.width * size.height); // partially off-screen
      expect(r.y).toBeGreaterThanOrEqual(wa.y);
    }
    const left = pickHideSpot(wa, size, () => 0.0); // edge 'left', min peek
    expect(left.x).toBeLessThan(wa.x);
    expect(left.x + left.width - wa.x).toBe(Math.round(size.width * 0.3));
  });
  it('reactions escalate with time / streak', () => {
    expect(hideReaction(2000).animate).toBe('Congratulate');
    expect(hideReaction(30000).animate).toBe('GestureDown');
    expect(catchReaction(5).animate).toBe('Congratulate');
    expect(catchReaction(10).text).toMatch(/10 in a row/);
    expect(catchReaction(3).animate).toBe('Wave');
  });
});

describe('ball physics', () => {
  const bounds = { width: 1000, height: 600 };
  it('flingVelocity uses only the recent samples and ignores a slow lift', () => {
    const v = flingVelocity([
      { t: 0, x: 0, y: 0 },      // stale (outside 100 ms window)
      { t: 900, x: 100, y: 100 },
      { t: 950, x: 150, y: 90 },
      { t: 1000, x: 200, y: 80 },
    ], 1000);
    expect(v.vx).toBeCloseTo(1000); // 100 px over 0.1 s
    expect(v.vy).toBeCloseTo(-200);
    expect(flingVelocity([{ t: 1000, x: 5, y: 5 }], 1000)).toEqual({ vx: 0, vy: 0 });
    expect(flingVelocity([{ t: 0, x: 0, y: 0 }, { t: 10, x: 1, y: 0 }], 1000)).toEqual({ vx: 0, vy: 0 });
  });
  it('capSpeed preserves direction', () => {
    const v = capSpeed({ vx: 3000, vy: 4000 }, 1000);
    expect(Math.hypot(v.vx, v.vy)).toBeCloseTo(1000);
    expect(v.vx / v.vy).toBeCloseTo(0.75);
    expect(capSpeed({ vx: 10, vy: 0 }, 1000)).toEqual({ vx: 10, vy: 0 });
  });
  it('a thrown ball falls, bounces off the walls/floor and comes to rest inside the bounds', () => {
    let b: Ball = { x: 100, y: 100, vx: 1500, vy: -400, r: 22 };
    let bounced = false;
    let steps = 0;
    while (!isAtRest(b, bounds) && steps++ < 5000) {
      const prev = b;
      b = stepBall(b, 1 / 60, bounds);
      if (Math.sign(b.vx) !== Math.sign(prev.vx) && prev.vx !== 0) bounced = true;
      expect(b.x).toBeGreaterThanOrEqual(b.r);
      expect(b.x).toBeLessThanOrEqual(bounds.width - b.r);
      expect(b.y).toBeLessThanOrEqual(bounds.height - b.r);
    }
    expect(bounced).toBe(true);
    expect(isAtRest(b, bounds)).toBe(true);
    expect(b.y).toBeCloseTo(bounds.height - b.r);
    expect(steps).toBeLessThan(5000);
  });
  it('reduced-motion tuning settles faster with a softer bounce', () => {
    const run = (cfg: typeof DEFAULT_PHYSICS) => {
      let b: Ball = { x: 100, y: 100, vx: 1200, vy: -300, r: 22 };
      let steps = 0;
      let maxUpV = 0;
      while (!isAtRest(b, bounds) && steps++ < 5000) {
        b = stepBall(b, 1 / 60, bounds, cfg);
        if (b.vy < maxUpV) maxUpV = b.vy; // most negative = biggest bounce
      }
      return { steps, maxUpV };
    };
    const normal = run(DEFAULT_PHYSICS);
    const reduced = run(REDUCED_PHYSICS);
    expect(reduced.steps).toBeLessThan(normal.steps);
    expect(Math.abs(reduced.maxUpV)).toBeLessThan(Math.abs(normal.maxUpV));
  });
  it('isAtRest requires the floor; clampBall keeps the center inside', () => {
    expect(isAtRest({ x: 50, y: 50, vx: 0, vy: 0, r: 22 }, bounds)).toBe(false);
    expect(isAtRest({ x: 50, y: 578, vx: 5, vy: 0, r: 22 }, bounds)).toBe(true);
    expect(clampBall({ x: -50, y: 9999, vx: 0, vy: 0, r: 22 }, bounds)).toMatchObject({ x: 22, y: 578 });
  });
  it('flags a barely-thrown ball', () => {
    expect(isWeakThrow(100, 150)).toBe(true);
    // carried far, dropped after a pause (speed reads 0) → still fetched
    expect(isWeakThrow(0, 300)).toBe(false);
    expect(isWeakThrow(800, 30)).toBe(true);
    expect(isWeakThrow(800, 300)).toBe(false);
  });
});
