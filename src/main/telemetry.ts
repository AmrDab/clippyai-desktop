/**
 * telemetry.ts — anonymous crash + usage reports (Azure Application Insights).
 *
 * Containment + privacy contract (owner requirement: Clippy stays private):
 *  - Anonymous: a random install id (UUID) is the only identifier. Never the
 *    license key, email, names, hostnames, paths, window titles, screen
 *    content, prompts, replies, tool args/results, clipboard or URLs.
 *  - Every string that leaves goes through scrubText() (logger.scrubPII +
 *    path / email / key / URL / IP / token stripping, length caps).
 *  - Off when: Settings toggle off, CLIPPY_TELEMETRY=0, or a dev build
 *    (app.isPackaged false) unless CLIPPY_TELEMETRY=1. Turning it off clears
 *    the queue immediately.
 *  - Batched in memory, flushed every 60 s and on quit (2 s budget). A failed
 *    POST is dropped — no retries. Hard cap: DAILY_CAP events/day/install, so
 *    a crash loop cannot flood the 0.5 GB/day ingestion cap.
 *  - No processes. One small file on disk: userData/telemetry.json
 *    ({installId, optOut, day counter, last crash-dump scan time}).
 *  - Never throws: every public function swallows its own errors.
 */
import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { scrubPII } from './logger';
import { TOOL_META } from './tool-meta';
import { TELEMETRY_CONNECTION_STRING } from './telemetry-config';
import type { TaskOutcome } from './task-outcome';

type PropValue = string | number | boolean | null | undefined;
export type Props = Record<string, PropValue>;

export const FLUSH_INTERVAL_MS = 60_000;
export const QUIT_FLUSH_TIMEOUT_MS = 2_000;
export const DAILY_CAP = 500;
const MAX_QUEUE = 200;
const MAX_STACK_CHARS = 2_000;
const MAX_STACK_LINES = 15;
const MAX_MESSAGE_CHARS = 300;
const MAX_PROP_CHARS = 120;
const MAX_SAME_EXCEPTION_PER_SESSION = 3;

// ── Connection string ───────────────────────────────────────────────

function parseConnectionString(cs: string): { iKey: string; endpoint: string } {
  const parts: Record<string, string> = {};
  for (const kv of cs.split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
  }
  let endpoint = parts.ingestionendpoint || 'https://dc.services.visualstudio.com/';
  if (!endpoint.endsWith('/')) endpoint += '/';
  return { iKey: parts.instrumentationkey || '', endpoint };
}

const { iKey: IKEY, endpoint: ENDPOINT } = parseConnectionString(TELEMETRY_CONNECTION_STRING);
export const TRACK_URL = `${ENDPOINT}v2.1/track`;

// ── Scrubbing ───────────────────────────────────────────────────────

