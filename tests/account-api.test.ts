import { describe, it, expect, vi } from 'vitest';
import {
  sendCode, verifyCode, requestCheckout, checkPlan, pollForUpgrade,
  normalizeCode, isCompleteCode, isValidEmail,
  isUpgrade, isSafeCheckoutUrl, shouldRefreshPlan, type FetchLike,
} from '../src/main/account-api';

function reply(status: number, body: unknown): FetchLike {
  return vi.fn(async () => ({ status, json: async () => body })) as unknown as FetchLike;
}
const offline: FetchLike = vi.fn(async () => { throw new Error('ENOTFOUND'); }) as unknown as FetchLike;
const lastCall = (f: FetchLike) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { headers: Record<string, string>; body: string }];

describe('code + email input', () => {
  it('keeps digits only, max 6', () => {
    expect(normalizeCode('12a3-45 678')).toBe('123456');
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode(' 123456')).toBe('123456');
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('123-456')).toBe('123456');
    expect(normalizeCode('123456789')).toBe('123456');
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
  it('checks email shape', () => {
    expect(isValidEmail(' a@b.co ')).toBe(true);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.d')).toBe(false);
  });
});

describe('sendCode', () => {
  it('asks for a code (code:true) and trims the email', async () => {
    const f = reply(200, { ok: true, sent: true });
    expect(await sendCode('  me@x.com ', f)).toEqual({ ok: true });
    expect(JSON.parse(lastCall(f)[1].body)).toEqual({ email: 'me@x.com', code: true, lang: 'en' });
  });
  it('sends the UI language for the code email (default en)', async () => {
    const f = reply(200, { ok: true });
    await sendCode('a@b.co', f, 'pt');
    expect(JSON.parse(lastCall(f)[1].body)).toEqual({ email: 'a@b.co', code: true, lang: 'pt' });
    const g = reply(200, { ok: true });
    await sendCode('a@b.co', g);
    expect(JSON.parse(lastCall(g)[1].body).lang).toBe('en');
  });
  it('passes retry_after on 429', async () => {
    expect(await sendCode('a@b.co', reply(429, { error: 'rate_limited', retry_after: 42 }))).toEqual({ ok: false, error: 'rate_limited', retryAfter: 42 });
    expect(await sendCode('a@b.co', reply(429, {}))).toEqual({ ok: false, error: 'rate_limited', retryAfter: undefined });
  });
  it('rejects a bad email without a request', async () => {
    const f = reply(200, { ok: true });
    expect(await sendCode('nope', f)).toEqual({ ok: false, error: 'invalid_email' });
    expect(f).not.toHaveBeenCalled();
  });
  it('maps 400, 429, 5xx and offline', async () => {
    expect(await sendCode('a@b.co', reply(400, {}))).toEqual({ ok: false, error: 'invalid_email' });
    expect(await sendCode('a@b.co', reply(502, {}))).toEqual({ ok: false, error: 'server' });
    expect(await sendCode('a@b.co', offline)).toEqual({ ok: false, error: 'offline' });
  });
});

