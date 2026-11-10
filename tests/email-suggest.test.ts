import { describe, it, expect } from 'vitest';
import { suggestEmail, inboxLink, editDistance } from '../src/main/email-suggest';

describe('suggestEmail', () => {
  it('fixes common domain typos', () => {
    expect(suggestEmail('ana@gmial.com')).toBe('ana@gmail.com');
    expect(suggestEmail('ana@gmai.com')).toBe('ana@gmail.com');
    expect(suggestEmail('ana@gmail.con')).toBe('ana@gmail.com');
    expect(suggestEmail('ana@hotmial.com')).toBe('ana@hotmail.com');
    expect(suggestEmail(' Ana.B@Gmial.com ')).toBe('Ana.B@gmail.com');
  });
  it('leaves correct, unknown and short company domains alone', () => {
    expect(suggestEmail('ana@gmail.com')).toBeNull();
    expect(suggestEmail('ana@acme.io')).toBeNull();
    expect(suggestEmail('ana@mycompany.org')).toBeNull();
    expect(suggestEmail('ana@')).toBeNull();
    expect(suggestEmail('nope')).toBeNull();
  });
});

describe('editDistance', () => {
  it('counts a swapped pair as one edit', () => {
    expect(editDistance('gmial', 'gmail')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('inboxLink', () => {
  it('maps Gmail and Outlook-family addresses, nothing else', () => {
    expect(inboxLink('a@gmail.com')?.provider).toBe('gmail');
    expect(inboxLink('a@hotmail.com')?.provider).toBe('outlook');
    expect(inboxLink('a@acme.io')).toBeNull();
  });
  it('never puts the user address in the url', () => {
    expect(inboxLink('secret.name@gmail.com')!.url).not.toContain('secret');
  });
});

import { isSafeInboxUrl } from '../src/main/email-suggest';
describe('isSafeInboxUrl', () => {
  it('allows exactly the two inbox urls', () => {
    expect(isSafeInboxUrl(inboxLink('a@gmail.com')!.url)).toBe(true);
    expect(isSafeInboxUrl('https://outlook.live.com/mail/0/')).toBe(true);
    expect(isSafeInboxUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(isSafeInboxUrl('https://evil.com/')).toBe(false);
  });
});