// Allowed URL hosts keep scheme://host (no path / query); anything else → <url>.
const SAFE_HOST_RE = /(^|\.)(clippyai\.app|github\.com|githubusercontent\.com|applicationinsights\.azure\.com)$|^(localhost|127\.0\.0\.1)$/i;
const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/[^\s'"<>()\]]+/gi;
// Windows drive / UNC / "~\" (home already scrubbed to ~) paths, and absolute
// POSIX paths. Spaces are allowed inside every segment except the last, so
// "C:\My Stuff\tax.xlsx" is removed whole but trailing message words survive.
const WIN_SEG = `[^\\\\/\\s'"<>|*?:()]+`;
const WIN_PATH_RE = new RegExp(`(?:\\b[A-Za-z]:|\\\\\\\\|~(?=[\\\\/]))[\\\\/](?:${WIN_SEG}(?: ${WIN_SEG})*[\\\\/])*(?:${WIN_SEG})?`, 'g');
const POSIX_PATH_RE = /(?<![\w.:/<>~-])\/(?:[\w.@+%-]+(?: [\w.@+%-]+)*\/)*[\w.@+%-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEY_RE = /\bCLIP(?:PY)?-[A-Z0-9*-]+/gi;
const IPV4_RE = /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g;
const TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Keep the app-relative tail of a bundled path (useful in stacks), drop the rest. */
function replacePath(p: string): string {
  const norm = p.replace(/\\/g, '/');
  const asar = norm.search(/app\.asar(?:\.unpacked)?\//i);
  if (asar >= 0) return `<app>/${norm.slice(asar).replace(/^app\.asar(?:\.unpacked)?\//i, '')}`;
  const nm = norm.lastIndexOf('node_modules/');
  if (nm >= 0) return `<app>/${norm.slice(nm)}`;
  // Built-in node internals ("node:internal/...") never match; a stack frame
  // from the dev out/ folder keeps only its out/ tail.
  const out = norm.search(/\/out\/(main|preload|renderer)\//);
  if (out >= 0) return `<app>${norm.slice(out)}`;
  return '<path>';
}

/**
 * Remove anything identifying from free text (error messages, stacks).
 * logger.scrubPII first (home dir, username, email, license + API keys),
 * then hostname, URLs, paths, emails, keys, IPs and long tokens.
 */
export function scrubText(input: unknown, maxLen = MAX_MESSAGE_CHARS): string {
  let s = typeof input === 'string' ? input : String(input ?? '');
  try { s = scrubPII(s); } catch { /* fall through to our own patterns */ }
  try {
    const host = os.hostname();
    if (host && host.length >= 3) s = s.split(host).join('<host>');
  } catch { /* ignore */ }
  s = s.replace(URL_RE, (m, scheme: string) => {
    if (/^file$/i.test(scheme)) return replacePath(decodeURIComponentSafe(m.replace(/^file:\/\/\/?/i, '/')));
    try {
      const u = new URL(m);
      return SAFE_HOST_RE.test(u.hostname) ? `${u.protocol}//${u.hostname}` : '<url>';
    } catch { return '<url>'; }
  });
  // A quoted path ('C:\a\my file.txt') goes whole, spaces in the file name included.
  s = s.replace(/'[^'\n]*[\\/][^'\n]*'|"[^"\n]*[\\/][^"\n]*"/g, (m) => {
    const inner = m.slice(1, -1);
    return inner.includes('://') || inner.startsWith('<') ? m : `'${replacePath(inner)}'`;
  });
  s = s.replace(WIN_PATH_RE, replacePath);
  s = s.replace(POSIX_PATH_RE, replacePath);
  s = s.replace(EMAIL_RE, '<email>');
  s = s.replace(KEY_RE, 'CLIPPY-****');
  s = s.replace(IPV4_RE, '<ip>');
  s = s.replace(TOKEN_RE, '<token>');
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function scrubStack(stack: unknown): string {
  // Frames only: the first line repeats the free-text message ("TypeError: …").
  const frames = String(stack ?? '').split('\n').filter((l) => /^\s*at\s/.test(l)).slice(0, MAX_STACK_LINES);
  return scrubText(frames.join('\n'), MAX_STACK_CHARS);
}

/**
 * An exception message reduced to its shape. Pattern scrubbing can't catch
 * every piece of user content an error may quote (a file name, a snippet of a
 * reply), so quoted text and long numbers are dropped outright; error codes
 * and the wording around them survive.
 */
export function messageShape(message: unknown): string {
  return scrubText(message)
    .replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g, '<str>')
    .replace(/\d{3,}/g, '<n>')
    .slice(0, 120);
}

/** Free-text error → a code only (ENOTFOUND, ERR_…, HTTP 404), else 'other'. */
export function errorCode(text: unknown): string {
  const s = String(text ?? '');
  const m = s.match(/\b(E[A-Z]{3,}|ERR_[A-Z0-9_]+)\b/) || s.match(/\b(?:HTTP|status)\s*(\d{3})\b/i);
  if (!m) return 'other';
  return /^\d+$/.test(m[1]) ? `HTTP ${m[1]}` : m[1];
}

/** Tool name only — known built-ins by name, skills/MCP/anything else bucketed. */
export function toolBucket(name: unknown): string {
  const n = String(name ?? '');
  if (Object.prototype.hasOwnProperty.call(TOOL_META, n)) return n;
  if (n.startsWith('skill__')) return 'skill';
  return 'other';
}

/** Short enum-ish token: lowercase identifier chars only. */
function enumish(v: unknown, max = 40): string {
  const s = String(v ?? '').toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, max);
  return s || 'unknown';
}

export function elapsedBucket(ms: number): string {
  if (ms < 5_000) return '<5s';
  if (ms < 15_000) return '5-15s';
  if (ms < 30_000) return '15-30s';
  if (ms < 60_000) return '30-60s';
  if (ms < 120_000) return '1-2m';
  if (ms < 300_000) return '2-5m';
  return '>5m';
}

// ── Persistent state (one small file) ───────────────────────────────

interface State { installId: string; optOut: boolean; day: string; count: number; lastDumpScan: number }
let state: State | null = null;

function statePath(): string {
  return path.join(app.getPath('userData'), 'telemetry.json');
}

function today(): string { return new Date().toISOString().slice(0, 10); }

function loadState(): State {
  if (state) return state;
  let s: Partial<State> = {};
  try { s = JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { /* first run / corrupt */ }
  state = {
    installId: typeof s.installId === 'string' && /^[0-9a-f-]{36}$/i.test(s.installId) ? s.installId : '',
    optOut: s.optOut === true,
    day: typeof s.day === 'string' ? s.day : today(),
    count: typeof s.count === 'number' ? s.count : 0,
    lastDumpScan: typeof s.lastDumpScan === 'number' ? s.lastDumpScan : 0,
  };
  return state;
}

function saveState(): void {
  if (!state) return;
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch { /* best-effort */ }
}

function installId(): string {
  const s = loadState();
  if (!s.installId) { s.installId = randomUUID(); saveState(); }
  return s.installId;
}

// ── Enable / disable ────────────────────────────────────────────────

/** The Settings preference (default ON). */
export function isTelemetryEnabled(): boolean {
  try { return !loadState().optOut; } catch { return true; }
}

/** Whether events are actually collected right now. */
export function isActive(): boolean {
  try {
    const env = process.env.CLIPPY_TELEMETRY;
    if (env === '0') return false;
    if (!app.isPackaged && env !== '1') return false;
    if (!IKEY) return false;
    return !loadState().optOut;
  } catch { return false; }
}

/** Settings toggle. Applies immediately; turning off drops anything queued. */
export function setTelemetryEnabled(enabled: boolean): void {
  try {
    const s = loadState();
    s.optOut = !enabled;
    saveState();
    if (!enabled) queue = [];
  } catch { /* never throw */ }
}

// ── Queue + envelopes ───────────────────────────────────────────────

interface Envelope {
  name: string;
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: { baseType: string; baseData: Record<string, unknown> };
}

let queue: Envelope[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
const sessionId = randomUUID();
let getPlanFn: (() => string) | null = null;
const exceptionCounts = new Map<string, number>();

function planBucket(): string {
  try {
    const p = String(getPlanFn?.() ?? '').toLowerCase();
    return p === 'free' || p === 'power' || p === 'max' ? p : 'unknown';
  } catch { return 'unknown'; }
}

function localeLang(): string {
  try { return enumish((app.getLocale() || '').split(/[-_]/)[0], 8); } catch { return 'unknown'; }
}

function splitProps(props: Props | undefined): { properties: Record<string, string>; measurements: Record<string, number> } {
  const properties: Record<string, string> = {
    plan: planBucket(),
    arch: enumish(process.arch, 12),
    locale: localeLang(),
  };
  const measurements: Record<string, number> = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue;
    const key = enumish(k, 40);
    if (typeof v === 'number') { if (Number.isFinite(v)) measurements[key] = v; continue; }
    properties[key] = scrubText(String(v), MAX_PROP_CHARS);
  }
  return { properties, measurements };
}

function envelope(baseType: 'EventData' | 'ExceptionData' | 'MetricData', type: 'Event' | 'Exception' | 'Metric', baseData: Record<string, unknown>): Envelope {
  let osVersion = '';
  try { osVersion = enumish(os.release(), 40); } catch { /* ignore */ }
  let ver = '';
  try { ver = app.getVersion(); } catch { /* ignore */ }
  return {
    name: `Microsoft.ApplicationInsights.${type}`,
    time: new Date().toISOString(),
    iKey: IKEY,
    tags: {
      'ai.cloud.role': 'clippy-desktop',
      'ai.application.ver': ver,
      'ai.device.os': process.platform,
      'ai.device.osVersion': `${process.platform} ${osVersion}`,
      'ai.user.id': installId(),
      'ai.session.id': sessionId,
      'ai.internal.sdkVersion': 'clippy-fetch:1',
    },
    data: { baseType, baseData: { ver: 2, ...baseData } },
  };
}

/** Daily cap check + count. Returns false when today's budget is spent. */
function takeBudget(): boolean {
  const s = loadState();
  const d = today();
  if (s.day !== d) { s.day = d; s.count = 0; }
  if (s.count >= DAILY_CAP) return false;
  s.count++;
  return true;
}

function enqueue(make: () => Envelope): void {
  if (!isActive()) return;
  if (queue.length >= MAX_QUEUE) return;
  if (!takeBudget()) return;
  queue.push(make());
  ensureTimer();
}

function ensureTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

// ── Public API ──────────────────────────────────────────────────────

/** Custom event. Props: strings are scrubbed + capped, numbers become measurements. */
export function track(name: string, props?: Props): void {
  try {
    enqueue(() => {
      const { properties, measurements } = splitProps(props);
      return envelope('EventData', 'Event', { name: enumish(name, 60), properties, measurements });
    });
  } catch { /* never throw */ }
}

export function trackMetric(name: string, value: number, props?: Props): void {
  try {
    if (!Number.isFinite(value)) return;
    enqueue(() => {
      const { properties } = splitProps(props);
      return envelope('MetricData', 'Metric', { metrics: [{ name: enumish(name, 60), value, count: 1 }], properties });
    });
  } catch { /* never throw */ }
}

/** Exception: type + scrubbed message + scrubbed, capped stack. Same error ≤3×/session. */
export function trackException(err: unknown, props?: Props): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'non-error rejection');
    const typeName = String(e.name || 'Error').replace(/[^\w.]/g, '').slice(0, 60) || 'Error';
    const message = messageShape(e.message);
    const sig = `${typeName}:${message.slice(0, 80)}`;
    const seen = exceptionCounts.get(sig) || 0;
    if (seen >= MAX_SAME_EXCEPTION_PER_SESSION) return;
    exceptionCounts.set(sig, seen + 1);
    enqueue(() => {
      const { properties, measurements } = splitProps(props);
      return envelope('ExceptionData', 'Exception', {
        exceptions: [{ typeName, message, hasFullStack: !!e.stack, stack: scrubStack(e.stack || '') }],
        severityLevel: 3,
        properties,
        measurements,
      });
    });
  } catch { /* never throw */ }
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json?: () => Promise<unknown> }>;

/**
 * Send everything queued in one POST. Drops the batch on any failure — no
 * retries. Resolves to the HTTP status (0 on network failure / nothing sent).
 */
export async function flush(timeoutMs = 10_000): Promise<number> {
  try {
    if (!isActive()) { queue = []; return 0; }
    if (queue.length === 0) return 0;
    const batch = queue;
    queue = [];
    saveState(); // persist the day counter (at most once per flush)
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await (globalThis.fetch as unknown as FetchFn)(TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        signal: ctrl.signal,
      });
      return res.status;
    } finally { clearTimeout(t); }
  } catch { return 0; }
}

