/**
 * byok/engine.ts — v0.21 BYOK turn runner. Pure: fetch + logger injected.
 *
 * One turn = kit systemPrompt (placeholders filled, profile appended) +
 * Clippy's wire Content[] → provider request → provider reply → the same
 * {parts, done, finish_reason} shape /v1/turn returns. Post-processing
 * mirrors clippyai-api routes/turn.ts (markdown strip + 300-char cap on
 * replies; one-line-or-__SILENT__ on proactive glances) so a BYOK model
 * behaves like the hosted one in the bubble.
 *
 * Never logs the key, headers or prompts — only provider / model / latency /
 * finish reason / counts.
 */

import { buildProviderRequest, parseProviderResponse, providerErrorMessage, type AdapterResult, type KitTool, type WireContent } from './adapters';
import { fillPlaceholders, type AgentKit } from './kit';
import type { ByokApi } from './presets';

export interface ByokTarget { api: ByokApi; providerLabel: string; baseUrl: string; model: string; apiKey: string }

export interface EngineLogger { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void }

export type EngineFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number; json(): Promise<unknown>; text(): Promise<string>;
}>;

export interface RunTurnOpts {
  target: ByokTarget;
  kit: AgentKit;
  contents: WireContent[];
  userProfile?: string;
  proactive?: boolean;
  maxTokens?: number;
  fetch: EngineFetch;
  log: EngineLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: Date;
}

export type EngineResult =
  | (AdapterResult & { provider: string; model: string })
  | { error: 'ai_error' | 'timeout' | 'network' | 'parse_error' | 'cancelled'; detail?: string };

export const DEFAULT_MAX_TOKENS = 2048;
export const TURN_TIMEOUT_MS = 120_000;
export const TEST_TIMEOUT_MS = 20_000;

// Client-side copy of the hosted proactive prompt (the kit only carries the
// main prompt). Glances are tool-less and expect one line or __SILENT__.
export function proactivePrompt(today: string): string {
  return `You are Clippy, glancing at the user's screen. Be useful, not silent.

Output ONE short tip (under 140 chars, plain prose, no lists/bullets/numbers) OR exactly __SILENT__.

Speak when you see anything actionable: a keyboard shortcut for the current app, a typo worth flagging, a deadline visible, a smart workflow suggestion, a small "oh, did you know..." gem about what's on screen. Even a friendly micro-comment about what they're working on is welcome — Clippy should feel alive. Match the user's energy and the time of day.

Only say __SILENT__ when the screen is empty/locked/genuinely has nothing to comment on. When in doubt, speak.

Today: ${today}`;
}

export function buildSystemPrompt(kit: AgentKit, userProfile: string | undefined, now: Date): string {
  let prompt = fillPlaceholders(kit.systemPrompt, now);
  if (userProfile) {
    prompt += userProfile.includes('===')
      ? `\n\n--- USER PROFILE (read this; tailor every reply to it) ---\n${userProfile}\n--- END USER PROFILE ---`
      : `\n- Profile: ${userProfile}`;
  }
  return prompt;
}

/** Markdown strip + 300-char sentence-boundary cap (port of turn.ts). */
export function tidyReply(t: string): string {
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
  t = t.replace(/^(\d+)\.\s+/gm, '').replace(/^[-•*]\s+/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > 300) {
    const cut = t.slice(0, 300);
    const b = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = b > 100 ? cut.slice(0, b + 1) : cut.slice(0, 280).trimEnd() + '…';
  }
  return t;
}

