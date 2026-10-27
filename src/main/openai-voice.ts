/**
 * v0.20.0 (voice v1) — Optional OpenAI voice proxy (main process only).
 *
 * WHY THIS LIVES IN MAIN, NOT THE RENDERER:
 *   The OpenAI API key is a secret. It is read here — from the macOS
 *   Keychain (service `clippyai-api`, account `openai`) or, as a dev
 *   convenience, from process.env.OPENAI_API_KEY — and NEVER crosses the
 *   contextBridge into the renderer. The renderer only ever receives
 *   synthesized audio BYTES (TTS) or a transcript STRING (STT); it never
 *   sees, stores, or forwards the key. This mirrors the existing
 *   api-routes.ts/getApiToken() pattern (keychain + presence flag).
 *
 * SCOPE (voice v1, client-only):
 *   - TTS:  gpt-4o-mini-tts  (~$0.015/min) → returns audio/mpeg bytes.
 *   - STT:  gpt-4o-transcribe → returns the transcript text.
 *   Both are OPT-IN. Local SpeechSynthesis (TTS) and bundled whisper.cpp
 *   (STT, win32 only) remain the default + offline fallback. If no key is
 *   configured these functions report "unavailable" and the caller falls
 *   back to / stays on the local path.
 *
 * TODO (voice v2): route through the ClippyAI worker instead of calling
 *   OpenAI directly, so billing/quota can be metered server-side and the
 *   user doesn't have to bring their own key. v1 is deliberately
 *   client-only and does NOT touch the worker (clippyai-api).
 *
 * PRIVACY: when the OpenAI path is active, audio (STT) or response text
 *   (TTS) is sent to OpenAI. This is gated behind an explicit Settings
 *   opt-in + a user-provided key; see the note in settings.html.
 */

import { net } from 'electron';
import { getSecret } from './skills/secrets';
import { API_KEYCHAIN_SERVICE } from './api-routes';
import { isOpenAiKeyPresent, getLicenseKey } from './license';
import { createLogger, serializeErr } from './logger';

const log = createLogger('OpenAIVoice');

// v0.20.0 (voice v2) — ClippyAI worker base. Mirrors brain.ts' API_BASE.
// Max-tier "premium voice, no API key needed" routes TTS through the
// worker's metered /v1/tts endpoint (worker uses its own OpenAI key and
// meters 300 min/mo) instead of the user's BYO key.
const API_BASE = 'https://api.clippyai.app';
const WORKER_TTS_ENDPOINT = `${API_BASE}/v1/tts`;

/** Keychain account under the shared `clippyai-api` service for the
 *  user-provided OpenAI key. Distinct from the app-integration keys
 *  (gmail/slack/…) so it never collides with API_CAPABLE_APP_IDS. */
export const OPENAI_KEYCHAIN_ACCOUNT = 'openai';

/** Default voice for gpt-4o-mini-tts. `alloy` is the neutral house voice. */
const DEFAULT_TTS_VOICE = 'alloy';
const TTS_MODEL = 'gpt-4o-mini-tts';
const STT_MODEL = 'gpt-4o-transcribe';

/**
 * Resolve the OpenAI key: Keychain first (what the Settings field writes),
 * then process.env.OPENAI_API_KEY as a dev/power-user fallback. Returns
 * null when neither is set. NEVER returned to the renderer.
 */
async function getOpenAiKey(): Promise<string | null> {
  // Presence flag avoids an async keychain hit when the user never set one.
  if (isOpenAiKeyPresent()) {
    try {
      const fromChain = await getSecret(API_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT);
      if (fromChain && fromChain.trim().length > 0) return fromChain.trim();
    } catch (err) {
      log.warn('getOpenAiKey keychain read failed', serializeErr(err));
    }
  }
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return null;
}

/** Cheap sync-ish availability check for `get-config` / status surfaces.
 *  Reflects whether *a* key source exists (keychain presence flag OR env).
 *  Does not read the secret itself. */
export function isOpenAiVoiceConfigured(): boolean {
  if (isOpenAiKeyPresent()) return true;
  const env = process.env.OPENAI_API_KEY;
  return !!(env && env.trim().length > 0);
}

