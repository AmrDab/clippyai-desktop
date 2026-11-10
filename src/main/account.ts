/**
 * account.ts — Electron glue for onboarding v3: the silent first-launch trial,
 * the email + 6-digit-code setup, and upgrade-by-checkout. The testable logic
 * (HTTP clients, parsing, polling) lives in account-api.ts.
 *
 * The license key and the code are never logged; outcome codes only.
 */
import { net, shell, BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import { createLogger } from './logger';
import * as telemetry from './telemetry';
import * as api from './account-api';
import { planLabel } from './activate';
import * as quitState from './quit-state';
import { createOnboardingWindow } from './window';
import { getLicenseKey, getPlan, isTrial, saveTrialLicense, saveLicense, getBuddyName, getTtsVoice, setPlan } from './license';

const log = createLogger('Account');

// net.fetch honours the system proxy (plain fetch in main does not).
const netFetch: api.FetchLike = (url, init) => net.fetch(url, init as unknown as RequestInit);

function readMachineGuid(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(err ? null : api.parseMachineGuid(String(stdout))));
  });
}

/**
 * First launch with no license: mint the silent trial key for this PC.
 * Returns true when a trial key was saved (skip the setup window). Windows
 * only — elsewhere, and on 409/429/offline, the caller opens the email setup.
 */
export async function startTrial(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const guid = await readMachineGuid();
  if (!guid) {
    log.warn('Trial.noMachineGuid');
    return false;
  }
  const r = await api.requestTrial(api.trialMachineHash(guid), netFetch);
  telemetry.track('trial', { outcome: r.ok ? 'ok' : r.error });
  if (!r.ok) {
    log.info('Trial.unavailable', { error: r.error });
    return false;
  }
  saveTrialLicense(r.licenseKey);
  log.info('Trial.started');
  return true;
}

/** Open the email + code screen: email-only when a (trial) key exists, full first-run flow otherwise. */
export function openSetup(reason?: 'trial_ended' | 'offer'): void {
  if (getLicenseKey()) createOnboardingWindow({ mode: 'email', reason });
  else createOnboardingWindow();
}

export async function sendEmailCode(email: string): Promise<api.SendCodeResult> {
  const r = await api.sendCode(email, netFetch);
  telemetry.track('signup', { outcome: r.ok ? 'code_sent' : r.error });
  if (!r.ok) log.info('Code.sendFailed', { error: r.error });
  return r;
}

export type VerifyOutcome =
  | { ok: true; plan: string }
  | { ok: false; error: string; message: string };

/** Verify the code with the current (trial) key as Bearer, then store the returned key. The key stays in main. */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyOutcome> {
  const r = await api.verifyCode(email, code, getLicenseKey() || undefined, netFetch);
  telemetry.track('signup', { outcome: r.ok ? 'verified' : r.error });
  if (!r.ok) {
    log.info('Code.verifyFailed', { error: r.error });
    return { ok: false, error: r.error, message: api.accountErrorMessage(r.error, r.error === 'wrong_code' ? r.triesLeft : undefined) };
  }
  saveLicense(r.licenseKey, r.plan, getBuddyName() || 'Clippy', getTtsVoice());
  log.info('Code.verified', { plan: r.plan });
  return { ok: true, plan: r.plan };
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
  | { status: 'error'; message: string };

export async function startUpgrade(plan: unknown, win: BrowserWindow | null): Promise<UpgradeOutcome> {
  if (plan !== 'power' && plan !== 'max') return { status: 'error', message: 'Unknown plan.' };
  const key = getLicenseKey();
  if (!key || isTrial()) {
    openSetup();
    return { status: 'needs_email' };
  }
  const before = getPlan();
  const r = await api.requestCheckout(key, plan, netFetch);
  telemetry.track('upgrade', { plan, outcome: r.ok ? ('updated' in r ? 'updated' : 'checkout') : r.error });
  if (!r.ok) {
    log.info('Checkout.failed', { error: r.error });
    if (r.error === 'email_required') {
      openSetup();
      return { status: 'needs_email' };
    }
    return { status: 'error', message: r.error === 'offline' ? "Couldn't reach our server. Check your connection and try again." : "Couldn't start checkout. Try again in a moment." };
  }
  // Never announce a plan from the click alone: an in-place change may still
  // need the user to confirm (Stripe page) or may fail to bill. Only the
  // /validate poll below says "You're on X now".
  const updating = 'updated' in r;
  if (!updating) {
    if (!api.isSafeCheckoutUrl(r.url)) {
      log.warn('Checkout.unsafeUrl');
      return { status: 'error', message: "Couldn't start checkout. Try again in a moment." };
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
    say(win, `You're on ${planLabel(newPlan)} now! 📎`);
  });
  return updating ? { status: 'updating' } : { status: 'opened' };
}
