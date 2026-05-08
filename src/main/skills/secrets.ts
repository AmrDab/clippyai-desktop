/**
 * Keytar-backed secrets module
 * Gracefully handles keytar failures (e.g., missing libsecret on Linux)
 */

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
      console.warn(`[secrets] keytar unavailable: ${keytarLoadError}`);
      return null;
    }
    return await keytar.getPassword(service, account);
  } catch (err) {
    console.warn(`[secrets] getSecret failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function setSecret(service: string, account: string, value: string): Promise<void> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      console.warn(`[secrets] keytar unavailable: ${keytarLoadError}`);
      return;
    }
    await keytar.setPassword(service, account, value);
  } catch (err) {
    console.warn(`[secrets] setSecret failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function clearSecret(service: string, account: string): Promise<void> {
  try {
    const loaded = await loadKeytar();
    if (!loaded) {
      console.warn(`[secrets] keytar unavailable: ${keytarLoadError}`);
      return;
    }
    await keytar.deletePassword(service, account);
  } catch (err) {
    console.warn(`[secrets] clearSecret failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
