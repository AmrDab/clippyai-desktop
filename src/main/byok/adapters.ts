/**
 * byok/adapters.ts — v0.21 "Your own AI model" (BYOK) wire adapters.
 *
 * Pure functions (no Electron, no network). Translate Clippy's wire shape —
 * the Content[] brain.ts already builds for /v1/turn (text / functionCall /
 * functionResponse / inlineData parts) plus the kit's systemPrompt + tools —
 * into one provider request, and the provider's reply back into the same
 * {parts, done, finish_reason} shape /v1/turn returns, so brain.ts's loop is
 * unchanged. Mirrors clippyai-api lib/deepseek.ts: tool-call ids are
 * `${name}_${turnIdx}_${callIdx}`, malformed tool-call JSON fails closed
 * (a text part, no calls), `done = !hasFunctionCall`.
 */

import type { ByokApi } from './presets';

export type WirePart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> | string } }
  | { inlineData: { mimeType: string; data: string } }
  | { _reasoning: string };

export interface WireContent { role: 'user' | 'model'; parts: WirePart[] }

export interface KitTool { name: string; description: string; parameters: Record<string, unknown> }

export interface AdapterInput {
  systemPrompt: string;
  contents: WireContent[];
  tools: KitTool[];
  model: string;
  maxTokens: number;
}

export interface ProviderRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export interface AdapterResult { parts: WirePart[]; done: boolean; finish_reason: string }

export const MALFORMED_TOOL_TEXT = "Oops — I fumbled that step. Could you ask me again?";
const SCREENSHOT_HINT = '[This is a screenshot of the desktop. Use it to identify coordinates, verify your actions, and plan the next step. You can SEE the screen now.]';

type AnyPart = Record<string, any>;
const has = (p: AnyPart, k: string): boolean => p && typeof p === 'object' && p[k] != null;

/** Fail-closed tool-call parsing (mirrors clippyai-api lib/tools.ts toFunctionCallParts). */
export function toFunctionCallParts(calls: Array<{ name: string; args: unknown }>): WirePart[] {
  const parts: WirePart[] = [];
  for (const c of calls) {
    let args: unknown = c.args;
    if (typeof args === 'string') {
      try { args = JSON.parse(args.trim() || '{}'); } catch { args = null; }
    }
    if (args === undefined) args = {};
    if (!c.name || typeof c.name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) {
      return [{ text: MALFORMED_TOOL_TEXT }];
    }
    parts.push({ functionCall: { name: c.name, args: args as Record<string, unknown> } });
  }
  return parts;
}

function responseToText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return JSON.stringify(resp ?? null);
  const { screen_after, ...rest } = resp as Record<string, unknown>;
  let s = JSON.stringify(rest);
  if (screen_after) s += `\n\n[SCREEN STATE AFTER THIS ACTION]\n${screen_after}`;
  return s;
}

function callId(name: string, turnIdx: number, callIdx: number): string {
  return `${name}_${turnIdx}_${callIdx}`;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}

// ── OpenAI-compatible chat/completions ──────────────────────────────

export function toOpenAIMessages(systemPrompt: string, contents: WireContent[]): AnyPart[] {
  const messages: AnyPart[] = [{ role: 'system', content: systemPrompt }];
  contents.forEach((turn, turnIdx) => {
    const parts = turn.parts as AnyPart[];
    if (turn.role === 'user') {
      const fnResponses = parts.filter((p) => has(p, 'functionResponse'));
      fnResponses.forEach((p, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: callId(p.functionResponse.name, turnIdx - 1, i),
          content: responseToText(p.functionResponse.response),
        });
      });
      const texts = parts.filter((p) => has(p, 'text'));
      const images = parts.filter((p) => has(p, 'inlineData'));
      if (images.length > 0) {
        const blocks: AnyPart[] = texts.map((p) => ({ type: 'text', text: p.text }));
        for (const ip of images) {
          blocks.push({ type: 'image_url', image_url: { url: `data:${ip.inlineData.mimeType};base64,${ip.inlineData.data}` } });
          blocks.push({ type: 'text', text: SCREENSHOT_HINT });
        }
        messages.push({ role: 'user', content: blocks });
      } else if (texts.length > 0) {
        messages.push({ role: 'user', content: texts.map((p) => p.text).join('\n') });
      }
    } else {
      const texts = parts.filter((p) => has(p, 'text'));
      const calls = parts.filter((p) => has(p, 'functionCall'));
      const reasoning = parts.find((p) => has(p, '_reasoning'));
      const msg: AnyPart = { role: 'assistant', content: texts.length ? texts.map((p) => p.text).join('\n') : null };
      // DeepSeek / Kimi thinking models require reasoning_content to ride
      // along with every assistant tool_calls message (API 400s otherwise).
      if (calls.length > 0) msg.reasoning_content = reasoning?._reasoning || 'Proceeding with tool call.';
      else if (reasoning) msg.reasoning_content = reasoning._reasoning;
      if (calls.length > 0) {
        msg.tool_calls = calls.map((p, i) => ({
          id: callId(p.functionCall.name, turnIdx, i),
          type: 'function',
          function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
        }));
      }
      if (msg.content !== null || calls.length > 0) messages.push(msg);
    }
  });
  return messages;
}

