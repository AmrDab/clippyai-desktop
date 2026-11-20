/**
 * Voice input: telling speech from silence. Pure (no Electron, no DOM) so the
 * recorder in the renderer and the transcriber in main share one set of rules.
 */

/** Below this whole-clip RMS a non-speech transcript ("you", "Thank you.") is
 *  taken for a hallucination. Spoken clips sit well above it. */
export const LOW_ENERGY_RMS = 0.01;
/** A clip shorter than this cannot hold a real "thank you". */
export const SHORT_CLIP_MS = 600;

export interface ClipStats {
  /** Root mean square of the samples, 0..1. */
  rms: number;
  durationMs: number;
}

/** RMS over a list of Float32 sample frames (0 when there are no samples). */
export function rmsOf(frames: ArrayLike<number>[]): number {
  let sum = 0;
  let n = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    n += f.length;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** Energy and length of a clip from the recorder: 16-bit mono PCM behind a
 *  44-byte WAV header (src/renderer/recorder.ts encodeWav). */
export function wavStats(wav: Uint8Array): ClipStats {
  if (wav.byteLength <= 44) return { rms: 0, durationMs: 0 };
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const rate = view.getUint32(24, true) || 16000;
  const samples = Math.floor((wav.byteLength - 44) / 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(44 + i * 2, true) / 0x8000;
    sum += s * s;
  }
  return { rms: samples ? Math.sqrt(sum / samples) : 0, durationMs: (samples / rate) * 1000 };
}

// What the speech engines print for audio with no speech in it.
const NON_SPEECH_TAG = /[[(]\s*(blank[_ ]audio|silence|music|inaudible)\s*[\])]/gi;
// What whisper invents for near-silent or very short clips.
const SILENCE_PHRASES = new Set(['you', 'thank you', 'thanks for watching']);

/**
 * The transcript with non-speech output removed; '' when nothing was said.
 * Tags such as [BLANK_AUDIO] or (silence) are never speech. "you",
 * "Thank you." and "Thanks for watching." are dropped only when the clip was
 * quiet or too short to hold them, so a spoken "thank you" still gets through.
 */
export function cleanTranscript(text: string, clip: ClipStats): string {
  const t = text.replace(NON_SPEECH_TAG, ' ').replace(/\s+/g, ' ').trim();
  const bare = t.toLowerCase().replace(/[.!?,\s]+$/, '');
  const doubtful = clip.rms < LOW_ENERGY_RMS || clip.durationMs < SHORT_CLIP_MS;
  if (doubtful && SILENCE_PHRASES.has(bare)) return '';
  return t;
}