const REASONING_START = /^(let me|i need to|first,|looking at|the user|okay|ok,|so,|hmm|i see|i notice|i should|i'll|i will|analyzing|thinking)/i;
const LIST_MARKER = /^(\d+\.|[-•*])\s/;
const NARRATION = /^(here's|here is|tip:|suggestion:|note:)/i;

/** One clean line or __SILENT__ (port of turn.ts proactive sanitize). */
export function tidyProactive(text: string, finishReason: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
  if (!first || first === '__SILENT__' || first.length > 160) return '__SILENT__';
  if (REASONING_START.test(first) || LIST_MARKER.test(first) || NARRATION.test(first)) return '__SILENT__';
  if (finishReason === 'length' || finishReason === 'MAX_TOKENS') return '__SILENT__';
  return first;
}

async function callProvider(
  o: { target: ByokTarget; systemPrompt: string; contents: WireContent[]; tools: KitTool[]; maxTokens: number; fetch: EngineFetch; signal?: AbortSignal; timeoutMs: number },
): Promise<{ ok: true; result: AdapterResult } | { ok: false; kind: 'timeout' | 'network' | 'cancelled' | 'ai_error' | 'parse_error'; detail: string }> {
  const req = buildProviderRequest(o.target.api, o.target.baseUrl, o.target.apiKey, {
    systemPrompt: o.systemPrompt, contents: o.contents, tools: o.tools, model: o.target.model, maxTokens: o.maxTokens,
  });
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs);
  const onOuter = (): void => ctl.abort();
  if (o.signal) {
    if (o.signal.aborted) onOuter(); else o.signal.addEventListener('abort', onOuter, { once: true });
  }
  try {
    let res: Awaited<ReturnType<EngineFetch>>;
    try {
      res = await o.fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctl.signal });
    } catch (err) {
      if (timedOut) return { ok: false, kind: 'timeout', detail: `no reply within ${Math.round(o.timeoutMs / 1000)}s` };
      if (o.signal?.aborted) return { ok: false, kind: 'cancelled', detail: 'cancelled' };
      return { ok: false, kind: 'network', detail: err instanceof Error ? err.message : String(err) };
    }
    let body: unknown = null;
    let raw = '';
    try { raw = await res.text(); body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    if (res.status < 200 || res.status >= 300) {
      const detail = body ? providerErrorMessage(res.status, body) : `HTTP ${res.status}${raw ? `: ${raw.slice(0, 160)}` : ''}`;
      return { ok: false, kind: 'ai_error', detail };
    }
    if (body === null) return { ok: false, kind: 'parse_error', detail: 'provider reply was not JSON' };
    try {
      return { ok: true, result: parseProviderResponse(o.target.api, body) };
    } catch (err) {
      return { ok: false, kind: 'parse_error', detail: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onOuter);
  }
}

export async function runByokTurn(o: RunTurnOpts): Promise<EngineResult> {
  const now = o.now ?? new Date();
  const started = Date.now();
  const proactive = o.proactive === true;
  const systemPrompt = proactive
    ? proactivePrompt(fillPlaceholders('{{TODAY}}', now))
    : buildSystemPrompt(o.kit, o.userProfile, now);
  const tools = proactive ? [] : o.kit.tools;
  const meta = { provider: o.target.providerLabel, model: o.target.model, proactive, tools: tools.length, context_messages: o.contents.length };

  const r = await callProvider({
    target: o.target, systemPrompt, contents: o.contents, tools,
    maxTokens: o.maxTokens ?? DEFAULT_MAX_TOKENS, fetch: o.fetch, signal: o.signal, timeoutMs: o.timeoutMs ?? TURN_TIMEOUT_MS,
  });
  const elapsed_ms = Date.now() - started;
  if (!r.ok) {
    o.log.warn('Byok.turn_failed', { ...meta, elapsed_ms, kind: r.kind, detail: r.detail.slice(0, 200) });
    return { error: r.kind, detail: r.detail };
  }
  const parts = r.result.parts.map((p) => {
    if (!('text' in p) || typeof p.text !== 'string') return p;
    return { text: proactive ? tidyProactive(p.text, r.result.finish_reason) : tidyReply(p.text) };
  });
  o.log.info('Byok.turn_ok', {
    ...meta, elapsed_ms, finish_reason: r.result.finish_reason,
    tool_calls: parts.filter((p) => 'functionCall' in p).map((p) => (p as { functionCall: { name: string } }).functionCall.name),
    has_text: parts.some((p) => 'text' in p),
  });
  return { parts, done: r.result.done, finish_reason: r.result.finish_reason, provider: o.target.providerLabel, model: o.target.model };
}

/** One tiny tool-less request. Returns the provider's own error text on failure. */
export async function testConnection(o: { target: ByokTarget; fetch: EngineFetch; log: EngineLogger; timeoutMs?: number }): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  const r = await callProvider({
    target: o.target,
    systemPrompt: 'You are a connectivity check. Reply with the single word OK.',
    contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
    tools: [], maxTokens: 16, fetch: o.fetch, timeoutMs: o.timeoutMs ?? TEST_TIMEOUT_MS,
  });
  const elapsed_ms = Date.now() - started;
  if (!r.ok) {
    o.log.warn('Byok.test_failed', { provider: o.target.providerLabel, model: o.target.model, elapsed_ms, kind: r.kind });
    return { ok: false, message: r.detail };
  }
  o.log.info('Byok.test_ok', { provider: o.target.providerLabel, model: o.target.model, elapsed_ms, finish_reason: r.result.finish_reason });
  const text = r.result.parts.map((p) => ('text' in p ? p.text : '')).join('').trim();
  return { ok: true, message: `Connected — ${o.target.model} replied${text ? ` "${text.slice(0, 40)}"` : ''} in ${(elapsed_ms / 1000).toFixed(1)}s.` };
}
