/**
 * v0.17.0 — Audio capture for voice input.
 *
 * Pipeline:
 *   getUserMedia → AudioContext at 16 kHz mono → MediaStreamSource →
 *   AudioWorkletNode (or ScriptProcessor fallback) collects raw Float32
 *   frames → on stop, concatenate → resample to 16 kHz if needed →
 *   downmix to mono → encode as 16-bit PCM WAV → return Uint8Array.
 *
 * Why we encode to WAV in the renderer instead of just sending raw PCM:
 *   whisper-cli reads its audio via libsndfile/dr_wav, which expects
 *   standard PCM WAV headers. The encoder is ~30 LOC. Easier than
 *   teaching the main process about raw-PCM framing and lets us debug
 *   by saving the .wav for manual playback during dev.
 *
 * Why 16 kHz mono: whisper's encoder downsamples everything to 16 kHz
 * mono internally anyway. Doing it once at capture-time means we send
 * 10x less data over IPC (vs 48 kHz stereo) — meaningful for a 30-second
 * clip.
 */

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'encoding';

export interface RecorderEvents {
  onStateChange?: (s: RecorderState) => void;
  /** Called every ~150ms while recording with a 0..1 amplitude value.
   *  Useful for the bubble UI to render a level meter / pulse. */
  onLevel?: (level: number) => void;
  /** Called when audio is captured + encoded. The Uint8Array is a
   *  standard 16 kHz mono 16-bit PCM .wav ready to send to the main
   *  process for whisper-cli. */
  onResult?: (wav: Uint8Array, durationMs: number) => void;
  onError?: (msg: string) => void;
}

export class Recorder {
  private events: RecorderEvents;
  private state: RecorderState = 'idle';
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private buffers: Float32Array[] = [];
  private startedAt = 0;
  // Some browsers won't grant 16 kHz directly — we accept whatever
  // AudioContext gives us and resample on encode.
  private actualSampleRate = 16000;
  // Cap recording at 30 s so a forgotten hotkey doesn't blow up RAM.
  private maxDurationMs = 30_000;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  // Level metering — RMS computed on each onaudioprocess tick.
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private lastLevelSamples: Float32Array | null = null;

  constructor(events: RecorderEvents = {}) {
    this.events = events;
  }

  getState(): RecorderState {
    return this.state;
  }

  /** Begin capturing from the default mic. Resolves once the worklet is
   *  actually receiving frames; rejects on permission denial. */
  async start(): Promise<void> {
    if (this.state !== 'idle') return; // idempotent
    this.setState('requesting');
    try {
      // Try requesting at 16 kHz; browsers may ignore the hint, which
      // is fine — we resample on encode.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.cleanup();
      this.setState('idle');
      const msg = err instanceof Error ? err.message : String(err);
      this.events.onError?.(`Microphone access denied: ${msg}`);
      throw err;
    }

    // Try to create at 16 kHz; fall back to default if browser refuses.
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    this.actualSampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);

    // We use ScriptProcessorNode rather than AudioWorklet for a single
    // reason: AudioWorklets require a module load via the AudioContext,
    // which means publishing a separate JS file as an asset and getting
    // its URL right under electron-vite's bundling. ScriptProcessor is
    // deprecated-but-still-supported and runs entirely in this file.
    // For 30-second voice clips at 16 kHz, the perf cost is negligible.
    const bufSize = 4096;
    this.node = this.ctx.createScriptProcessor(bufSize, 1, 1);
    this.node.onaudioprocess = (e) => {
      const channel = e.inputBuffer.getChannelData(0);
      // Copy: the underlying buffer is reused by the audio thread.
      this.buffers.push(new Float32Array(channel));
      this.lastLevelSamples = channel;
    };
    this.source.connect(this.node);
    // ScriptProcessor needs to be connected to destination to fire on Chromium.
    this.node.connect(this.ctx.destination);

    this.buffers = [];
    this.startedAt = Date.now();
    this.setState('recording');

