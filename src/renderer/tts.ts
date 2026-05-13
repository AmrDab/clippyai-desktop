export class TTS {
  private synth: SpeechSynthesis;
  private enabled: boolean = true;
  private rate: number = 1.1;
  private voice: SpeechSynthesisVoice | null = null;
  private preferredVoiceName: string = '';

  constructor() {
    this.synth = window.speechSynthesis;
    window.speechSynthesis.onvoiceschanged = () => this.selectVoice();
    this.selectVoice();
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
   * "paperclip" at the end of every reply (per user report 573d7579).
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
    this.synth.cancel();
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = this.rate;
    utt.pitch = this.pitch;
    utt.volume = this.volume;
    if (this.voice) utt.voice = this.voice;
    this.synth.speak(utt);
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2.0, rate));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.synth.cancel();
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.synth.getVoices();
  }
}
