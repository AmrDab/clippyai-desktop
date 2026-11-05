import { describe, it, expect } from 'vitest';
import { languageSample, proactiveMessage } from '../src/main/tip-language';

const u = (text: string) => ({ role: 'user' as const, parts: [{ text }] });
const m = (text: string) => ({ role: 'model' as const, parts: [{ text }] });

describe('languageSample', () => {
  it('takes the last few user messages, newest first, skipping tiny ones', () => {
    const h = [u('salut'), m('Salut !'), u('comment je mets mon avatar en r6'), u('l'), m('Tu voulais dire quoi ?'), u('je suis dans profil')];
    expect(languageSample(h)).toBe('je suis dans profil / comment je mets mon avatar en r6 / salut');
  });

  it('caps the sample and is empty without user messages', () => {
    expect(languageSample([u('x'.repeat(500))]).length).toBe(160);
    expect(languageSample([m('hi there')])).toBe('');
  });
});

describe('proactiveMessage', () => {
  it('adds the language hint only when there is a sample', () => {
    expect(proactiveMessage('YouTube', '')).toBe('Current screen:\nYouTube');
    const msg = proactiveMessage('YouTube', 'je suis dans profil');
    expect(msg).toMatch(/^Current screen:\nYouTube\n\n/);
    expect(msg).toContain('«je suis dans profil»');
  });
});
