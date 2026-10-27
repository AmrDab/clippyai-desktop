import Store from 'electron-store';
import { net, app } from 'electron';
import os from 'os';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { clearAllSecrets } from './skills/secrets';

const API_BASE = 'https://api.clippyai.app';
const GRACE_PERIOD_DAYS = 1; // 24h grace when API is temporarily unreachable

interface LicenseStore {
  licenseKey: string;
  plan: string;
  buddyName: string;
  ttsVoice: string;
  validated: boolean;
  graceExpiry: number;      // timestamp — grace window when API unreachable
  lastValidated: number;    // timestamp — when key was last confirmed with API
  // v0.19.0 PR-6 — onboarding app picker + API-key presence flags.
  // The actual API tokens live in macOS Keychain via setSecret('clippyai-api', appId, …);
  // only a presence boolean per app rides in the store. Why split: tokens are
  // sensitive and belong in Keychain (where the OS handles encryption +
  // user-prompt-on-export); the presence flag is what tools.ts checks to
  // decide between API-route and UI-automation fallback, so it needs to be
  // sync-readable without an async keychain hit on every tool call.
  userApps: string[];
  apiKeys: Record<string, boolean>;
  // v0.20.0 (voice v1) — optional OpenAI voice (TTS/STT). The key itself
  // lives in Keychain (service `clippyai-api`, account `openai`); only a
  // presence boolean rides in the store so get-config can answer without
  // an async keychain hit. ttsEngine picks System (free, default) vs OpenAI.
  openaiKeyPresent: boolean;
  ttsEngine: 'system' | 'openai';
  // feat/pricing-free-tier — last usage snapshot from a /turn response. Lets
  // Settings render a monthly usage meter (tokensUsed / tokensAllowed) without
  // a dedicated usage endpoint. Additive + best-effort: zero means "unknown".
  tokensUsed: number;
  tokensAllowed: number;
}

const store = new Store<LicenseStore>({
  defaults: {
    licenseKey: '',
    plan: '',
    buddyName: 'Clippy',
    ttsVoice: '',
    validated: false,
    graceExpiry: 0,
    lastValidated: 0,
    userApps: [],
    apiKeys: {},
    // v0.20.0 (voice v1) — default OFF / System voice so the free, offline
    // path stays the default. Opt-in only.
    openaiKeyPresent: false,
    ttsEngine: 'system',
    tokensUsed: 0,
    tokensAllowed: 0,
  },
});

// ── Helpers ──────────────────────────────────────────────────────────

function getMachineFingerprint(): string {
  try {
    const hostname = os.hostname();
    const username = os.userInfo().username;
    const ifaces = os.networkInterfaces();
    const macs: string[] = [];
    for (const name of Object.keys(ifaces)) {
      const list = ifaces[name];
      if (!list) continue;
      for (const iface of list) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }
    const seed = `${hostname}|${username}|${macs.sort().join(',')}`;
    return crypto.createHash('sha256').update(seed).digest('hex').substring(0, 16).toUpperCase();
  } catch {
    return 'UNKNOWN';
  }
}

// ── Getters ──────────────────────────────────────────────────────────

export function getLicenseKey(): string {
  return store.get('licenseKey');
}

export function getPlan(): string {
  return store.get('plan');
}

export function getBuddyName(): string {
  return store.get('buddyName');
}

export function getTtsVoice(): string {
  return store.get('ttsVoice');
}

export function getMachineId(): string {
  return getMachineFingerprint();
}

// feat/pricing-free-tier — usage snapshot accessors. The worker stamps
// `tokens_used` / `tokens_allowed` on every successful /turn response; brain.ts
// records the latest here so Settings can show a free-tier usage meter.
export function recordUsage(tokensUsed: number, tokensAllowed: number): void {
  if (Number.isFinite(tokensUsed)) store.set('tokensUsed', Math.max(0, tokensUsed));
  if (Number.isFinite(tokensAllowed) && tokensAllowed > 0) store.set('tokensAllowed', tokensAllowed);
}

export function getUsage(): { tokensUsed: number; tokensAllowed: number } {
  return {
    tokensUsed: store.get('tokensUsed', 0),
    tokensAllowed: store.get('tokensAllowed', 0),
  };
}

export function isFirstRun(): boolean {
  return !store.get('licenseKey');
}

// ── License checks ───────────────────────────────────────────────────

const REVALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * BUG FIX v0.17.1 — previously this function returned false when the
 * stored key was more than 24 hours stale, even though the key was
 * still in the store. src/main/index.ts read that as "no license,
 * show onboarding" and never even tried to revalidate. Every cold
 * start more than a day apart sent the user back to re-enter their
 * key. The intent of isLicensed() was always "do we have a stored
 * key to work with" — the freshness check belongs in
 * revalidateIfNeeded(), and the cold-start flow in index.ts already
 * calls that after a true-return.
 */
export function isLicensed(): boolean {
  return !!store.get('licenseKey');
}

// ── Save / clear ─────────────────────────────────────────────────────

