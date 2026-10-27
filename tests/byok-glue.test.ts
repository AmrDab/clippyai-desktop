/**
 * byok.ts (Electron glue) with electron / electron-store / license / logger
 * mocked: the key is encrypted at rest, never in a status payload (what IPC
 * returns to Settings), never in any log line — but does reach the provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'byok-glue-'));
let encryptionAvailable = true;

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));
vi.mock('electron-store', () => ({
  default: class {
    private m: Record<string, unknown>;
    constructor(o: { defaults: Record<string, unknown> }) { this.m = { ...o.defaults }; }
    get(k: string) { return this.m[k]; }
    set(k: string, v: unknown) { this.m[k] = v; }
  },
}));
vi.mock('../src/main/license', () => ({ getLicenseKey: () => 'CLIP-TEST-KEY' }));
const logCalls: unknown[] = [];
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: (m: string, d: unknown) => logCalls.push([m, d]),
    info: (m: string, d: unknown) => logCalls.push([m, d]),
    warn: (m: string, d: unknown) => logCalls.push([m, d]),
    error: (m: string, d: unknown) => logCalls.push([m, d]),
  }),
}));

import * as byok from '../src/main/byok';

const KEY = 'sk-live-TOPSECRET-4321';
const kit = { version: 'k1', systemPrompt: 'You are Clippy {{TODAY}}', tools: [], notes: '' };

function fetchMock(handler: (url: string, init: any) => { status: number; body?: unknown; etag?: string }) {
  const fn = vi.fn(async (url: string, init: any) => {
    const r = handler(url, init);
    return {
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? r.etag ?? null : null) },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? null),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => { logCalls.length = 0; encryptionAvailable = true; });

describe('byok settings + key storage', () => {
  it('is off by default and not active until configured', () => {
    const s = byok.getByokStatus();
    expect(s.enabled).toBe(false);
    expect(s.active).toBe(false);
    expect(s.keyPresent).toBe(false);
    expect(s.brainLabel).toBe('Clippy');
    expect(s.presets.map((p) => p.id)).toEqual(['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'groq', 'ollama', 'lmstudio', 'custom']);
    expect(byok.saveByokSettings({ enabled: true }).status.active).toBe(false); // OpenAI needs a key
    expect(byok.getBrainLabel()).toBe('Clippy');
  });

  it('refuses to store a key when safeStorage is unavailable and says why', () => {
    encryptionAvailable = false;
    const r = byok.saveByokSettings({ apiKey: KEY });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/cannot encrypt/i);
    expect(r.status.keyPresent).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('stores the key encrypted; status/IPC payload only carries a hint', () => {
    const r = byok.saveByokSettings({ provider: 'openai', model: 'gpt-5.4-mini', apiKey: KEY, enabled: true });
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ active: true, keyPresent: true, keyHint: '4321', brainLabel: 'your own — gpt-5.4-mini via OpenAI', baseUrl: 'https://api.openai.com/v1' });
    expect(JSON.stringify(r.status)).not.toContain(KEY);
    expect(JSON.stringify(logCalls)).not.toContain(KEY);
    expect(JSON.stringify(logCalls)).not.toContain('TOPSECRET');
  });

  it('validates the base URL and resets URL/model on preset switch', () => {
    expect(byok.saveByokSettings({ baseUrl: 'ftp://x' }).ok).toBe(false);
    const r = byok.saveByokSettings({ provider: 'ollama' });
    expect(r.status).toMatchObject({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', active: true });
    byok.saveByokSettings({ provider: 'openai' });
  });
});

describe('kit + turn through the glue', () => {
  it('fetches the kit with the LICENSE key, caches it on disk, then sends the MODEL key only to the provider', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    fetchMock((url, init) => {
      seen.push({ url, auth: init.headers?.Authorization });
      if (url.includes('/v1/agent-kit')) return { status: 200, body: kit, etag: '"k1"' };
      return { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] } };
    });
    const k = await byok.getKitForTurn({ caps: { clawd: false }, toolTiers: { read_screen: { tier: 1 } } });
    expect(k.kit).toEqual(kit);
    expect(seen[0].url).toMatch(/^https:\/\/api\.clippyai\.app\/v1\/agent-kit\?platform=/);
    expect(seen[0].url).toContain('caps=');
    expect(seen[0].url).toContain('tool_tiers=');
    expect(seen[0].auth).toBe('Bearer CLIP-TEST-KEY');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'byok-kit.json'), 'utf8'))).toMatchObject({ etag: '"k1"', kit });

    const r = await byok.runTurn(kit, [{ role: 'user', parts: [{ text: 'hello' }] }], {});
    expect(r).toMatchObject({ parts: [{ text: 'hi' }], done: true, provider: 'OpenAI', model: 'gpt-5.4-mini' });
    expect(seen[1]).toEqual({ url: 'https://api.openai.com/v1/chat/completions', auth: `Bearer ${KEY}` });
    expect(byok.getLastByokModel()).toBe('gpt-5.4-mini (OpenAI)');
    // the key never reached the kit request or the logs
    expect(seen.filter((s) => s.url.includes('clippyai.app')).every((s) => s.auth === 'Bearer CLIP-TEST-KEY')).toBe(true);
    expect(JSON.stringify(logCalls)).not.toContain(KEY);
    expect(JSON.stringify(logCalls)).toContain('Byok.turn_ok');
  });

  it('serves the cached kit while offline (fresh → no request; stale → failed revalidate still serves cache)', async () => {
    const fetch = fetchMock(() => { throw new Error('offline'); });
    const k = await byok.getKitForTurn({ caps: { clawd: false }, toolTiers: { read_screen: { tier: 1 } } });
    expect(k.kit).toEqual(kit);
    expect(fetch).not.toHaveBeenCalled(); // fresh (<5 min) → no network at all
    const k2 = await byok.getKitForTurn({ caps: { clawd: true }, toolTiers: {} }); // different query → tries network
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(k2.kit).toEqual(kit); // offline → cache
  });

  it('401 drops the cached kit and reports invalid_key', async () => {
    fetchMock(() => ({ status: 401, body: { error: 'invalid_key' } }));
    const k = await byok.getKitForTurn({ caps: { clawd: true }, toolTiers: {} });
    expect(k).toMatchObject({ kit: null, error: 'invalid_key' });
    expect(fs.existsSync(path.join(tmp, 'byok-kit.json'))).toBe(false);
    expect(byok.getByokStatus().kit.cached).toBe(false);
  });

  it('abortByokRequests cancels an in-flight provider call', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))));
    const p = byok.runTurn(kit, [{ role: 'user', parts: [{ text: 'hello' }] }], {});
    byok.abortByokRequests();
    expect(await p).toMatchObject({ error: 'cancelled' });
  });

  it('test connection reports the provider error text', async () => {
    fetchMock(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
    expect(await byok.testByokConnection()).toEqual({ ok: false, message: 'HTTP 401: Incorrect API key provided' });
    byok.clearByokKey();
    expect(await byok.testByokConnection()).toMatchObject({ ok: false, message: expect.stringMatching(/needs an API key/) });
    expect(byok.getByokStatus()).toMatchObject({ keyPresent: false, keyHint: '', active: false });
  });
});
