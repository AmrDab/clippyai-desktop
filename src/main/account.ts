/**
 * account.ts — Electron glue for onboarding v3: the email + 6-digit-code setup, and upgrade-by-checkout. The testable logic
 * (HTTP clients, parsing, polling) lives in account-api.ts.
 *
 * The license key and the code are never logged; outcome codes only.
 */
import { net, shell, BrowserWindow } from 'electron';
import { createLogger } from './logger';
import * as telemetry from './telemetry';
import * as api from './account-api';
import { planLabel } from './activate';
import * as quitState from './quit-state';
import { createOnboardingWindow, getSettingsWindow, noteOnboardingStep } from './window';
import { uiLang } from './lang';
import { t } from './i18n';
import { getLicenseKey, getPlan, saveLicense, getBuddyName, getTtsVoice, setPlan } from './license';

const log = createLogger('Account');

// net.fetch honours the system proxy (plain fetch in main does not).
const netFetch: api.FetchLike = (url, init) => net.fetch(url, init as unknown as RequestInit);

/** Open the email + code setup window (also used when there is no license and Clippy is asked something). */
export function openSetup(): void {
  createOnboardingWindow();
}

export async function sendEmailCode(email: string): Promise<api.SendCodeResult> {
  const r = await api.sendCode(email, netFetch, uiLang());
  telemetry.track('signup', { outcome: r.ok ? 'code_sent' : r.error });
  if (!r.ok) log.info('Code.sendFailed', { error: r.error });
  return r;
}

export type VerifyOutcome =
  | { ok: true; plan: string }
  | { ok: false; error: string; triesLeft?: number; retryAfter?: number };

/** Verify the code, then store the returned key. The key stays in main. */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyOutcome> {
  const r = await api.verifyCode(email, code, netFetch);
  telemetry.track('signup', { outcome: r.ok ? 'verified' : r.error });
  if (!r.ok) {
    log.info('Code.verifyFailed', { error: r.error });
    return {
      ok: false,
      error: r.error,
      triesLeft: r.error === 'wrong_code' ? r.triesLeft : undefined,
      retryAfter: r.error === 'rate_limited' ? r.retryAfter : undefined,
    };
  }
  saveLicense(r.licenseKey, r.plan, getBuddyName() || 'Clippy', getTtsVoice());
  noteOnboardingStep('verified');
  log.info('Code.verified', { plan: r.plan });
  return { ok: true, plan: r.plan };
}

// ── Plan refresh (launch, Settings open) ──

let lastRefreshAt = 0;

/** Re-read the plan from /validate and tell Settings if it changed. Never clears the license; throttled. */
export async function refreshPlan(): Promise<void> {
  const key = getLicenseKey();
  if (!key || !api.shouldRefreshPlan(lastRefreshAt, Date.now())) return;
  lastRefreshAt = Date.now();
  const c = await api.checkPlan(key, netFetch);
  if (c.state !== 'valid' || !c.plan || c.plan.toLowerCase() === getPlan().toLowerCase()) return;
  setPlan(c.plan.toLowerCase());
  log.info('Plan.refreshed', { plan: c.plan });
  getSettingsWindow()?.webContents.send('plan-changed', c.plan.toLowerCase());
}

// ── Upgrade: checkout in the browser, then poll /validate for the new plan ──

let pollGeneration = 0;

function say(win: BrowserWindow | null, text: string, animate = 'Congratulate'): void {
  if (!win || win.isDestroyed()) return;
  log.info('Clippy.say', { text, animation: animate, trigger: 'upgrade' });
  win.webContents.send('clippy-speak', { text, animate });
}

export type UpgradeOutcome =
  | { status: 'needs_email' }
  | { status: 'opened' }
  | { status: 'updating' }
  | { status: 'already'; plan: string }
  | { status: 'error'; message: string };

export async function startUpgrade(plan: unknown, win: BrowserWindow | null): Promise<UpgradeOutcome> {
  if (plan !== 'power' && plan !== 'max') return { status: 'error', message: 'Unknown plan.' };
  const key = getLicenseKey();
  if (!key) {
    openSetup(); // no account yet: sign in first
    return { status: 'needs_email' };
  }
  const before = getPlan();
  const r = await api.requestCheckout(key, plan, netFetch);
  telemetry.track('upgrade', { plan, outcome: r.ok ? ('updated' in r ? 'updated' : 'checkout') : r.error });
  if (!r.ok) {
    log.info('Checkout.failed', { error: r.error });
    return { status: 'error', message: t(uiLang(), 'checkout.error') };
  }
  // Never announce a plan from the click alone: an in-place change may still
  // need the user to confirm (Stripe page) or may fail to bill. Only the
  // /validate poll below says "You're on X now".
  const updating = 'updated' in r;
  // The server changed nothing: the key is already on that plan.
  if ('updated' in r && r.plan.toLowerCase() === before.toLowerCase()) return { status: 'already', plan: r.plan };
  if (!updating) {
    if (!api.isSafeCheckoutUrl(r.url)) {
      log.warn('Checkout.unsafeUrl');
      return { status: 'error', message: t(uiLang(), 'checkout.error') };
    }
    await shell.openExternal(r.url);
    log.info('Checkout.opened', { plan });
  }

  const gen = ++pollGeneration;
  void api.pollForUpgrade({
    fromPlan: before,
    check: () => api.checkPlan(getLicenseKey(), netFetch),
    cancelled: () => gen !== pollGeneration || getLicenseKey() !== key || quitState.isQuitting(),
  }).then((newPlan) => {
    if (!newPlan) {
      log.info('Checkout.pollEnded', { gen, stale: gen !== pollGeneration });
      return;
    }
    setPlan(newPlan);
    log.info('Checkout.planChanged', { plan: newPlan });
    getSettingsWindow()?.webContents.send('plan-changed', newPlan);
    say(win, t(uiLang(), 'upgraded', { plan: planLabel(newPlan) }) + ' 📎');
  });
  return updating ? { status: 'updating' } : { status: 'opened' };
}
