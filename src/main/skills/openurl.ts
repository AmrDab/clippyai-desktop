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

  // Require an EXPLICIT scheme. Bare "example.com" used to default to 'https'
  // and pass the allowlist, then shell.openExternal('example.com') on Windows
  // could match an installed file/protocol handler. Force the caller to be
  // explicit; if they want https, they say so.
  const colonIdx = url.indexOf(':');
  if (colonIdx <= 0) {
    return { text: '(error:NO_SCHEME) URL must include an explicit scheme (e.g., https://example.com)' };
  }
  const candidate = url.substring(0, colonIdx).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(candidate)) {
    return { text: `(error:INVALID_SCHEME) malformed scheme: ${candidate}` };
  }
  const scheme = candidate;

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
