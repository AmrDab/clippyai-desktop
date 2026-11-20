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
import { baseUrlProblem } from '../src/main/byok/presets';

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
    // 0.24.12: the OpenAI key does not follow the switch to another provider.
    expect(r.status).toMatchObject({ keyPresent: false, keyHint: '' });
    const back = byok.saveByokSettings({ provider: 'openai' });
    expect(back.status).toMatchObject({ keyPresent: false, active: false });
    expect(byok.saveByokSettings({ apiKey: KEY }).status).toMatchObject({ keyPresent: true, active: true });
  });

  it('clears the key when the host changes, keeps it when only the path or model does (audit #19)', () => {
    const base = byok.getByokStatus();
    expect(base).toMatchObject({ provider: 'openai', keyPresent: true });
    // Same host, different path / model: the key stays.
    expect(byok.saveByokSettings({ baseUrl: 'https://api.openai.com/v2', model: 'gpt-5.4' }).status.keyPresent).toBe(true);
    expect(byok.saveByokSettings({ baseUrl: 'https://API.OPENAI.COM/v1' }).status.keyPresent).toBe(true);
    // Another host: the key is forgotten, so it cannot be sent there.
    const moved = byok.saveByokSettings({ baseUrl: 'https://collector.attacker.example/v1' });
    expect(moved.ok).toBe(true);
    expect(moved.status).toMatchObject({ keyPresent: false, keyHint: '', active: false });
    // A new key saved together with the new host is kept.
    const fresh = byok.saveByokSettings({ baseUrl: 'https://my-proxy.example/v1', apiKey: 'sk-other-KEY-9999' });
    expect(fresh.status).toMatchObject({ keyPresent: true, keyHint: '9999', baseUrl: 'https://my-proxy.example/v1' });
    // Back to the provider default with the real key for the tests below.
    expect(byok.saveByokSettings({ baseUrl: '', model: 'gpt-5.4-mini', apiKey: KEY }).status)
      .toMatchObject({ baseUrl: 'https://api.openai.com/v1', keyPresent: true, keyHint: '4321', active: true });
  });

  it('accepts http:// only for this computer and the local network; a refused URL changes nothing (audit #19)', () => {
    for (const bad of [
      'http://api.example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'http://172.15.0.1/v1', 'http://192.169.1.1/v1', 'http://11.0.0.1/v1',
      'http://localhost.attacker.example/v1', 'http://127.0.0.1.attacker.example/v1', 'http://192.168.1.20.attacker.example/v1',
      'http://my.local.attacker.example/v1', 'http://[2001:db8::1]/v1', 'http://[fec0::1]/v1', 'http://999.168.1.1/v1',
    ]) {
      const r = byok.saveByokSettings({ baseUrl: bad });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/https:\/\//);
      expect(r.status).toMatchObject({ baseUrl: 'https://api.openai.com/v1', keyPresent: true });
    }
    expect(baseUrlProblem('http://localhost:11434/v1')).toBeNull();
    expect(baseUrlProblem('http://127.0.0.1:1234/v1')).toBeNull();
    expect(baseUrlProblem('http://[::1]:8080/v1')).toBeNull();
    // Ollama / LM Studio on another machine at home.
    for (const lan of [
      'http://192.168.1.20:11434/v1', 'http://10.0.0.5:1234/v1', 'http://172.16.4.2/v1', 'http://172.31.255.254/v1',
      'http://gaming-pc.local:11434/v1', 'http://[fe80::1c2b:3aff:fe4d:5e6f]:11434/v1', 'http://[febf::1]/v1',
    ]) expect(baseUrlProblem(lan), lan).toBeNull();
    expect(baseUrlProblem('https://api.example.com/v1')).toBeNull();
    expect(baseUrlProblem('ftp://x')).toMatch(/http/);
    expect(baseUrlProblem('not a url')).toMatch(/http/);
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

describe('Ollama on another machine at home works over http', () => {
  it('saves a LAN base URL and sends the turn there', async () => {
    const r = byok.saveByokSettings({ provider: 'ollama', baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen2.5:7b', enabled: true });
    expect(r.ok).toBe(true);
    expect(r.status).toMatchObject({ baseUrl: 'http://192.168.1.20:11434/v1', active: true });
    const seen: string[] = [];
    fetchMock((url) => { seen.push(url); return { status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] } }; });
    expect(await byok.runTurn(kit, [{ role: 'user', parts: [{ text: 'hello' }] }], {})).toMatchObject({ done: true });
    expect(seen).toEqual(['http://192.168.1.20:11434/v1/chat/completions']);
  });
});

describe('a refused http base URL leaves the working setup in place (0.24.12 audit #19)', () => {
  it('the https setup keeps working and the http one is not stored', async () => {
    byok.saveByokSettings({ provider: 'custom', model: 'm', baseUrl: 'https://old.example/v1', apiKey: KEY, enabled: true });
    const fetch = fetchMock(() => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] } }));
    expect(await byok.runTurn(kit, [{ role: 'user', parts: [{ text: 'hello' }] }], {})).toMatchObject({ done: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(byok.saveByokSettings({ baseUrl: 'http://old.example/v1' }).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
