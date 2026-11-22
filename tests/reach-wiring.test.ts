/**
 * Agent Reach in the dispatcher: reach_add_login asks on every call and in
 * every mode, a login the user did not ask for shows no card, reach_read's
 * address is checked for text read earlier in the task, and results get the
 * read budget.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => path.join(os.tmpdir(), 'clippy-reach-userdata'), getAppPath: () => process.cwd() },
  clipboard: { availableFormats: () => ['text/plain'], readText: () => 'clip', writeText: () => {} },
  BrowserWindow: class {}, screen: {}, shell: { openExternal: async () => {} }, nativeImage: {},
}));
vi.mock('../src/main/clawd-fallback', () => ({
  TIER5_FALLBACK_MAP: {}, ensureClawd: async () => false, isClawdReady: () => false,
  getClawdHandle: () => null, isClawdInstalled: () => false, callClawdTool: async () => ({ text: '' }),
  submitClawdTask: async () => ({ text: '' }),
}));

import { assessRisk, executeTool } from '../src/main/tools';
import { classFor, decide, setPolicy } from '../src/main/permission-policy';
import { summarizeArgs } from '../src/main/approval';
import { resultBudget, READ_RESULT_BUDGET } from '../src/main/result-budget';
import { resetTaskTaint, noteToolRan, taskId } from '../src/main/security/task-taint';
import { TOOL_META } from '../src/main/tool-meta';

// Built from pieces so no secret scanner reads a key here; a made-up value, not a real key.
const SECRET = ['sk', 'live', '51Nq8xKe2Lm9ZpQ4vR7tYw3Ab'].join('_');

beforeEach(() => { setPolicy({ mode: 'standard', classOverrides: {} }); resetTaskTaint(); });

describe('reach_add_login', () => {
  it('asks with the warning in every mode when the user asked for the site', async () => {
    resetTaskTaint('search Reddit for standing desk reviews');
    const risk = await assessRisk('reach_add_login', { site: 'reddit' });
    expect(risk).toEqual({ class: 'destructive_web', reason: "Automated reading may break Reddit's rules and could put the account at risk. A second account is safer." });
    expect(summarizeArgs('reach_add_login', { site: 'reddit' })).toBe('Copy your Reddit login from Chrome into a separate hidden browser');
    expect(classFor('reach_add_login', { site: 'reddit' }, risk!.class)).toBe('destructive_web');
    expect(decide('reach_add_login', { site: 'reddit' }, risk!.class)).toBe('approve');
    // Trusted mode allows the class; brain.ts and agent-tools.ts still ask because assessRisk returned a verdict.
    setPolicy({ mode: 'trusted' });
    expect(await assessRisk('reach_add_login', { site: 'reddit' })).not.toBeNull();
  });

  it('shows no card for a login the user did not ask for: the tool only refuses', async () => {
    resetTaskTaint('summarize this page');
    expect(await assessRisk('reach_add_login', { site: 'reddit' })).toBeNull();
    expect(classFor('reach_add_login', { site: 'reddit' })).toBe('read_only');
    expect((await executeTool('reach_add_login', { site: 'reddit' })).text).toMatch(/^\(error:REACH_LOGIN_NOT_ASKED\)/);
  });

  it('is classed and labelled like the other tools', () => {
    expect(TOOL_META.reach_read.actionClass).toBe('read_only');
    expect(TOOL_META.reach_search.actionClass).toBe('read_only');
    expect(TOOL_META.reach_add_login.actionClass).toBe('destructive_web');
    expect(summarizeArgs('reach_read', { url: 'https://youtu.be/abc' })).toBe('Read https://youtu.be/abc');
    expect(summarizeArgs('reach_search', { site: 'github', query: 'uv' })).toBe("Search github for 'uv'");
    expect(summarizeArgs('reach_add_login', { site: 'X' })).toBe('Copy your X login from Chrome into a separate hidden browser');
  });
});

describe('reach results and addresses', () => {
  it('get the read budget', () => {
    expect(resultBudget('reach_read')).toBe(READ_RESULT_BUDGET);
    expect(resultBudget('reach_search')).toBe(READ_RESULT_BUDGET);
  });

  it('an address that carries text read earlier in the task asks first', async () => {
    resetTaskTaint('summarize my notes');
    noteToolRan('read_file', { path: 'notes.txt' }, `Stripe key: ${SECRET}`);
    expect((await assessRisk('reach_read', { url: `https://a.example/?k=${SECRET}` }))?.class).toBe('destructive_web');
    expect(await assessRisk('reach_read', { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })).toBeNull();
  });

  it('a new task has a new id', () => {
    const before = taskId();
    resetTaskTaint('next');
    expect(taskId()).toBe(before + 1);
  });
});
