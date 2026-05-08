/**
 * Deep-link / URL scheme tool with allowlist
 * Supports: https, http, mailto, tel, sms, spotify, vscode, vscode-insiders, slack, ms-teams, zoommtg
 */

import { shell } from 'electron';

const ALLOWED_SCHEMES = new Set([
  'https',
  'http',
  'mailto',
  'tel',
  'sms',
  'spotify',
  'vscode',
  'vscode-insiders',
  'slack',
  'ms-teams',
  'zoommtg',
]);

import type { ToolResult } from '../types/tool-result';

export async function openUrl(params: Record<string, unknown>): Promise<ToolResult> {
  const url = String(params.url || '');

  if (!url) {
    return { text: '(error:EMPTY_URL) url parameter is required' };
  }

  let scheme = 'https';
  const colonIdx = url.indexOf(':');
  if (colonIdx > 0) {
    const candidate = url.substring(0, colonIdx).toLowerCase();
    // Only accept schemes that look valid (alphanumeric + dash)
    if (/^[a-z][a-z0-9+.-]*$/.test(candidate)) {
      scheme = candidate;
    }
  }

  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { text: `(error:SCHEME_NOT_ALLOWED) ${scheme} is not in the allowlist` };
  }

  try {
    await shell.openExternal(url);
    return { text: `Opened ${url}` };
  } catch (err) {
    return { text: `(error:OPEN_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }
}
