import { describe, it, expect } from 'vitest';
import {
  toOpenAIRequest, fromOpenAIResponse, toAnthropicRequest, fromAnthropicResponse,
  toGeminiRequest, fromGeminiResponse, sanitizeGeminiSchema, buildProviderRequest, parseProviderResponse,
  providerErrorMessage, MALFORMED_TOOL_TEXT, ANTHROPIC_VERSION, type WireContent, type KitTool,
} from '../src/main/byok/adapters';

const tools: KitTool[] = [
  { name: 'read_screen', description: 'Read the screen', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'open_app', description: 'Open an app', parameters: { type: 'object', properties: { name: { type: 'string', description: 'App name' } }, required: ['name'] } },
];

const PNG = 'iVBORw0KGgo=';

// user → model(call) → user(result) → model(2 calls) → user(2 results + screenshot)
const convo: WireContent[] = [
  { role: 'user', parts: [{ text: 'open notepad' }] },
  { role: 'model', parts: [{ text: 'On it.' }, { functionCall: { name: 'open_app', args: { name: 'Notepad' } } }] },
  { role: 'user', parts: [{ functionResponse: { name: 'open_app', response: { result: 'ok', screen_after: 'Notepad window' } } }] },
  { role: 'model', parts: [{ _reasoning: 'think' }, { functionCall: { name: 'read_screen', args: {} } }, { functionCall: { name: 'open_app', args: { name: 'Calc' } } }] },
  { role: 'user', parts: [
    { functionResponse: { name: 'read_screen', response: { text: 'hello' } } },
    { functionResponse: { name: 'open_app', response: 'opened' } },
    { inlineData: { mimeType: 'image/png', data: PNG } },
    { text: 'here is the screen' },
  ] },
];

const input = { systemPrompt: 'SYS', contents: convo, tools, model: 'm', maxTokens: 512 };

describe('OpenAI-compatible adapter', () => {
  it('translates the wire shape to chat/completions (tools, tool_calls, tool results, images)', () => {
    const req = toOpenAIRequest('http://localhost:11434/v1/', 'sk-test', input);
    expect(req.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(req.headers.Authorization).toBe('Bearer sk-test');
    const b = req.body as any;
    expect(b.model).toBe('m');
    expect(b.max_tokens).toBe(512);
    expect(b.tools).toEqual([
      { type: 'function', function: { name: 'read_screen', description: 'Read the screen', parameters: tools[0].parameters } },
      { type: 'function', function: { name: 'open_app', description: 'Open an app', parameters: tools[1].parameters } },
    ]);
    const m = b.messages;
    expect(m[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(m[1]).toEqual({ role: 'user', content: 'open notepad' });
    expect(m[2].role).toBe('assistant');
    expect(m[2].content).toBe('On it.');
    expect(m[2].tool_calls).toEqual([{ id: 'open_app_1_0', type: 'function', function: { name: 'open_app', arguments: '{"name":"Notepad"}' } }]);
    expect(m[2].reasoning_content).toBe('Proceeding with tool call.');
    // tool result id matches the call id; screen_after is appended as text
    expect(m[3].role).toBe('tool');
    expect(m[3].tool_call_id).toBe('open_app_1_0');
    expect(m[3].content).toBe('{"result":"ok"}\n\n[SCREEN STATE AFTER THIS ACTION]\nNotepad window');
    // multi-call assistant turn round-trips its reasoning
    expect(m[4].reasoning_content).toBe('think');
    expect(m[4].tool_calls.map((t: any) => t.id)).toEqual(['read_screen_3_0', 'open_app_3_1']);
    // two tool results, then the multimodal user message
    expect(m[5]).toMatchObject({ role: 'tool', tool_call_id: 'read_screen_3_0', content: '{"text":"hello"}' });
    expect(m[6]).toMatchObject({ role: 'tool', tool_call_id: 'open_app_3_1', content: 'opened' });
    expect(m[7].role).toBe('user');
    expect(m[7].content[0]).toEqual({ type: 'text', text: 'here is the screen' });
    expect(m[7].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } });
    expect(m).toHaveLength(8);
  });

  it('uses max_completion_tokens for gpt-5 / o-series and no Authorization without a key', () => {
    const req = toOpenAIRequest('https://api.openai.com/v1', '', { ...input, model: 'gpt-5.4-mini' });
    expect((req.body as any).max_completion_tokens).toBe(512);
    expect((req.body as any).max_tokens).toBeUndefined();
    expect(req.headers.Authorization).toBeUndefined();
    expect((req.body as any).temperature).toBeUndefined();
  });

  it('omits tools when the kit has none', () => {
    const b = toOpenAIRequest('https://x/v1', 'k', { ...input, tools: [] }).body as any;
    expect(b.tools).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
  });

  it('parses text, tool calls and finish_reason back into wire parts', () => {
    const r = fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: 'ok', reasoning_content: 'r', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'open_app', arguments: '{"name":"Notepad"}' } },
      { id: 'b', type: 'function', function: { name: 'read_screen', arguments: '' } },
    ] } }] });
    expect(r.parts).toEqual([{ text: 'ok' }, { _reasoning: 'r' }, { functionCall: { name: 'open_app', args: { name: 'Notepad' } } }, { functionCall: { name: 'read_screen', args: {} } }]);
    expect(r.done).toBe(false);
    expect(r.finish_reason).toBe('tool_calls');
  });

  it('text-only reply is done; no tools returned is fine', () => {
    const r = fromOpenAIResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Hi!' } }] });
    expect(r).toEqual({ parts: [{ text: 'Hi!' }], done: true, finish_reason: 'stop' });
  });

  it('fails closed on malformed tool-call JSON (text part, no calls, no crash)', () => {
    const r = fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'r', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'open_app', arguments: '{"name": Notepad' } },
    ] } }] });
    expect(r.parts).toEqual([{ text: MALFORMED_TOOL_TEXT }]);
    expect(r.done).toBe(true);
  });

  it('throws a readable error when the reply has no choices', () => {
    expect(() => fromOpenAIResponse({ error: 'x' })).toThrow(/no choices/);
  });
});

