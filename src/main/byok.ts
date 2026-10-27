/**
 * byok.ts — v0.21 "Your own AI model": Electron glue.
 *
 * Owns the settings store (provider / base URL / model / key), the key's
 * safeStorage encryption, the on-disk kit cache (userData/byok-kit.json) and
 * the in-flight request set so brain.ts's cancel paths can abort a turn.
 * The pure parts live in byok/{presets,adapters,kit,engine}.ts.
 *
 * The user's model key is only ever (1) encrypted at rest here, (2) put in
 * the provider request header. It never goes to api.clippyai.app, never
 * crosses IPC after save (Settings gets a "••••1234" hint), never gets logged.
 */

import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import fs from 'fs';
import path from 'path';
import { getLicenseKey } from './license';
import { createLogger } from './logger';
import { PROVIDER_PRESETS, getPreset, type ProviderPreset } from './byok/presets';
import { buildKitUrl, loadKitCache, resolveKit, saveKitCache, type AgentKit, type KitCache } from './byok/kit';
import { runByokTurn, testConnection, TURN_TIMEOUT_MS, type ByokTarget, type EngineResult } from './byok/engine';
import type { WireContent } from './byok/adapters';

export type { WireContent };

const log = createLogger('Byok');
const API_BASE = 'https://api.clippyai.app';

interface ByokStore {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  /** safeStorage.encryptString(key) as base64; '' = no key. */
  keyEnc: string;
  /** Last 4 chars of the key, for the "saved ••••1234" label. */
  keyHint: string;
}

const store = new Store<ByokStore>({
  name: 'byok',
  defaults: { enabled: false, provider: 'openai', baseUrl: '', model: '', keyEnc: '', keyHint: '' },
});

export interface ByokStatus {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  keyPresent: boolean;
  keyHint: string;
  encryptionAvailable: boolean;
  /** enabled AND fully configured — turns are routed to the user's model. */
  active: boolean;
  brainLabel: string;
  kit: { cached: boolean; version: string; checkedAt: number };
  presets: ProviderPreset[];
}

function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function readKey(): string {
  const enc = store.get('keyEnc');
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch (err) {
    log.warn('Byok.key_decrypt_failed', { msg: err instanceof Error ? err.message : String(err) });
    return '';
  }
}

function effective(): { preset: ProviderPreset; baseUrl: string; model: string } {
  const preset = getPreset(store.get('provider'));
  return {
    preset,
    baseUrl: (store.get('baseUrl') || preset.baseUrl).trim(),
    model: (store.get('model') || preset.defaultModel).trim(),
  };
}

function configured(): boolean {
  const { preset, baseUrl, model } = effective();
  if (!baseUrl || !model) return false;
  if (preset.needsKey && !store.get('keyEnc')) return false;
  return true;
}

export function isByokActive(): boolean {
  return store.get('enabled') === true && configured();
}

export function getBrainLabel(): string {
  if (!isByokActive()) return 'Clippy';
  const { preset, model } = effective();
  return `your own — ${model} via ${preset.label}`;
}

let kitCache: KitCache | null | undefined; // undefined = not loaded yet

function kitFile(): string { return path.join(app.getPath('userData'), 'byok-kit.json'); }

function kitCacheState(): KitCache | null {
  if (kitCache === undefined) kitCache = loadKitCache(kitFile());
  return kitCache;
}

export function getByokStatus(): ByokStatus {
  const { baseUrl, model } = effective();
  const kc = kitCacheState();
  return {
    enabled: store.get('enabled') === true,
    provider: store.get('provider'),
    baseUrl,
    model,
    keyPresent: !!store.get('keyEnc'),
    keyHint: store.get('keyHint'),
    encryptionAvailable: encryptionAvailable(),
    active: isByokActive(),
    brainLabel: getBrainLabel(),
    kit: { cached: !!kc, version: kc?.kit.version || '', checkedAt: kc?.checkedAt || 0 },
    presets: PROVIDER_PRESETS.slice(),
  };
}

export interface ByokSaveInput { enabled?: boolean; provider?: string; baseUrl?: string; model?: string; apiKey?: string }

