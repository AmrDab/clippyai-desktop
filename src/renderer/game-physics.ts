/**
 * game-physics.ts — v0.21
 *
 * Pure ball physics for the Catch mini-game overlay. No DOM, no Electron —
 * the overlay renderer drives it from requestAnimationFrame and vitest loads
 * it directly. Units: px (DIP) and seconds.
 */

export interface Ball { x: number; y: number; vx: number; vy: number; r: number }
export interface Bounds { width: number; height: number }

export interface PhysicsConfig {
  /** px/s² downward. */
  gravity: number;
  /** Fraction of velocity lost per second to air drag (0..1). */
  airDrag: number;
  /** Bounce restitution off edges and floor (0..1). */
  restitution: number;
  /** Fraction of horizontal velocity kept per second while rolling on the floor. */
  rollFriction: number;
  /** Fling speed cap, px/s. */
  maxSpeed: number;
}

export const DEFAULT_PHYSICS: PhysicsConfig = {
  gravity: 1800,
  airDrag: 0.25,
  restitution: 0.55,
  rollFriction: 0.25,
  maxSpeed: 2600,
};

/** Softer tuning for prefers-reduced-motion: no big bounces, shorter flights. */
export const REDUCED_PHYSICS: PhysicsConfig = {
  gravity: 2200,
  airDrag: 0.6,
  restitution: 0.15,
  rollFriction: 0.08,
  maxSpeed: 1400,
};

export interface PointerSample { t: number; x: number; y: number }

/**
 * Fling velocity (px/s) from the last ~100 ms of pointer samples. Returns
 * zero velocity for a slow lift or a single sample.
 */
export function flingVelocity(samples: PointerSample[], now: number, windowMs = 100): { vx: number; vy: number } {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

export function capSpeed(v: { vx: number; vy: number }, max: number): { vx: number; vy: number } {
  const mag = Math.hypot(v.vx, v.vy);
  if (mag <= max || mag === 0) return v;
  return { vx: (v.vx / mag) * max, vy: (v.vy / mag) * max };
}

/** Advance the ball by `dt` seconds inside `bounds` (0..width, 0..height). */
export function stepBall(b: Ball, dt: number, bounds: Bounds, cfg: PhysicsConfig = DEFAULT_PHYSICS): Ball {
  const floor = bounds.height - b.r;
  const onFloor = b.y >= floor - 0.5;
  let vx = b.vx;
  let vy = b.vy + cfg.gravity * dt;
  const drag = Math.max(0, 1 - cfg.airDrag * dt);
  vx *= drag;
  vy *= drag;
  if (onFloor && vy >= 0) vx *= Math.pow(cfg.rollFriction, dt);

  let x = b.x + vx * dt;
  let y = b.y + vy * dt;

  if (x < b.r) { x = b.r; vx = -vx * cfg.restitution; }
  else if (x > bounds.width - b.r) { x = bounds.width - b.r; vx = -vx * cfg.restitution; }
  if (y < b.r) { y = b.r; vy = -vy * cfg.restitution; }
  else if (y > floor) {
    y = floor;
    vy = -vy * cfg.restitution;
    if (Math.abs(vy) < 40) vy = 0; // kill micro-bounces
  }
  return { x, y, vx, vy, r: b.r };
}

/** At rest = sitting on the floor and barely moving. */
export function isAtRest(b: Ball, bounds: Bounds, minSpeed = 12): boolean {
  const onFloor = b.y >= bounds.height - b.r - 0.5;
  return onFloor && Math.abs(b.vx) < minSpeed && Math.abs(b.vy) < minSpeed;
}

/** Keep a ball center inside the bounds (used when placing / clamping). */
export function clampBall(b: Ball, bounds: Bounds): Ball {
  return {
    ...b,
    x: Math.min(Math.max(b.x, b.r), bounds.width - b.r),
    y: Math.min(Math.max(b.y, b.r), bounds.height - b.r),
  };
}

/** A throw that barely left the user's hand — Clippy teases instead of fetching. */
export function isWeakThrow(speed: number, distance: number): boolean {
  return speed < 250 || distance < 80;
}
