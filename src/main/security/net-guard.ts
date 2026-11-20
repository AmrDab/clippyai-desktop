/**
 * net-guard.ts — checks on where a tool is about to send something.
 * Pure, so every branch is unit-tested (tests/net-guard.test.ts).
 */

import net from 'net';

// One DNS label: letters, digits, hyphens, not starting or ending with a hyphen.
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
// A real host label is short. A long one is how data rides a DNS lookup
// (`<base64 of a file>.attacker.example`), so ping_host refuses it.
const MAX_LABEL = 30;
const MAX_LABELS = 6;
const MAX_HOST = 100;

/** True for an IPv4/IPv6 address or a plain hostname ping_host may look up. */
export function isPingableHost(host: string): boolean {
  const h = String(host ?? '').trim();
  if (!h || h.length > MAX_HOST) return false;
  if (net.isIP(h)) return true;
  const labels = h.replace(/\.$/, '').split('.');
  if (labels.length > MAX_LABELS) return false;
  return labels.every((l) => l.length <= MAX_LABEL && LABEL.test(l));
}

/**
 * The URL a browser-navigation tool may open: http(s) only. A bare domain
 * ("example.com/x") gets https://. Anything else (file:, javascript:,
 * ms-msdt:, search-ms:, a local path...) is null: shell.openExternal would
 * hand it to whatever protocol handler is installed.
 */
export function httpUrlOrNull(raw: string): string | null {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[\w.-]+:\d+(?:[/?#]|$)/.test(url)) {
    if (!/^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(url)) return null;
    url = `https://${url}`;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
