import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  fillPlaceholders, dateContext, resolveKit, loadKitCache, saveKitCache, buildKitUrl, isValidKit,
  REVALIDATE_MS, type AgentKit, type KitCache, type FetchLike,
} from '../src/main/byok/kit';

const kit: AgentKit = { version: 'abc123', systemPrompt: 'You are Clippy. Today: {{TODAY}}, {{TIME}} ({{SEASON}}). Again {{TODAY}}.', tools: [
  { name: 'read_screen', description: 'd', parameters: { type: 'object', properties: {} } },
] };
const URL1 = 'https://api.clippyai.app/v1/agent-kit?platform=win32';
const T0 = 1_700_000_000_000;

function resp(status: number, body?: unknown, etag?: string) {
  return { status, headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag ?? null : null) }, json: async () => body };
}

describe('placeholders', () => {
  it('fills every {{TODAY}} / {{TIME}} / {{SEASON}} occurrence', () => {
    const now = new Date(2026, 0, 5, 9, 41); // Monday, January 5, 2026 — winter
    const d = dateContext(now);
    expect(d).toEqual({ today: 'Monday, January 5, 2026', time: '9:41 AM', season: 'winter' });
    const out = fillPlaceholders(kit.systemPrompt, now);
    expect(out).toBe('You are Clippy. Today: Monday, January 5, 2026, 9:41 AM (winter). Again Monday, January 5, 2026.');
    expect(out).not.toMatch(/\{\{/);
  });
  it('season boundaries', () => {
    expect(dateContext(new Date(2026, 2, 1)).season).toBe('spring');
    expect(dateContext(new Date(2026, 7, 31)).season).toBe('summer');
    expect(dateContext(new Date(2026, 10, 30)).season).toBe('fall');
    expect(dateContext(new Date(2026, 11, 1)).season).toBe('winter');
  });
});

describe('kit URL + validation', () => {
  it('encodes caps and tool_tiers as JSON query params', () => {
    const u = new URL(buildKitUrl('https://api.clippyai.app', { platform: 'darwin', caps: { clawd: false, bridge: true }, toolTiers: { read_screen: { tier: 1, cost: 'low' } } }));
    expect(u.pathname).toBe('/v1/agent-kit');
    expect(u.searchParams.get('platform')).toBe('darwin');
    expect(JSON.parse(u.searchParams.get('caps')!)).toEqual({ clawd: false, bridge: true });
    expect(JSON.parse(u.searchParams.get('tool_tiers')!)).toEqual({ read_screen: { tier: 1, cost: 'low' } });
    expect(buildKitUrl('https://api.clippyai.app', { platform: 'win32', caps: {} })).toBe(URL1);
  });
  it('rejects malformed kits', () => {
    expect(isValidKit(kit)).toBe(true);
    expect(isValidKit({ ...kit, tools: [{ name: 'x' }] })).toBe(false);
    expect(isValidKit({ ...kit, systemPrompt: '' })).toBe(false);
    expect(isValidKit(null)).toBe(false);
  });
});

describe('resolveKit (cache / ETag)', () => {
  const fresh: KitCache = { kit, etag: '"abc123"', query: URL1, checkedAt: T0 };

  it('fresh cache for the same query → no network', async () => {
    const fetch = vi.fn<FetchLike>();
    const r = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch, now: T0 + REVALIDATE_MS - 1 });
    expect(r).toEqual({ kit, cache: fresh, source: 'cache' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stale cache → If-None-Match; 304 bumps checkedAt and keeps the kit', async () => {
    const fetch = vi.fn<FetchLike>(async () => resp(304));
    const now = T0 + REVALIDATE_MS + 1;
    const r = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch, now });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0][1];
    expect(init.headers).toEqual({ Authorization: 'Bearer CLIP-1', 'If-None-Match': '"abc123"' });
    expect(r).toMatchObject({ source: 'revalidated', kit, cache: { ...fresh, checkedAt: now } });
  });

  it('200 replaces the cache with the new kit + ETag', async () => {
    const kit2 = { ...kit, version: 'def456' };
    const fetch = vi.fn<FetchLike>(async () => resp(200, kit2, '"def456"'));
    const now = T0 + REVALIDATE_MS + 1;
    const r = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch, now });
    expect(r).toEqual({ source: 'fetched', kit: kit2, cache: { kit: kit2, etag: '"def456"', query: URL1, checkedAt: now } });
  });

  it('different query (caps changed) → fetch without If-None-Match even when fresh', async () => {
    const fetch = vi.fn<FetchLike>(async () => resp(200, kit, '"abc123"'));
    const url2 = `${URL1}&caps=%7B%22clawd%22%3Atrue%7D`;
    const r = await resolveKit({ cache: fresh, url: url2, licenseKey: 'CLIP-1', fetch, now: T0 + 1 });
    expect(fetch.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer CLIP-1' });
    expect(r).toMatchObject({ source: 'fetched', cache: { query: url2 } });
  });

  it('offline with a cache → keeps using the cached kit (local models keep working)', async () => {
    const fetch = vi.fn<FetchLike>(async () => { throw new Error('ENOTFOUND'); });
    const r = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch, now: T0 + REVALIDATE_MS + 1 });
    expect(r).toEqual({ kit, cache: fresh, source: 'offline-cache' });
    const r5 = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch: async () => resp(503), now: T0 + REVALIDATE_MS + 1 });
    expect(r5.kit).toBe(kit);
    const r429 = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch: async () => resp(429), now: T0 + REVALIDATE_MS + 1 });
    expect(r429).toMatchObject({ source: 'offline-cache' });
  });

  it('no cache + offline / 401 / 429 / garbage → typed errors', async () => {
    const base = { cache: null, url: URL1, licenseKey: 'CLIP-1', now: T0 };
    expect(await resolveKit({ ...base, fetch: async () => { throw new Error('x'); } })).toMatchObject({ kit: null, error: 'network' });
    expect(await resolveKit({ ...base, fetch: async () => resp(401, { error: 'invalid_key' }) })).toEqual({ kit: null, cache: null, error: 'invalid_key' });
    expect(await resolveKit({ ...base, fetch: async () => resp(429, { error: 'rate_limited' }) })).toMatchObject({ error: 'rate_limited' });
    expect(await resolveKit({ ...base, fetch: async () => resp(200, { nope: true }) })).toMatchObject({ error: 'bad_response' });
  });

  it('401 with a cache does NOT serve the cache (revoked key)', async () => {
    const r = await resolveKit({ cache: fresh, url: URL1, licenseKey: 'CLIP-1', fetch: async () => resp(401), now: T0 + REVALIDATE_MS + 1 });
    expect(r).toEqual({ kit: null, cache: null, error: 'invalid_key' });
  });

  it('kit fetch times out via AbortSignal', async () => {
    const fetch: FetchLike = (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const r = await resolveKit({ cache: null, url: URL1, licenseKey: 'CLIP-1', fetch, now: T0, timeoutMs: 10 });
    expect(r).toMatchObject({ kit: null, error: 'network' });
  });
});

describe('kit cache file', () => {
  it('round-trips through disk and rejects corrupt files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-kit-'));
    const file = path.join(dir, 'nested', 'byok-kit.json');
    const c: KitCache = { kit, etag: '"abc123"', query: URL1, checkedAt: T0 };
    saveKitCache(file, c);
    expect(loadKitCache(file)).toEqual(c);
    fs.writeFileSync(file, '{not json');
    expect(loadKitCache(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ kit: { version: 'v' }, etag: 'e' }));
    expect(loadKitCache(file)).toBeNull();
    expect(loadKitCache(path.join(dir, 'missing.json'))).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
