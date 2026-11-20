import { describe, it, expect } from 'vitest';
import {
  cleanTranscript, rmsOf, wavStats, isSilentClip, silentMicMessage,
  HEARD_NOTHING, LOW_ENERGY_RMS, SHORT_CLIP_MS, SILENT_CLIP_RMS,
} from '../src/main/voice-gate';

const spoken = { rms: 0.05, durationMs: 2000 };
const quiet = { rms: LOW_ENERGY_RMS / 10, durationMs: 2000 };
const short = { rms: 0.05, durationMs: SHORT_CLIP_MS - 100 };

/** A recorder-shaped WAV: 44-byte header, 16 kHz mono 16-bit, constant amplitude. */
function wav(amplitude: number, samples: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buf);
  view.setUint32(24, 16000, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(amplitude * 0x7fff), true);
  return new Uint8Array(buf);
}

describe('cleanTranscript — non-speech output never becomes a message', () => {
  it('drops whisper non-speech tags whatever the clip energy', () => {
    for (const t of ['[BLANK_AUDIO]', '[ Silence ]', '(silence)', '[Music]', '[inaudible]', ' [BLANK_AUDIO] [BLANK_AUDIO] ']) {
      expect(cleanTranscript(t, spoken)).toBe('');
      expect(cleanTranscript(t, quiet)).toBe('');
    }
  });
  it('drops the silence phrases on a quiet clip', () => {
    for (const t of ['you', 'You', 'Thank you.', 'thank you', 'Thanks for watching.', 'Thanks for watching!']) {
      expect(cleanTranscript(t, quiet)).toBe('');
    }
  });
  it('drops the silence phrases on a clip too short to hold them', () => {
    expect(cleanTranscript('you', short)).toBe('');
    expect(cleanTranscript('Thank you.', short)).toBe('');
  });
  it('keeps the same phrases when they were clearly spoken', () => {
    expect(cleanTranscript('Thank you.', spoken)).toBe('Thank you.');
    expect(cleanTranscript('you', spoken)).toBe('you');
  });
  it('keeps real speech, quiet or not, and strips a tag around it', () => {
    expect(cleanTranscript('open notepad', quiet)).toBe('open notepad');
    expect(cleanTranscript('thank you for the file', quiet)).toBe('thank you for the file');
    expect(cleanTranscript('[BLANK_AUDIO] open notepad', spoken)).toBe('open notepad');
    expect(cleanTranscript('play [the] music (loudly)', spoken)).toBe('play [the] music (loudly)');
  });
  it('a tag plus a silence phrase on a quiet clip is empty', () => {
    expect(cleanTranscript('[BLANK_AUDIO] you', quiet)).toBe('');
  });
  it('empty stays empty', () => {
    expect(cleanTranscript('', spoken)).toBe('');
    expect(cleanTranscript('   ', quiet)).toBe('');
  });
});

describe('rmsOf / wavStats — clip energy', () => {
  it('rmsOf is 0 for no samples and for digital silence', () => {
    expect(rmsOf([])).toBe(0);
    expect(rmsOf([new Float32Array(1024)])).toBe(0);
  });
  it('rmsOf spans every frame', () => {
    expect(rmsOf([new Float32Array([0.5, -0.5]), new Float32Array([0.5, -0.5])])).toBeCloseTo(0.5, 6);
    expect(rmsOf([new Float32Array([1, 1]), new Float32Array([0, 0])])).toBeCloseTo(Math.SQRT1_2, 6);
  });
  it('wavStats reads energy and length from the recorder WAV', () => {
    const s = wavStats(wav(0.25, 16000));
    expect(s.rms).toBeCloseTo(0.25, 3);
    expect(s.durationMs).toBeCloseTo(1000, 3);
  });
  it('wavStats of a silent or header-only clip is zero', () => {
    expect(wavStats(wav(0, 8000))).toEqual({ rms: 0, durationMs: 500 });
    expect(wavStats(new Uint8Array(44))).toEqual({ rms: 0, durationMs: 0 });
  });
  it('wavStats honours a Buffer view offset', () => {
    const w = wav(0.25, 1600);
    const padded = new Uint8Array(w.length + 8);
    padded.set(w, 8);
    expect(wavStats(padded.subarray(8)).rms).toBeCloseTo(0.25, 3);
  });
});

describe('silence gate — a silent clip is never transcribed', () => {
  it('digital silence and a dead input are silent', () => {
    expect(isSilentClip(0)).toBe(true);
    expect(isSilentClip(rmsOf([new Float32Array(16000)]))).toBe(true);
    expect(isSilentClip(SILENT_CLIP_RMS / 2)).toBe(true);
  });
  it('speech, even quiet speech, is not', () => {
    expect(isSilentClip(SILENT_CLIP_RMS)).toBe(false);
    expect(isSilentClip(0.02)).toBe(false);
  });
  it('a clip whisper would call "you" is gated before the hallucination filter needs to', () => {
    expect(SILENT_CLIP_RMS).toBeLessThan(LOW_ENERGY_RMS);
  });
  it('names the microphone and what to check', () => {
    expect(silentMicMessage('Microphone (HP USB-C Dock Audio Headset)')).toBe(
      "I didn't hear anything. Your microphone (Microphone (HP USB-C Dock Audio Headset)) seems silent; check it's plugged in and its input volume isn't 0, or pick another in Settings → Voice.",
    );
  });
  it('still reads well when the microphone has no name', () => {
    expect(silentMicMessage('')).toBe(
      "I didn't hear anything. Your microphone seems silent; check it's plugged in and its input volume isn't 0, or pick another in Settings → Voice.",
    );
    expect(HEARD_NOTHING).toBe("I didn't hear anything.");
  });
});
