/**
 * Mail-environment probe — runs at app boot, results cached in memory and
 * sent to the server as prompt context so the model knows which email
 * backend will work without trial-and-error.
 *
 * Probes:
 *   - classic_outlook_com: is Outlook.Application COM ProgID registered?
 *   - new_outlook_installed: is Microsoft.OutlookForWindows AppX present?
 *   - default_mailto_handler: what's HKCU\…\mailto\UserChoice ProgId?
 *
 * NOT probed at boot (deferred to first use because it requires a browser):
 *   - outlook_web_signed_in: needs cdp_connect + DOM check on outlook.live.com
 *   - gmail_web_signed_in: needs cdp_connect + DOM check on mail.google.com
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, serializeErr } from './logger';

const execFileAsync = promisify(execFile);
const log = createLogger('MailEnv');

export interface MailEnvironment {
  classic_outlook_com: boolean;
  new_outlook_installed: boolean;
  default_mailto_handler: string | null;
  default_is_olk: boolean;
  /** ISO timestamp the probe ran. */
  probed_at: string;
}

let cached: MailEnvironment | null = null;

/**
 * Run a short PowerShell snippet and return stdout. Used by all 3 probes
 * because they're each tiny registry/AppX reads.
 */
async function ps(snippet: string, timeoutMs = 5_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', snippet],
      { timeout: timeoutMs, windowsHide: true },
    );
    return String(stdout || '').trim();
  } catch (err) {
    log.debug('mail-env ps probe failed', serializeErr(err));
    return '';
  }
}

export async function probeMailEnvironment(): Promise<MailEnvironment> {
  const t0 = Date.now();

  const [comReg, olkPkg, mailtoProgId] = await Promise.all([
    // 1. Classic Outlook COM ProgID — present iff classic Outlook is installed
    ps(`if (Test-Path 'HKLM:\\SOFTWARE\\Classes\\Outlook.Application' -or (Test-Path 'HKCU:\\SOFTWARE\\Classes\\Outlook.Application')) { 'yes' } else { 'no' }`),
    // 2. New Outlook AppX package presence
    ps(`if ((Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue)) { 'yes' } else { 'no' }`),
    // 3. Default mailto handler
    ps(`(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\mailto\\UserChoice' -ErrorAction SilentlyContinue).ProgId`),
  ]);

  const classicCom = comReg.toLowerCase() === 'yes';
  const olkInstalled = olkPkg.toLowerCase() === 'yes';
  const defaultHandler = mailtoProgId || null;
  const defaultIsOlk = !!defaultHandler && /OutlookForWindows|OutlookMail/i.test(defaultHandler);

  const env: MailEnvironment = {
    classic_outlook_com: classicCom,
    new_outlook_installed: olkInstalled,
    default_mailto_handler: defaultHandler,
    default_is_olk: defaultIsOlk,
    probed_at: new Date().toISOString(),
  };
  cached = env;
  log.info('Mail environment probed', { ...env, elapsed_ms: Date.now() - t0 });
  return env;
}

export function getCachedMailEnvironment(): MailEnvironment | null {
  return cached;
}

/**
 * Format the mail environment as a one-paragraph context string suitable
 * for injection into the system prompt. The model uses this to pick the
 * right send-email path on its first call instead of trial-and-error.
 */
export function formatMailEnvForPrompt(env: MailEnvironment | null): string {
  if (!env) return '';
  const parts: string[] = [];
  if (env.classic_outlook_com) parts.push('classic Outlook (COM available)');
  if (env.new_outlook_installed) parts.push('new Outlook (olk.exe)' + (env.default_is_olk ? ' as default' : ' but NOT the default mailto handler'));
  if (!env.classic_outlook_com && !env.new_outlook_installed) parts.push('no local Outlook detected');
  return `User's mail setup: ${parts.join(', ')}. Default mailto handler: ${env.default_mailto_handler || '(none set)'}.`;
}