export interface SynthResult {
  ok: boolean;
  /** Raw audio bytes (audio/mpeg). Only present on ok=true. */
  audio?: Uint8Array;
  mimeType?: string;
  /** `unavailable` = no key configured → renderer should use local TTS.
   *  Any other error = transient (network/HTTP) → renderer also falls back. */
  error?: string;
  unavailable?: boolean;
  /** voice v2 (worker path) — monthly metered minutes exhausted (HTTP 402).
   *  Caller falls back to the system voice; surfaced for diagnostics. */
  capped?: boolean;
  /** voice v2 (worker path) — plan has no premium voice (HTTP 403).
   *  Caller falls back to the system voice; surfaced for diagnostics. */
  notEntitled?: boolean;
  /** voice v2 — seconds left this month (from X-Voice-Seconds-Remaining). */
  secondsRemaining?: number;
}

/**
 * Synthesize `text` to speech via OpenAI gpt-4o-mini-tts. Returns audio
 * bytes the renderer can play through an <audio>/AudioContext. On ANY
 * failure (no key, offline, HTTP error, timeout) returns ok=false so the
 * renderer falls back to local SpeechSynthesis — Clippy never goes mute.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; timeoutMs?: number } = {},
): Promise<SynthResult> {
  const clean = (text || '').trim();
  if (!clean) return { ok: false, error: 'empty-text' };

  const key = await getOpenAiKey();
  if (!key) {
    // Distinct from a transient error: tells the renderer "stay on local".
    return { ok: false, unavailable: true, error: 'no-openai-key' };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: opts.voice || DEFAULT_TTS_VOICE,
        input: clean,
        // mp3 is the smallest broadly-decodable format; the renderer
        // plays it via an Audio element fed a blob: URL.
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await safeErrText(resp);
      log.warn('synthesizeSpeech HTTP error', { status: resp.status, detail });
      return { ok: false, error: `openai-tts-${resp.status}` };
    }
    const arrayBuf = await resp.arrayBuffer();
    return { ok: true, audio: new Uint8Array(arrayBuf), mimeType: 'audio/mpeg' };
  } catch (err) {
    log.warn('synthesizeSpeech threw', serializeErr(err));
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * voice v2 — synthesize `text` via the ClippyAI WORKER's metered premium
 * endpoint. For Max subscribers who selected the OpenAI engine WITHOUT a
 * personal key: the worker uses its OWN OpenAI key and meters 300 min/mo,
 * so the user gets "premium voice, no API key needed".
 *
 * Auth: the LICENSE KEY rides as a Bearer token (same as /v1/turn). The
 * license key is read here in MAIN and NEVER crosses into the renderer.
 *
 * Worker contract:
 *   POST <base>/v1/tts  Authorization: Bearer <licenseKey>
 *   body { text, voice? }
 *   200 → audio/mpeg bytes + header X-Voice-Seconds-Remaining
 *   402 { error: "voice_capped" }       → out of monthly minutes
 *   403 { error: "voice_not_entitled" } → plan has no premium voice
 *
 * On 402 → { ok:false, capped:true, unavailable:true }
 * On 403 → { ok:false, notEntitled:true, unavailable:true }
 * On any other failure (no license key, network, timeout, other HTTP) →
 *   { ok:false, unavailable:true }.
 * `unavailable:true` on every non-OK path tells the renderer to fall back
 * to the local system voice — Clippy never goes mute.
 */
