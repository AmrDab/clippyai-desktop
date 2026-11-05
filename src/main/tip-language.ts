// v0.23.1 — proactive tips are a separate request with no chat history, so
// they came out in English for users who chat in French. Send a short sample
// of the user's own recent messages so the tip matches their language.
type Turn = { role: 'user' | 'model'; parts: readonly object[] };

const SAMPLE_CHARS = 160;

export function languageSample(history: readonly Turn[]): string {
  const texts: string[] = [];
  for (let i = history.length - 1; i >= 0 && texts.length < 3; i--) {
    const h = history[i];
    if (h.role !== 'user') continue;
    const t = h.parts.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim();
    if (t.length >= 4) texts.push(t);
  }
  return texts.join(' / ').slice(0, SAMPLE_CHARS);
}

export function proactiveMessage(context: string, sample: string): string {
  const screen = `Current screen:\n${context}`;
  if (!sample) return screen;
  return `${screen}\n\nWrite the tip in the language the user writes to you in (not the language on screen). Their recent messages: «${sample}»`;
}