describe('Anthropic adapter', () => {
  it('builds a Messages request with system, input_schema tools, tool_use/tool_result and base64 images', () => {
    const req = toAnthropicRequest('https://api.anthropic.com/v1', 'sk-ant', input);
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant');
    expect(req.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    const b = req.body as any;
    expect(b.system).toBe('SYS');
    expect(b.max_tokens).toBe(512);
    expect(b.tools[1]).toEqual({ name: 'open_app', description: 'Open an app', input_schema: tools[1].parameters });
    const m = b.messages;
    expect(m[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'open notepad' }] });
    expect(m[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'open_app_1_0', name: 'open_app', input: { name: 'Notepad' } }] });
    expect(m[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'open_app_1_0' });
    expect(m[3].content.map((c: any) => c.id)).toEqual(['read_screen_3_0', 'open_app_3_1']);
    // tool_result blocks lead; then the image + text
    expect(m[4].content.map((c: any) => c.type)).toEqual(['tool_result', 'tool_result', 'image', 'text', 'text']);
    expect(m[4].content[2]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(m[4].content.some((c: any) => c.type === 'text' && c.text === '')).toBe(false);
  });

  it('parses text + multiple tool_use blocks; max_tokens → length', () => {
    const r = fromAnthropicResponse({ stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Sure' }, { type: 'tool_use', id: 'x', name: 'open_app', input: { name: 'Calc' } }, { type: 'tool_use', id: 'y', name: 'read_screen', input: {} },
    ] });
    expect(r.parts).toEqual([{ text: 'Sure' }, { functionCall: { name: 'open_app', args: { name: 'Calc' } } }, { functionCall: { name: 'read_screen', args: {} } }]);
    expect(r.done).toBe(false);
    expect(fromAnthropicResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'long' }] }).finish_reason).toBe('length');
  });

  it('fails closed on a non-object tool_use input', () => {
    const r = fromAnthropicResponse({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'open_app', input: 'nope' }] });
    expect(r.parts).toEqual([{ text: MALFORMED_TOOL_TEXT }]);
    expect(r.done).toBe(true);
  });
});

