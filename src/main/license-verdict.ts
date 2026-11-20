/**
 * license-verdict.ts — what a /validate answer means. Pure (no Electron).
 *
 * Only an 'invalid' verdict clears the stored license key and sends the user
 * back to onboarding, so it has to be an answer the license server really
 * gave: HTTP 200 with {valid:false}. A 4xx/3xx carrying {valid:false} can
 * come from something in between (a WAF, a rate limiter, a captive portal, a
 * proxy's error page), and anything else is the server having a bad day:
 * those are 'unreachable' and the user keeps working under grace.
 */

export type ValidateVerdict =
  | { kind: 'valid'; plan?: string }
  | { kind: 'invalid' }
  | { kind: 'unreachable' };

/**
 * The startup check is awaited before the app launches. A server that accepts
 * the connection and never answers used to hold the launch until the network
 * stack gave up; after this long the request is aborted and grace applies.
 */
export const VALIDATE_TIMEOUT_MS = 5_000;

export function classifyValidateResponse(statusCode: number | undefined, body: string): ValidateVerdict {
  // HTTP 5xx → server is sick. Don't trust the body, don't revoke.
  if (statusCode && statusCode >= 500) return { kind: 'unreachable' };
  let parsed: { valid?: unknown; plan?: unknown } | null;
  try { parsed = JSON.parse(body); } catch { return { kind: 'unreachable' }; } // HTML error page, empty body
  if (!parsed || typeof parsed !== 'object') return { kind: 'unreachable' };
  if (parsed.valid === true) return { kind: 'valid', ...(typeof parsed.plan === 'string' && parsed.plan ? { plan: parsed.plan } : {}) };
  if (parsed.valid === false && statusCode === 200) return { kind: 'invalid' };
  return { kind: 'unreachable' };
}