export function toOpenAIRequest(baseUrl: string, apiKey: string, input: AdapterInput): ProviderRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    messages: toOpenAIMessages(input.systemPrompt, input.contents),
  };
  if (input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  // gpt-5.x / o-series reject `max_tokens` (want max_completion_tokens) and
  // non-default temperature; everything else takes the classic field.
  if (/^(gpt-5|o[0-9])/i.test(input.model)) body.max_completion_tokens = input.maxTokens;
  else body.max_tokens = input.maxTokens;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url: joinUrl(baseUrl, '/chat/completions'), headers, body };
}

export function fromOpenAIResponse(json: unknown): AdapterResult {
  const choice = (json as AnyPart)?.choices?.[0];
  if (!choice || typeof choice !== 'object') throw new Error('provider reply had no choices');
  const msg: AnyPart = choice.message || {};
  const parts: WirePart[] = [];
  const text = typeof msg.content === 'string' ? msg.content
    : Array.isArray(msg.content) ? msg.content.filter((b: AnyPart) => b?.type === 'text').map((b: AnyPart) => b.text).join('') : '';
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (text) parts.push({ text });
  const rawCalls: AnyPart[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const callParts = rawCalls.length
    ? toFunctionCallParts(rawCalls.map((tc) => ({ name: tc?.function?.name, args: tc?.function?.arguments })))
    : [];
  if (reasoning && callParts.some((p) => has(p, 'functionCall'))) parts.push({ _reasoning: reasoning });
  parts.push(...callParts);
  const done = !parts.some((p) => has(p, 'functionCall'));
  return { parts, done, finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop' };
}

// ── Anthropic Messages API ──────────────────────────────────────────

export const ANTHROPIC_VERSION = '2023-06-01';

export function toAnthropicMessages(contents: WireContent[]): AnyPart[] {
  const messages: AnyPart[] = [];
  contents.forEach((turn, turnIdx) => {
    const parts = turn.parts as AnyPart[];
    const blocks: AnyPart[] = [];
    if (turn.role === 'user') {
      // tool_result blocks must lead the user message.
      parts.filter((p) => has(p, 'functionResponse')).forEach((p, i) => {
        blocks.push({ type: 'tool_result', tool_use_id: callId(p.functionResponse.name, turnIdx - 1, i), content: responseToText(p.functionResponse.response) });
      });
      for (const p of parts) {
        if (has(p, 'inlineData')) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } });
          blocks.push({ type: 'text', text: SCREENSHOT_HINT });
        } else if (has(p, 'text') && String(p.text).trim()) {
          blocks.push({ type: 'text', text: p.text });
        }
      }
      if (blocks.length) messages.push({ role: 'user', content: blocks });
    } else {
      for (const p of parts) {
        if (has(p, 'text') && String(p.text).trim()) blocks.push({ type: 'text', text: p.text });
      }
      parts.filter((p) => has(p, 'functionCall')).forEach((p, i) => {
        blocks.push({ type: 'tool_use', id: callId(p.functionCall.name, turnIdx, i), name: p.functionCall.name, input: p.functionCall.args || {} });
      });
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
    }
  });
  return messages;
}

export function toAnthropicRequest(baseUrl: string, apiKey: string, input: AdapterInput): ProviderRequest {
  const body: Record<string, unknown> = {
    model: input.model,
    system: input.systemPrompt,
    messages: toAnthropicMessages(input.contents),
    max_tokens: input.maxTokens,
  };
  if (input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return {
    url: joinUrl(baseUrl, '/messages'),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body,
  };
}

export function fromAnthropicResponse(json: unknown): AdapterResult {
  const content = (json as AnyPart)?.content;
  if (!Array.isArray(content)) throw new Error('provider reply had no content');
  const parts: WirePart[] = [];
  const text = content.filter((b: AnyPart) => b?.type === 'text' && typeof b.text === 'string').map((b: AnyPart) => b.text).join('');
  if (text) parts.push({ text });
  const uses: AnyPart[] = content.filter((b: AnyPart) => b?.type === 'tool_use');
  if (uses.length) parts.push(...toFunctionCallParts(uses.map((b) => ({ name: b.name, args: b.input }))));
  const stop = (json as AnyPart).stop_reason;
  const finish = stop === 'max_tokens' ? 'length' : 'stop';
  return { parts, done: !parts.some((p) => has(p, 'functionCall')), finish_reason: finish };
}

// ── Google Gemini generateContent ───────────────────────────────────

// Gemini's OpenAPI-subset schema rejects most JSON-schema vocabulary.
const GEMINI_SCHEMA_DROP = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'additionalProperties', 'default', 'examples',
  'title', 'pattern', 'minLength', 'maxLength', 'const', 'oneOf', 'allOf', 'anyOf', 'not',
  'patternProperties', 'dependencies', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'uniqueItems', 'additionalItems', 'contentEncoding', 'contentMediaType', 'readOnly', 'writeOnly',
]);

