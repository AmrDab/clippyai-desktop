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

  speak(text: string): void {
    if (!this.enabled || !text.trim()) return;
    this.synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = this.rate;
    utt.pitch = 1.0;
    utt.volume = 0.9;
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
