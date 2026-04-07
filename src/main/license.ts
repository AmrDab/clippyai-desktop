import Store from 'electron-store';
import { net } from 'electron';
import os from 'os';
import crypto from 'crypto';

const API_BASE = 'https://clippyai-api.amraldabbas19.workers.dev';
const GRACE_PERIOD_DAYS = 7;
const TRIAL_DAYS = 7;

interface LicenseStore {
  licenseKey: string;
  plan: string;
  buddyName: string;
  ttsVoice: string;
  validated: boolean;
  graceExpiry: number; // timestamp
  trialStartedAt: number; // timestamp when free trial started
  trialKey: string; // the issued trial license key
  isTrial: boolean; // true while in trial period
}

const store = new Store<LicenseStore>({
  defaults: {
    licenseKey: '',
    plan: '',
    buddyName: 'Clippy',
    ttsVoice: '',
    validated: false,
    graceExpiry: 0,
    trialStartedAt: 0,
    trialKey: '',
    isTrial: false,
  },
});

/**
 * Get a stable machine fingerprint for trial activation.
 * Combines hostname + MAC addresses + username, hashed.
 */
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

export function isLicensed(): boolean {
  const key = store.get('licenseKey');
  if (!key) return false;

  if (store.get('validated')) return true;

  const graceExpiry = store.get('graceExpiry');
  if (graceExpiry > 0 && Date.now() < graceExpiry) return true;

  return false;
}

export function saveLicense(key: string, plan: string, buddyName: string, ttsVoice: string): void {
  store.set('licenseKey', key);
  store.set('plan', plan);
  store.set('buddyName', buddyName);
  store.set('ttsVoice', ttsVoice);
  store.set('validated', true);
}

export function setGracePeriod(): void {
  const expiry = Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  store.set('graceExpiry', expiry);
}

export async function validateLicenseKey(key: string): Promise<{ valid: boolean; plan: string }> {
  return new Promise((resolve) => {
    const req = net.request({
      url: `${API_BASE}/validate`,
      method: 'POST',
    });
    req.setHeader('Content-Type', 'application/json');

    req.on('response', (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => {
        try {
          const result = JSON.parse(data) as { valid: boolean; plan: string };
          resolve(result);
        } catch {
          resolve({ valid: false, plan: '' });
        }
      });
    });

    req.on('error', () => {
      // API unreachable — grant grace period
      setGracePeriod();
      resolve({ valid: true, plan: 'grace' });
    });

    req.write(JSON.stringify({ key }));
    req.end();
  });
}

/**
 * Start a 7-day free trial — issues a local trial key and stores the start time.
 * The trial key is the test license key in dev; in production it would be
 * issued by the backend tied to the machine fingerprint.
 */
export function startTrial(): { key: string; expiresAt: number } {
  const expiresAt = Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  // For now we use the existing test license key.
  // Production: POST /trial with machine fingerprint, backend returns a unique trial key.
  const trialKey = 'CLIPPY-TEST-AMRD-2026';

  store.set('trialKey', trialKey);
  store.set('licenseKey', trialKey);
  store.set('plan', 'pro'); // trial gets Pro features
  store.set('isTrial', true);
  store.set('trialStartedAt', Date.now());
  store.set('graceExpiry', expiresAt);
  store.set('validated', true);
  return { key: trialKey, expiresAt };
}

export function getTrialStatus(): { isTrial: boolean; daysLeft: number; expired: boolean } {
  const isTrial = store.get('isTrial');
  if (!isTrial) return { isTrial: false, daysLeft: 0, expired: false };

  const startedAt = store.get('trialStartedAt');
  if (!startedAt) return { isTrial: false, daysLeft: 0, expired: false };

  const elapsed = Date.now() - startedAt;
  const totalMs = TRIAL_DAYS * 24 * 60 * 60 * 1000;
  const remainingMs = totalMs - elapsed;
  const daysLeft = Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
  const expired = remainingMs <= 0;

  return { isTrial: true, daysLeft, expired };
}

export function getMachineId(): string {
  return getMachineFingerprint();
}

export function isFirstRun(): boolean {
  return !store.get('licenseKey') && !store.get('trialStartedAt');
}

export { store };