export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (GEMINI_SCHEMA_DROP.has(k)) continue;
    if (k === 'type') {
      // Gemini wants a single lowercase type; ["string","null"] → string + nullable.
      const types = (Array.isArray(v) ? v : [v]).filter((t) => typeof t === 'string').map((t) => String(t).toLowerCase());
      if (types.includes('null') && types.length > 1) out.nullable = true;
      const t = types.find((x) => x !== 'null');
      if (t) out.type = t;
    } else if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
        const s = sanitizeGeminiSchema(pv);
        if (s) props[pk] = s;
      }
      out.properties = props;
    } else if (k === 'items') {
      const s = sanitizeGeminiSchema(v);
      if (s) out.items = s;
    } else if (k === 'enum') {
      if (Array.isArray(v)) out.enum = v.map((e) => String(e));
    } else {
      out[k] = v;
    }
  }
  if (out.type === 'object') {
    const props = (out.properties ?? {}) as Record<string, unknown>;
    if (Object.keys(props).length === 0) return undefined; // Gemini rejects empty OBJECT schemas
    if (Array.isArray(out.required)) {
      const req = out.required.filter((r) => typeof r === 'string' && r in props);
      if (req.length) out.required = req; else delete out.required;
    }
  }
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };
  return out;
}

export function toGeminiContents(contents: WireContent[]): AnyPart[] {
  const out: AnyPart[] = [];
  for (const turn of contents) {
    const parts: AnyPart[] = [];
    for (const p of turn.parts as AnyPart[]) {
      if (has(p, 'text') && String(p.text).trim()) parts.push({ text: p.text });
      else if (has(p, 'functionCall')) parts.push({ functionCall: { name: p.functionCall.name, args: p.functionCall.args || {} } });
      else if (has(p, 'functionResponse')) {
        const r = p.functionResponse.response;
        parts.push({ functionResponse: { name: p.functionResponse.name, response: r && typeof r === 'object' ? r : { result: String(r ?? '') } } });
      } else if (has(p, 'inlineData')) {
        parts.push({ inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } });
        parts.push({ text: SCREENSHOT_HINT });
      }
    }
    if (parts.length) out.push({ role: turn.role, parts });
  }
  return out;
}

export function toGeminiRequest(baseUrl: string, apiKey: string, input: AdapterInput): ProviderRequest {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: input.systemPrompt }] },
    contents: toGeminiContents(input.contents),
    generationConfig: { maxOutputTokens: input.maxTokens },
  };
  if (input.tools.length > 0) {
    body.tools = [{
      functionDeclarations: input.tools.map((t) => {
        const parameters = sanitizeGeminiSchema(t.parameters);
        return parameters ? { name: t.name, description: t.description, parameters } : { name: t.name, description: t.description };
      }),
    }];
  }
  return {
    url: joinUrl(baseUrl, `/models/${encodeURIComponent(input.model)}:generateContent`),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body,
  };
}

export function fromGeminiResponse(json: unknown): AdapterResult {
  const cand = (json as AnyPart)?.candidates?.[0];
  if (!cand || typeof cand !== 'object') {
    const block = (json as AnyPart)?.promptFeedback?.blockReason;
    throw new Error(block ? `Gemini blocked the prompt (${block})` : 'provider reply had no candidates');
  }
  const raw: AnyPart[] = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
  const parts: WirePart[] = [];
  const text = raw.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (text) parts.push({ text });
  const calls = raw.filter((p) => has(p, 'functionCall'));
  if (calls.length) parts.push(...toFunctionCallParts(calls.map((p) => ({ name: p.functionCall.name, args: p.functionCall.args ?? {} }))));
  const finish = typeof cand.finishReason === 'string' ? cand.finishReason : 'STOP';
  return { parts, done: !parts.some((p) => has(p, 'functionCall')), finish_reason: finish };
}

// ── Dispatch ────────────────────────────────────────────────────────

export function buildProviderRequest(api: ByokApi, baseUrl: string, apiKey: string, input: AdapterInput): ProviderRequest {
  if (api === 'anthropic') return toAnthropicRequest(baseUrl, apiKey, input);
  if (api === 'gemini') return toGeminiRequest(baseUrl, apiKey, input);
  return toOpenAIRequest(baseUrl, apiKey, input);
}

export function parseProviderResponse(api: ByokApi, json: unknown): AdapterResult {
  if (api === 'anthropic') return fromAnthropicResponse(json);
  if (api === 'gemini') return fromGeminiResponse(json);
  return fromOpenAIResponse(json);
}

/** Best-effort human-readable error from a provider's non-2xx JSON body. */
export function providerErrorMessage(status: number, body: unknown): string {
  const b = body as AnyPart;
  const msg = b?.error?.message || b?.message || b?.error?.error || (typeof b?.error === 'string' ? b.error : '') || (typeof b?.detail === 'string' ? b.detail : '');
  return msg ? `HTTP ${status}: ${String(msg).slice(0, 200)}` : `HTTP ${status}`;
}
