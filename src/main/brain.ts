/**
 * Brain — ClippyAI's agent loop on the client side.
 *
 * Calls the unified /v1/turn backend endpoint which runs Kimi K2 (Moonshot)
 * with native function calling. No JSON-in-text. No regex parsing of model
 * output. Tool calls come back as structured `functionCall` parts; we
 * execute them locally via tools.ts and feed results back as
 * `functionResponse` parts.
 *
 * The server owns the system prompt (identity, date, plan, tool schema).
 * The client owns the conversation loop and local tool execution.
 *
 * v0.11.27 — single LLM provider. The Gemini fallback was removed in
 * favor of Kimi-only operation per Option A (operator decision,
 * 2026-05-07). If the upstream Moonshot API is unavailable, /v1/turn
 * returns a 502 ai_error and the user sees an error message — no
 * silent failover. See git tag `legacy-kimi-k2-v0.11.26` for the
 * prior Kimi+Gemini-fallback shape if rollback is ever needed.
 */

import { BrowserWindow, net, app } from 'electron';
import { executeTool, abortAllInFlightTools } from './tools';
import { TOOL_META } from './tool-meta';
import { getLicenseKey } from './license';
import { getGuidePrompt } from './guides';
import { formatWorkflowHint, recordWorkflow, isEnabled as memoryEnabled } from './memory';
import Store from 'electron-store';
import { createLogger, serializeErr, setCurrentTaskId } from './logger';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

const log = createLogger('Brain');
const API_BASE = 'https://api.clippyai.app';
const TURN_ENDPOINT = `${API_BASE}/v1/turn`;

/**
 * Tools that change layout/focus and warrant a follow-up read_screen so
 * the model sees what actually happened. Restricted in v0.11.23 from the
 * old 13-tool set — type_text / smart_type / key_press / mouse_scroll /
 * write_clipboard rarely change layout in ways the model needs verified
 * before its next decision, and the post-tool read_screen costs ~300-600ms
 * each (UIA call). Removing them saves 2-3 seconds end-to-end on a
 * 12-step task with mixed clicks + typing. The model can still call
 * read_screen voluntarily when it wants to verify.
 */
const UI_MODIFYING_TOOLS = new Set([
  'open_app',
  'focus_window',
  'smart_click',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_drag',
  'navigate_browser',
]);

/**
 * v0.11.25 — destructive / non-undoable tools. After any of these fires,
 * we (a) record success/failure in `destructiveAttempts` for the
 * hallucination guard, and (b) the final task summary is post-checked
 * against the actual results. Per report ccd4d6f4 the model claimed
 * "Email sent!" without any tool actually confirming the send went
 * through — outlook_send_email had errored, smart_click("Send") returned
 * "(not found via UIA; OCR unavailable)", and a Ctrl+Enter keypress went
 * to the wrong window after focus drift. The model invented success.
 *
 * Hallucination guard: if the model's final spoken text contains
 * confident-success language ("sent", "posted", "submitted", "created",
 * "deleted", etc.) AND the most recent destructive attempt FAILED or
 * was unverified, we override the spoken text with an honest version.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'outlook_send_email',
  'outlook_create_event',
  'create_reminder',
  'write_file',
  'kill_process',
  'cdp_click',     // could be a "Send" or "Delete" button
  'cdp_evaluate',  // arbitrary JS execution
  'http_request',  // POST/DELETE etc.
]);

/**
 * Heuristic: does this string sound like the model claiming a destructive
 * action succeeded? Conservative — we only trip on confident past-tense
 * verbs. Future-tense ("I'll send", "let me send") is fine.
 */