export function saveLicense(key: string, plan: string, buddyName: string, ttsVoice: string): void {
  store.set('licenseKey', key);
  store.set('plan', plan);
  store.set('buddyName', buddyName);
  store.set('ttsVoice', ttsVoice);
  store.set('validated', true);
  store.set('lastValidated', Date.now());
}

export function clearLicense(): void {
  store.set('licenseKey', '');
  store.set('plan', '');
  store.set('validated', false);
  store.set('graceExpiry', 0);
  store.set('lastValidated', 0);
}

/**
 * Full local reset for the EXPLICIT user "clear license / start fresh" action.
 * Beyond clearLicense(): also wipes the Keychain API tokens (which survive even
 * a manual Application-Support delete) and the on-disk profile so NOTHING is
 * orphaned and the next launch re-onboards from a clean slate. NOT used on
 * transient server-revokes — clearLicense() alone handles those, so a lapsed
 * subscription doesn't nuke the user's persona/instincts.
 */
export async function clearAllLocalData(): Promise<void> {
  clearLicense();
  store.set('buddyName', '');
  store.set('ttsVoice', '');
  // Keychain (service must match api-routes.ts API_KEYCHAIN_SERVICE) — the one
  // store that survives deleting ~/Library/Application Support/ClippyAI.
  await clearAllSecrets('clippyai-api');
  // On-disk profile / learned state under userData.
  const userData = app.getPath('userData');
  for (const rel of ['profile', 'action-history.json', 'user.md']) {
    try {
      fs.rmSync(path.join(userData, rel), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

export function setGracePeriod(): void {
  const expiry = Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  store.set('graceExpiry', expiry);
}

// ── API validation ───────────────────────────────────────────────────

/**
 * Result of an API validation call.
 *   - 'valid'       — server explicitly said key is good
 *   - 'invalid'     — server explicitly said key is bad (revoked, expired,
 *                     wrong-format). Only this state should clear the key.
 *   - 'unreachable' — anything else: network error, HTTP 5xx, malformed
 *                     response, timeout. Caller treats this as "trust the
 *                     stored state, grant grace" — NOT "user's key is bad".
 *
 * Why the discriminated state: pre-v0.17.1 the function returned
 * `{valid: boolean}` and any non-2xx or parse-error collapsed to
 * `{valid: false}`. revalidateIfNeeded() then cleared the license on
 * the first 5xx from our worker — one transient incident permanently
 * kicked the user back to onboarding.
 */
export interface ValidationResult {
  state: 'valid' | 'invalid' | 'unreachable';
  plan: string;
}

export async function validateLicenseKey(key: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const req = net.request({
      url: `${API_BASE}/validate`,
      method: 'POST',
    });
    req.setHeader('Content-Type', 'application/json');

    const grantGraceIfPossible = (): ValidationResult => {
      // API unreachable / 5xx / parse failure — only grant grace if a
      // key already exists in the store. Otherwise the caller is
      // validating a freshly-typed key and we have no fallback state.
      const existingKey = store.get('licenseKey');
      if (existingKey) {
        setGracePeriod();
        return { state: 'unreachable', plan: store.get('plan') || 'grace' };
      }
      return { state: 'unreachable', plan: '' };
    };

    req.on('response', (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        // HTTP 5xx → server is sick. Don't trust the body, don't revoke.
        if (response.statusCode && response.statusCode >= 500) {
          resolve(grantGraceIfPossible());
          return;
        }
        try {
          const parsed = JSON.parse(data) as { valid?: boolean; plan?: string };
          if (parsed && parsed.valid === true) {
            store.set('validated', true);
            store.set('lastValidated', Date.now());
            if (parsed.plan) store.set('plan', parsed.plan);
            resolve({ state: 'valid', plan: parsed.plan || store.get('plan') });
          } else if (parsed && parsed.valid === false) {
            // Server explicitly rejected — this is the ONLY path that
            // clears the license in revalidateIfNeeded(). 4xx with a
            // proper {valid:false} body counts; HTML error pages don't.
            resolve({ state: 'invalid', plan: '' });
          } else {
            // Body parsed but didn't have `valid` boolean — malformed
            // response, treat as unreachable so we don't revoke on a
            // server-side bug we don't control.
            resolve(grantGraceIfPossible());
          }
        } catch {
          // Body wasn't JSON (HTML 404 page, gateway error page, empty).
          // Don't revoke — server's having a bad day.
          resolve(grantGraceIfPossible());
        }
      });
    });

    req.on('error', () => {
      resolve(grantGraceIfPossible());
    });

    req.write(JSON.stringify({ key }));
    req.end();
  });
}

/**
 * Revalidate the stored key with the API. Call at app startup.
 *
 * Returns true to mean "let the user keep using the app". The only
 * path that clears the stored license is an EXPLICIT 'invalid' state
 * from the server — i.e. the worker said {valid: false}. Transient
 * failures ('unreachable') keep the license in place and the user
 * keeps working under grace.
 *
 * Pre-v0.17.1 this cleared the license on any non-valid result,
 * including server 5xx and malformed responses. Combined with the
 * isLicensed() 24h staleness bug, that meant either a worker hiccup
 * OR a >24h gap between launches kicked the user back to onboarding.
 */