export function synthesizeViaWorker(
  text: string,
  voice?: string,
  opts: { timeoutMs?: number } = {},
): Promise<SynthResult> {
  const clean = (text || '').trim();
  if (!clean) return Promise.resolve({ ok: false, error: 'empty-text' });

  const licenseKey = getLicenseKey();
  if (!licenseKey) {
    // No license → can't authenticate to the metered endpoint. Fall back.
    return Promise.resolve({ ok: false, unavailable: true, error: 'no-license-key' });
  }

  const timeoutMs = opts.timeoutMs ?? 20_000;

  return new Promise<SynthResult>((resolve) => {
    let settled = false;
    const done = (r: SynthResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const req = net.request({ url: WORKER_TTS_ENDPOINT, method: 'POST' });
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', `Bearer ${licenseKey}`);

    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* already closed */ }
      log.warn('synthesizeViaWorker timeout', { timeoutMs });
      done({ ok: false, unavailable: true, error: 'worker-tts-timeout' });
    }, timeoutMs);

    req.on('response', (response) => {
      const status = response.statusCode || 0;
      const secsHeader = response.headers['x-voice-seconds-remaining'];
      const secondsRemaining = parseRemaining(secsHeader);
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        if (status === 200) {
          if (body.byteLength === 0) {
            log.warn('synthesizeViaWorker empty 200 body');
            done({ ok: false, unavailable: true, error: 'worker-tts-empty' });
            return;
          }
          done({
            ok: true,
            audio: new Uint8Array(body),
            mimeType: 'audio/mpeg',
            secondsRemaining,
          });
          return;
        }
        if (status === 402) {
          // Out of monthly minutes — surface for diagnostics, fall back.
          log.info('synthesizeViaWorker voice_capped — using system voice', { secondsRemaining });
          done({ ok: false, unavailable: true, capped: true, error: 'voice_capped', secondsRemaining });
          return;
        }
        if (status === 403) {
          // Plan has no premium voice — fall back silently.
          log.info('synthesizeViaWorker voice_not_entitled — using system voice');
          done({ ok: false, unavailable: true, notEntitled: true, error: 'voice_not_entitled' });
          return;
        }
        log.warn('synthesizeViaWorker HTTP error', { status, detail: body.toString('utf8').slice(0, 200) });
        done({ ok: false, unavailable: true, error: `worker-tts-${status}` });
      });
    });

    req.on('error', (err) => {
      log.warn('synthesizeViaWorker network error', serializeErr(err));
      done({ ok: false, unavailable: true, error: 'worker-tts-network' });
    });

    req.write(JSON.stringify(voice ? { text: clean, voice } : { text: clean }));
    req.end();
  });
}

/** Parse the X-Voice-Seconds-Remaining header (string | string[] | undefined). */
function parseRemaining(v: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface OpenAiTranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
  unavailable?: boolean;
  elapsedMs?: number;
}

/**
 * Transcribe a 16 kHz mono WAV buffer via OpenAI gpt-4o-transcribe.
 * Used on macOS where the bundled Windows whisper-cli cannot run.
 * Returns unavailable=true when no key is configured so the caller can
 * surface a clean "voice input needs a key" state instead of erroring.
 */
export async function transcribeWithOpenAi(
  wavBuffer: Uint8Array | Buffer,
  opts: { initialPrompt?: string; timeoutMs?: number } = {},
): Promise<OpenAiTranscribeResult> {
  const key = await getOpenAiKey();
  if (!key) return { ok: false, unavailable: true, error: 'no-openai-key' };

  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Build multipart/form-data. Node 20+/Electron 29 expose global
    // FormData + Blob, so no extra dep. The file MUST carry a .wav name +
    // audio/wav type so OpenAI's decoder picks the right container.
    const form = new FormData();
    // Copy into a fresh ArrayBuffer so Blob gets a clean, correctly-sized
    // backing store regardless of how the IPC buffer was allocated.
    const bytes = wavBuffer instanceof Uint8Array ? wavBuffer : new Uint8Array(wavBuffer);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.append('file', new Blob([ab], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', STT_MODEL);
    form.append('response_format', 'json');
    if (opts.initialPrompt) form.append('prompt', opts.initialPrompt);

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - start;
    if (!resp.ok) {
      const detail = await safeErrText(resp);
      log.warn('transcribeWithOpenAi HTTP error', { status: resp.status, detail, elapsedMs });
      return { ok: false, error: `openai-stt-${resp.status}`, elapsedMs };
    }
    const data = (await resp.json()) as { text?: string };
    const transcript = (data.text || '').trim();
    log.info('transcribeWithOpenAi', { chars: transcript.length, elapsedMs });
    return { ok: true, text: transcript, elapsedMs };
  } catch (err) {
    log.warn('transcribeWithOpenAi threw', serializeErr(err));
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort read of an OpenAI error body for logging (never thrown). */
async function safeErrText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return '';
  }
}
