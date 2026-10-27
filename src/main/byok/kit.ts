/**
 * byok/kit.ts — v0.21 BYOK agent kit: fetch + cache + placeholder fill.
 *
 * Pure (no Electron): the caller injects `fetch`, the cache file path and
 * `now`. The kit (GET /v1/agent-kit — Clippy's system prompt + tool catalog)
 * is persisted with its ETag; we revalidate with If-None-Match at most every
 * REVALIDATE_MS, and keep using the cached copy when the server is
 * unreachable so local models work offline.
 */

import fs from 'fs';
import path from 'path';
import type { KitTool } from './adapters';

export interface AgentKit { version: string; systemPrompt: string; tools: KitTool[]; notes?: string }

export interface KitCache {
  kit: AgentKit;
  etag: string;
  /** Query signature (platform/caps/tiers) the kit was fetched for. */
  query: string;
  /** Epoch ms of the last 200/304 from the server. */
  checkedAt: number;
}

export const REVALIDATE_MS = 5 * 60_000;
export const KIT_FETCH_TIMEOUT_MS = 15_000;

export function dateContext(now = new Date()): { today: string; time: string; season: string } {
  const today = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const m = now.getMonth();
  const season = m >= 2 && m <= 4 ? 'spring' : m >= 5 && m <= 7 ? 'summer' : m >= 8 && m <= 10 ? 'fall' : 'winter';
  return { today, time, season };
}

/** Fill {{TODAY}} / {{TIME}} / {{SEASON}} — every occurrence, every turn. */
export function fillPlaceholders(systemPrompt: string, now = new Date()): string {
  const { today, time, season } = dateContext(now);
  return systemPrompt.replace(/\{\{TODAY\}\}/g, today).replace(/\{\{TIME\}\}/g, time).replace(/\{\{SEASON\}\}/g, season);
}

export function isValidKit(k: unknown): k is AgentKit {
  const o = k as AgentKit;
  return !!o && typeof o === 'object' && typeof o.version === 'string' && typeof o.systemPrompt === 'string'
    && o.systemPrompt.length > 0 && Array.isArray(o.tools)
    && o.tools.every((t) => t && typeof t.name === 'string' && typeof t.description === 'string' && !!t.parameters && typeof t.parameters === 'object');
}

export function loadKitCache(file: string): KitCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<KitCache>;
    if (!isValidKit(raw.kit) || typeof raw.etag !== 'string') return null;
    return { kit: raw.kit, etag: raw.etag, query: typeof raw.query === 'string' ? raw.query : '', checkedAt: Number(raw.checkedAt) || 0 };
  } catch {
    return null;
  }
}

export function saveKitCache(file: string, cache: KitCache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
  fs.renameSync(tmp, file);
}

export function buildKitUrl(apiBase: string, q: { platform: string; caps?: Record<string, boolean>; toolTiers?: Record<string, unknown> }): string {
  const u = new URL('/v1/agent-kit', apiBase);
  u.searchParams.set('platform', q.platform);
  if (q.caps && Object.keys(q.caps).length) u.searchParams.set('caps', JSON.stringify(q.caps));
  if (q.toolTiers && Object.keys(q.toolTiers).length) u.searchParams.set('tool_tiers', JSON.stringify(q.toolTiers));
  return u.toString();
}

export type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>;
}>;

export interface ResolveKitOpts {
  cache: KitCache | null;
  url: string;
  licenseKey: string;
  fetch: FetchLike;
  now?: number;
  timeoutMs?: number;
}

export type ResolveKitResult =
  | { kit: AgentKit; cache: KitCache; source: 'cache' | 'revalidated' | 'fetched' | 'offline-cache' }
  | { kit: null; cache: null; error: 'invalid_key' | 'rate_limited' | 'network' | 'bad_response'; detail?: string };

/**
 * Decide + fetch. Fresh cache for the same query → no network. Otherwise GET
 * with If-None-Match; 304 → bump checkedAt; 200 → replace; network failure or
 * 5xx/429 with a cache → keep serving the cache (offline mode). 401 → the
 * license key is bad: drop the cache so a revoked key can't keep a kit alive.
 */
export async function resolveKit(o: ResolveKitOpts): Promise<ResolveKitResult> {
  const now = o.now ?? Date.now();
  const { cache } = o;
  const sameQuery = !!cache && cache.query === o.url;
  if (cache && sameQuery && now - cache.checkedAt < REVALIDATE_MS) return { kit: cache.kit, cache, source: 'cache' };

  const headers: Record<string, string> = { Authorization: `Bearer ${o.licenseKey}` };
  if (cache && sameQuery) headers['If-None-Match'] = `"${cache.kit.version}"`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? KIT_FETCH_TIMEOUT_MS);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await o.fetch(o.url, { method: 'GET', headers, signal: ctl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (cache) return { kit: cache.kit, cache, source: 'offline-cache' };
    return { kit: null, cache: null, error: 'network', detail: err instanceof Error ? err.message : String(err) };
  }
  clearTimeout(timer);

  if (res.status === 304 && cache && sameQuery) {
    const next = { ...cache, checkedAt: now };
    return { kit: next.kit, cache: next, source: 'revalidated' };
  }
  if (res.status === 401) return { kit: null, cache: null, error: 'invalid_key' };
  if (res.status === 200) {
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    if (!isValidKit(body)) {
      if (cache) return { kit: cache.kit, cache, source: 'offline-cache' };
      return { kit: null, cache: null, error: 'bad_response' };
    }
    const etag = res.headers.get('etag') || `"${body.version}"`;
    const next: KitCache = { kit: body, etag, query: o.url, checkedAt: now };
    return { kit: body, cache: next, source: 'fetched' };
  }
  // 429 / 5xx / anything else: serve the cache if we have one.
  if (cache) return { kit: cache.kit, cache, source: 'offline-cache' };
  return { kit: null, cache: null, error: res.status === 429 ? 'rate_limited' : 'network', detail: `HTTP ${res.status}` };
}
