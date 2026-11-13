/**
 * screen-context.ts — pure planning for the screen context sent with each user
 * turn (active window + a short UIA/OCR dump).
 *
 * Why this exists (data-review F6): on one real machine every task paid 6-9 s
 * before a ~2 s model call. The old path (a) ran get_active_window and
 * read_screen together, raced them against 2.5 s but never cancelled the loser,
 * then (b) called get_active_window AGAIN, untimed. The PowerShell host runs one
 * request at a time, so that second call queued behind the read_screen still
 * running in the background (up to its 10 s timeout). Fix: one window call with
 * a tight deadline, the heavy dump only with what is left of a small budget and
 * a short script timeout, no duplicate call, a 3 s cache, and a circuit breaker
 * so a machine where it keeps failing is not slowed at all.
 *
 * No Electron / tool imports: brain.ts executes the plan.
 */

export type ScreenCtxOutcome = 'ok' | 'partial' | 'timeout' | 'off';

/** Active-window call: normally tens of ms in the host; this is the fail-fast cap. */
export const WINDOW_DEADLINE_MS = 1_200;
/** Extra wait for the UIA/OCR dump once the window is known. Never blocks past this. */
export const HEAVY_DEADLINE_MS = 700;
/** Hard cap on the whole capture. */
export const TOTAL_BUDGET_MS = 1_800;
/** A capture this recent is reused (quick follow-up messages, the name exchange). */
export const CTX_CACHE_MS = 3_000;
/** After this many timeouts in a row, skip the capture for a while. */
export const PAUSE_AFTER_TIMEOUTS = 3;
export const PAUSE_MS = 60_000;

export type ScreenSource = 'ocr' | 'uia' | 'window' | 'none';
export interface CtxCache { text: string; process: string; at: number; source?: ScreenSource }
export interface CtxState {
  consecutiveTimeouts: number;
  pausedUntil: number;
  cache: CtxCache | null;
}

export function newCtxState(): CtxState {
  return { consecutiveTimeouts: 0, pausedUntil: 0, cache: null };
}

export type CtxPlan =
  | { kind: 'cached'; cache: CtxCache }
  | { kind: 'skip' }
  | { kind: 'capture'; windowMs: number; heavyMs: number; totalMs?: number };

/**
 * macOS: every bridge call is a fresh process (no resident host like Windows),
 * and the first run after install is slower (Gatekeeper / TCC). The Windows
 * deadlines would time most captures out there.
 */
export const MAC_DEADLINES = { windowMs: 3_000, heavyMs: 3_000, totalMs: 5_500 } as const;

function capturePlan(platform: string): CtxPlan {
  return platform === 'darwin'
    ? { kind: 'capture', ...MAC_DEADLINES }
    : { kind: 'capture', windowMs: WINDOW_DEADLINE_MS, heavyMs: HEAVY_DEADLINE_MS };
}

/** `force` (the user asked about their screen) skips the cache and the timeout pause. */
export function planCapture(state: CtxState, now: number, force = false, platform = 'win32'): CtxPlan {
  if (force) return capturePlan(platform);
  if (state.cache && now - state.cache.at <= CTX_CACHE_MS) return { kind: 'cached', cache: state.cache };
  if (now < state.pausedUntil) return { kind: 'skip' };
  return capturePlan(platform);
}

/** Remaining time for the heavy dump given how long the window call took. */
export function heavyBudgetMs(plan: { heavyMs: number; totalMs?: number }, windowElapsedMs: number): number {
  return Math.max(0, Math.min(plan.heavyMs, (plan.totalMs ?? TOTAL_BUDGET_MS) - windowElapsedMs));
}