function soundsLikeClaimedSuccess(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // Anchored on " sent" / " posted" etc. with leading space to avoid
  // false positives like "presented", "submitted to git" (not "submitted").
  return /\b(sent|posted|submitted|created|deleted|saved|published|emailed|booked|scheduled)\b/.test(t)
    && !/\b(will|going to|let me|trying|attempting|about to|i'll|i’ll|would)\b.*\b(send|post|submit|create|delete|save|publish|email|book|schedule)\b/.test(t);
}

/**
 * Tier-aware tool selection (Pipeline v0 PR 5).
 *
 * The brain ships `tool_tiers` to /v1/turn so the server can prepend
 * `[T<tier>]` to each function declaration's description and append the
 * "prefer the lowest-tier tool that fits the task" line to the system
 * prompt. The system prompt and tool schema are owned by the API; this
 * client just provides the metadata. See src/main/tool-meta.ts for the
 * source-of-truth registry.
 *
 * If the API does not yet consume `tool_tiers`, the field is ignored and
 * behavior is unchanged — safe to deploy ahead of the orchestrator wiring.
 */
function buildToolTiers(): Record<string, { tier: number; cost: string }> {
  const out: Record<string, { tier: number; cost: string }> = {};
  for (const [name, meta] of Object.entries(TOOL_META)) {
    out[name] = { tier: meta.tier, cost: meta.cost };
  }
  return out;
}

// ========== Wire content shape used by /v1/turn (Kimi K2 backend) ==========

type TextPart = { text: string };
type FunctionCallPart = { functionCall: { name: string; args: Record<string, unknown> } };
type FunctionResponsePart = {
  functionResponse: { name: string; response: Record<string, unknown> };
};
type InlineDataPart = { inlineData: { mimeType: string; data: string } };
type Part = TextPart | FunctionCallPart | FunctionResponsePart | InlineDataPart;

type Content = {
  role: 'user' | 'model';
  parts: Part[];
};

type TurnSuccess = {
  parts: Part[];
  done: boolean;
  finish_reason: string;
  tokens_used: number;
  tokens_remaining: number;
  /** v0.11.27 — typed to remove the `as any` cast in the log line.
   * Server always sets this to "kimi" (Kimi-only post-v0.11.27). */
  provider?: string;
};

type TurnError = { error: string; detail?: string; message?: string };
type TurnResponse = TurnSuccess | TurnError;

function isError(r: TurnResponse): r is TurnError {
  return 'error' in r;
}

function isFunctionCall(p: Part): p is FunctionCallPart {
  return 'functionCall' in p && !!p.functionCall;
}

function isText(p: Part): p is TextPart {
  return 'text' in p && !!p.text;
}

/**
 * Map a tool name to the right "in-progress" animation. Played BEFORE the
 * tool fires so the sprite shows what Clippy is doing during the wait.
 * Without this, the sprite freezes on a single Thinking pose for the entire
 * tool duration (up to 30s for Office COM ops), which feels broken.
 */
function animationForTool(tool: string): string {
  // Email & calendar
  if (tool === 'outlook_send_email' || tool.endsWith('_send_email')) return 'SendMail';
  if (tool === 'outlook_create_event' || tool === 'create_reminder') return 'Writing';
  if (tool === 'outlook_read_inbox' || tool === 'outlook_upcoming') return 'Searching';
  // Writing / typing
  if (tool === 'write_file' || tool === 'excel_write' || tool === 'word_to_pdf') return 'Writing';
  if (tool === 'type_text' || tool === 'smart_type' || tool === 'cdp_type' || tool === 'write_clipboard') return 'Writing';
  // Searching / reading
  if (tool === 'read_file' || tool === 'read_screen' || tool === 'cdp_read_text' || tool === 'cdp_page_context') return 'Searching';
  if (tool === 'search_files_content' || tool === 'list_files' || tool === 'cdp_list_tabs') return 'Searching';
  if (tool === 'desktop_screenshot' || tool === 'ocr_read_screen') return 'CheckingSomething';
  // Browser / web
  if (tool === 'navigate_browser' || tool === 'cdp_connect' || tool === 'cdp_click' || tool === 'cdp_switch_tab') return 'CheckingSomething';
  if (tool === 'cdp_evaluate' || tool === 'cdp_wait_for_selector' || tool === 'detect_webview_apps') return 'GetTechy';
  // System / power-tool
  if (tool === 'system_info' || tool === 'list_processes' || tool === 'kill_process') return 'GetTechy';
  if (tool === 'run_powershell' || tool === 'http_request' || tool === 'ping_host') return 'GetTechy';
  // Drawing / mouse / spatial
  if (tool === 'mouse_drag') return 'GetArtsy';
  if (tool === 'mouse_click' || tool === 'mouse_double_click' || tool === 'mouse_right_click') return 'GestureDown';
  // Window management
  if (tool === 'minimize_all_windows' || tool === 'show_desktop' || tool === 'minimize_window') return 'GestureDown';
  if (tool === 'open_app' || tool === 'focus_window' || tool === 'get_windows' || tool === 'get_active_window') return 'CheckingSomething';
  // Voice
  if (tool === 'speak_text') return 'Hearing_1';
  // Planning
  if (tool === 'plan') return 'Thinking';
  // Default
  return 'Processing';
}

// ========== User Profile ==========

function getUserProfilePath(): string {
  return path.join(app.getPath('userData'), 'user.md');
}

function loadUserProfile(): string {
  try {
    const p = getUserProfilePath();
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log.warn('Could not load user profile', err);
  }
  return '';
}

export function saveUserProfile(data: Record<string, string>): void {
  const lines = ['# User Profile', ''];
  for (const [k, v] of Object.entries(data)) if (v) lines.push(`- **${k}:** ${v}`);
  try {
    fs.writeFileSync(getUserProfilePath(), lines.join('\n'), 'utf-8');
    log.info('User profile saved');
  } catch (err) {
    log.error('Failed to save user profile', err);
  }
}

export function getUserProfile(): Record<string, string> {
  const content = loadUserProfile();
  const profile: Record<string, string> = {};
  const regex = /- \*\*(.+?):\*\* (.+)/g;
  let m;
  while ((m = regex.exec(content)) !== null) profile[m[1]] = m[2];
  return profile;
}

export function isProfileSetUp(): boolean {
  return !!getUserProfile()['Name'];
}

// ========== Settings ==========

interface BrainSettings {
  proactiveInterval: number;
  proactiveEnabled: boolean;
  /** TTS voice on/off (wired from settings UI → broadcast to main renderer). */
  ttsEnabled: boolean;
  /** Utterance rate 0.5–2.0 (default 1.1). */
  speechRate: number;
}

const settingsStore = new Store<BrainSettings>({
  name: 'brain-settings',
  defaults: {
    proactiveInterval: 300000, // 5 minutes — was 30s, way too frequent
    proactiveEnabled: true,
    ttsEnabled: true,
    speechRate: 1.1,
  },
});

// ========== Brain class ==========

export class Brain {
  private win: BrowserWindow;
  private intervalId: NodeJS.Timeout | null = null;
  private mode: 'awake' | 'sleep' = 'sleep';
  /** Collapsed conversation history (text-only) across user turns. */
  private history: Content[] = [];
  private static readonly MAX_HISTORY = 16;
  private recentProactiveMessages: string[] = [];
  private static readonly MAX_PROACTIVE_HISTORY = 8;
  private noRepeatUntil = 0;
  private lastScreenFingerprint = '';
  private greetedOnWake = false;
  private isExecuting = false;
  // Set by a NEW handleUserMessage call arriving while a previous one is
  // still in its tool-loop. The in-flight loop checks this between steps
  // and aborts, letting the new message take over. Resets at the start of
  // every new execution.
  private cancelRequested = false;

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  setMode(mode: 'awake' | 'sleep'): void {
    log.info('Brain.mode', { from: this.mode, to: mode });
    this.mode = mode;
    if (mode === 'awake') {
      this.greetedOnWake = false;
      this.noRepeatUntil = 0;
      // v0.11.29 — reset fingerprint on wake so a stale "screen unchanged"
      // marker from before sleep doesn't permanently silence proactive on
      // the SAME app. Per user report: "proactive on, 300s, Clippy silent."
      this.lastScreenFingerprint = '';
      this.startLoop();
    } else {
      // Sleep is a hard stop. Three layers, in order:
      //   1. cancelRequested=true — signals the agent loop to break at
      //      its next iteration AND short-circuits the next per-call
      //      pre-dispatch check (added in v0.11.25).
      //   2. abortAllInFlightTools() (v0.11.26) — sends AbortSignal to
      //      every active execFileAbortable child process. This kills
      //      a mid-flight 30s outlook_send_email or 60s word_to_pdf
      //      that the loop-level cancel can't interrupt because the
      //      loop is awaiting the tool's completion. Without this,
      //      sleep felt unresponsive — Clippy's sprite went to sleep
      //      pose while the underlying powershell.exe was still
      //      driving the user's keyboard. Per report 8836f5ec.
      //   3. stopLoop() — stops the proactive timer.
      this.cancelRequested = true;
      try { abortAllInFlightTools(); } catch (err) {
        log.warn('abortAllInFlightTools threw on sleep (non-fatal)', serializeErr(err));
      }
      this.stopLoop();
    }
  }

  getMode(): 'awake' | 'sleep' {
    return this.mode;
  }

  /**
   * Restart the proactive loop so a settings change (interval or on/off)
   * takes effect immediately instead of waiting for the next sleep/wake cycle.
   * Safe to call even when Clippy is sleeping — it's a no-op then.
   */
  restartProactiveLoop(): void {
    if (this.mode === 'awake') {
      log.info('Proactive loop restarted (settings changed)');
      this.startLoop();
    }
  }

  // ========== Public entry ==========

  async handleUserMessage(text: string): Promise<string> {
    // v0.11.28 — task correlation id. Set as the logger's current task so every
    // log line emitted by brain/tools/scripts under this user request shares it.
    // Cleared in finally{} so post-task lines don't bleed into a stale id.
    const task_id = randomUUID();
    setCurrentTaskId(task_id);
    log.info('User.message', { text: text.substring(0, 200), length: text.length, task_id });

    // Name introduction — handled client-side for deterministic UX.
    // Matches "my name is X", "call me X", "I'm X", or just a bare name
    // (user responding to "What should I call you? Just type your name!")
    if (!isProfileSetUp()) {
      const match = text.match(/(?:my name is|call me|i'm called|name's|i'm|im)\s+([A-Za-z]{2,20})/i)
        || text.match(/^([A-Za-z]{2,20})$/); // bare name like "Amr"
      if (match) {
        const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        saveUserProfile({ Name: name });
        const greeting = `Nice to meet you, ${name}! I'll remember that. How can I help? 📎`;
        log.info('Clippy.say', { text: greeting, animation: 'Wave', trigger: 'name_intro', userName: name });
        this.pushHistory({ role: 'user', parts: [{ text }] });
        this.pushHistory({ role: 'model', parts: [{ text: greeting }] });
        this.emit('clippy-speak', { text: greeting, animate: 'Wave' });
        return greeting;
      }
    }

    // If a previous task is still running, signal cancel and wait for it to
    // release the executing flag, then take over. Prevents the "I'm still
    // working" dead-end where users typed a new thing mid-task and got
    // nothing useful. The in-flight loop checks cancelRequested between
    // steps and aborts with a "switching gears" message.
    if (this.isExecuting) {
      log.info('User override — cancelling in-flight task', { newMessage: text.substring(0, 80) });
      this.cancelRequested = true;
      const waitStart = Date.now();
      while (this.isExecuting && Date.now() - waitStart < 10_000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.isExecuting) {
        // Previous tool is stuck (e.g. PSBridge hang). Bail — don't start
        // two concurrent tool loops because that would clobber each other's
        // always-on-top re-asserts and read_screen output.
        log.warn('Previous task did not abort within 10s — dropping override', { newMessage: text.substring(0, 80) });
        return "Give me a sec — still finishing that up.";
      }
    }
    this.isExecuting = true;
    this.cancelRequested = false;

    try {
      this.emit('play-animation', 'Thinking');

      // Build initial user message — add screen context if we can grab it
      // fast. Pass userText so memory.lookupWorkflow can match learned
      // workflows for this user+app+task.
      const screenContext = await this.captureScreenContext(2500, text);
      // Pre-capture the active app's process name so we can record the
      // workflow under it on success (active app may shift mid-task).
      let activeProcessAtStart = '';
      try {
        const aw = await executeTool('get_active_window', {});
        const parsed = JSON.parse(aw.text);
        if (typeof parsed.processName === 'string') activeProcessAtStart = parsed.processName;
      } catch { /* memory recording is best-effort */ }
      // Track successful tool calls so we can distill them into a learned
      // workflow on task completion. Only the model-emitted Tool.call args
      // — populated below in the loop.
      const successfulActions: Array<{ name: string; args: Record<string, unknown> }> = [];
      // v0.11.25 — destructive-action ledger for the hallucination guard.
      // Each entry records whether the destructive call genuinely
      // succeeded (per the tool's own result text). Used at task-end to
      // sanity-check the model's "I sent it!" closer.
      const destructiveAttempts: Array<{ name: string; succeeded: boolean; resultPreview: string }> = [];
      const screenContextOk = !!screenContext && !screenContext.startsWith('<screen-context-');
      log.info('Task.start', {
        hasScreenContext: screenContextOk,
        screenContextLen: screenContext?.length || 0,
        screenContextSentinel: screenContextOk ? null : screenContext || null,
        historyMessages: this.history.length,
        activeProcessAtStart,
        task_id,
      });
      const initialText = screenContextOk
        ? `${text}\n\n[Screen context you can reference if useful:\n${screenContext}]`
        : text;

      // Working contents for this turn's function-call loop
      const contents: Content[] = [
        ...this.history,
        { role: 'user', parts: [{ text: initialText }] },
      ];

      // Persist the unaugmented user text to history
      this.pushHistory({ role: 'user', parts: [{ text }] });

      const profile = getUserProfile();
      const userProfile = profile.Name ? `Name: ${profile.Name}` : undefined;

      // 40 covers drawing tasks (stickfigure ≈ 45 mouse_drags) and
      // multi-step Excel writes. Previous limit of 15 starved drawings
      // mid-figure. browser-use defaults to 100, UFO 30+, anthropic
      // computer-use 50.
      const MAX_STEPS = 40;
      let finalSpoken = '';
      let taskCompleted = false;
      // D5/D8: track step count and abort reason accurately.
      let lastStep = 0;
      let abortReason: string | null = null;
      // Stuck-loop detection: if read_screen returns the same text twice in a
      // row, the model is staring at the same page without learning anything.
      // Inject a hint to break the pattern before the 3-call runaway guard fires.
      let lastReadScreenResult = '';

      for (let step = 0; step < MAX_STEPS; step++) {
        lastStep = step + 1;

        // Cancel-requested abort. Two callers set this:
        //  - handleUserMessage when a newer user message arrives (override)
        //  - setMode('sleep') so sleep is a real stop, not just a sprite swap
        // Only chatter on user-override; sleeping users want silence.
        if (this.cancelRequested) {
          if (this.mode === 'sleep') {
            log.info('Task aborted — sleep');
            abortReason = 'sleep';
          } else {
            log.info('Task aborted — user override');
            this.emit('clippy-speak', { text: 'Got it — switching gears.', animate: 'Wave' });
            finalSpoken = 'Got it — switching gears.';
            abortReason = 'user_override';
          }
          break;
        }
        // Clippy stays always-on-top (visible in corner) throughout the loop.
        // We do NOT lower ourselves — the user should see Clippy's bubble and
        // animations while tasks execute. The focus_window tool uses
        // AttachThreadInput + Alt-key to give KEYBOARD FOCUS to the target app
        // without changing z-order, so SendKeys goes to Notepad/Paint/etc.
        // while Clippy's sprite remains visible on screen.
        //
        // The old v0.9.9 code lowered Clippy here (setAlwaysOnTop(false)),
        // which hid Clippy during tasks. The even older code re-asserted
        // alwaysOnTop here, which stole keyboard focus. Both were wrong.
        // Correct: leave z-order alone, let focus_window handle focus.

        // Show thinking animation while waiting for API response
        if (step > 0) this.emit('play-animation', 'Thinking');
        const turnStart = Date.now();
        const resp = await this.callTurn(contents, { user_profile: userProfile });
        const turnMs = Date.now() - turnStart;

        if (isError(resp)) {
          log.info('Turn.error', { step: step + 1, error: resp.error, detail: resp.detail, elapsed_ms: turnMs });
          const msg = this.errorMessage(resp.error, resp.detail || resp.message);
          log.info('Clippy.say', { text: msg, animation: 'Alert', trigger: 'error', error: resp.error });
          this.emit('clippy-speak', { text: msg, animate: 'Alert' });
          finalSpoken = msg;
          break;
        }

        // Separate text and function-call parts
        const texts = resp.parts.filter(isText).map((p) => p.text);
        const calls = resp.parts.filter(isFunctionCall).map((p) => p.functionCall);
        const spoken = texts.join(' ').trim();

        // Structured API response log — the missing piece for diagnosing performance
        const okResp = resp as TurnSuccess;
        log.info('Turn.ok', {
          step: step + 1,
          elapsed_ms: turnMs,
          tokens_used: okResp.tokens_used,
          tokens_remaining: okResp.tokens_remaining,
          provider: okResp.provider,
          finish_reason: okResp.finish_reason,
          has_text: !!spoken,
          text_preview: spoken ? spoken.substring(0, 100) : null,
          tool_calls: calls.map((c) => c.name),
          context_messages: contents.length,
        });

        // Emit text to bubble — structured, clean, no stripping needed
        if (spoken) {
          const anim = this.pickAnimation(text, spoken, calls.length > 0);
          log.info('Clippy.say', { text: spoken, animation: anim, trigger: 'reply', step: step + 1 });
          this.emit('clippy-speak', { text: spoken, animate: anim });
          finalSpoken = spoken;
        }

        // === SENTINEL: task_complete ===
        const completeCall = calls.find((c) => c.name === 'task_complete');
        if (completeCall) {
          const summary = String(
            (completeCall.args as { summary?: string }).summary || 'Done!',
          );
          log.info('Clippy.say', { text: summary, animation: 'Congratulate', trigger: 'task_complete', step: step + 1 });
          this.emit('clippy-speak', { text: summary, animate: 'Congratulate' });
          finalSpoken = summary;
          taskCompleted = true;
          break;
        }

        // Fallback: no tool calls → done (or ambiguous)
        if (calls.length === 0 || resp.done) {
          if (calls.length === 0 && !spoken) {
            finalSpoken = "I'm not sure what to do — can you rephrase?";
            log.info('Clippy.say', { text: finalSpoken, animation: 'Alert', trigger: 'no_tools' });
            this.emit('clippy-speak', { text: finalSpoken, animate: 'Alert' });
          }
          break;
        }

        // Append model turn to working contents
        contents.push({ role: 'model', parts: resp.parts });

        // === RUNAWAY GUARD (from ClawdCursor v0.8.3) ===
        // If the model calls the same tool with identical args 3+ times in
        // the last 6 steps, it's stuck. Break the loop instead of burning
        // tokens on the same failing action.
        for (const call of calls) {
          // Drawing tasks LEGITIMATELY chain many mouse_drags. Each drag
          // has different start/end coords (signature is unique per call),
          // so the byte-identical-args check below already exempts normal
          // drawing. But to be safe, skip the runaway guard entirely for
          // mouse_drag — drawings naturally repeat the same tool name.
          if (call.name === 'mouse_drag') continue;
          const sig = `${call.name}::${JSON.stringify(call.args)}`;
          const recent = contents.slice(-12) // last 6 turn pairs
            .filter((c) => c.role === 'model')
            .flatMap((c) => c.parts.filter(isFunctionCall).map((p) => `${p.functionCall.name}::${JSON.stringify(p.functionCall.args)}`));
          const repeatCount = recent.filter((s) => s === sig).length;
          // #3: threshold used to be `>= 2` with a `+1` in the log, which
          // meant the guard fired at the *2nd* identical call but logged it
          // as "repeats:3" — aborting legitimate `focus → read → re-focus
          // → read` patterns. Now fires only on the *3rd* identical call
          // (recent already includes the current call via contents.push
          // above, so repeatCount == 3 means 3 total identical calls).
          if (repeatCount >= 3) {
            log.warn('Runaway guard', { tool: call.name, repeats: repeatCount });
            const msg = `I'm stuck repeating ${call.name} — stopping. Try rephrasing or a different approach.`;
            log.info('Clippy.say', { text: msg, animation: 'Alert', trigger: 'runaway_guard' });
            this.emit('clippy-speak', { text: msg, animate: 'Alert' });
            finalSpoken = msg;
            // D5: the task DID NOT complete — it was aborted. We previously
            // set taskCompleted=true here, which lied to success-rate metrics.
            // Record the abort reason explicitly for Task.end and use that
            // signal to break the outer loop instead of taskCompleted.
            abortReason = 'runaway_guard';
            break;
          }
        }
        if (abortReason) break;

        // Execute each function call, collect responses
        const responseParts: FunctionResponsePart[] = [];
        for (const call of calls) {
          // v0.11.25 — cancel check BEFORE each tool. Previously
          // `cancelRequested` was only checked between turns (top of the
          // outer `for (step ...)` loop), so a 30-second outlook_send_email
          // or 60-second word_to_pdf would happily run to completion even
          // after the user put Clippy to sleep or sent a new message.
          // Subagent B (audit, May 7) flagged this as P0. Now: short-circuit
          // here, push a synthetic "cancelled" functionResponse so the
          // model's tool-call schema stays consistent if we re-enter,
          // and break out.
          if (this.cancelRequested) {
            log.info('Tool.cancelled before exec', { tool: call.name, mode: this.mode });
            responseParts.push({
              functionResponse: {
                name: call.name,
                response: { error: 'cancelled by user before tool ran' },
              },
            });
            break; // exit the per-call loop; outer loop will catch cancelRequested at top of next step
          }
          const toolStart = Date.now();
          log.info('Tool.call', { step: step + 1, tool: call.name, args: call.args });
          // Trigger an in-progress animation BEFORE the tool runs so the
          // sprite shows what Clippy is doing during the wait. Without
          // this, the sprite freezes on Thinking for the full tool duration
          // (up to 30s for Outlook/Excel) and the user can't tell anything
          // is happening. Map tool category → animation.
          this.emit('play-animation', animationForTool(call.name));
          try {
            const result = await executeTool(call.name, call.args);
            const toolElapsed = Date.now() - toolStart;
            const resultText = result.text || JSON.stringify(result).substring(0, 500);
            log.info('Tool.result', {
              step: step + 1,
              tool: call.name,
              elapsed_ms: toolElapsed,
              output: resultText.substring(0, 300),
              has_image: !!(result.image?.data),
            });

            // === RE-ASSERT CLIPPY'S Z-ORDER ===
            // Any tool that hands foreground to another app — open_app,
            // navigate_browser, focus_window, mouse_click, mouse_drag,
            // key_press (alt+tab!), smart_click, smart_type — can knock
            // Clippy off topmost. setAlwaysOnTop is idempotent and ~free
            // on Windows, so just re-assert after every tool call. The
            // prior open_app/navigate_browser-only filter meant Clippy
            // disappeared any time the agent used focus_window or
            // clicked another window.
            if (!this.win.isDestroyed()) {
              this.win.setAlwaysOnTop(true, 'screen-saver');
            }

            // === VERIFICATION: inject fresh screen state ===
            let screenAfter: string | undefined;
            if (UI_MODIFYING_TOOLS.has(call.name)) {
              try {
                const screen = await executeTool('read_screen', {});
                if (screen.text) screenAfter = screen.text.substring(0, 1500);
              } catch {
                /* best effort */
              }
              log.info('Tool.verify', {
                step: step + 1,
                tool: call.name,
                screen_after_len: screenAfter?.length || 0,
                screen_after_preview: screenAfter?.substring(0, 150) || '(empty)',
              });
            }

            // Stuck-screen detection: if read_screen returns the same text twice
            // consecutively, inject a hint so the model knows it's looping and
            // tries something different instead of repeating the same OCR call.
            let stuckHint = '';
            if (call.name === 'read_screen') {
              const resultKey = resultText.substring(0, 400);
              if (resultKey && resultKey === lastReadScreenResult) {
                stuckHint = '\n\n[HINT: The screen has not changed since your last read_screen. Try a different approach — scroll, wait(2), navigate, or use desktop_screenshot to see the visual state.]';
              }
              lastReadScreenResult = resultKey;
            }

            responseParts.push({
              functionResponse: {
                name: call.name,
                response: {
                  result: (resultText + stuckHint).substring(0, 900),
                  ...(screenAfter ? { screen_after: screenAfter } : {}),
                },
              },
            });

            // === VISION: pass screenshot images to the model ===
            // When desktop_screenshot returns an image, include it as an
            // inlineData part so the vision-capable model (Kimi K2) can
            // actually SEE the screen. This is the fundamental shift from
            // "blind agent reading UIA trees" to "sighted agent with eyes."
            // Without this, the model draws blindly, clicks blindly, and
            // can never verify visual results.
            if (result.image?.data && result.image?.mimeType) {
              log.info('Tool.vision', { step: step + 1, tool: call.name, size_kb: Math.round(result.image.data.length / 1024) });
              responseParts.push({
                inlineData: {
                  mimeType: result.image.mimeType,
                  data: result.image.data,
                },
              } as any);
            }

            // === MEMORY: track action for learned-workflow recording ===
            // Only count tools that actually changed state (not observations).
            // Filter out clearly-failed results so we don't memorize a no-op
            // sequence as a "successful" workflow.
            const looksLikeError = resultText.startsWith('(') || resultText.toLowerCase().startsWith('error:');
            if (!looksLikeError) {
              successfulActions.push({ name: call.name, args: call.args as Record<string, unknown> });
            }

            // === DESTRUCTIVE LEDGER (v0.11.25) ===
            // Track destructive-tool outcomes for the end-of-task
            // hallucination guard. We're conservative: if the result
            // text doesn't start with `(` AND doesn't contain explicit
            // failure words, we count it as a (possibly) successful
            // attempt. The guard then cross-checks the model's final
            // claim against this ledger.
            if (DESTRUCTIVE_TOOLS.has(call.name)) {
              destructiveAttempts.push({
                name: call.name,
                succeeded: !looksLikeError && !/\b(failed|not found|unavailable|timeout|denied|refused)\b/i.test(resultText),
                resultPreview: resultText.substring(0, 120),
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const toolElapsed = Date.now() - toolStart;
            log.error('Tool.error', { step: step + 1, tool: call.name, elapsed_ms: toolElapsed, error: msg });
            responseParts.push({
              functionResponse: {
                name: call.name,
                response: { error: msg.substring(0, 300) },
              },
            });
          }
        }

        contents.push({ role: 'user', parts: responseParts });
        await new Promise((r) => setTimeout(r, 300));

        if (step === MAX_STEPS - 1 && !taskCompleted) {
          // Hitting the cap is a FAILURE state, not a celebration. Previous
          // code played Congratulate which visually lied to the user that
          // the task succeeded. Alert is honest.
          const capMsg = "That's a long task — stopping here. Tell me what to focus on next.";
          log.warn('Clippy.say', { text: capMsg, animation: 'Alert', trigger: 'max_steps', steps_used: MAX_STEPS });
          this.emit('clippy-speak', { text: capMsg, animate: 'Alert' });
          finalSpoken = capMsg;
          abortReason = 'max_steps';
        }
      }

      // === HALLUCINATION GUARD (v0.11.25) ===
      // If the model closed with confident-success language ("Email sent!",
      // "Posted!", "Created!") but no destructive tool actually succeeded,
      // override the spoken text with an honest version. Per report
      // ccd4d6f4 the model said "Email sent!" when (a) outlook_send_email
      // had errored, (b) cdp_connect refused, (c) smart_click "Send"
      // returned "(not found via UIA; OCR unavailable)", and (d) the
      // Ctrl+Enter keypress went to explorer.exe after focus drift.
      // Lying to the user is worse than failing visibly.
      if (
        finalSpoken
        && destructiveAttempts.length > 0
        && soundsLikeClaimedSuccess(finalSpoken)
        && !destructiveAttempts.some((a) => a.succeeded)
      ) {
        const failures = destructiveAttempts.map((a) => `${a.name}: ${a.resultPreview}`).join(' | ');
        log.warn('Task.hallucinatedSuccess', {
          claimed: finalSpoken.substring(0, 200),
          destructiveAttempts: destructiveAttempts.length,
          attemptsSummary: failures.substring(0, 400),
        });
        const honest = `I tried but couldn't confirm it worked — every attempt failed or returned an unverified result. Want me to try a different approach? (Details: ${destructiveAttempts.map((a) => a.name).join(', ')} all failed.)`;
        this.emit('clippy-speak', { text: honest, animate: 'Alert' });
        finalSpoken = honest;
      }

      // D8: stepsUsed used to be `contents.length - history.length` which is
      // a message-count proxy, not a step count. It showed 0 for simple text
      // replies and 22 for a 12-step task. Use the actual loop counter.
      log.info('Task.end', {
        finalText: finalSpoken?.substring(0, 200) || '(none)',
        taskCompleted,
        abortReason,
        stepsUsed: lastStep,
        successfulActionCount: successfulActions.length,
        destructiveAttempts: destructiveAttempts.length,
        destructiveSucceeded: destructiveAttempts.filter((a) => a.succeeded).length,
      });

      // v0.11.22 — record the action sequence as a learned workflow scoped
      // to the active app at task start. Only for clean successes (no
      // abort, ≥2 substantive actions). The next time the user asks
      // something similar in the same app, formatWorkflowHint() injects
      // these steps as context so the model takes the proven path.
      if (taskCompleted && !abortReason && activeProcessAtStart && successfulActions.length >= 2) {
        try {
          recordWorkflow(activeProcessAtStart, text, successfulActions);
        } catch (err) {
          log.warn('recordWorkflow failed (non-fatal)', { error: serializeErr(err) });
        }
      }

      if (finalSpoken) {
        this.pushHistory({ role: 'model', parts: [{ text: finalSpoken }] });
      }
      return finalSpoken || "I'm not sure what to say.";
    } catch (err) {
      log.error('handleUserMessage threw', serializeErr(err));
      this.emit('clippy-speak', { text: "Hmm, that didn't work. Try again!", animate: 'Alert' });
      return 'Something went wrong.';
    } finally {
      this.isExecuting = false;
      // Clear task correlation id so subsequent proactive/idle log lines
      // don't carry a stale id from a finished task.
      setCurrentTaskId(undefined);
      // Clippy stays always-on-top throughout — no re-assert needed.
      // The window was never lowered during the loop.
    }
  }

  // ========== Proactive loop ==========

  private startLoop(): void {
    this.stopLoop();
    setTimeout(() => this.proactiveCheck(), 2000);
    const interval = settingsStore.get('proactiveInterval');
    this.intervalId = setInterval(() => this.proactiveCheck(), interval);
  }

  private stopLoop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async proactiveCheck(): Promise<void> {
    // v0.11.29 — these gating checks were silent (no log). Per user report
    // "Clippy stays silent, proactive on at 300s", we now emit Proactive.tick
    // INFO logs so production reports show whether the loop is even firing
    // and which gate is closing it.
    if (this.mode !== 'awake') { log.info('Proactive.tick', { gate: 'not_awake', mode: this.mode }); return; }
    if (!settingsStore.get('proactiveEnabled')) { log.info('Proactive.tick', { gate: 'disabled' }); return; }
    if (Date.now() < this.noRepeatUntil) {
      log.info('Proactive.tick', { gate: 'cooldown', remaining_ms: this.noRepeatUntil - Date.now() });
      return;
    }
    if (this.isExecuting) { log.info('Proactive.tick', { gate: 'task_in_flight' }); return; }
    log.info('Proactive.tick', { gate: 'open' });

    try {
      if (!this.greetedOnWake) {
        this.greetedOnWake = true;
        // v0.11.23 — suppress wake_greeting when name_prompt is going to
        // fire 1-3s later. Otherwise the user sees:
        //   "Hi! Click me to chat..."  ← generic
        //   "Hey! What should I call you?"  ← what they actually need
        // back-to-back, which feels chatty/repetitive (per user report).
        // If the profile isn't set up, the post-onboarding flow is about
        // to fire its own greeting — don't double-talk.
        const profile = getUserProfile();
        if (!profile.Name) {
          this.noRepeatUntil = Date.now() + 120_000;
          log.info('Proactive.skip', { reason: 'name_prompt_will_fire' });
          return;
        }
        const name = profile.Name;
        const greeting = `Hi ${name}! Click me to chat — I can help with whatever you're working on.`;
        log.info('Clippy.say', { text: greeting, animation: 'Wave', trigger: 'wake_greeting' });
        this.emit('clippy-speak', { text: greeting, animate: 'Wave' });
        this.noRepeatUntil = Date.now() + 120_000;
        return;
      }

      const context = await this.captureScreenContext(3000);
      if (!context || context.startsWith('<screen-context-')) {
        log.info('Proactive.skip', { reason: 'no_context', sentinel: context });
        return;
      }

      // Screen fingerprint — skip API call if nothing changed.
      // v0.11.29 — bumped from 200 → 800 chars + included extras (guides,
      // workflow hints) so two visits to the SAME window with different
      // foreground content (different Outlook email, different VS Code
      // file) still register as "changed". The 200-char fingerprint was
      // tripping false-identical on every interval when the user was
      // sitting on the same app, leading to permanent silence.
      const fingerprint = context.substring(0, 800);
      if (fingerprint === this.lastScreenFingerprint) {
        // Was DEBUG (invisible in production) — promoted to INFO so users
        // who report "Clippy never speaks" can see this in their bundle.
        log.info('Proactive.skip', { reason: 'screen_unchanged', fingerprint_len: fingerprint.length });
        return;
      }
      this.lastScreenFingerprint = fingerprint;

      // D2: max_tokens was 120 which truncated legitimate one-sentence tips
      // mid-word (e.g. "...Useful tips for" cut off at token 120). Bumped
      // to 200. The 200-char reply-length cap below still enforces brevity.
      // Kimi K2.5 uses chain-of-thought reasoning before outputting the tip.
      // 200 tokens was too small — the model burned all tokens on thinking and
      // produced empty content. 800 gives room to think (~500) + tip (~50).
      const resp = await this.callTurn(
        [{ role: 'user', parts: [{ text: `Current screen:\n${context}` }] }],
        { proactive: true, max_tokens: 800 },
      );

      if (isError(resp)) { log.info('Proactive.error', { error: (resp as TurnError).error }); return; }

      // BUG 4 FIX: if Kimi hit max_tokens, the tip is truncated mid-sentence.
      // A half-sentence shown to the user is worse than silence — discard it.
      if ((resp as TurnSuccess).finish_reason === 'length' || (resp as TurnSuccess).finish_reason === 'MAX_TOKENS') {
        log.info('Proactive.filtered', { reason: 'truncated_by_max_tokens' });
        return;
      }

      // BUG 3 FIX: Kimi K2.5 reasoning bleeds into content on proactive calls.
      // The model outputs a multi-line "thinking" paragraph then the actual tip.
      // Take ONLY the first non-empty line — the actual tip (or __SILENT__).
      const rawReply = resp.parts
        .filter(isText)
        .map((p) => p.text)
        .join('\n')
        .trim();
      // Find the first non-blank line as the candidate tip
      const firstLine = rawReply.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '';
      const reply = firstLine;

      if (!reply || reply.includes('__SILENT__')) { log.info('Proactive.silent', { tokens: (resp as TurnSuccess).tokens_used }); return; }
      if (reply.length > 160) { log.info('Proactive.filtered', { reason: 'too_long', length: reply.length }); return; }
      // Defense-in-depth narration filter.
      if (/^\s*[-•*]\s|^\s*\d+[.)]\s/.test(reply)) { log.info('Proactive.filtered', { reason: 'starts_with_list_marker', text: reply.substring(0, 60) }); return; }
      const NARRATION_RE = /\b(i see you|you have .+ open|you're (using|looking|working)|i (should|'ll|will) (provide|suggest|recommend)|useful tips? for|potential tips?|since .+ is (the )?active|let me (think|check|try)|here'?s (a|one|some) tips?|(what|how) could (i|you)|could suggest|could recommend|they (might|may) (want|be)|given that|no windows|empty desktop|not much to|the screen is|there('?s| are) (nothing|no |not)|nothing (specific|to|visible)|based on (the|what)|from the screen|nothing stands out)\b/i;
      if (NARRATION_RE.test(reply)) { log.info('Proactive.filtered', { reason: 'narration', text: reply.substring(0, 60) }); return; }
      if (this.isSimilarToRecent(reply)) {
        log.info('Proactive.filtered', { reason: 'similar_to_recent', text: reply.substring(0, 60) });
        return;
      }

      this.recentProactiveMessages.push(reply);
      if (this.recentProactiveMessages.length > Brain.MAX_PROACTIVE_HISTORY) {
        this.recentProactiveMessages.shift();
      }
      log.info('Clippy.say', { text: reply, animation: 'GetAttention', trigger: 'proactive' });
      this.emit('clippy-speak', { text: reply, animate: 'GetAttention' });
      // 10 min cooldown after speaking — silence is better than noise
      this.noRepeatUntil = Date.now() + 600_000;
    } catch (err) {
      log.error('proactiveCheck failed', serializeErr(err));
      this.noRepeatUntil = Date.now() + 120_000;
    }
  }

  // ========== Helpers ==========

  private async captureScreenContext(timeoutMs: number, userText?: string): Promise<string> {
    try {
      const promise = (async () => {
        const [active, screen] = await Promise.allSettled([
          executeTool('get_active_window', {}),
          executeTool('read_screen', {}),
        ]);
        const activeText = active.status === 'fulfilled' ? active.value.text : '';
        const screenText = screen.status === 'fulfilled' ? screen.value.text : '';
        if (!activeText && !screenText) return '';

        // v0.11.22 — extract process name from active-window JSON, then
        // append (a) the bundled ClawdCursor app guide and (b) the
        // per-machine learned-workflow hint if one matches the user's ask.
        // Both are app-agnostic injections — they do NOT replace the
        // smart_click OCR fallback, they supplement it. Guide tells the
        // model the right shortcut (e.g. Ctrl+Enter for Outlook send) so
        // it skips coordinate-clicking entirely.
        let extras = '';
        try {
          const parsedActive = JSON.parse(activeText) as { processName?: string };
          const proc = parsedActive.processName;
          if (proc) {
            const guide = getGuidePrompt(proc);
            if (guide) extras += guide;
            if (userText && memoryEnabled()) {
              const hint = formatWorkflowHint(proc, userText);
              if (hint) extras += hint;
            }
          }
        } catch {
          // activeText not JSON (e.g. "(no active window)") — skip extras
        }

        return `Active: ${activeText || 'unknown'}\nScreen: ${(screenText || '').substring(0, 2000)}${extras}`;
      })();
      const timeout = new Promise<string>((r) => setTimeout(() => r('<screen-context-timeout>'), timeoutMs));
      return await Promise.race([promise, timeout]);
    } catch (err) {
      // v0.11.28 — was a bare `catch { return ''; }` that swallowed UIA
      // failures, OCR failures, and read_screen errors silently. Per the
      // silent-failure audit (subagent C) this was the single most
      // dangerous mute in the codebase: the model would then run blind
      // with no screen context AND no log line explaining why.
      // Now: log the error with full stack and return a sentinel string
      // so the model knows the visual state is untrusted instead of
      // assuming "empty screen".
      log.error('captureScreenContext failed', {
        timeoutMs,
        userText: userText?.substring(0, 80),
        err: serializeErr(err),
      });
      return '<screen-context-unavailable>';
    }
  }

  /**
   * Pick a Clippy animation based on user intent + reply content.
   * Clippy has 43 animations in the sprite — this picker uses ~30 of them with
   * randomness inside each category so the character feels alive, not robotic.
   * Full list: Alert, CheckingSomething, Congratulate, EmptyTrash, Explain,
   * GestureDown/Left/Right/Up, GetArtsy, GetAttention, GetTechy, GetWizardy,
   * GoodBye, Greeting, Idle*, LookDown*, LookLeft, LookRight,
   * LookUp*, Print, Processing, RestPose, Save, Searching, SendMail, Thinking,
   * Wave, Writing.
   */
  private pickAnimation(userText: string, reply: string, hasTools: boolean): string {
    const u = userText.toLowerCase();
    const r = reply.toLowerCase();
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    // ACTION PHASE — Clippy is doing something
    if (hasTools) {
      if (/type|write|draft|compose|email|message|letter/.test(u)) {
        return pick(['Writing', 'SendMail']);
      }
      if (/save|download/.test(u)) return 'Save';
      if (/print/.test(u)) return 'Print';
      if (/delete|remove|trash|empty/.test(u)) return 'EmptyTrash';
      if (/search|find|look|browse/.test(u)) return pick(['Searching', 'CheckingSomething']);
      if (/design|draw|paint|art|creat/.test(u)) return pick(['GetArtsy', 'Writing']);
      if (/code|program|script|compile|debug/.test(u)) return 'GetTechy';
      if (/magic|wizard|automate|bulk/.test(u)) return 'GetWizardy';
      return pick(['Searching', 'Processing', 'CheckingSomething']);
    }

    // REPLY PHASE — Clippy is responding with text
    // Playful / entertainment
    if (/trick|dance|entertain|show me|funny|perform|animat|cool|surprise/.test(u)) {
      return pick([
        'Congratulate', 'GetAttention', 'GetArtsy', 'GetWizardy',
        'IdleAtom', 'IdleRopePile', 'IdleSideToSide', 'IdleEyeBrowRaise',
        'IdleFingerTap', 'IdleHeadScratch',
      ]);
    }
    // Greetings / goodbyes
    if (/^(hi|hey|hello|sup|yo|howdy|what'?s up|good morning|good afternoon)/i.test(u)) {
      return pick(['Wave', 'Greeting']);
    }
    if (/^(bye|goodbye|see you|later|cya)/i.test(u)) return 'GoodBye';

    // Question topics → gesture directions feel natural for explanations
    if (/what|how|why|when|where|which|explain|tell me/.test(u)) {
      return pick(['Explain', 'GestureUp', 'GestureLeft', 'GestureRight', 'Searching']);
    }

    // Reply content-based
    if (/sorry|error|can'?t|couldn'?t|failed|wrong|oops|hmm,? that/.test(r)) return 'Alert';
    if (/done|success|great|perfect|awesome|ta-?da|congratul|finished|complete/.test(r)) {
      return pick(['Congratulate', 'GetAttention']);
    }
    if (/tip|suggest|recommend|try |you could|you should|maybe/.test(r)) {
      return pick(['GetAttention', 'Explain', 'GestureUp']);
    }
    if (/hmm|let me think|interesting|good question|not sure/.test(r)) {
      return pick(['Thinking', 'CheckingSomething', 'LookUp', 'LookUpLeft', 'LookUpRight']);
    }
    if (/look|see|check|here|there/.test(r)) {
      return pick(['LookLeft', 'LookRight', 'LookDown', 'LookDownLeft', 'LookDownRight']);
    }

    // Default: a small wave/greeting or a subtle idle gesture
    return pick(['Wave', 'Greeting', 'GestureUp', 'Explain']);
  }

  /**
   * Check similarity against ALL recent proactive messages, not just the last one.
   * Uses 35% word overlap threshold (was 50% against single message). This catches
   * the "model rewords same observation" pattern that plagued earlier versions.
   */
  private isSimilarToRecent(message: string): boolean {
    if (this.recentProactiveMessages.length === 0) return false;
    const words = (s: string) => new Set(s.toLowerCase().match(/\b\w{3,}\b/g) || []);
    const a = words(message);
    if (a.size === 0) return false;
    for (const prev of this.recentProactiveMessages) {
      const b = words(prev);
      if (b.size === 0) continue;
      let overlap = 0;
      for (const w of a) if (b.has(w)) overlap++;
      if (overlap / Math.min(a.size, b.size) > 0.35) return true;
    }
    return false;
  }

  private pushHistory(msg: Content): void {
    this.history.push(msg);
    if (this.history.length > Brain.MAX_HISTORY) {
      this.history = this.history.slice(-Brain.MAX_HISTORY);
    }
  }

  private errorMessage(error: string, detail?: string): string {
    if (error === 'ai_error' && detail) {
      // Show a simplified version of the actual error so user has context
      return `Oops — ${detail.substring(0, 80)}. Try again!`;
    }
    const map: Record<string, string> = {
      limit_reached: 'Monthly quota used up! Upgrade for more.',
      invalid_key: 'License key invalid.',
      subscription_inactive: 'Subscription inactive.',
      service_unavailable: "My server is having a moment — try again in a bit!",
      feature_locked: "That's a Pro feature! I can chat all day — for desktop control, upgrade at clippyai.app 📎",
      ai_error: "Couldn't think straight — try again!",
      timeout: 'Took too long — try again!',
      network: "Can't reach my brain. Check your internet.",
      parse_error: 'Got a garbled response. Try again!',
    };
    return map[error] || detail || 'Something went wrong.';
  }

  private emit(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  // ========== API call with retry (NanoClaw pattern) ==========

  /**
   * Exponential backoff retry for transient failures (network, 502, rate limit).
   * Non-retryable errors (auth, quota, parse) return immediately.
   */
  private async callTurn(
    contents: Content[],
    opts: { user_profile?: string; proactive?: boolean; max_tokens?: number } = {},
  ): Promise<TurnResponse> {
    const MAX_RETRIES = 2;
    const BASE_DELAY_MS = 1500;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.callTurnOnce(contents, opts);
      // Don't retry non-transient errors
      if (!isError(result)) return result;
      if (['invalid_key', 'subscription_inactive', 'limit_reached', 'feature_locked', 'parse_error'].includes(result.error)) {
        return result;
      }
      // Retry transient errors (ai_error, network, timeout, rate_limited)
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        log.warn('Turn retry', { attempt: attempt + 1, error: result.error, delay_ms: delay });
        await new Promise((r) => setTimeout(r, delay));
      } else {
        return result;
      }
    }
    return { error: 'network' }; // unreachable but satisfies TS
  }

  private callTurnOnce(
    contents: Content[],
    opts: { user_profile?: string; proactive?: boolean; max_tokens?: number } = {},
  ): Promise<TurnResponse> {
    const licenseKey = getLicenseKey();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const req = net.request({ url: TURN_ENDPOINT, method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${licenseKey}`);
      req.setHeader('X-Client-Version', app.getVersion());

      const timeout = setTimeout(() => {
        log.error('Turn API timeout (60s)');
        req.abort();
        resolve({ error: 'timeout' });
      }, 60_000);

      req.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timeout);
          const elapsed = Date.now() - startTime;
          try {
            const parsed = JSON.parse(data) as TurnResponse;
            log.debug(`Turn response (${elapsed}ms)`, data.substring(0, 250));
            resolve(parsed);
          } catch (err) {
            log.error('Turn parse error', serializeErr(err));
            resolve({ error: 'parse_error' });
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Turn network error', serializeErr(err));
        resolve({ error: 'network' });
      });

      // tool_tiers — see buildToolTiers above. Server appends "[Tn]" to each
      // declared function's description and adds a "prefer lowest tier" line
      // to the system prompt. Forward-compatible: ignored if not yet wired.
      req.write(JSON.stringify({ contents, tool_tiers: buildToolTiers(), ...opts }));
      req.end();
    });
  }
}

export { settingsStore as brainSettingsStore };
