/**
 * game-overlay.ts — v0.21 Catch overlay renderer.
 *
 * Owns the ball: drag → fling (velocity from the last pointer samples) →
 * physics (game-physics.ts) → reports the rest position to main, which
 * glides Clippy over, "picks it up" (carry mode: the ball rides on his
 * anchor) and re-arms the ball next to him (ball-ready).
 *
 * Coordinates: the window covers the display's work area, so local px =
 * screen DIP − work-area origin. Clippy's anchor (his sprite's bottom-right
 * corner) arrives in screen DIP and is converted here.
 */

import {
  Ball, PointerSample, DEFAULT_PHYSICS, REDUCED_PHYSICS, PhysicsConfig,
  flingVelocity, capSpeed, stepBall, isAtRest, clampBall, isWeakThrow,
} from './game-physics';

const BALL_R = 22;
const bridge = window.clippy.gameOverlay!;
const ballEl = document.getElementById('ball') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;

let wa = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
let cfg: PhysicsConfig = DEFAULT_PHYSICS;
let ball: Ball = { x: 100, y: 100, vx: 0, vy: 0, r: BALL_R };
let mode: 'idle' | 'ready' | 'dragging' | 'flying' | 'carried' = 'idle';
let samples: PointerSample[] = [];
let throwStart = { x: 0, y: 0 };
let raf: number | null = null;
let lastT = 0;
let restSince = 0;
let hintShown = false;
let throwSpeed = 0;

function bounds(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function toLocal(anchor: { x: number; y: number }): { x: number; y: number } {
  return { x: anchor.x - wa.x, y: anchor.y - wa.y };
}

function draw(): void {
  ballEl.style.transform = `translate(${ball.x - BALL_R}px, ${ball.y - BALL_R}px)`;
}

/** Place the ball at rest just left of Clippy's feet, ready to be thrown. */
function placeReady(anchor: { x: number; y: number }): void {
  const a = toLocal(anchor);
  ball = clampBall({ x: a.x - 140 - BALL_R - 12, y: a.y - BALL_R, vx: 0, vy: 0, r: BALL_R }, bounds());
  mode = 'ready';
  ballEl.classList.remove('hidden', 'dragging');
  draw();
  if (!hintShown) {
    hintShown = true;
    hintEl.style.left = `${ball.x}px`;
    hintEl.style.top = `${Math.max(8, ball.y - 60)}px`;
    hintEl.classList.remove('hidden');
    setTimeout(() => hintEl.classList.add('hidden'), 3500);
  }
}

function stopLoop(): void {
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
}

function fly(): void {
  stopLoop();
  mode = 'flying';
  lastT = performance.now();
  restSince = 0;
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    ball = stepBall(ball, dt, bounds(), cfg);
    draw();
    if (isAtRest(ball, bounds())) {
      if (!restSince) restSince = now;
      if (now - restSince > 250) {
        raf = null;
        mode = 'idle';
        ball = { ...ball, vx: 0, vy: 0 };
        draw();
        const distance = Math.hypot(ball.x - throwStart.x, ball.y - throwStart.y);
        bridge.ballRest({ x: ball.x, y: ball.y, r: BALL_R, speed: throwSpeed, distance, weak: isWeakThrow(throwSpeed, distance) });
        return;
      }
    } else {
      restSince = 0;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ── Pointer handling ─────────────────────────────────────────────────────────

ballEl.addEventListener('mouseenter', () => { if (mode !== 'carried') bridge.setIgnoreMouse(false); });
ballEl.addEventListener('mouseleave', () => { if (mode !== 'dragging') bridge.setIgnoreMouse(true); });

ballEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || mode === 'carried' || mode === 'flying') return;
  stopLoop();
  mode = 'dragging';
  ballEl.classList.add('dragging');
  ballEl.setPointerCapture(e.pointerId);
  samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
  throwStart = { x: e.clientX, y: e.clientY };
  hintEl.classList.add('hidden');
  e.preventDefault();
});

ballEl.addEventListener('pointermove', (e) => {
  if (mode !== 'dragging') return;
  ball = clampBall({ ...ball, x: e.clientX, y: e.clientY }, bounds());
  draw();
  samples.push({ t: performance.now(), x: e.clientX, y: e.clientY });
  if (samples.length > 12) samples.shift();
});

function release(e: PointerEvent): void {
  if (mode !== 'dragging') return;
  ballEl.classList.remove('dragging');
  try { ballEl.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  const v = capSpeed(flingVelocity(samples, performance.now()), cfg.maxSpeed);
  throwSpeed = Math.hypot(v.vx, v.vy);
  ball = { ...ball, vx: v.vx, vy: v.vy };
  samples = [];
  bridge.setIgnoreMouse(true);
  fly();
}
ballEl.addEventListener('pointerup', release);
ballEl.addEventListener('pointercancel', release);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') bridge.stop(); });

// ── Main ⇄ overlay ───────────────────────────────────────────────────────────

bridge.onInit((p) => {
  wa = p.wa;
  cfg = p.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? REDUCED_PHYSICS : DEFAULT_PHYSICS;
  placeReady(p.anchor);
});

bridge.onCarry(({ anchor }) => {
  if (anchor) {
    stopLoop();
    mode = 'carried';
    const a = toLocal(anchor);
    // Ride just below-left of the sprite's hand (anchor is the bottom-right).
    ball = { x: a.x - 58, y: a.y - 26, vx: 0, vy: 0, r: BALL_R };
    bridge.setIgnoreMouse(true);
    draw();
  } else {
    mode = 'idle';
  }
});

bridge.onBallReady(({ anchor }) => placeReady(anchor));

bridge.ready();
