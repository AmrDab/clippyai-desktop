/** The GitHub skill uses the token saved in Settings → Apps, falling back to the older clippy.github/pat key. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  settingsToken: null as string | null,
  oldToken: null as string | null,
  auths: [] as string[],
}));
vi.mock('../src/main/api-routes', () => ({ getApiToken: async (app: string) => (app === 'github' ? h.settingsToken : null) }));
vi.mock('../src/main/skills/secrets', () => ({
  getSecret: async (service: string, account: string) => (service === 'clippy.github' && account === 'pat' ? h.oldToken : null),
}));
vi.mock('../src/main/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock('@octokit/rest', () => ({
  Octokit: class {
    constructor(o: { auth: string }) { h.auths.push(o.auth); }
    issues = { create: async () => ({ data: { number: 1, title: 't', html_url: 'u' } }) };
  },
}));

import { githubCreateIssue } from '../src/main/skills/github';

const params = { owner: 'o', repo: 'r', title: 't' };

describe('GitHub skill token', () => {
  beforeEach(() => { h.settingsToken = null; h.oldToken = null; h.auths = []; });

  it('uses the Settings-saved token first', async () => {
    h.settingsToken = 'from-settings';
    h.oldToken = 'old';
    await githubCreateIssue(params);
    expect(h.auths).toEqual(['from-settings']);
  });

  it('falls back to the older clippy.github/pat key', async () => {
    h.oldToken = 'old';
    await githubCreateIssue(params);
    expect(h.auths).toEqual(['old']);
  });

  it('reports no token when neither is saved', async () => {
    const res = await githubCreateIssue(params);
    expect(res.text).toContain('GITHUB_NO_TOKEN');
    expect(h.auths).toEqual([]);
  });
});
