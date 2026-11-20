/**
 * 0.24.12 audit #10 / #34: provider keys never reach the log, content tools
 * log only a length, and an odd account name cannot crash startup.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { scrubPII, redactArgs, resultForLog, isContentResultTool, buildIdentityPatterns } from '../src/main/logger';

// Built at run time so no key-shaped literal sits in the repo.
const j = (...parts: string[]) => parts.join('');
const body = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const KEYS: Array<[string, string]> = [
  ['Stripe live secret', j('sk', '_live_', body)],
  ['Stripe test secret', j('sk', '_test_', body)],
  ['Stripe restricted', j('rk', '_live_', body)],
  ['Stripe publishable', j('pk', '_live_', body)],
  ['Stripe key fragment', j('sk', '_live_', '51Abc')],
  ['Stripe webhook secret', j('whsec', '_', body)],
  ['GitHub PAT', j('ghp', '_', body, 'abcdefgh')],
  ['GitHub OAuth', j('gho', '_', body, 'abcdefgh')],
  ['GitHub server', j('ghs', '_', body, 'abcdefgh')],
  ['GitHub fine-grained PAT', j('github', '_pat_', '11ABCDEFG0', body)],
  ['AWS access key id', j('AKIA', 'IOSFODNN7EXAMPLE')],
  ['Slack bot token', j('xoxb', '-123456789012-', body)],
  ['Slack user token', j('xoxp', '-123456789012-', body)],
  ['Groq key', j('gsk', '_', body)],
  ['Anthropic key', j('sk', '-ant-api03-', body)],
  ['JWT', j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')],
];

describe('scrubPII: provider keys', () => {
  it.each(KEYS)('%s is redacted', (_name, key) => {
    for (const line of [key, `Tool.result {"output":"notes: ${key} end"}`, `key=${key}`, `"${key}"`]) {
      const out = scrubPII(line);
      expect(out).not.toContain(key);
      expect(out).not.toContain(key.slice(-12));
      expect(out).toMatch(/redacted/);
    }
  });

  it('HTTP Basic credentials are redacted', () => {
    const cred = Buffer.from('alice:s3cret-pass').toString('base64');
    const out = scrubPII(`Authorization: Basic ${cred}`);
    expect(out).toBe('Authorization: Basic [redacted]');
  });

  it.each([
    'Clippy clicked Send in Outlook',
    'Basic information about the task',
    'Basic troubleshooting steps',
    'the skill_list has pk_columns and sk values',
    'risk_level=low task_live=true',
    'opened github_pat documentation page',
    'eyJ is how a JWT starts',
    'step 3 of 5: xoxo',
    'AKIA is the prefix of an AWS key id',
    'Tool.result {"step":2,"tool":"open_app","elapsed_ms":412}',
  ])('ordinary text is left alone: %s', (line) => {
    expect(scrubPII(line)).toBe(line);
  });
});

describe('buildIdentityPatterns (audit #34)', () => {
  const scrub = (text: string, home: string, user: string) =>
    buildIdentityPatterns(home, user).reduce((t, [re, to]) => t.replace(re, to), text);

  it.each(['J. (Work)', 'a+b', 'name[1]', 'x*y?', 'back\\slash', 'dollar$', '{curly}', 'pipe|name', '^caret'])(
    'an account name with regex characters does not throw: %s', (user) => {
      const home = `C:\\Users\\${user}`;
      expect(() => buildIdentityPatterns(home, user)).not.toThrow();
      expect(scrub(`opened ${home}\\Documents\\a.txt`, home, user)).toBe('opened ~\\Documents\\a.txt');
    });

  it('the home path is replaced in all three written forms', () => {
    const home = 'C:\\Users\\Jordan (Work)';
    expect(scrub('C:\\Users\\Jordan (Work)\\x', home, 'Jordan (Work)')).toBe('~\\x');
    expect(scrub('C:/Users/Jordan (Work)/x', home, 'Jordan (Work)')).toBe('~/x');
    expect(scrub(JSON.stringify({ p: 'C:\\Users\\Jordan (Work)\\x' }), home, 'Jordan (Work)')).toBe('{"p":"~\\\\x"}');
  });

  it('a distinctive username is replaced on its own', () => {
    expect(scrub('window owner jordanlee here', 'C:\\Users\\jordanlee', 'jordanlee')).toBe('window owner <user> here');
  });

  it.each(['me', 'bob', 'al', 'user', 'User', 'admin', 'Administrator', 'owner', 'guest'])(
    'a short or generic username is not replaced as a bare word: %s', (user) => {
      const line = `the ${user} asked: read ${user} guide, ${user}name stays`;
      expect(scrub(line, `C:\\Users\\${user}`, user)).toBe(line);
      // ...but the home path still is.
      expect(scrub(`C:\\Users\\${user}\\Desktop`, `C:\\Users\\${user}`, user)).toBe('~\\Desktop');
    });
});

describe('redactArgs: value / javascript / command / text are free text', () => {
  it('logs only their length', () => {
    const secret = j('sk', '_live_', body);
    const javascript = `fetch("https://a.example/?k=${secret}")`;
    const command = `curl -H "X: ${secret}" https://a.example`;
    const out = redactArgs({ value: secret, javascript, command, text: secret });
    expect(out).toEqual({
      value: { len: secret.length },
      javascript: { len: javascript.length },
      command: { len: command.length },
      text: { len: secret.length },
    });
    expect(JSON.stringify(out)).not.toContain(body);
  });
  it('other args are logged as before', () => {
    expect(redactArgs({ path: 'C:\\x\\a.txt', target: 'Save', key: 'ctrl+s', x: 10 })).toEqual({ path: 'C:\\x\\a.txt', target: 'Save', key: 'ctrl+s', x: 10 });
  });
});

describe('resultForLog: content tools log only a length', () => {
  const secret = `notes ${j('sk', '_live_', body)} more`;
  it.each([
    'read_screen', 'smart_read', 'ocr_read_screen', 'ocr_from_image', 'excel_read', 'cdp_page_context', 'shell_exec',
    'http_request', 'read_file', 'read_clipboard', 'get_selection', 'outlook_read_inbox', 'cdp_read_text', 'browser_read_text',
  ])('%s', (tool) => {
    expect(isContentResultTool(tool)).toBe(true);
    expect(resultForLog(tool, secret)).toBe(`{len:${secret.length}}`);
  });
  it('an error keeps its code, not its text', () => {
    const err = '(error:NOT_FOUND) File not found: C:\\Users\\me\\secret-plan.txt';
    expect(resultForLog('read_file', err)).toBe(`(error:NOT_FOUND) {len:${err.length}}`);
  });
  it.each(['open_app', 'smart_click', 'focus_window', 'type_text', 'key_press', 'navigate_browser', 'write_file', 'list_files'])(
    'action tools keep their short result: %s', (tool) => {
      expect(isContentResultTool(tool)).toBe(false);
      expect(resultForLog(tool, 'Focused "Untitled - Notepad"')).toBe('Focused "Untitled - Notepad"');
      expect(resultForLog(tool, 'x'.repeat(500)).length).toBe(300);
      expect(resultForLog(tool, 'x'.repeat(500), 200).length).toBe(200);
    });
});
