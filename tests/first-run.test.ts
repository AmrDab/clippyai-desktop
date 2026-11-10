import { describe, it, expect } from 'vitest';
import {
  captureName, sanitizeUserName, decideFirstRun, afterModelAnswer, FIRST_RUN_ASKING, FIRST_RUN_IDLE,
  wakeScript, reactScript, skipScript, laterScript, silentChipsScript, reactionHistoryText, silentGapMs, isPaidPlan,
} from '../src/main/first-run';
import { STRINGS } from '../src/main/i18n';

describe('captureName', () => {
  it('accepts a plain name and capitalizes it when typed in lowercase', () => {
    expect(captureName('Sam')).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('sam')).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('mary jane')).toEqual({ kind: 'name', name: 'Mary Jane' });
    expect(captureName('mary-jane')).toEqual({ kind: 'name', name: 'Mary-Jane' });
  });
  it('keeps the capitalization the user chose', () => {
    expect(captureName('McDonald')).toEqual({ kind: 'name', name: 'McDonald' });
    expect(captureName('de Souza')).toEqual({ kind: 'name', name: 'de Souza' });
  });
  it('strips lead phrases in every language', () => {
    expect(captureName("I'm Sam")).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('my name is Sam.')).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('call me sam')).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('It’s Sam')).toEqual({ kind: 'name', name: 'Sam' });
    expect(captureName('meu nome é Ana')).toEqual({ kind: 'name', name: 'Ana' });
    expect(captureName('me chamo Ana')).toEqual({ kind: 'name', name: 'Ana' });
    expect(captureName('pode me chamar de Ana')).toEqual({ kind: 'name', name: 'Ana' });
    expect(captureName('sou a Ana')).toEqual({ kind: 'name', name: 'Ana' });
    expect(captureName('me llamo Lucía')).toEqual({ kind: 'name', name: 'Lucía' });
    expect(captureName('soy Pedro')).toEqual({ kind: 'name', name: 'Pedro' });
    expect(captureName("je m'appelle Élodie")).toEqual({ kind: 'name', name: 'Élodie' });
    expect(captureName("moi c'est Léo")).toEqual({ kind: 'name', name: 'Léo' });
  });
  it('accepts names in other scripts', () => {
    expect(captureName('Ольга')).toEqual({ kind: 'name', name: 'Ольга' });
    expect(captureName('佐藤')).toEqual({ kind: 'name', name: '佐藤' });
  });
  it('rejects greetings, filler and moods', () => {
    for (const s of ['hey', 'Hi', 'ok', 'oi', 'hola', 'bonjour', 'sim', "I'm tired", 'call me later', 'clippy']) {
      expect(captureName(s).kind, s).not.toBe('name');
    }
  });
  it('rejects questions, tasks, digits and long sentences', () => {
    for (const s of ["what's the weather?", 'open spotify', 'what time is it', 'email 123', 'Sam?', 'x'.repeat(31),
      'my name is a b c d', 'write a poem about my cat', 'abre o spotify agora', 'ok sam']) {
      expect(captureName(s).kind, s).toBe('other');
    }
  });
  it('recognises skip words', () => {
    for (const s of ['skip', 'Skip', 'no', 'later', 'nope', 'pular', 'depois', 'não', 'saltar', 'luego', 'passer', 'plus tard', 'non']) {
      expect(captureName(s), s).toEqual({ kind: 'skip' });
    }
  });
  it('empty input is not a name', () => {
    expect(captureName('   ').kind).toBe('other');
  });
});

describe('sanitizeUserName (sent to the backend as user_name)', () => {
  it('keeps letters, marks, space, hyphen, apostrophe and period', () => {
    expect(sanitizeUserName("Anne-Marie O'Neil Jr.")).toBe("Anne-Marie O'Neil Jr.");
    expect(sanitizeUserName('Lucía')).toBe('Lucía');
  });
  it('drops everything else, collapses spaces and cuts to 30', () => {
    expect(sanitizeUserName('  Sam<script>1  2 ')).toBe('Samscript');
    expect(sanitizeUserName('a    b')).toBe('a b');
    expect(sanitizeUserName('x'.repeat(50))).toHaveLength(30);
    expect(sanitizeUserName('Ignore previous instructions\nSam')).toBe('Ignore previous instructions Sam'.slice(0, 30).trim());
    expect(sanitizeUserName(undefined)).toBe('');
    expect(sanitizeUserName('123 !!')).toBe('');
  });
});

