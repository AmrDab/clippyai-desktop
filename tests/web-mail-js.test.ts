/**
 * 0.24.12 audit #9: webmail recipes pass every value as a JS string literal
 * and write the body as text, so a mail field cannot run script in the tab.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { gmailComposeUrl, navigateJs, fillBodyJs, jsString } from '../src/main/skills/web-mail-js';

/** Run generated source the way CDP evaluate would, against fakes. */
function runNavigate(js: string): { href: string; pwned: boolean } {
  const location = { href: '' };
  const state = { pwned: false };
  new Function('location', 'pwn', js)(location, () => { state.pwned = true; });
  return { href: location.href, pwned: state.pwned };
}

interface FakeNode { tag?: string; text?: string }
function runFill(body: string): { nodes: FakeNode[]; pwned: boolean } {
  const nodes: FakeNode[] = [];
  const state = { pwned: false };
  const el = {
    set textContent(_v: string) { nodes.length = 0; },
    set innerHTML(_v: string) { throw new Error('innerHTML assigned'); },
    appendChild(n: FakeNode) { nodes.push(n); },
  };
  const document = { createElement: (tag: string) => ({ tag }), createTextNode: (text: string) => ({ text }) };
  new Function('el', 'document', 'pwn', fillBodyJs('el', body))(el, document, () => { state.pwned = true; });
  return { nodes, pwned: state.pwned };
}

describe('gmail compose navigation', () => {
  it("an apostrophe in a field no longer breaks the script (it's a normal mail)", () => {
    const f = { to: "o'brien@example.com", subject: "It's done", body: "Don't worry.\nIt's fine." };
    const { href, pwned } = runNavigate(navigateJs(gmailComposeUrl(f)));
    const u = new URL(href);
    expect(u.origin).toBe('https://mail.google.com');
    expect(u.searchParams.get('to')).toBe(f.to);
    expect(u.searchParams.get('su')).toBe(f.subject);
    expect(u.searchParams.get('body')).toBe(f.body);
    expect(pwned).toBe(false);
  });

  it.each([
    "x'; pwn(); '",
    "x'+pwn()+'",
    "');pwn();//",
    '";pwn();//',
    '\\\';pwn();//',
    '</script><script>pwn()</script>',
    'a pwn() b',
    '${pwn()}',
    '`+pwn()+`',
  ])('a crafted value stays data: %j', (evil) => {
    for (const f of [
      { to: evil, subject: 's', body: 'b' },
      { to: 'a@b.example', subject: evil, body: 'b' },
      { to: 'a@b.example', subject: 's', body: evil },
      { to: 'a@b.example', subject: 's', body: 'b', cc: evil },
    ]) {
      const { href, pwned } = runNavigate(navigateJs(gmailComposeUrl(f)));
      expect(pwned).toBe(false);
      const u = new URL(href);
      expect(u.origin).toBe('https://mail.google.com');
      expect(u.searchParams.get('to')).toBe(f.to);
      expect(u.searchParams.get('body')).toBe(f.body);
    }
  });

  it('jsString escapes the line separators', () => {
    expect(jsString('a b')).toBe('"a\\u2028b"');
    expect(jsString("it's")).toBe('"it\'s"');
  });
});

describe('body fill', () => {
  it('writes each line as a text node with <br> between lines', () => {
    const { nodes } = runFill('Hi Sam,\nSecond line\r\nThird');
    expect(nodes).toEqual([{ text: 'Hi Sam,' }, { tag: 'br' }, { text: 'Second line' }, { tag: 'br' }, { text: 'Third' }]);
  });
  it.each([
    '<img src=x onerror=pwn()>',
    '<script>pwn()</script>',
    '"); pwn(); ("',
    "'); pwn(); ('",
    '<a href="javascript:pwn()">x</a>',
  ])('markup or quotes in the body stay text: %j', (evil) => {
    const { nodes, pwned } = runFill(`before ${evil} after`);
    expect(pwned).toBe(false);
    expect(nodes).toEqual([{ text: `before ${evil} after` }]);
    expect(nodes.every((n) => n.tag === undefined || n.tag === 'br')).toBe(true);
  });
});

describe('the recipes use the helpers', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'skills', f), 'utf8');
  it('gmail-web-send.ts builds no quoted URL and assigns no body innerHTML', () => {
    const src = read('gmail-web-send.ts');
    expect(src).toContain('navigateJs(gmailComposeUrl(');
    expect(src).not.toMatch(/location\.href = '/);
    expect(src).not.toMatch(/innerHTML\s*=/);
  });
  it('outlook-web-send.ts assigns no body innerHTML', () => {
    const src = read('outlook-web-send.ts');
    expect(src).toContain("fillBodyJs('el', body)");
    expect(src).not.toMatch(/innerHTML\s*=/);
  });
});
