/**
 * first-run.ts — the scripted first-run name exchange, as pure logic.
 *
 * The app (not the model) asks the user's name, captures it, reacts and says
 * the plan line: on Free the model gets no profile and no profile tools, so a
 * model-driven version would silently do nothing for new users. No Electron
 * import: main (brain.ts) decides, the renderer plays the lines.
 */
import { t, type Lang } from './i18n';

// ── Name capture ─────────────────────────────────────────────────────

/** Words that are never a name. The original v0.20 list plus greetings in pt/es/fr and common first words of requests. */
export const NAME_STOP_LIST: ReadonlySet<string> = new Set([
  // Greetings + affirmations
  'hey', 'hi', 'hello', 'hiya', 'howdy', 'sup', 'yo', 'ok', 'okay',
  'yes', 'yeah', 'yep', 'nope', 'no', 'sure', 'cool', 'nice',
  'oi', 'olá', 'ola', 'hola', 'buenas', 'salut', 'bonjour', 'coucou',
  'sim', 'não', 'nao', 'sí', 'oui', 'non',
  // Common "I'm X" complements that aren't names
  'tired', 'busy', 'back', 'fine', 'good', 'great', 'happy', 'sad',
  'hungry', 'thirsty', 'bored', 'angry', 'sleepy', 'ready', 'done',
  'free', 'available', 'here', 'in', 'out', 'home', 'working',
  'going', 'leaving', 'sorry', 'late', 'early',
  // "call me X" complements that aren't names
  'later', 'tomorrow', 'soon', 'never', 'asap', 'maybe',
  // First-message instructions / clippy mentions
  'clippy', 'you', 'me', 'this', 'that', 'help', 'wait', 'stop',
  'cancel', 'pause', 'resume', 'quit', 'exit', 'close', 'open',
  // First words of questions and requests (a name never starts a sentence like these)
  'what', 'whats', 'how', 'why', 'who', 'when', 'where', 'can', 'could', 'please',
  'write', 'send', 'show', 'tell', 'make', 'find', 'search', 'play', 'email', 'do', 'does', 'is', 'are',
  'abre', 'abra', 'escreve', 'envie', 'mande', 'como', 'quem', 'quando', 'onde', 'por',
  'escribe', 'envía', 'cómo', 'qué', 'quién', 'cuándo', 'dónde',
  'ouvre', 'écris', 'envoie', 'comment', 'quoi', 'qui', 'quand', 'où', 'pourquoi',
]);

const SKIP_WORDS: ReadonlySet<string> = new Set([
  'skip', 'no', 'later', 'nope', 'pular', 'depois', 'não', 'nao', 'saltar', 'luego', 'passer', 'plus tard', 'non',
]);

/** "my name is", "me chamo"... — longest first so "sou o" wins over "sou". */
const LEAD_PHRASES = [
  'my name is', "name's", 'call me', "i'm", 'i am', "it's", 'its',
  'meu nome é', 'meu nome e', 'me chamo', 'pode me chamar de', 'eu sou', 'sou o', 'sou a', 'sou',
  'me llamo', 'mi nombre es', 'llámame', 'llamame', 'soy',
  "je m'appelle", 'moi c\'est', "c'est", 'je suis', 'appelez-moi', 'appelle-moi',
].sort((a, b) => b.length - a.length);

const LEAD_RE = new RegExp(`^(?:${LEAD_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s+`, 'i');
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'-]*(?: [\p{L}\p{M}][\p{L}\p{M}'-]*){0,2}$/u;

export type NameCapture =
  | { kind: 'name'; name: string }
  | { kind: 'skip' }
  | { kind: 'other' };

function normalize(raw: string): string {
  return raw.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!,;:]+$/g, '').trim();
}