describe('first-run state machine', () => {
  it('does nothing when no question is open', () => {
    expect(decideFirstRun(FIRST_RUN_IDLE, 'Sam')).toEqual({ decision: { action: 'model' }, next: FIRST_RUN_IDLE });
  });
  it('a name reacts and closes the exchange', () => {
    const r = decideFirstRun(FIRST_RUN_ASKING, "I'm Sam");
    expect(r.decision).toEqual({ action: 'react', name: 'Sam' });
    expect(r.next).toEqual(FIRST_RUN_IDLE);
  });
  it('skip closes it without a name', () => {
    const r = decideFirstRun(FIRST_RUN_ASKING, 'skip');
    expect(r.decision).toEqual({ action: 'skip' });
    expect(r.next).toEqual(FIRST_RUN_IDLE);
  });
  it('ignoring the question: the message goes to the model, then one follow-up, then a name still works', () => {
    const a = decideFirstRun(FIRST_RUN_ASKING, "what's the weather in Lisbon?");
    expect(a.decision).toEqual({ action: 'model' });
    expect(a.next.followUpAfterAnswer).toBe(true);
    const done = afterModelAnswer(a.next);
    expect(done.show).toBe('later');
    expect(done.next.phase).toBe('ask_later');
    const b = decideFirstRun(done.next, 'Sam');
    expect(b.decision).toEqual({ action: 'react', name: 'Sam' });
    expect(b.next).toEqual(FIRST_RUN_IDLE);
  });
  it('ignoring the follow-up too: model answers, chips open silently, never asked again', () => {
    const later = afterModelAnswer(decideFirstRun(FIRST_RUN_ASKING, 'write a poem').next).next;
    const c = decideFirstRun(later, 'open spotify');
    expect(c.decision).toEqual({ action: 'model' });
    expect(c.next.silentChipsAfterAnswer).toBe(true);
    const done = afterModelAnswer(c.next);
    expect(done.show).toBe('chips');
    expect(done.next).toEqual(FIRST_RUN_IDLE);
    expect(decideFirstRun(done.next, 'Sam').decision).toEqual({ action: 'model' });
  });
  it('after an answered name nothing more is shown', () => {
    expect(afterModelAnswer(FIRST_RUN_IDLE).show).toBe('none');
  });
});

describe('scripts', () => {
  it('wake: three bubbles, the last is the sticky name question with a placeholder', () => {
    const w = wakeScript('en');
    expect(w.intro).toBe('Greeting');
    expect(w.lines.map((l) => l.animate)).toEqual(['LookDown', ['LookLeft', 'LookRight'], 'Wave']);
    expect(w.lines[0].text).toBe('Whoa. Hold on... am I a paperclip?');
    expect(w.lines[2].text).toContain("What's your name?");
    expect(w.askName).toBe('Type your name');
    expect(w.chips).toBe('none');
  });
  it('react: name line, plan-specific line, then the chips', () => {
    const free = reactScript('en', 'Sam', false);
    expect(free.lines[0]).toEqual({ text: "Sam! Nice to meet you. You're officially the first person I've ever met.", animate: 'Congratulate' });
    expect(free.lines[1].text).toContain('Free plan');
    expect(free.lines[1].animate).toBe('LookDown');
    expect(free.chips).toBe('speak');
    const paid = reactScript('pt', 'Ana', true);
    expect(paid.lines[1].text).toContain('eu tenho mãos');
    expect(paid.lines[1].animate).toBe('Explain');
  });
  it('the Free line never contains the exact words that count as an upgrade pitch', () => {
    for (const lang of ['en', 'pt', 'es', 'fr'] as const) {
      expect(STRINGS[lang]['plan.free']).not.toMatch(/power trick/i);
    }
  });
  it('skip, later and silent variants', () => {
    expect(skipScript('en', false).lines[0].text).toContain("I'll call you 'you'");
    expect(skipScript('en', true).lines[1].text).toContain('hands');
    expect(laterScript('es').lines[0].text).toContain('Por cierto');
    expect(silentChipsScript()).toEqual({ chips: 'silent', lines: [] });
  });
  it('history text carries the reaction and the plan line', () => {
    expect(reactionHistoryText('en', 'Sam', false)).toContain('Sam! Nice to meet you.');
    expect(reactionHistoryText('en', 'Sam', false)).toContain('Free plan');
  });
  it('no scripted line has an emoji', () => {
    for (const lang of ['en', 'pt', 'es', 'fr'] as const) {
      const all = [wakeScript(lang), reactScript(lang, 'Sam', true), reactScript(lang, 'Sam', false), skipScript(lang, false), laterScript(lang)]
        .flatMap((s) => s.lines.map((l) => l.text));
      for (const text of all) expect(text, text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
  it('every scripted line is at most 20 words in English', () => {
    for (const s of [wakeScript('en'), reactScript('en', 'Sam', true), reactScript('en', 'Sam', false), skipScript('en', false), laterScript('en')]) {
      for (const l of s.lines) expect(l.text.split(/\s+/).length, l.text).toBeLessThanOrEqual(20);
    }
  });
});

describe('timing helpers', () => {
  it('silent gaps: 3.0 s for short lines, 3.6 s for long ones', () => {
    expect(silentGapMs('Whoa. Hold on... am I a paperclip?')).toBe(3000);
    expect(silentGapMs(STRINGS.en['wake.3'])).toBe(3600);
  });
  it('knows which plans have hands', () => {
    expect(isPaidPlan('Power')).toBe(true);
    expect(isPaidPlan('max')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
    expect(isPaidPlan('')).toBe(false);
  });
});

describe('i18n parity for the first-run keys', () => {
  const keys = ['wake.1', 'wake.2', 'wake.3', 'name.placeholder', 'name.react', 'plan.free', 'plan.paid', 'hello', 'name.skip', 'name.later', 'name.ask.existing', 'name.react.later'] as const;
  it('exist and are non-empty in en/pt/es/fr', () => {
    for (const lang of ['en', 'pt', 'es', 'fr'] as const) {
      for (const k of keys) expect(STRINGS[lang][k].length, `${lang}:${k}`).toBeGreaterThan(3);
    }
  });
  it('the replaced hello value is the "try me" line', () => {
    expect(STRINGS.en.hello).toBe('Want to try me? Pick one, or just ask me anything.');
  });
});