describe('verifyCode', () => {
  it('returns the key and sends no Authorization header', async () => {
    const f = reply(200, { licenseKey: 'CLIPPY-1111-2222-3333', plan: 'power' });
    expect(await verifyCode('a@b.co', '012345', f)).toEqual({ ok: true, licenseKey: 'CLIPPY-1111-2222-3333', plan: 'power' });
    const [url, init] = lastCall(f);
    expect(url).toBe('https://api.clippyai.app/v1/verify-code');
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.co', code: '012345' });
  });
  it('defaults the plan to free', async () => {
    expect(await verifyCode('a@b.co', '123456', reply(200, { licenseKey: 'K' }))).toEqual({ ok: true, licenseKey: 'K', plan: 'free' });
  });
  it('maps wrong code with tries left, expired, rate limit, server, offline', async () => {
    expect(await verifyCode('a@b.co', '123456', reply(400, { error: 'wrong_code', tries_left: 3 }))).toEqual({ ok: false, error: 'wrong_code', triesLeft: 3 });
    expect(await verifyCode('a@b.co', '123456', reply(410, { error: 'code_expired' }))).toEqual({ ok: false, error: 'code_expired' });
    expect(await verifyCode('a@b.co', '123456', reply(429, { retry_after: 3600 }))).toEqual({ ok: false, error: 'rate_limited', retryAfter: 3600 });
    expect(await verifyCode('a@b.co', '123456', reply(500, {}))).toEqual({ ok: false, error: 'server' });
    expect(await verifyCode('a@b.co', '123456', offline)).toEqual({ ok: false, error: 'offline' });
  });
  it('never calls the server for an incomplete code', async () => {
    const f = reply(200, {});
    expect((await verifyCode('a@b.co', '123', f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('requestCheckout', () => {
  it('returns the checkout url, key only in the Bearer header', async () => {
    const f = reply(200, { url: 'https://checkout.stripe.com/c/pay/x' });
    expect(await requestCheckout('CLIPPY-K', 'power', f)).toEqual({ ok: true, url: 'https://checkout.stripe.com/c/pay/x' });
    const [url, init] = lastCall(f);
    expect(url).not.toContain('CLIPPY');
    expect(init.headers.Authorization).toBe('Bearer CLIPPY-K');
    expect(JSON.parse(init.body)).toEqual({ plan: 'power' });
  });
  it('reports an in-place change', async () => {
    expect(await requestCheckout('K', 'max', reply(200, { updated: true, plan: 'max' }))).toEqual({ ok: true, updated: true, plan: 'max' });
  });
  it('maps 401, 403, 400, 5xx and offline', async () => {
    expect(await requestCheckout('K', 'max', reply(401, {}))).toEqual({ ok: false, error: 'unauthorized' });
    expect(await requestCheckout('K', 'max', reply(400, { error: 'unknown_plan' }))).toEqual({ ok: false, error: 'unknown_plan' });
    expect(await requestCheckout('K', 'max', reply(500, {}))).toEqual({ ok: false, error: 'server' });
    expect(await requestCheckout('K', 'max', offline)).toEqual({ ok: false, error: 'offline' });
  });
  it('only opens https Stripe / clippyai.app urls', () => {
    expect(isSafeCheckoutUrl('https://checkout.stripe.com/c/pay/x')).toBe(true);
    expect(isSafeCheckoutUrl('https://clippyai.app/thanks')).toBe(true);
    expect(isSafeCheckoutUrl('https://billing.stripe.com/p/session/x')).toBe(true);
    expect(isSafeCheckoutUrl('http://checkout.stripe.com/x')).toBe(false);
    expect(isSafeCheckoutUrl('https://evil.com/checkout.stripe.com')).toBe(false);
    expect(isSafeCheckoutUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('checkPlan', () => {
  it('maps /validate answers', async () => {
    expect(await checkPlan('K', reply(200, { valid: true, plan: 'power' }))).toEqual({ state: 'valid', plan: 'power' });
    expect(await checkPlan('K', reply(200, { valid: false }))).toEqual({ state: 'invalid' });
    expect(await checkPlan('K', reply(503, {}))).toEqual({ state: 'unreachable' });
    expect(await checkPlan('K', reply(200, {}))).toEqual({ state: 'unreachable' });
    expect(await checkPlan('K', offline)).toEqual({ state: 'unreachable' });
  });
});

describe('isUpgrade', () => {
  it('only counts a higher plan', () => {
    expect(isUpgrade('free', 'power')).toBe(true);
    expect(isUpgrade('power', 'max')).toBe(true);
    expect(isUpgrade('power', 'power')).toBe(false);
    expect(isUpgrade('max', 'power')).toBe(false);
    expect(isUpgrade('free', 'weird')).toBe(false);
  });
});

describe('pollForUpgrade', () => {
  it('resolves the new plan once /validate shows an upgrade', async () => {
    let t = 0;
    const answers = [{ state: 'valid', plan: 'free' }, { state: 'unreachable' }, { state: 'valid', plan: 'power' }] as const;
    let i = 0;
    const plan = await pollForUpgrade({
      fromPlan: 'free',
      check: async () => answers[i++],
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(plan).toBe('power');
    expect(i).toBe(3);
  });
  it('gives up after the timeout', async () => {
    let t = 0;
    let calls = 0;
    const plan = await pollForUpgrade({
      fromPlan: 'free', intervalMs: 5000, timeoutMs: 60_000,
      check: async () => { calls++; return { state: 'valid', plan: 'free' }; },
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(plan).toBeNull();
    expect(calls).toBe(12);
  });
  it('keeps polling for 30 minutes by default', async () => {
    let t = 0;
    const plan = await pollForUpgrade({
      fromPlan: 'free',
      check: async () => (t >= 29 * 60_000 ? { state: 'valid', plan: 'max' } : { state: 'valid', plan: 'free' }),
      sleep: async (ms) => { t += ms; },
      now: () => t,
    });
    expect(plan).toBe('max');
  });
  it('stops when cancelled', async () => {
    let t = 0;
    const check = vi.fn(async () => ({ state: 'valid', plan: 'power' }) as const);
    const plan = await pollForUpgrade({ fromPlan: 'free', check, sleep: async (ms) => { t += ms; }, now: () => t, cancelled: () => true });
    expect(plan).toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('shouldRefreshPlan', () => {
  it('refreshes at most once a minute', () => {
    expect(shouldRefreshPlan(0, 1_000_000)).toBe(true);
    expect(shouldRefreshPlan(1_000_000 - 59_999, 1_000_000)).toBe(false);
    expect(shouldRefreshPlan(1_000_000 - 60_000, 1_000_000)).toBe(true);
  });
});