export async function revalidateIfNeeded(): Promise<boolean> {
  const key = store.get('licenseKey');
  if (!key) return false;

  const lastCheck = store.get('lastValidated');
  if (lastCheck > 0 && Date.now() - lastCheck < REVALIDATION_INTERVAL) {
    return true; // checked recently, skip network call
  }

  const result = await validateLicenseKey(key);
  if (result.state === 'valid') return true;
  if (result.state === 'unreachable') {
    // Grace already set inside validateLicenseKey via setGracePeriod().
    // Let the user keep going; we'll retry on the next launch.
    return true;
  }
  // result.state === 'invalid' — server explicitly revoked. Clear so
  // onboarding shows and the user gets a chance to enter a fresh key.
  clearLicense();
  return false;
}


// ── v0.19.0 PR-6 onboarding app + API-key state ──────────────────────

/**
 * Whitelist of app IDs surfaced in the onboarding app picker. Kept here
 * (not in the renderer) so the IPC clamp in ipc.ts and the keychain
 * lookup in api-routes.ts can validate against the same set without an
 * import cycle. Add a new app: append here AND to APP_CATALOG in
 * src/renderer/app-catalog.ts (the renderer side owns rendering metadata
 * — icons, labels, groups — to keep main slim).
 */
export const KNOWN_APP_IDS = [
  // Email
  'apple-mail', 'gmail', 'outlook',
  // Calendar
  'apple-calendar', 'google-calendar', 'outlook-calendar',
  // Notes
  'notion', 'obsidian', 'apple-notes',
  // Messaging
  'slack', 'teams',
  // CRM
  'hubspot', 'salesforce',
  // Dev
  'github', 'linear', 'jira',
  // Browser
  'chrome', 'safari', 'arc',
] as const;

/**
 * Apps that have a usable API route (vs UI-automation only). hasApiKey()
 * gates here so an app like Apple Mail (no public API) never tries to
 * read a keychain entry that can't exist anyway.
 */
export const API_CAPABLE_APP_IDS = ['gmail', 'hubspot', 'notion', 'slack', 'linear', 'github'] as const;

export function getUserApps(): string[] {
  const raw = store.get('userApps') as unknown;
  if (!Array.isArray(raw)) return [];
  // Re-validate against the whitelist on every read — a corrupted store
  // (manual edit, prior-version migration) shouldn't smuggle in app IDs
  // we don't know how to render.
  const allow = new Set<string>(KNOWN_APP_IDS as readonly string[]);
  return raw.filter((s): s is string => typeof s === 'string' && allow.has(s));
}

export function setUserApps(apps: string[]): void {
  const allow = new Set<string>(KNOWN_APP_IDS as readonly string[]);
  const filtered = Array.from(new Set(apps.filter((s) => typeof s === 'string' && allow.has(s))));
  store.set('userApps', filtered);
}

export function getApiKeysPresence(): Record<string, boolean> {
  const raw = store.get('apiKeys') as unknown;
  if (!raw || typeof raw !== 'object') return {};
  const allow = new Set<string>(API_CAPABLE_APP_IDS as readonly string[]);
  const out: Record<string, boolean> = {};
  for (const id of allow) {
    out[id] = Boolean((raw as Record<string, unknown>)[id]);
  }
  return out;
}

export function setApiKeyPresence(appId: string, present: boolean): void {
  const allow = new Set<string>(API_CAPABLE_APP_IDS as readonly string[]);
  if (!allow.has(appId)) return;
  const current = (store.get('apiKeys') as Record<string, boolean>) || {};
  current[appId] = present;
  store.set('apiKeys', current);
}

/**
 * Sync presence check. Hot path: tools.ts calls this every time an
 * API-route-equivalent tool fires. Stays sync (no keychain hit) by
 * design — see comment on LicenseStore.apiKeys.
 */
export function hasApiKey(appId: string): boolean {
  return getApiKeysPresence()[appId] === true;
}

// ── v0.20.0 (voice v1) — optional OpenAI voice ────────────────────────

/** Sync presence check for the user-provided OpenAI key. The secret
 *  itself never lives in the store — only this flag (set when the
 *  Settings field writes the key to Keychain). */
export function isOpenAiKeyPresent(): boolean {
  return store.get('openaiKeyPresent') === true;
}

export function setOpenAiKeyPresence(present: boolean): void {
  store.set('openaiKeyPresent', present);
}

/** Which TTS engine the user picked. 'system' (default, free, offline)
 *  or 'openai' (premium, requires a key). */
export function getTtsEngine(): 'system' | 'openai' {
  return store.get('ttsEngine') === 'openai' ? 'openai' : 'system';
}

export function setTtsEngine(engine: 'system' | 'openai'): void {
  store.set('ttsEngine', engine === 'openai' ? 'openai' : 'system');
}

export { store };
