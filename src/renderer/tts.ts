export class TTS {
  private synth: SpeechSynthesis;
  private enabled: boolean = true;
  private rate: number = 1.1;
  private voice: SpeechSynthesisVoice | null = null;
  private preferredVoiceName: string = '';

  // voice parity — engine selection. 'system' = browser SpeechSynthesis
  // (the existing Windows/SAPI voice: free, offline, the DEFAULT + fallback).
  // 'openai' = gpt-4o-mini-tts via the main-process proxy (premium, opt-in,
  // needs a key). When 'openai' fails for ANY reason (no key, offline, HTTP
  // error) we fall back to the system path so Clippy never goes mute.
  private engine: 'system' | 'openai' = 'system';
  // OpenAI playback handle so a new speak() can interrupt the previous one
  // (mirrors synth.cancel() for the system path).
  private currentAudio: HTMLAudioElement | null = null;
  private currentAudioUrl: string | null = null;
  // Monotonic token: each speak() bumps it; an in-flight OpenAI fetch that
  // resolves after a newer speak() started is discarded (stale-reply guard).
  private speakSeq = 0;

  constructor() {
    this.synth = window.speechSynthesis;
    window.speechSynthesis.onvoiceschanged = () => this.selectVoice();
    this.selectVoice();
  }

  /** voice parity — switch TTS engine. Called on launch from config and
   *  live on settings change. Switching to a new engine stops any in-flight
   *  speech on the old one. */
  setEngine(engine: 'system' | 'openai'): void {
    if (engine === this.engine) return;
    this.engine = engine === 'openai' ? 'openai' : 'system';
    this.stopAll();
  }

  private selectVoice(): void {
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;

    if (this.preferredVoiceName) {
      this.voice = voices.find((v) => v.name === this.preferredVoiceName) ?? null;
      if (this.voice) return;
    }

    this.voice =
      voices.find((v) => v.name.includes('David')) ??
      voices.find((v) => v.name.includes('Zira')) ??
      voices.find((v) => v.lang.startsWith('en')) ??
      voices[0] ??
      null;
  }

  setPreferredVoice(name: string): void {
    this.preferredVoiceName = name;
    this.selectVoice();
  }

  /**
   * v0.11.29 — strip emoji + pictographs before passing to the speech engine.
   * Without this, the SAPI voice reads "📎" aloud as the literal word
   * "paperclip" at the end of every reply (per support report 573d7579).
   * Bubble display keeps the emoji — only the audio stream is cleaned.
   */
  private stripEmoji(text: string): string {
    return text
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // v0.16.0 — pitch + volume become user-configurable via Settings → Voice.
  private pitch: number = 1.0;
  private volume: number = 0.9;

  setPitch(pitch: number): void {
    this.pitch = Math.max(0.5, Math.min(2.0, pitch));
  }
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  speak(text: string): void {
    const clean = this.stripEmoji(text);
    if (!this.enabled || !clean) return;
    // New utterance supersedes anything currently playing on either engine.
    const seq = ++this.speakSeq;
    this.stopAll();
    if (this.engine === 'openai') {
      // Fire-and-forget; on ANY failure we fall back to the system voice
      // inside speakViaOpenAi so Clippy never goes silent.
      void this.speakViaOpenAi(clean, seq);
      return;
    }
    this.speakViaSystem(clean);
  }

  /** Local SpeechSynthesis path — the free, offline default + fallback.
   *  This is the existing Windows/SAPI voice, unchanged. */
  private speakViaSystem(clean: string): void {
    this.synth.cancel();
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = this.rate;
    utt.pitch = this.pitch;
    utt.volume = this.volume;
    if (this.voice) utt.voice = this.voice;
    this.synth.speak(utt);
  }

  /** OpenAI gpt-4o-mini-tts path via the main-process proxy. The API key is
   *  read in main and NEVER reaches the renderer — we only receive audio
   *  bytes. Any failure (no key, offline, HTTP error, or a newer speak()
   *  superseding this one) cleanly falls back to the system voice. */
  private async speakViaOpenAi(clean: string, seq: number): Promise<void> {
    const synth = window.clippy?.synthesizeSpeech;
    if (!synth) { this.speakViaSystem(clean); return; }
    let res: { ok: boolean; audio?: Uint8Array; mimeType?: string } | undefined;
    try {
      res = await synth(clean);
    } catch {
      res = undefined;
    }
    // Stale-reply guard: a newer speak() ran while we awaited; drop this.
    if (seq !== this.speakSeq) return;
    if (!res || !res.ok || !res.audio || res.audio.byteLength === 0) {
      // Unavailable or transient error → local voice keeps Clippy talking.
      this.speakViaSystem(clean);
      return;
    }
    try {
      // structured-clone may hand us a plain object {0:..,1:..}; normalize.
      const bytes = res.audio instanceof Uint8Array ? res.audio : new Uint8Array(Object.values(res.audio));
      // Copy into a fresh ArrayBuffer so the Blob constructor gets a clean
      // (non-shared) backing store — sidesteps the TS BlobPart lib quirk.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const blob = new Blob([ab], { type: res.mimeType || 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = this.volume;
      // playbackRate maps our speech-rate slider onto the cloud voice too.
      audio.playbackRate = Math.max(0.5, Math.min(2.0, this.rate));
      this.currentAudio = audio;
      this.currentAudioUrl = url;
      const cleanup = () => {
        if (this.currentAudioUrl === url) {
          URL.revokeObjectURL(url);
          this.currentAudio = null;
          this.currentAudioUrl = null;
        } else {
          URL.revokeObjectURL(url);
        }
      };
      audio.onended = cleanup;
      audio.onerror = () => { cleanup(); this.speakViaSystem(clean); };
      await audio.play();
    } catch {
      this.speakViaSystem(clean);
    }
  }

  /** Stop all in-flight speech on both engines. */
  private stopAll(): void {
    this.synth.cancel();
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch { /* ignore */ }
      this.currentAudio = null;
    }
    if (this.currentAudioUrl) {
      URL.revokeObjectURL(this.currentAudioUrl);
      this.currentAudioUrl = null;
    }
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.0, rate));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stopAll();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth.getVoices();
  }
}
