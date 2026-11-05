import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { isValidSkillSlug, skillChildEnv, installSkill, runSkill } from '../src/main/clawhub';

describe('isValidSkillSlug', () => {
  it.each(['twitter-poster', 'ab', 'a1', 'pdf2text', '0day-notes', 'a'.repeat(64)])('accepts %s', (slug) => {
    expect(isValidSkillSlug(slug)).toBe(true);
  });
  it.each([
    '', 'a', '-leading', 'Upper', 'has space', 'dot.name', '..', '../evil', '..\\evil', 'a/b', 'a\\b',
    "x'; Remove-Item C:\\ -Recurse; '", 'x$(calc)', 'snake_case', 'a'.repeat(65), 'trailing\n', 'C:', null, 42,
  ])('rejects %j', (slug) => {
    expect(isValidSkillSlug(slug)).toBe(false);
  });

  it('installSkill throws before touching the filesystem or network', async () => {
    await expect(installSkill("../x'; calc; '")).rejects.toThrow(/Invalid skill slug/);
  });
  it('runSkill refuses a bad slug', async () => {
    await expect(runSkill('../../Windows', {})).resolves.toMatch(/INVALID_ARGS/);
  });
});

describe('skillChildEnv', () => {
  it('strips secret-looking variables and keeps the rest', () => {
    const env = skillChildEnv({
      PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', TEMP: 'C:\\t',
      OPENAI_API_KEY: 'sk-1', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'x', DB_PASSWORD: 'p',
      clippy_license_key: 'k', NPM_TOKEN: 't', client_secret: 's',
    });
    expect(env).toMatchObject({ PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', TEMP: 'C:\\t', ELECTRON_RUN_AS_NODE: '1' });
    for (const k of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'clippy_license_key', 'NPM_TOKEN', 'client_secret']) {
      expect(env).not.toHaveProperty(k);
    }
  });
});