/** Quit path: best-effort flush capped at QUIT_FLUSH_TIMEOUT_MS. */
export function flushOnQuit(): Promise<number> {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  return flush(QUIT_FLUSH_TIMEOUT_MS);
}

let quitHandled = false;
let noQuitHold = false;

/**
 * app 'before-quit': record app_quit and, once, hold the quit for at most
 * QUIT_FLUSH_TIMEOUT_MS while the queue is sent, then quit again. Never
 * holds when nothing is queued, telemetry is off, or an update install owns
 * the quit (see flushBeforeInstall).
 */
export function onBeforeQuit(e: { preventDefault: () => void }, quit: () => void): void {
  try {
    if (quitHandled) return;
    quitHandled = true;
    track('app_quit');
    if (noQuitHold || !isActive() || queue.length === 0) return;
    e.preventDefault();
    void flushOnQuit().finally(() => { try { quit(); } catch { /* ignore */ } });
  } catch { /* never block a quit */ }
}

/** Update install path: send now (the installer quits a few seconds later) and never hold that quit. */
export function flushBeforeInstall(): void {
  noQuitHold = true;
  void flush(QUIT_FLUSH_TIMEOUT_MS);
}

/**
 * Boot: remember how to read the plan (no license key ever reaches here),
 * then report crash dumps written since the last scan (count only — dumps
 * are never uploaded).
 */
