/**
 * account-api.ts — clients for the onboarding-v3 account endpoints
 * (/v1/trial, /v1/free-signup {code:true}, /v1/verify-code, /v1/checkout,
 * /validate) plus the small pure helpers around them.
 *
 * Pure (no Electron imports): the HTTP function is injected so every branch is
 * unit-testable. The license key, the 6-digit code and the machine hash are
 * NEVER logged here and never put in a URL — callers log outcome codes only.
 */
import crypto from 'crypto';
import { isValidEmail, isCompleteCode } from './account-input';

export { isValidEmail, normalizeCode, isCompleteCode } from './account-input';

export const ACCOUNT_API_BASE = 'https://api.clippyai.app';
/** Fixed salt for the trial machine hash. Must match the backend's expectation. */
export const TRIAL_SALT = 'clippyai-trial-v1';

export interface FetchInit { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
export type FetchLike = (url: string, init: FetchInit) => Promise<{ status: number; json: () => Promise<unknown> }>;

const REQUEST_TIMEOUT_MS = 15_000;
/** First launch waits on this one: keep it short so setup shows quickly on a bad network. */
const TRIAL_TIMEOUT_MS = 6_000;

type Json = Record<string, unknown>;

/** POST JSON. status 0 = could not reach the server at all. */
async function postJson(fetchFn: FetchLike, path: string, body: unknown, bearer?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  try {
    const res = await fetchFn(`${ACCOUNT_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let parsed: Json = {};
    try {
      const j = await res.json();
      if (j && typeof j === 'object') parsed = j as Json;
    } catch { /* status decides */ }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: {} };
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Seconds the server asks us to wait (429 bodies carry `retry_after`); undefined when absent. */
const retryAfter = (b: Json): number | undefined => (typeof b.retry_after === 'number' && b.retry_after > 0 ? Math.ceil(b.retry_after) : undefined);

// ── Pure helpers ─────────────────────────────────────────────────────

/** Extract the GUID from `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` output. */
export function parseMachineGuid(regOutput: string): string | null {
  const m = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{8,})/.exec(regOutput || '');
  return m ? m[1].toLowerCase() : null;
}

/** sha256 hex (64 chars) of the MachineGuid + the fixed salt. */
export function trialMachineHash(machineGuid: string): string {
  return crypto.createHash('sha256').update(`${machineGuid.trim().toLowerCase()}${TRIAL_SALT}`).digest('hex');
}

const PLAN_RANK: Record<string, number> = { free: 0, power: 1, max: 2 };
export function isUpgrade(from: string, to: string): boolean {
  return (PLAN_RANK[(to || '').toLowerCase()] ?? -1) > (PLAN_RANK[(from || '').toLowerCase()] ?? 0);
}

// ── POST /v1/trial ───────────────────────────────────────────────────

export type TrialResult =
  | { ok: true; licenseKey: string }
  | { ok: false; error: 'trial_used' | 'rate_limited' | 'offline' | 'server' };

export async function requestTrial(machineHash: string, fetchFn: FetchLike): Promise<TrialResult> {
  const r = await postJson(fetchFn, '/v1/trial', { machine: machineHash }, undefined, TRIAL_TIMEOUT_MS);
  if (r.status === 200 && str(r.body.licenseKey)) return { ok: true, licenseKey: str(r.body.licenseKey) };
  if (r.status === 409) return { ok: false, error: 'trial_used' };
  if (r.status === 429) return { ok: false, error: 'rate_limited' };
  return { ok: false, error: r.status === 0 ? 'offline' : 'server' };
}

// ── POST /v1/free-signup {code:true} ─────────────────────────────────

export type SendCodeResult =
  | { ok: true }
  | { ok: false; error: 'invalid_email' | 'offline' | 'server' }
  | { ok: false; error: 'rate_limited'; retryAfter?: number };

/** `lang` picks the language of the code email (backend ignores unknown values). */
export async function sendCode(email: string, fetchFn: FetchLike, lang = 'en'): Promise<SendCodeResult> {
  const trimmed = email.trim();
  if (!isValidEmail(trimmed)) return { ok: false, error: 'invalid_email' };
  const r = await postJson(fetchFn, '/v1/free-signup', { email: trimmed, code: true, lang });
  if (r.status === 200 && r.body.ok === true) return { ok: true };
  if (r.status === 400) return { ok: false, error: 'invalid_email' };
  if (r.status === 429) return { ok: false, error: 'rate_limited', retryAfter: retryAfter(r.body) };
  return { ok: false, error: r.status === 0 ? 'offline' : 'server' };
}

// ── POST /v1/verify-code ─────────────────────────────────────────────

export type VerifyResult =
  | { ok: true; licenseKey: string; plan: string }
  | { ok: false; error: 'wrong_code'; triesLeft: number }
  | { ok: false; error: 'rate_limited'; retryAfter?: number }
  | { ok: false; error: 'code_expired' | 'invalid_email' | 'offline' | 'server' };

/** `bearer` is the current (trial) key so the backend can attach the email to it. */
export async function verifyCode(email: string, code: string, bearer: string | undefined, fetchFn: FetchLike): Promise<VerifyResult> {
  if (!isCompleteCode(code)) return { ok: false, error: 'wrong_code', triesLeft: 0 };
  const r = await postJson(fetchFn, '/v1/verify-code', { email: email.trim(), code }, bearer || undefined);
  if (r.status === 200 && str(r.body.licenseKey)) {
    return { ok: true, licenseKey: str(r.body.licenseKey), plan: str(r.body.plan) || 'free' };
  }
  if (r.status === 410) return { ok: false, error: 'code_expired' };
  if (r.status === 400 && r.body.error === 'wrong_code') {
    return { ok: false, error: 'wrong_code', triesLeft: typeof r.body.tries_left === 'number' ? r.body.tries_left : 0 };
  }
  if (r.status === 400) return { ok: false, error: 'invalid_email' };
  if (r.status === 429) return { ok: false, error: 'rate_limited', retryAfter: retryAfter(r.body) };
  return { ok: false, error: r.status === 0 ? 'offline' : 'server' };
}

// ── POST /v1/checkout ────────────────────────────────────────────────

export type CheckoutPlan = 'power' | 'max';
export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: true; updated: true; plan: string }
  | { ok: false; error: 'email_required' | 'unauthorized' | 'unknown_plan' | 'offline' | 'server' };

export async function requestCheckout(key: string, plan: CheckoutPlan, fetchFn: FetchLike): Promise<CheckoutResult> {
  const r = await postJson(fetchFn, '/v1/checkout', { plan }, key);
  if (r.status === 200 && r.body.updated === true) return { ok: true, updated: true, plan: str(r.body.plan) || plan };
  if (r.status === 200 && str(r.body.url)) return { ok: true, url: str(r.body.url) };
  if (r.status === 401) return { ok: false, error: 'unauthorized' };
  if (r.status === 403) return { ok: false, error: 'email_required' };
  if (r.status === 400) return { ok: false, error: 'unknown_plan' };
  return { ok: false, error: r.status === 0 ? 'offline' : 'server' };
}

/** Only https URLs on Stripe (checkout / billing portal) or our own site may be opened for payment. */
export function isSafeCheckoutUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'checkout.stripe.com' || u.hostname === 'billing.stripe.com' || u.hostname === 'clippyai.app' || u.hostname.endsWith('.clippyai.app'));
  } catch { return false; }
}

// ── POST /validate (plan poll) ───────────────────────────────────────

export type PlanCheck = { state: 'valid'; plan: string } | { state: 'invalid' } | { state: 'unreachable' };

export async function checkPlan(key: string, fetchFn: FetchLike): Promise<PlanCheck> {
  const r = await postJson(fetchFn, '/validate', { key });
  if (r.status >= 500 || r.status === 0) return { state: 'unreachable' };
  if (r.body.valid === true) return { state: 'valid', plan: str(r.body.plan) };
  if (r.body.valid === false) return { state: 'invalid' };
  return { state: 'unreachable' };
}

export interface PollOptions {
  fromPlan: string;
  check: () => Promise<PlanCheck>;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Return true to abandon the poll (a newer poll started, key changed, app closing). */
  cancelled?: () => boolean;
}

/** Poll until the plan becomes higher than `fromPlan`. Resolves the new plan, or null on timeout/cancel. */
export async function pollForUpgrade(opts: PollOptions): Promise<string | null> {
  const interval = opts.intervalMs ?? 5_000;
  const timeout = opts.timeoutMs ?? 30 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeout;
  while (now() < deadline) {
    await sleep(interval);
    if (opts.cancelled?.()) return null;
    const c = await opts.check();
    if (c.state === 'valid' && isUpgrade(opts.fromPlan, c.plan)) return c.plan.toLowerCase();
  }
  return null;
}

// ── "Add your email" bubble ──────────────────────────────────────────

export const EMAIL_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Offer the bubble only to trial keys, at most once a day. */
export function shouldOfferEmail(isTrialKey: boolean, lastPromptAt: number, now: number): boolean {
  return isTrialKey && now - lastPromptAt >= EMAIL_PROMPT_COOLDOWN_MS;
}

// ── Plan refresh ─────────────────────────────────────────────────────

export const PLAN_REFRESH_MIN_GAP_MS = 60_000;

/** Re-check the plan at launch and when Settings opens, but never more than once a minute (/validate is rate limited). */
export function shouldRefreshPlan(lastRefreshAt: number, now: number): boolean {
  return now - lastRefreshAt >= PLAN_REFRESH_MIN_GAP_MS;
}
