import { describe, it, expect, vi } from 'vitest';
import {
  runByokTurn, testConnection, tidyReply, tidyProactive, buildSystemPrompt, proactivePrompt,
  type ByokTarget, type EngineFetch, type EngineLogger,
} from '../src/main/byok/engine';
import type { AgentKit } from '../src/main/byok/kit';

const KEY = 'sk-SUPER-SECRET-KEY-9876';
const target: ByokTarget = { api: 'openai', providerLabel: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', apiKey: KEY };
const kit: AgentKit = { version: 'v1', systemPrompt: 'You are Clippy. Today: {{TODAY}} {{TIME}} {{SEASON}}', tools: [
  { name: 'open_app', description: 'Open', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
] };

function mockLog(): EngineLogger & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, info: (m, d) => calls.push([m, d]), warn: (m, d) => calls.push([m, d]) };
}
function okFetch(body: unknown, status = 200): ReturnType<typeof vi.fn<EngineFetch>> {
  return vi.fn<EngineFetch>(async () => ({ status, json: async () => body, text: async () => JSON.stringify(body) }));
}
const contents = [{ role: 'user' as const, parts: [{ text: 'open notepad' }] }];

describe('runByokTurn', () => {
  it('sends the key only to the provider; the logger never sees it, prompts or headers', async () => {
    const fetch = okFetch({ choices: [{ finish_reason: 'tool_calls', message: { content: '**On it**', tool_calls: [{ id: 'c', type: 'function', function: { name: 'open_app', arguments: '{"name":"Notepad"}' } }] } }] });
    const log = mockLog();
    const r = await runByokTurn({ target, kit, contents, userProfile: '=== USER.md ===\nName: Amr', fetch, log, now: new Date(2026, 5, 1, 10, 0) });
    expect(r).toEqual({ parts: [{ text: 'On it' }, { functionCall: { name: 'open_app', args: { name: 'Notepad' } } }], done: false, finish_reason: 'tool_calls', provider: 'OpenAI', model: 'gpt-5.4-mini' });
    // the provider did get the key + the filled prompt + the profile
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toContain('Today: Monday, June 1, 2026 10:00 AM summer');
    expect(body.messages[0].content).toContain('--- USER PROFILE');
    expect(body.messages[0].content).not.toContain('{{');
    // the log never did
    const logged = JSON.stringify(log.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('SECRET');
    expect(logged).not.toContain('You are Clippy');
    expect(logged).not.toContain('Authorization');
    expect(log.calls[0]).toEqual(['Byok.turn_ok', expect.objectContaining({ provider: 'OpenAI', model: 'gpt-5.4-mini', finish_reason: 'tool_calls', tool_calls: ['open_app'], tools: 1, has_text: true, elapsed_ms: expect.any(Number) })]);
  });

  it('tidies long markdown replies like the hosted brain does', () => {
    expect(tidyReply('**Bold** and *it*\n1. one\n- two\n\n\n\nend')).toBe('Bold and it\none\ntwo\n\nend');
    const long = `${'Sentence one is here. '.repeat(10)}And a tail ${'x'.repeat(200)}`;
    const t = tidyReply(long);
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.endsWith('.')).toBe(true);
    expect(tidyReply('a'.repeat(400))).toBe('a'.repeat(280) + '…');
  });

  it('proactive glances: tool-less request with the proactive prompt; one line or __SILENT__', async () => {
    const fetch = okFetch({ choices: [{ finish_reason: 'stop', message: { content: 'Ctrl+S saves — handy here.\nAlso more stuff' } }] });
    const r = await runByokTurn({ target, kit, contents, proactive: true, maxTokens: 100, fetch, log: mockLog() });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.max_completion_tokens).toBe(100);
    expect(body.messages[0].content).toBe(proactivePrompt(body.messages[0].content.split('Today: ')[1]));
    expect(r).toMatchObject({ parts: [{ text: 'Ctrl+S saves — handy here.' }], done: true });
    expect(tidyProactive('Let me think about this', 'stop')).toBe('__SILENT__');
    expect(tidyProactive('- a list', 'stop')).toBe('__SILENT__');
    expect(tidyProactive('fine tip', 'length')).toBe('__SILENT__');
    expect(tidyProactive('', 'stop')).toBe('__SILENT__');
    expect(tidyProactive('x'.repeat(161), 'stop')).toBe('__SILENT__');
    expect(tidyProactive('\n\n  short tip  ', 'stop')).toBe('short tip');
  });

  it('surfaces the provider error message, never crashes', async () => {
    const log = mockLog();
    const r = await runByokTurn({ target, kit, contents, fetch: okFetch({ error: { message: 'Incorrect API key provided: sk-SUPER…' } }, 401), log });
    expect(r).toEqual({ error: 'ai_error', detail: 'HTTP 401: Incorrect API key provided: sk-SUPER…' });
    expect(JSON.stringify(log.calls)).not.toContain(KEY);
    const r2 = await runByokTurn({ target, kit, contents, fetch: vi.fn<EngineFetch>(async () => ({ status: 200, json: async () => null, text: async () => 'not json' })), log });
    expect(r2).toMatchObject({ error: 'parse_error' });
    const r3 = await runByokTurn({ target, kit, contents, fetch: vi.fn<EngineFetch>(async () => { throw new Error('ECONNREFUSED'); }), log });
    expect(r3).toEqual({ error: 'network', detail: 'ECONNREFUSED' });
  });

  it('times out and honours the outer cancel signal', async () => {
    const hang: EngineFetch = (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const t = await runByokTurn({ target, kit, contents, fetch: hang, log: mockLog(), timeoutMs: 10 });
    expect(t).toMatchObject({ error: 'timeout' });
    const ctl = new AbortController();
    const p = runByokTurn({ target, kit, contents, fetch: hang, log: mockLog(), signal: ctl.signal });
    ctl.abort();
    expect(await p).toMatchObject({ error: 'cancelled' });
  });

  it('works with the Anthropic and Gemini shapes end to end', async () => {
    const a = await runByokTurn({ target: { ...target, api: 'anthropic', providerLabel: 'Anthropic' }, kit, contents, log: mockLog(),
      fetch: okFetch({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello!' }] }) });
    expect(a).toMatchObject({ parts: [{ text: 'Hello!' }], done: true, provider: 'Anthropic' });
    const g = await runByokTurn({ target: { ...target, api: 'gemini', providerLabel: 'Google Gemini' }, kit, contents, log: mockLog(),
      fetch: okFetch({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'open_app', args: { name: 'Calc' } } }] } }] }) });
    expect(g).toMatchObject({ parts: [{ functionCall: { name: 'open_app', args: { name: 'Calc' } } }], done: false });
  });
});

describe('buildSystemPrompt', () => {
  it('appends a bundle as a labelled block and a legacy Name as an inline line', () => {
    const now = new Date(2026, 9, 8);
    expect(buildSystemPrompt(kit, undefined, now)).not.toContain('PROFILE');
    expect(buildSystemPrompt(kit, 'Name: Amr', now)).toMatch(/\n- Profile: Name: Amr$/);
    expect(buildSystemPrompt(kit, '=== USER.md ===\nx', now)).toMatch(/--- USER PROFILE[\s\S]*--- END USER PROFILE ---$/);
  });
});

describe('testConnection', () => {
  it('reports success with the model reply and failure with the provider message', async () => {
    const log = mockLog();
    const ok = await testConnection({ target, fetch: okFetch({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }), log });
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/^Connected — gpt-5.4-mini replied "OK" in \d+\.\ds\.$/);
    const bad = await testConnection({ target, fetch: okFetch({ error: { message: 'model not found' } }, 404), log });
    expect(bad).toEqual({ ok: false, message: 'HTTP 404: model not found' });
    expect(JSON.stringify(log.calls)).not.toContain(KEY);
  });
});