function capitalizeWords(s: string): string {
  return s.replace(/(^|[ -])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/**
 * Decide whether the reply to "What's your name?" is a name, a skip, or
 * something else (a question, a task, a long sentence).
 */
export function captureName(text: string): NameCapture {
  let s = normalize(text);
  if (!s) return { kind: 'other' };
  if (SKIP_WORDS.has(s.toLowerCase())) return { kind: 'skip' };
  s = s.replace(LEAD_RE, '');
  s = normalize(s);
  if (!s || s.length > 30 || /[?\d]/.test(s)) return { kind: 'other' };
  if (SKIP_WORDS.has(s.toLowerCase()) && !/^[A-Z]/.test(s)) return { kind: 'skip' };
  if (!NAME_RE.test(s)) return { kind: 'other' };
  const words = s.toLowerCase().split(' ');
  // A request like "open spotify" starts with a stop word; so does "ok sam".
  if (NAME_STOP_LIST.has(words[0]) || NAME_STOP_LIST.has(s.toLowerCase())) return { kind: 'other' };
  return { kind: 'name', name: /\p{Lu}/u.test(s) ? s : capitalizeWords(s) };
}

/** What we send to the backend as `user_name`: letters, marks, space, hyphen, apostrophe, period; one space; 30 chars. */
export function sanitizeUserName(raw: string | undefined | null): string {
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{M} '’.-]/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, 30)
    .trim();
}

// ── State machine ────────────────────────────────────────────────────

export interface FirstRunState {
  /** 'ask': the name question is open. 'ask_later': the one follow-up is open. 'off': nothing pending. */
  phase: 'off' | 'ask' | 'ask_later';
  /** The question was ignored: after the model's next answer, show name.later once. */
  followUpAfterAnswer: boolean;
  /** The follow-up was ignored too: after the model's next answer, open the chips silently. */
  silentChipsAfterAnswer: boolean;
}

export const FIRST_RUN_IDLE: FirstRunState = { phase: 'off', followUpAfterAnswer: false, silentChipsAfterAnswer: false };
export const FIRST_RUN_ASKING: FirstRunState = { phase: 'ask', followUpAfterAnswer: false, silentChipsAfterAnswer: false };

export type FirstRunDecision =
  | { action: 'react'; name: string }
  | { action: 'skip' }
  | { action: 'model' };

/** The user's next message while a name question may be open. */
export function decideFirstRun(state: FirstRunState, text: string): { decision: FirstRunDecision; next: FirstRunState } {
  if (state.phase === 'off') return { decision: { action: 'model' }, next: state };
  const c = captureName(text);
  if (c.kind === 'name') return { decision: { action: 'react', name: c.name }, next: FIRST_RUN_IDLE };
  if (c.kind === 'skip') return { decision: { action: 'skip' }, next: FIRST_RUN_IDLE };
  return {
    decision: { action: 'model' },
    next: state.phase === 'ask'
      ? { phase: 'off', followUpAfterAnswer: true, silentChipsAfterAnswer: false }
      : { phase: 'off', followUpAfterAnswer: false, silentChipsAfterAnswer: true },
  };
}

/** After the model finished answering a message that was not a name. */
export function afterModelAnswer(state: FirstRunState): { show: 'later' | 'chips' | 'none'; next: FirstRunState } {
  if (state.followUpAfterAnswer) return { show: 'later', next: { phase: 'ask_later', followUpAfterAnswer: false, silentChipsAfterAnswer: false } };
  if (state.silentChipsAfterAnswer) return { show: 'chips', next: FIRST_RUN_IDLE };
  return { show: 'none', next: state };
}

// ── The scripted lines ───────────────────────────────────────────────

export interface ScriptLine {
  text: string;
  /** Animation name(s); several play one after the other. */
  animate: string | string[];
}

export interface ScriptPayload {
  lines: ScriptLine[];
  /** 'speak': open the chips with the spoken "try me" line. 'silent': open them quietly. 'none'. */
  chips: 'speak' | 'silent' | 'none';
  /** Played at once, before the first line. */
  intro?: string;
  /** Wait before the first line (ms). */
  startDelayMs?: number;
  /** The last line is the sticky name question; the input opens focused with this placeholder. */
  askName?: string;
}

/** Wake-up: appear, three bubbles, then the sticky name question. */
export function wakeScript(lang: Lang): ScriptPayload {
  return {
    intro: 'Greeting',
    startDelayMs: 1200,
    askName: t(lang, 'name.placeholder'),
    chips: 'none',
    lines: [
      { text: t(lang, 'wake.1'), animate: 'LookDown' },
      { text: t(lang, 'wake.2'), animate: ['LookLeft', 'LookRight'] },
      { text: t(lang, 'wake.3'), animate: 'Wave' },
    ],
  };
}

/** The plan line: Free states a fact about Clippy, Power/Max says he has hands. */
function planLine(lang: Lang, paid: boolean): ScriptLine {
  return paid
    ? { text: t(lang, 'plan.paid'), animate: 'Explain' }
    : { text: t(lang, 'plan.free'), animate: 'LookDown' };
}

/** After a name: reaction, plan line, then the chips (the overlay speaks "try me"). */
export function reactScript(lang: Lang, name: string, paid: boolean): ScriptPayload {
  return {
    chips: 'speak',
    lines: [
      { text: t(lang, 'name.react', { name }), animate: 'Congratulate' },
      planLine(lang, paid),
    ],
  };
}

/** The name was skipped: one light line, the plan line, the chips. */
export function skipScript(lang: Lang, paid: boolean): ScriptPayload {
  return {
    chips: 'speak',
    lines: [{ text: t(lang, 'name.skip'), animate: 'Wave' }, planLine(lang, paid)],
  };
}

/** The one follow-up after an ignored question. */
export function laterScript(lang: Lang): ScriptPayload {
  return { chips: 'none', lines: [{ text: t(lang, 'name.later'), animate: 'Wave' }] };
}

/** Chips with no talking (the name was ignored twice). */
export function silentChipsScript(): ScriptPayload {
  return { chips: 'silent', lines: [] };
}

/** Text pushed into the chat history after a captured name: what Clippy said. */
export function reactionHistoryText(lang: Lang, name: string, paid: boolean): string {
  return `${t(lang, 'name.react', { name })} ${planLine(lang, paid).text}`;
}

// ── Timing ───────────────────────────────────────────────────────────

export const AFTER_SPEECH_MS = 600;

/** Pause after a bubble when nothing is being read aloud (3.0 s, 3.6 s for longer lines). */
export function silentGapMs(text: string): number {
  return text.length > 60 ? 3600 : 3000;
}

/** Delay before the "never got your name" follow-up. */
export const FOLLOW_UP_DELAY_MS = 2500;

/** Is the plan one with hands? */
export function isPaidPlan(plan: string): boolean {
  return /^(power|max)$/i.test(plan || '');
}
