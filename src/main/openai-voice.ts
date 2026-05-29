/**
 * voice parity — Optional OpenAI voice proxy (main process only).
 *
 * WHY THIS LIVES IN MAIN, NOT THE RENDERER:
 *   The OpenAI API key is a secret. It is read here — from the OS secret
 *   store via keytar (service `clippyai-api`, account `openai`) or, as a
 *   dev convenience, from process.env.OPENAI_API_KEY — and NEVER crosses
 *   the contextBridge into the renderer. The renderer only ever receives
 *   synthesized audio BYTES; it never sees, stores, or forwards the key.
 *   Mirrors the existing skills/github.ts getSecret() pattern.
 *
 * SCOPE (Windows voice parity, client-only):
 *   - TTS: gpt-4o-mini-tts (~$0.015/min) → returns audio/mpeg bytes.
 *   STT is NOT touched here — Windows ships bundled whisper.cpp (stt.ts)
 *   which works locally and stays the only STT path. This module adds the
 *   premium OpenAI TTS option for parity with macOS.
 *
 *   TTS is OPT-IN. Local SpeechSynthesis (the Windows/SAPI voice) remains
 *   the default + offline fallback. If no key is configured these functions
 *   report "unavailable" and the caller falls back to / stays on the local
 *   path so Clippy never goes mute.
 *
 * PRIVACY: when the OpenAI path is active, the text Clippy speaks is sent to
 *   OpenAI. This is gated behind an explicit Settings opt-in + a
 *   user-provided key; see the disclosure note in settings.html.
 */

import { getSecret } from './skills/secrets';
import { isOpenAiKeyPresent } from './license';
import { createLogger, serializeErr } from './logger';

const log = createLogger('OpenAIVoice');

/** Keytar service for the user-provided OpenAI key. Distinct from the
 *  per-app integration secrets (e.g. clippy.github) so it never collides. */
export const OPENAI_KEYCHAIN_SERVICE = 'clippyai-api';
/** Keytar account under the shared `clippyai-api` service. */
export const OPENAI_KEYCHAIN_ACCOUNT = 'openai';

/** Default voice for gpt-4o-mini-tts. `alloy` is the neutral house voice. */
const DEFAULT_TTS_VOICE = 'alloy';
const TTS_MODEL = 'gpt-4o-mini-tts';

/**
 * Resolve the OpenAI key: secret store first (what the Settings field
 * writes), then process.env.OPENAI_API_KEY as a dev/power-user fallback.
 * Returns null when neither is set. NEVER returned to the renderer.
 */
async function getOpenAiKey(): Promise<string | null> {
  // Presence flag avoids an async keytar hit when the user never set one.
  if (isOpenAiKeyPresent()) {
    try {
      const fromChain = await getSecret(OPENAI_KEYCHAIN_SERVICE, OPENAI_KEYCHAIN_ACCOUNT);
      if (fromChain && fromChain.trim().length > 0) return fromChain.trim();
    } catch (err) {
      log.warn('getOpenAiKey secret-store read failed', serializeErr(err));
    }
  }
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return null;
}

/** Cheap availability check for `get-config` / status surfaces. Reflects
 *  whether *a* key source exists (presence flag OR env). Does not read the
 *  secret itself. */
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
}

/**
 * Synthesize `text` to speech via OpenAI gpt-4o-mini-tts. Returns audio
 * bytes the renderer can play through an <audio> element. On ANY failure
 * (no key, offline, HTTP error, timeout) returns ok=false so the renderer
 * falls back to local SpeechSynthesis — Clippy never goes mute.
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
        // mp3 is the smallest broadly-decodable format; the renderer plays
        // it via an Audio element fed a blob: URL.
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

/** Best-effort read of an OpenAI error body for logging (never thrown). */
async function safeErrText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 300);
  } catch {
    return '';
  }
}
