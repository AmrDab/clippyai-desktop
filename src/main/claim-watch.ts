/**
 * claim-watch.ts — finishes activation when the email link is opened on
 * ANOTHER device (v0.24). Telemetry showed new users signing up and never
 * activating: the email's Activate link opens `clippyai://`, which does
 * nothing on a phone.
 *
 * The free signup sends a random claim secret (one per app run, so a Resend
 * still matches older emails). When the link is opened anywhere, the web page
 * tells the API; we poll POST /v1/activate/claim with the secret and get the
 * key once. The secret and the key are never logged.
 */
import { randomBytes } from 'crypto';
import { pickUpClaim, type ActivationResult } from './activate';
import { createLogger } from './logger';

const log = createLogger('ClaimWatch');
const POLL_MS = 5_000;
const WATCH_MS = 30 * 60_000;

type Found = Extract<ActivationResult, { ok: true }>;
let claim: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let until = 0;
let onFound: ((r: Found) => void | Promise<void>) | null = null;
let isDone: () => boolean = () => false;

/** The claim secret for this app run (created on first use). */
export function getSignupClaim(): string {
  if (!claim) claim = randomBytes(32).toString('base64url');
  return claim;
}

/** index.ts wires what happens on success, and when to stop (already licensed). */
export function setClaimHandler(found: (r: Found) => void | Promise<void>, done: () => boolean): void {
  onFound = found;
  isDone = done;
}

/** Start (or extend) watching after a signup email was sent. */
export function watchClaim(): void {
  until = Date.now() + WATCH_MS;
  if (timer) return;
  log.info('ClaimWatch.start');
  const tick = async () => {
    timer = null;
    if (isDone() || Date.now() > until || !claim) { log.info('ClaimWatch.stop'); return; }
    const r = await pickUpClaim(claim);
    if (r === 'stop') { log.warn('ClaimWatch.rejected'); return; }
    if (r !== 'pending') {
      log.info('ClaimWatch.found', { plan: r.plan });
      if (!isDone()) await onFound?.(r);
      return;
    }
    timer = setTimeout(tick, POLL_MS);
  };
  timer = setTimeout(tick, POLL_MS);
}