export function initTelemetry(opts: { getPlan: () => string }): void {
  try {
    getPlanFn = opts.getPlan;
    if (!isActive()) return;
    // First batch goes out after 10 s instead of 60 s, so a launch that
    // crashes natively soon after still reports app_start / crash counts.
    const early = setTimeout(() => { void flush(); }, 10_000);
    if (typeof early.unref === 'function') early.unref();
    const s = loadState();
    const since = s.lastDumpScan;
    s.lastDumpScan = Date.now();
    saveState();
    if (!since) return; // first run: don't report historical dumps
    const n = countDumpsSince(app.getPath('crashDumps'), since);
    if (n > 0) track('crash_dumps_found', { count: n });
  } catch { /* never throw */ }
}

export function countDumpsSince(dir: string, sinceMs: number, depth = 0): number {
  if (depth > 3) return 0;
  let n = 0;
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { n += countDumpsSince(p, sinceMs, depth + 1); continue; }
    if (!/\.dmp$/i.test(ent.name)) continue;
    try { if (fs.statSync(p).mtimeMs > sinceMs) n++; } catch { /* skip */ }
  }
  return n;
}

// ── Turn health (brain enforces one in-flight task, so one accumulator) ──

interface TaskStats { start: number; errorKind: string; toolFails: Map<string, number>; unsupported: number }
let task: TaskStats | null = null;

