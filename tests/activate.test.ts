import { describe, it, expect, vi } from 'vitest';

import { parseActivateUrl, findActivateUrl, redeemActivationToken, activateFromUrl, planLabel } from '../src/main/activate';

describe('parseActivateUrl', () => {
  it('accepts clippyai://activate?t=<token>', () => {
    expect(parseActivateUrl('clippyai://activate?t=abc_DEF-123')).toBe('abc_DEF-123');
    expect(parseActivateUrl('clippyai://activate/?t=tok')).toBe('tok');
  });

  it('rejects the wrong scheme or host', () => {
    expect(parseActivateUrl('https://activate?t=tok')).toBeNull();
    expect(parseActivateUrl('clippyai://settings?t=tok')).toBeNull();
    expect(parseActivateUrl('clippyai://activate/extra?t=tok')).toBeNull();
  });

  it('rejects a missing, malformed or oversized token', () => {
    expect(parseActivateUrl('clippyai://activate')).toBeNull();
    expect(parseActivateUrl('clippyai://activate?t=')).toBeNull();
    expect(parseActivateUrl('clippyai://activate?t=a.b')).toBeNull();
    expect(parseActivateUrl('clippyai://activate?t=a%20b')).toBeNull();
    expect(parseActivateUrl(`clippyai://activate?t=${'a'.repeat(129)}`)).toBeNull();
    expect(parseActivateUrl(`clippyai://activate?t=${'a'.repeat(128)}`)).toHaveLength(128);
    expect(parseActivateUrl('not a url')).toBeNull();
  });
});

describe('findActivateUrl', () => {
  it('picks the clippyai:// argument out of argv', () => {
    expect(findActivateUrl(['C:\\app.exe', '--updated', 'clippyai://activate?t=tok'])).toBe('clippyai://activate?t=tok');
    expect(findActivateUrl(['C:\\app.exe'])).toBeNull();
  });
});

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ status, json: async () => body }));
}

describe('redeemActivationToken', () => {
  it('POSTs the token and returns the key + plan on 200', async () => {
    const fetchFn = mockFetch(200, { licenseKey: 'CLIPPY-AAAA-BBBB-CCCC', plan: 'power' });
    const r = await redeemActivationToken('tok', fetchFn);
    expect(r).toEqual({ ok: true, licenseKey: 'CLIPPY-AAAA-BBBB-CCCC', plan: 'power' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe('https://api.clippyai.app/v1/activate');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ token: 'tok' });
  });

  it('maps 400 / 410 / 5xx / network failure to friendly errors with the paste fallback', async () => {
    const cases: Array<[ReturnType<typeof mockFetch>, string]> = [
      [mockFetch(400, { error: 'invalid_token' }), 'invalid_token'],
      [mockFetch(410, { error: 'expired_or_used' }), 'expired_or_used'],
      [mockFetch(500, {}), 'server'],
      [vi.fn(async () => { throw new Error('ECONNRESET'); }), 'offline'],
    ];
    for (const [fetchFn, error] of cases) {
      const r = await redeemActivationToken('tok', fetchFn as never);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(error);
        expect(r.message).toContain('paste the key');
      }
    }
  });

  it('treats a 200 without a key as a server error', async () => {
    const r = await redeemActivationToken('tok', mockFetch(200, { plan: 'free' }));
    expect(r.ok).toBe(false);
  });
});

describe('activateFromUrl', () => {
  it('never calls the server for a bad URL', async () => {
    const fetchFn = mockFetch(200, {});
    const r = await activateFromUrl('clippyai://nope?t=tok', fetchFn);
    expect(r).toMatchObject({ ok: false, error: 'invalid_url' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('redeems a good URL', async () => {
    const r = await activateFromUrl('clippyai://activate?t=tok', mockFetch(200, { licenseKey: 'K', plan: 'max' }));
    expect(r).toEqual({ ok: true, licenseKey: 'K', plan: 'max' });
  });
});

describe('planLabel', () => {
  it('capitalizes the plan for the bubble line', () => {
    expect(planLabel('power')).toBe('Power');
    expect(planLabel('')).toBe('Free');
  });
});