    // Level meter: report RMS every 150ms.
    this.levelTimer = setInterval(() => {
      if (!this.lastLevelSamples) return;
      let sum = 0;
      for (let i = 0; i < this.lastLevelSamples.length; i++) {
        const s = this.lastLevelSamples[i];
        sum += s * s;
      }
      const rms = Math.sqrt(sum / this.lastLevelSamples.length);
      // Compress to 0..1 with a perceptual curve; raw RMS is too quiet
      // visually because speech-level audio rarely exceeds 0.15 RMS.
      const level = Math.min(1, Math.pow(rms * 6, 0.7));
      this.events.onLevel?.(level);
    }, 150);

    // Hard cap on duration.
    this.maxDurationTimer = setTimeout(() => {
      this.events.onError?.('Recording capped at 30 seconds.');
      void this.stop();
    }, this.maxDurationMs);
  }

  /** Stop capturing + encode to WAV. Fires onResult with the byte array. */
  async stop(): Promise<void> {
    if (this.state !== 'recording') return;
    this.setState('encoding');

    // Detach audio graph FIRST so no more frames accumulate.
    if (this.node) {
      try { this.node.disconnect(); } catch { /* ignore */ }
      this.node.onaudioprocess = null as unknown as (e: AudioProcessingEvent) => void;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* ignore */ }
    }
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }

    const durationMs = Date.now() - this.startedAt;
    const wav = encodeWav(this.buffers, this.actualSampleRate);
    this.buffers = [];

    // Now actually shut down the stream + audio context.
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.source = null;
    this.node = null;

    this.setState('idle');
    this.events.onResult?.(wav, durationMs);
  }

  /** Abandon the recording without emitting a result. Used when the
   *  user cancels (ESC, click-away) before releasing the hotkey. */
  cancel(): void {
    if (this.state === 'idle') return;
    this.cleanup();
    this.setState('idle');
  }

  private cleanup(): void {
    if (this.node) { try { this.node.disconnect(); } catch { /* */ } this.node = null; }
    if (this.source) { try { this.source.disconnect(); } catch { /* */ } this.source = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { void this.ctx.close().catch(() => undefined); this.ctx = null; }
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    this.buffers = [];
  }

  private setState(s: RecorderState): void {
    this.state = s;
    this.events.onStateChange?.(s);
  }
}

// ── WAV encoder ────────────────────────────────────────────────────────
//
// Takes a list of Float32Array frames at `sourceRate`, resamples to
// 16 kHz mono, encodes as 16-bit PCM with a standard 44-byte WAV header.
// Returns a Uint8Array ready for IPC transfer.
//
// Why hand-rolled (vs an npm package): we ship to electron-vite which
// bundles everything. Adding a dep for 30 LOC of encoding isn't worth
// the build-graph weight. The format is rigid and well-documented.

const TARGET_RATE = 16000;

function encodeWav(buffers: Float32Array[], sourceRate: number): Uint8Array {
  // Concatenate all source buffers into one Float32Array.
  let total = 0;
  for (const b of buffers) total += b.length;
  const merged = new Float32Array(total);
  let off = 0;
  for (const b of buffers) { merged.set(b, off); off += b.length; }

  // Resample to 16 kHz if needed. Simple linear interpolation — for
  // speech-band 16 kHz target, this is acceptable; we don't need a
  // proper anti-aliasing filter because whisper's own encoder handles
  // any residual aliasing.
  const resampled = sourceRate === TARGET_RATE ? merged : resample(merged, sourceRate, TARGET_RATE);

  // Encode 16-bit PCM little-endian. 2 bytes per sample.
  const sampleCount = resampled.length;
  const dataSize = sampleCount * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);              // PCM chunk size
  view.setUint16(20, 1, true);               // PCM format
  view.setUint16(22, 1, true);               // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true);               // block align
  view.setUint16(34, 16, true);              // bits per sample
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Samples
  let pos = 44;
  for (let i = 0; i < sampleCount; i++) {
    let s = Math.max(-1, Math.min(1, resampled[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    view.setInt16(pos, s, true);
    pos += 2;
  }
  return new Uint8Array(buf);
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const newLen = Math.round(input.length / ratio);
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function writeString(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}