export function recordOutcome(state: CtxState, outcome: ScreenCtxOutcome, cache: CtxCache | null, now: number): CtxState {
  if (outcome === 'timeout') {
    const n = state.consecutiveTimeouts + 1;
    return { consecutiveTimeouts: n, pausedUntil: n >= PAUSE_AFTER_TIMEOUTS ? now + PAUSE_MS : state.pausedUntil, cache: state.cache };
  }
  if (outcome === 'off') return state;
  return { consecutiveTimeouts: 0, pausedUntil: 0, cache: cache ?? state.cache };
}

/**
 * The window tool returns JSON, "(no active window)" when nothing has focus
 * (not a failure), or an error line / sentinel when the call itself failed.
 */
export function windowCallFailed(text: string | undefined | null): boolean {
  const s = (text ?? '').trim();
  return !s || s.startsWith('<') || /^\((could not|error|get_active_window error)/i.test(s);
}

/** Process name from the window JSON ({processName} on Windows, {app} from the macOS bridge). */
export function extractProcessName(windowJson: string): string {
  try {
    const p = JSON.parse(windowJson) as { processName?: unknown; app?: unknown };
    if (typeof p.processName === 'string' && p.processName) return p.processName;
    if (typeof p.app === 'string' && p.app) return p.app;
  } catch { /* not JSON */ }
  return '';
}

export type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

/** Resolve with the value, or `{timedOut:true}` after ms. The timer is always cleared. */
export function raceDeadline<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
    p.then(
      (value) => { clearTimeout(timer); resolve({ timedOut: false, value }); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** OCR budget when the user asked about their screen (they are waiting on exactly this). */
export const SCREEN_Q_OCR_MS = 3_000;

// "screen"/"desktop" (+ pt/es/fr), "what app/page am I on", "what am I looking at", "summarize/read/look at this", "what does this ...".
const SCREEN_WORD_RE = /(?<!\p{L})(?:screen|desktop|tela|pantalla|[eé]cran)(?!\p{L})/iu; // \b is ASCII-only: it would miss 'écran'
const SCREEN_PHRASE_RE = /\b(?:(?:what|which)\s+(?:app|application|program|window|page|tab|site|website)\s+(?:am\s+i|i'?m|is\s+(?:this|that|open)|are\s+we)\b|what\s+am\s+i\s+(?:looking|viewing|reading|seeing)\b|(?:read|summari[sz]e|explain|look\s+at|translate)\s+(?:this|that|these)\b|(?:read|summari[sz]e|look\s+at)\s+the\s+(?:page|article|email|document|error|message|tab)\b|what\s+does\s+(?:this|that)\b)/i;

/** True when the user is asking about what is on their screen / the app they are in. */
export function isScreenQuestion(text: string): boolean {
  return SCREEN_WORD_RE.test(text) || SCREEN_PHRASE_RE.test(text);
}

interface DumpNode { name?: unknown; title?: unknown; value?: unknown; children?: unknown; elements?: unknown }

/**
 * Compact, model-readable form of the read_screen JSON. The raw JSON spends its
 * whole 800 chars on window handles and bounds, so the focused app's content
 * never reached the model: list the windows, then the UIA names of the focused one.
 */
export function formatScreenDump(raw: string, maxChars = 800): string {
  let d: { windows?: unknown; focusedProcessId?: unknown; uiTree?: unknown; error?: unknown; app?: unknown };
  try { d = JSON.parse(raw); } catch { return raw.slice(0, maxChars); }
  if (!d || typeof d !== 'object') return raw.slice(0, maxChars);
  if (d.error) return '';
  const wins = (Array.isArray(d.windows) ? d.windows : []) as Array<{ title?: unknown; processName?: unknown; processId?: unknown; isMinimized?: unknown; elements?: unknown }>;
  // macOS bridge a11y-tree: {app, pid, windows:[{title, elements:[{title, value, children}]}]} — one app, no uiTree.
  const macApp = typeof d.app === 'string' ? d.app : '';
  const shown = [...wins.filter((w) => !w.isMinimized), ...wins.filter((w) => w.isMinimized)]
    .filter((w) => typeof w.title === 'string' && w.title.trim())
    .slice(0, 8)
    .map((w) => `${String(w.title).trim().slice(0, 60)} (${String(w.processName ?? (macApp || '?'))})`);
  const lines: string[] = [];
  if (shown.length) lines.push(`Open windows: ${shown.join('; ')}`);

  const names: string[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [d.uiTree];
  if (macApp) for (let i = wins.length - 1; i >= 0; i--) stack.push(wins[i].elements);
  let budget = maxChars * 2; // enough to fill the cap; stops a 400-node tree being walked for nothing
  while (stack.length && budget > 0) {
    const n = stack.pop();
    if (Array.isArray(n)) { for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]); continue; }
    if (!n || typeof n !== 'object') continue;
    const { name, title, value, children } = n as DumpNode;
    // UIA nodes carry `name`; AX nodes carry `title` and (text fields, documents) `value`.
    for (const raw of [name, title, typeof value === 'string' ? value.slice(0, 300) : undefined]) {
      if (typeof raw !== 'string') continue;
      const t = raw.trim();
      if (t.length > 1 && !seen.has(t)) { seen.add(t); names.push(t); budget -= t.length + 3; }
    }
    if (children) stack.push(children);
  }
  if (names.length) {
    const fp = wins.find((w) => w.processId === d.focusedProcessId);
    lines.push(`In ${fp?.processName ? String(fp.processName) : (macApp || 'the focused app')}: ${names.join(' · ')}`);
  }
  return noBrackets(lines.join('\n')).slice(0, maxChars);
}

/** OCR text of the focused window as a single line for the model, whitespace-collapsed and capped. */
export function formatOcrContext(app: string, fullText: string, maxChars = 1500): string {
  return noBrackets(`Screen text (read from ${app || 'the focused window'}): ${fullText.replace(/\s+/g, ' ').trim()}`).slice(0, maxChars);
}

/** Screen text sits inside a [ ... ] block in the user's turn: square brackets in it must not close that block early. */
function noBrackets(s: string): string {
  return s.replace(/\[/g, '(').replace(/\]/g, ')');
}

// ── macOS (Swift bridge) helpers ─────────────────────────────────────────
// On Windows the foreground scripts take ExcludeProcessId so Clippy's own
// chat window is never "the screen". The bridge's active-window / a11y-tree
// target the frontmost app, which IS Clippy while the user types in the chat,
// so the context read "ClippyAI" with an empty title and nothing else.

export interface MacWindowLike {
  pid: number;
  app: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  layer?: number;
  alpha?: number;
  minimized?: boolean;
}

/**
 * The window the user is really looking at: the bridge's active window unless
 * that is Clippy itself, then the topmost on-screen normal window of another
 * app (the bridge lists windows front-to-back).
 */
export function pickForegroundMacWindow<T extends MacWindowLike>(active: T, windows: T[], ownPid: number): T {
  if (active.pid !== ownPid) return active;
  const other = windows.find((w) =>
    w.pid !== ownPid && (w.layer ?? 0) === 0 && !w.minimized && (w.alpha ?? 1) > 0
    && w.bounds.width >= 120 && w.bounds.height >= 80);
  return other ?? active;
}

/**
 * Text of one window from a whole-screen Vision OCR result: keep the elements
 * whose centre lies inside the window's bounds (both are top-left-origin
 * points in the same global space; matchOcrTarget relies on the same fact).
 * Reading order = bridge order. Clippy's own bubble only leaks in where it
 * overlaps the window.
 */
export function ocrTextInBounds(
  elements: Array<{ text: string; x: number; y: number; width: number; height: number }>,
  bounds: { x: number; y: number; width: number; height: number },
): string {
  const inside = elements.filter((e) => {
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    return cx >= bounds.x && cx <= bounds.x + bounds.width && cy >= bounds.y && cy <= bounds.y + bounds.height;
  });
  return inside.map((e) => e.text).join(' ').replace(/\s+/g, ' ').trim();
}
