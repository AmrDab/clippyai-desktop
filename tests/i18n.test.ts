import { describe, it, expect } from 'vitest';
import { STRINGS, pickLang, t, isLang } from '../src/main/i18n';
import { accountErrorText, clearsCodeInput, needsNewCode, resendHoldSeconds } from '../src/main/account-copy';

describe('pickLang', () => {
  it('takes the first preferred language we have', () => {
    expect(pickLang(['pt-BR', 'en-US'])).toBe('pt');
    expect(pickLang(['de-DE', 'fr-FR', 'es'])).toBe('fr');
    expect(pickLang(['es-419'])).toBe('es');
  });
  it('falls back to English', () => {
    expect(pickLang([])).toBe('en');
    expect(pickLang(['de-DE', 'ja'])).toBe('en');
    expect(pickLang([''])).toBe('en');
  });
  it('isLang guards the URL param', () => {
    expect(isLang('pt')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe('t', () => {
  it('looks up and fills placeholders', () => {
    expect(t('pt', 'upgraded', { plan: 'Power' })).toBe('Agora você está no Power!');
    expect(t('en', 'code.resend.wait', { s: 12 })).toBe('Send a new code (12s)');
  });
  it('keeps an unfilled placeholder visible', () => {
    expect(t('en', 'upgraded')).toBe("You're on {plan} now!");
  });
  it('falls back to English when a language lacks an entry', () => {
    const table = STRINGS as unknown as Record<string, Record<string, string>>;
    const saved = table.fr;
    const { hello: _removed, ...rest } = saved;
    void _removed;
    table.fr = rest;
    try {
      expect(t('fr', 'hello')).toBe(STRINGS.en.hello);
    } finally {
      table.fr = saved;
    }
  });
  it('every language has every key and the same placeholders as English', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    for (const lang of ['pt', 'es', 'fr'] as const) {
      expect(Object.keys(STRINGS[lang]).sort()).toEqual(Object.keys(STRINGS.en).sort());
      for (const k of Object.keys(STRINGS.en) as (keyof typeof STRINGS.en)[]) {
        expect(ph(STRINGS[lang][k]), `${lang}:${k}`).toBe(ph(STRINGS.en[k]));
      }
    }
  });
  it('the setup heading says email is needed and Clippy is free, in every language', () => {
    expect(t('en', 'setup.title')).toBe("Let's get you set up");
    expect(t('en', 'setup.sub')).toContain('Clippy is free, no card');
    expect(t('pt', 'setup.sub')).toContain('grátis, sem cartão');
    expect(t('es', 'setup.sub')).toContain('gratis, sin tarjeta');
    expect(t('fr', 'setup.sub')).toContain('gratuit, sans carte');
  });
  it('the code email is localized', () => {
    expect(t('pt', 'mail.subject', { code: '123456' })).toBe('123456 é o seu código do ClippyAI');
    expect(t('en', 'mail.subject', { code: '123456' })).toBe('123456 is your ClippyAI code');
  });
});

describe('accountErrorText', () => {
  it('wrong code shows tries left, the last try asks for a new code', () => {
    expect(accountErrorText('en', { error: 'wrong_code', triesLeft: 4 })).toBe("That code isn't right. Tries left: 4.");
    expect(accountErrorText('en', { error: 'wrong_code', triesLeft: 0 })).toContain('Send a new code');
    expect(accountErrorText('en', { error: 'code_expired' })).toContain('expired');
  });
  it('rate limit uses retry_after: minutes up to 90, else try tomorrow, generic wait without it', () => {
    expect(accountErrorText('en', { error: 'rate_limited', retryAfter: 45 })).toBe('Too many tries. Wait 1 min and try again.');
    expect(accountErrorText('en', { error: 'rate_limited', retryAfter: 600 })).toContain('10 min');
    expect(accountErrorText('en', { error: 'rate_limited', retryAfter: 5400 })).toContain('90 min');
    expect(accountErrorText('en', { error: 'rate_limited', retryAfter: 5401 })).toBe('Too many tries today. Try again tomorrow.');
    expect(accountErrorText('fr', { error: 'rate_limited' })).toContain('1 min');
  });
  it('offline and server copy', () => {
    expect(accountErrorText('es', { error: 'offline' })).toContain('conexión');
    expect(accountErrorText('en', { error: 'server' })).toContain('our side');
  });
  it('which errors clear the typed digits and which need a new code', () => {
    expect(clearsCodeInput({ error: 'wrong_code', triesLeft: 3 })).toBe(true);
    expect(clearsCodeInput({ error: 'code_expired' })).toBe(true);
    expect(clearsCodeInput({ error: 'offline' })).toBe(false);
    expect(clearsCodeInput({ error: 'server' })).toBe(false);
    expect(clearsCodeInput({ error: 'rate_limited' })).toBe(false);
    expect(needsNewCode({ error: 'wrong_code', triesLeft: 0 })).toBe(true);
    expect(needsNewCode({ error: 'wrong_code', triesLeft: 2 })).toBe(false);
    expect(needsNewCode({ error: 'code_expired' })).toBe(true);
  });
  it('resend hold: server retry_after wins, 30 s otherwise', () => {
    expect(resendHoldSeconds({ error: 'rate_limited', retryAfter: 75 })).toBe(75);
    expect(resendHoldSeconds()).toBe(30);
  });
});
