/**
 * Keytar-backed secrets module
 * Gracefully handles keytar failures (e.g., missing libsecret on Linux)
 */

import { createLogger } from '../logger';

const log = createLogger('Secrets');

let keytar: any = null;
let keytarLoadError: string | null = null;

async function loadKeytar(): Promise<boolean> {
  if (keytar !== null) return keytarLoadError === null;
  if (keytarLoadError !== null) return false;

  try {
    keytar = await import('keytar');
    return true;
  } catch (err) {
    keytarLoadError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

export async function getSecret(service: string, account: string): Promise<string | null> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      log.warn('keytar unavailable', { reason: keytarLoadError });
      return null;
    }
    return await keytar.getPassword(service, account);
  } catch (err) {
    log.warn('getSecret failed', { service, account, msg: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function setSecret(service: string, account: string, value: string): Promise<void> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      log.warn('keytar unavailable', { reason: keytarLoadError });
      return;
    }
    await keytar.setPassword(service, account, value);
  } catch (err) {
    log.warn('setSecret failed', { service, account, msg: err instanceof Error ? err.message : String(err) });
  }
}

export async function clearSecret(service: string, account: string): Promise<void> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      log.warn('keytar unavailable', { reason: keytarLoadError });
      return;
    }
    await keytar.deletePassword(service, account);
  } catch (err) {
    log.warn('clearSecret failed', { service, account, msg: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Deletes EVERY credential stored under a service (all accounts). Used by the
 * explicit "clear license / reset" path so no API tokens are left orphaned in
 * the Keychain after a user clears the app. Best-effort — never throws.
 */
export async function clearAllSecrets(service: string): Promise<void> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      log.warn('keytar unavailable', { reason: keytarLoadError });
      return;
    }
    const creds: Array<{ account: string }> = await keytar.findCredentials(service);
    for (const { account } of creds) {
      await keytar.deletePassword(service, account);
    }
    log.info('clearAllSecrets', { service, count: creds.length });
  } catch (err) {
    log.warn('clearAllSecrets failed', { service, msg: err instanceof Error ? err.message : String(err) });
  }
}
