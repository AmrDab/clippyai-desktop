import Store from 'electron-store';
import { net } from 'electron';
import os from 'os';
import crypto from 'crypto';

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

export function isFirstRun(): boolean {
  return !store.get('licenseKey');
}

// ── License checks ───────────────────────────────────────────────────

const REVALIDATION_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

export function isLicensed(): boolean {
  const key = store.get('licenseKey');
  if (!key) return false;

  // Validated recently? Trust it.
  if (store.get('validated')) {
    const lastCheck = store.get('lastValidated');
    if (lastCheck > 0 && Date.now() - lastCheck < REVALIDATION_INTERVAL) return true;
  }

  // Within grace period? (API was unreachable but had a valid key before)
  const graceExpiry = store.get('graceExpiry');
  if (graceExpiry > 0 && Date.now() < graceExpiry) return true;

  return false;
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

export function setGracePeriod(): void {
  const expiry = Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  store.set('graceExpiry', expiry);
}

// ── API validation ───────────────────────────────────────────────────

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
          if (result.valid) {
            store.set('validated', true);
            store.set('lastValidated', Date.now());
            if (result.plan) store.set('plan', result.plan);
          }
          resolve(result);
        } catch {
          resolve({ valid: false, plan: '' });
        }
      });
    });

    req.on('error', () => {
      // API unreachable — only grant grace if a key already exists
      const existingKey = store.get('licenseKey');
      if (existingKey) {
        setGracePeriod();
        resolve({ valid: true, plan: store.get('plan') || 'grace' });
      } else {
        resolve({ valid: false, plan: '' });
      }
    });

    req.write(JSON.stringify({ key }));
    req.end();
  });
}

/**
 * Revalidate the stored key with the API. Call at app startup.
 * Returns true if still valid, false if key was revoked/expired.
 */
export async function revalidateIfNeeded(): Promise<boolean> {
  const key = store.get('licenseKey');
  if (!key) return false;

  const lastCheck = store.get('lastValidated');
  if (lastCheck > 0 && Date.now() - lastCheck < REVALIDATION_INTERVAL) {
    return true; // checked recently, skip network call
  }

  const result = await validateLicenseKey(key);
  if (result.valid) return true;

  // Key is invalid — clear it so onboarding shows
  clearLicense();
  return false;
}

export { store };
