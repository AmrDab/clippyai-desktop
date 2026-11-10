/**
 * activate.ts — one-click license activation via the `clippyai://` protocol.
 *
 * Key-delivery emails link to https://clippyai.app/activate?t=<token>; that
 * page opens `clippyai://activate?t=<token>`. The OS hands the URL to the app
 * (macOS: `open-url`; Windows/Linux: argv of the first launch or of the
 * second instance) and this module redeems the single-use token against
 * POST /v1/activate for the real license key.
 *
 * Pure (no Electron imports) so the parser + redeem path are unit-testable.
 * The token and the returned key are NEVER logged — callers log outcome +
 * plan only.
 */

const PROTOCOL = 'clippyai:';
const ACTIVATE_ENDPOINT = 'https://api.clippyai.app/v1/activate';
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const PASTE_FALLBACK = 'You can paste the key from your email instead.';

/** Strict parse of `clippyai://activate?t=<token>`. Returns the token or null. */
export function parseActivateUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== PROTOCOL) return null;
  if (url.hostname !== 'activate') return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  const token = url.searchParams.get('t');
  if (!token || !TOKEN_RE.test(token)) return null;
  return token;
}

/** First `clippyai://` argument in an argv array (Windows/Linux launch path). */
export function findActivateUrl(argv: readonly string[]): string | null {
  return argv.find((a) => typeof a === 'string' && a.startsWith('clippyai://')) ?? null;
}

export type ActivationResult =
  | { ok: true; licenseKey: string; plan: string }
  | { ok: false; error: 'invalid_url' | 'invalid_token' | 'expired_or_used' | 'offline' | 'server'; message: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const FRIENDLY: Record<Exclude<ActivationResult, { ok: true }>['error'], string> = {
  invalid_url: `That activation link doesn't look right. ${PASTE_FALLBACK}`,
  invalid_token: `That activation link isn't valid. ${PASTE_FALLBACK}`,
  expired_or_used: `That activation link has expired or was already used. ${PASTE_FALLBACK}`,
  offline: `Couldn't reach our server to activate. Check your connection and try the link again. ${PASTE_FALLBACK}`,
  server: `Our server had a hiccup activating your key. Try the link again in a moment. ${PASTE_FALLBACK}`,
};

function fail(error: Exclude<ActivationResult, { ok: true }>['error']): ActivationResult {
  return { ok: false, error, message: FRIENDLY[error] };
}

/** POST /v1/activate {token} → { licenseKey, plan } (single use). */
export async function redeemActivationToken(token: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<ActivationResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(ACTIVATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    return fail('offline');
  }
  let body: { licenseKey?: unknown; plan?: unknown; error?: unknown } = {};
  try { body = (await res.json()) as typeof body; } catch { /* status decides below */ }
  if (res.status === 200 && typeof body.licenseKey === 'string' && body.licenseKey) {
    return { ok: true, licenseKey: body.licenseKey, plan: typeof body.plan === 'string' && body.plan ? body.plan : 'free' };
  }
  if (res.status === 400) return fail('invalid_token');
  if (res.status === 410) return fail('expired_or_used');
  return fail('server');
}

/** Parse + redeem in one step. */
export async function activateFromUrl(raw: string, fetchFn?: FetchLike): Promise<ActivationResult> {
  const token = parseActivateUrl(raw);
  if (!token) return fail('invalid_url');
  return redeemActivationToken(token, fetchFn);
}

/** 'power' → 'Power' for the in-bubble confirmation. */
export function planLabel(plan: string): string {
  const p = (plan || 'free').toLowerCase();
  return p.charAt(0).toUpperCase() + p.slice(1);
}