export function taskBegin(): void {
  task = { start: Date.now(), errorKind: '', toolFails: new Map(), unsupported: 0 };
}

/** A turn failed (resp.error: timeout / network / ai_error / limit_reached / …). */
export function taskTurnError(kind: string): void {
  if (task) task.errorKind = enumish(kind, 32);
}

/** A tool returned an error-shaped result or threw. Only the tool NAME is kept. */
export function taskToolFailed(tool: string, text?: string): void {
  if (!task) return;
  const b = toolBucket(tool);
  task.toolFails.set(b, (task.toolFails.get(b) || 0) + 1);
  if (typeof text === 'string' && text.includes('PLATFORM_UNSUPPORTED')) task.unsupported++;
}

const CANCEL_REASONS = new Set(['user_stop', 'user_override', 'sleep', 'exception_cancelled']);

/** End of a task: one task_end event with outcome ok / error / cancelled. */
export function taskEnd(result: TaskOutcome, abortReason: string | null, steps: number): void {
  try {
    if (!task) return;
    const t = task;
    task = null;
    let outcome: 'ok' | 'error' | 'cancelled' = 'ok';
    let errorKind = t.errorKind;
    if (errorKind) outcome = 'error';
    else if (abortReason && CANCEL_REASONS.has(abortReason)) outcome = 'cancelled';
    else if (result === 'failed' || result === 'stuck' || result === 'step_limit') { outcome = 'error'; errorKind = enumish(abortReason || result, 32); }
    const fails = [...t.toolFails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    track('task_end', {
      outcome,
      result,
      error_kind: errorKind || undefined,
      elapsed: elapsedBucket(Date.now() - t.start),
      steps,
      tool_failures: fails.length ? fails.map(([n, c]) => `${n}:${c}`).join(',') : undefined,
      tool_failure_count: fails.reduce((a, [, c]) => a + c, 0),
      platform_unsupported: t.unsupported,
    });
  } catch { /* never throw */ }
}

// ── Small helpers for hook sites ─────────────────────────────────────

/** Renderer / overlay / any webContents died. Only the page's file name is kept. */
export function trackRendererGone(wc: { getURL: () => string }, details: { reason?: string; exitCode?: number }): void {
  if (details?.reason === 'clean-exit') return;
  let url = '';
  try { url = wc.getURL(); } catch { /* destroyed */ }
  const page = /([a-z-]+)\.html/i.exec(url)?.[1]?.toLowerCase() || 'other';
  track('renderer_gone', { page, reason: enumish(details?.reason), exit_code: Number(details?.exitCode) });
}

const seenAgentClients = new Set<string>();
/** Agent connected — client NAME only (no version, nothing user-typed). */
export function trackAgentClients(clients: string[]): void {
  for (const c of clients || []) {
    const name = String(c).replace(/\s+v?\d[\w.-]*$/, '').replace(/[^\w .-]/g, '').trim().slice(0, 40) || 'unknown';
    if (seenAgentClients.has(name)) continue;
    seenAgentClients.add(name);
    track('agent_connected', { client: name });
  }
}

/** Test-only: reset module state. */
export function __resetForTests(): void {
  state = null;
  queue = [];
  task = null;
  exceptionCounts.clear();
  seenAgentClients.clear();
  quitHandled = false;
  noQuitHold = false;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}

/** Test-only: inspect the queue. */
export function __queueForTests(): Envelope[] { return queue; }