describe('Gemini adapter', () => {
  it('sanitizes JSON-schema keywords Gemini rejects', () => {
    const s = sanitizeGeminiSchema({
      $schema: 'x', type: 'object', additionalProperties: false, title: 'T',
      properties: {
        a: { type: ['string', 'null'], pattern: '^a', minLength: 1, default: 'z' },
        b: { type: 'ARRAY', items: { type: 'integer', minimum: 0 } },
        c: { type: 'object', properties: {}, anyOf: [] },
        d: { type: 'string', enum: ['x', 1] },
        e: { type: 'array' },
      },
      required: ['a', 'c', 'zzz'],
    })!;
    expect(s).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true },
        b: { type: 'array', items: { type: 'integer', minimum: 0 } },
        d: { type: 'string', enum: ['x', '1'] },
        e: { type: 'array', items: { type: 'string' } },
      },
      required: ['a'],
    });
    // empty OBJECT → dropped entirely (Gemini rejects it)
    expect(sanitizeGeminiSchema({ type: 'object', properties: {} })).toBeUndefined();
  });

  it('builds generateContent with functionDeclarations, systemInstruction and native parts', () => {
    const req = toGeminiRequest('https://generativelanguage.googleapis.com/v1beta', 'g-key', { ...input, model: 'gemini-2.5-flash' });
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(req.headers['x-goog-api-key']).toBe('g-key');
    const b = req.body as any;
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(b.generationConfig).toEqual({ maxOutputTokens: 512 });
    const decl = b.tools[0].functionDeclarations;
    expect(decl[0]).toEqual({ name: 'read_screen', description: 'Read the screen' }); // empty object schema dropped
    expect(decl[1].parameters).toEqual({ type: 'object', properties: { name: { type: 'string', description: 'App name' } }, required: ['name'] });
    const c = b.contents;
    expect(c[1].parts).toEqual([{ text: 'On it.' }, { functionCall: { name: 'open_app', args: { name: 'Notepad' } } }]);
    expect(c[3].parts.some((p: any) => p._reasoning)).toBe(false);
    // string functionResponse is wrapped into an object; inlineData passes through
    expect(c[4].parts[1]).toEqual({ functionResponse: { name: 'open_app', response: { result: 'opened' } } });
    expect(c[4].parts[2]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } });
  });

  it('parses candidates (text + functionCall) and MAX_TOKENS', () => {
    const r = fromGeminiResponse({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [
      { text: 'Opening' }, { functionCall: { name: 'open_app', args: { name: 'Calc' } } }, { functionCall: { name: 'read_screen' } },
    ] } }] });
    expect(r.parts).toEqual([{ text: 'Opening' }, { functionCall: { name: 'open_app', args: { name: 'Calc' } } }, { functionCall: { name: 'read_screen', args: {} } }]);
    expect(r.done).toBe(false);
    expect(fromGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'x' }] } }] }).finish_reason).toBe('MAX_TOKENS');
    expect(fromGeminiResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'open_app', args: 'bad' } }] } }] }).parts).toEqual([{ text: MALFORMED_TOOL_TEXT }]);
    expect(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(/SAFETY/);
  });
});

describe('dispatch + errors', () => {
  it('routes by api', () => {
    expect(buildProviderRequest('anthropic', 'https://a/v1', 'k', input).url).toBe('https://a/v1/messages');
    expect(buildProviderRequest('gemini', 'https://g', 'k', input).url).toContain(':generateContent');
    expect(buildProviderRequest('openai', 'https://o/v1', 'k', input).url).toBe('https://o/v1/chat/completions');
    expect(parseProviderResponse('openai', { choices: [{ message: { content: 'a' } }] }).parts).toEqual([{ text: 'a' }]);
  });
  it('extracts provider error messages', () => {
    expect(providerErrorMessage(401, { error: { message: 'Incorrect API key provided' } })).toBe('HTTP 401: Incorrect API key provided');
    expect(providerErrorMessage(404, { error: 'model "x" not found' })).toBe('HTTP 404: model "x" not found');
    expect(providerErrorMessage(500, null)).toBe('HTTP 500');
  });
});