/** Save settings; `apiKey` (when present and non-empty) is encrypted at rest. */
export function saveByokSettings(input: ByokSaveInput): { ok: true; status: ByokStatus } | { ok: false; error: string; status: ByokStatus } {
  if (typeof input.provider === 'string' && PROVIDER_PRESETS.some((p) => p.id === input.provider)) {
    if (input.provider !== store.get('provider')) {
      // Switching preset resets the URL/model to that preset's defaults.
      store.set('provider', input.provider);
      store.set('baseUrl', '');
      store.set('model', '');
    }
  }
  if (typeof input.baseUrl === 'string') {
    const u = input.baseUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) return { ok: false, error: 'Base URL must start with http:// or https://', status: getByokStatus() };
    store.set('baseUrl', u.slice(0, 500));
  }
  if (typeof input.model === 'string') store.set('model', input.model.trim().slice(0, 200));
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const key = input.apiKey.trim();
    if (!encryptionAvailable()) {
      return { ok: false, error: 'This system cannot encrypt secrets (Electron safeStorage is unavailable — on Linux this needs a keyring like gnome-keyring or kwallet). The key was not saved.', status: getByokStatus() };
    }
    try {
      store.set('keyEnc', safeStorage.encryptString(key).toString('base64'));
      store.set('keyHint', key.slice(-4));
    } catch (err) {
      log.warn('Byok.key_encrypt_failed', { msg: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: 'Could not encrypt the key on this system. The key was not saved.', status: getByokStatus() };
    }
  }
  if (typeof input.enabled === 'boolean') store.set('enabled', input.enabled);
  const { preset, model } = effective();
  log.info('Byok.settings', { enabled: store.get('enabled'), provider: preset.id, model, key_present: !!store.get('keyEnc'), active: isByokActive() });
  return { ok: true, status: getByokStatus() };
}

export function clearByokKey(): ByokStatus {
  store.set('keyEnc', '');
  store.set('keyHint', '');
  log.info('Byok.key_cleared', { provider: store.get('provider') });
  return getByokStatus();
}

function target(): ByokTarget {
  const { preset, baseUrl, model } = effective();
  return { api: preset.api, providerLabel: preset.label, baseUrl, model, apiKey: readKey() };
}

const fetchImpl = (url: string, init: RequestInit) => fetch(url, init);

export async function testByokConnection(): Promise<{ ok: boolean; message: string }> {
  const { preset, baseUrl, model } = effective();
  if (!baseUrl || !model) return { ok: false, message: 'Enter a base URL and a model name first.' };
  if (preset.needsKey && !store.get('keyEnc')) return { ok: false, message: `${preset.label} needs an API key — paste and save it first.` };
  try {
    // A local model's first request loads GBs of weights into memory — on a
    // CPU that alone can take longer than the 20 s cloud check (measured 17 s
    // warm for qwen2.5:7b), so local hosts get the full turn timeout.
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
    const r = await testConnection({ target: target(), fetch: fetchImpl, log, timeoutMs: local ? TURN_TIMEOUT_MS : undefined });
    if (!r.ok && local && /no reply within/.test(r.message)) {
      return { ok: false, message: `${r.message} — the first run loads the model into memory; try again, or pick a smaller model.` };
    }
    return r;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export type KitResult = { kit: AgentKit } | { kit: null; error: 'invalid_key' | 'rate_limited' | 'network' | 'bad_response'; detail?: string };

/**
 * Kit for this turn: cached when fresh (<5 min, same query), revalidated with
 * If-None-Match otherwise, cached copy when offline. The license key (not
 * the model key) authenticates this call.
 */
export async function getKitForTurn(q: { caps?: Record<string, boolean>; toolTiers?: Record<string, unknown> }): Promise<KitResult> {
  const url = buildKitUrl(API_BASE, { platform: process.platform, caps: q.caps, toolTiers: q.toolTiers });
  const before = kitCacheState();
  const r = await resolveKit({ cache: before, url, licenseKey: getLicenseKey(), fetch: fetchImpl });
  if (r.kit) {
    if (r.cache !== before) {
      kitCache = r.cache;
      try { saveKitCache(kitFile(), r.cache); } catch (err) { log.warn('Byok.kit_cache_write_failed', { msg: err instanceof Error ? err.message : String(err) }); }
    }
    if (r.source !== 'cache') log.info('Byok.kit', { source: r.source, version: r.kit.version, tools: r.kit.tools.length });
    return { kit: r.kit };
  }
  if (r.error === 'invalid_key' && before) {
    kitCache = null;
    try { fs.rmSync(kitFile(), { force: true }); } catch { /* best-effort */ }
  }
  log.warn('Byok.kit_unavailable', { error: r.error, detail: r.detail, had_cache: !!before });
  return { kit: null, error: r.error, detail: r.detail };
}

// In-flight provider requests, so sleep / override / takeover cancel them.
const inflight = new Set<AbortController>();
export function abortByokRequests(): void {
  for (const c of inflight) c.abort();
  inflight.clear();
}

let lastByokModel: string | null = null;
export function getLastByokModel(): string | null { return lastByokModel; }

export async function runTurn(
  kit: AgentKit,
  contents: WireContent[],
  opts: { user_profile?: string; proactive?: boolean; max_tokens?: number },
): Promise<EngineResult> {
  const ctl = new AbortController();
  inflight.add(ctl);
  try {
    const r = await runByokTurn({
      target: target(), kit, contents,
      userProfile: opts.user_profile, proactive: opts.proactive, maxTokens: opts.max_tokens,
      fetch: fetchImpl, log, signal: ctl.signal,
    });
    if (!('error' in r)) lastByokModel = `${r.model} (${r.provider})`;
    return r;
  } finally {
    inflight.delete(ctl);
  }
}
