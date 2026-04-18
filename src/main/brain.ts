/**
 * Brain — ClippyAI's agent loop on the client side.
 *
 * Calls the unified /v1/turn backend endpoint which runs Gemini with native
 * function calling. No JSON-in-text. No regex parsing of model output.
 * Tool calls come back as structured `functionCall` parts; we execute them
 * locally via tools.ts and feed results back as `functionResponse` parts.
 *
 * The server owns the system prompt (identity, date, plan, tool schema).
 * The client owns the conversation loop and local tool execution.
 */

import { BrowserWindow, net, app } from 'electron';
import { executeTool } from './tools';
import { getLicenseKey } from './license';
import Store from 'electron-store';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';

const log = createLogger('Brain');
const API_BASE = 'https://api.clippyai.app';
const TURN_ENDPOINT = `${API_BASE}/v1/turn`;

/**
 * Tools that modify the screen state. After these fire, we inject a fresh
 * read_screen into the tool's functionResponse so the model sees what
 * actually happened, not what it hoped happened. Fixes the "blind after
 * step 1" problem that caused multi-step tasks to drift.
 */
const UI_MODIFYING_TOOLS = new Set([
  'open_app',
  'focus_window',
  'smart_click',
  'smart_type',
  'type_text',
  'key_press',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_drag',
  'mouse_scroll',
  'navigate_browser',
  'write_clipboard',
]);

// ========== Gemini content shape (local types — no runtime SDK dep) ==========

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
    proactiveInterval: 30000,
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
  private static readonly MAX_HISTORY = 20;
  private lastProactiveMessage = '';
  private noRepeatUntil = 0;
  private greetedOnWake = false;
  private isExecuting = false;

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  setMode(mode: 'awake' | 'sleep'): void {
    this.mode = mode;
    if (mode === 'awake') {
      this.greetedOnWake = false;
      this.noRepeatUntil = 0;
      this.startLoop();
    } else {
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
    log.info('User message', text.substring(0, 120));

    // Name introduction — handled client-side for deterministic UX
    if (!isProfileSetUp()) {
      const match = text.match(/(?:my name is|call me|i'm called|name's)\s+([A-Za-z]{2,20})/i);
      if (match) {
        const name = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        saveUserProfile({ Name: name });
        const greeting = `Nice to meet you, ${name}! I'll remember that. How can I help? 📎`;
        this.pushHistory({ role: 'user', parts: [{ text }] });
        this.pushHistory({ role: 'model', parts: [{ text: greeting }] });
        this.emit('clippy-speak', { text: greeting, animate: 'Wave' });
        return greeting;
      }
    }

    if (this.isExecuting) {
      log.warn('Already executing — dropping new message');
      return "I'm still working on the last thing — hang on!";
    }
    this.isExecuting = true;

    try {
      this.emit('play-animation', 'Thinking');

      // Build initial user message — add screen context if we can grab it fast
      const screenContext = await this.captureScreenContext(2500);
      const initialText = screenContext
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

      // 15 gives room for verification interleaved with real work.
      const MAX_STEPS = 15;
      let finalSpoken = '';
      let taskCompleted = false;

      for (let step = 0; step < MAX_STEPS; step++) {
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

        const resp = await this.callTurn(contents, { user_profile: userProfile });

        if (isError(resp)) {
          const msg = this.errorMessage(resp.error, resp.detail || resp.message);
          this.emit('clippy-speak', { text: msg, animate: 'Alert' });
          finalSpoken = msg;
          break;
        }

        // Separate text and function-call parts
        const texts = resp.parts.filter(isText).map((p) => p.text);
        const calls = resp.parts.filter(isFunctionCall).map((p) => p.functionCall);
        const spoken = texts.join(' ').trim();

        // Emit text to bubble — structured, clean, no stripping needed
        if (spoken) {
          const anim = this.pickAnimation(text, spoken, calls.length > 0);
          this.emit('clippy-speak', { text: spoken, animate: anim });
          finalSpoken = spoken;
        }

        // === SENTINEL: task_complete ===
        // Gemini signals task end by calling task_complete(summary=...). This
        // replaces the unreliable "empty tool calls = done" heuristic that
        // caused silent exits mid-task.
        const completeCall = calls.find((c) => c.name === 'task_complete');
        if (completeCall) {
          const summary = String(
            (completeCall.args as { summary?: string }).summary || 'Done!',
          );
          this.emit('clippy-speak', { text: summary, animate: 'Congratulate' });
          finalSpoken = summary;
          taskCompleted = true;
          break;
        }

        // Fallback: no tool calls → done (or ambiguous)
        if (calls.length === 0 || resp.done) {
          if (calls.length === 0 && !spoken) {
            finalSpoken = "I'm not sure what to do — can you rephrase?";
            this.emit('clippy-speak', { text: finalSpoken, animate: 'Alert' });
          }
          break;
        }

        // Append model turn to working contents
        contents.push({ role: 'model', parts: resp.parts });

        // Execute each function call, collect responses
        const responseParts: FunctionResponsePart[] = [];
        for (const call of calls) {
          log.info(`Tool[${step + 1}] ${call.name}`, JSON.stringify(call.args).substring(0, 200));
          try {
            const result = await executeTool(call.name, call.args);
            const resultText = result.text || JSON.stringify(result).substring(0, 500);

            // === VERIFICATION: inject fresh screen state after UI-modifying tools ===
            // Gemini used to go blind after step 1 (screen only captured at start).
            // Now every UI-modifying tool gets paired with a fresh screen snapshot
            // so the model can verify what actually happened.
            let screenAfter: string | undefined;
            if (UI_MODIFYING_TOOLS.has(call.name)) {
              try {
                const screen = await executeTool('read_screen', {});
                if (screen.text) screenAfter = screen.text.substring(0, 1500);
              } catch {
                /* best effort — don't fail the task over a missed verification */
              }
            }

            responseParts.push({
              functionResponse: {
                name: call.name,
                response: {
                  result: resultText.substring(0, 800),
                  ...(screenAfter ? { screen_after: screenAfter } : {}),
                },
              },
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`Tool ${call.name} failed`, msg);
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
          const capMsg = "That's a long task — stopping here for now!";
          this.emit('clippy-speak', { text: capMsg, animate: 'Congratulate' });
          finalSpoken = capMsg;
        }
      }

      if (finalSpoken) {
        this.pushHistory({ role: 'model', parts: [{ text: finalSpoken }] });
      }
      return finalSpoken || "I'm not sure what to say.";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('handleUserMessage threw', msg);
      this.emit('clippy-speak', { text: "Hmm, that didn't work. Try again!", animate: 'Alert' });
      return 'Something went wrong.';
    } finally {
      this.isExecuting = false;
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
    if (this.mode !== 'awake') return;
    if (!settingsStore.get('proactiveEnabled')) return;
    if (Date.now() < this.noRepeatUntil) return;
    if (this.isExecuting) return;

    try {
      if (!this.greetedOnWake) {
        this.greetedOnWake = true;
        this.emit('clippy-speak', {
          text: "Hi! Click me to chat. I can help with whatever you're working on!",
          animate: 'Wave',
        });
        this.noRepeatUntil = Date.now() + 120_000;
        return;
      }

      const context = await this.captureScreenContext(3000);
      if (!context) return;

      const resp = await this.callTurn(
        [{ role: 'user', parts: [{ text: `Current screen:\n${context}` }] }],
        { proactive: true, max_tokens: 120 },
      );

      if (isError(resp)) return;

      const reply = resp.parts
        .filter(isText)
        .map((p) => p.text)
        .join(' ')
        .trim();

      if (!reply || reply.includes('__SILENT__')) return;
      if (this.isSimilarToLast(reply)) return;

      this.lastProactiveMessage = reply;
      log.info(`Proactive tip: ${reply.substring(0, 80)}`);
      this.emit('clippy-speak', { text: reply, animate: 'Suggest' });
      this.noRepeatUntil = Date.now() + 120_000;
    } catch (err) {
      log.error('proactiveCheck failed', err);
      this.noRepeatUntil = Date.now() + 120_000;
    }
  }

  // ========== Helpers ==========

  private async captureScreenContext(timeoutMs: number): Promise<string> {
    try {
      const promise = (async () => {
        const [active, screen] = await Promise.allSettled([
          executeTool('get_active_window', {}),
          executeTool('read_screen', {}),
        ]);
        const activeText = active.status === 'fulfilled' ? active.value.text : '';
        const screenText = screen.status === 'fulfilled' ? screen.value.text : '';
        if (!activeText && !screenText) return '';
        // 3000 chars gives Gemini enough to see meaningful UI structure
        // (was 800 — too small for modern apps, Gemini was blind).
        return `Active: ${activeText || 'unknown'}\nScreen: ${(screenText || '').substring(0, 3000)}`;
      })();
      const timeout = new Promise<string>((r) => setTimeout(() => r(''), timeoutMs));
      return await Promise.race([promise, timeout]);
    } catch {
      return '';
    }
  }

  /**
   * Pick a Clippy animation based on user intent + reply content.
   * Clippy has 43 animations in the sprite — this picker uses ~30 of them with
   * randomness inside each category so the character feels alive, not robotic.
   * Full list: Alert, CheckingSomething, Congratulate, EmptyTrash, Explain,
   * GestureDown/Left/Right/Up, GetArtsy, GetAttention, GetTechy, GetWizardy,
   * GoodBye, Greeting, Hearing_1, Idle*, LookDown*, LookLeft, LookRight,
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
      return pick(['Explain', 'GestureUp', 'GestureLeft', 'GestureRight', 'Hearing_1']);
    }

    // Reply content-based
    if (/sorry|error|can'?t|couldn'?t|failed|wrong|oops|hmm,? that/.test(r)) return 'Alert';
    if (/done|success|great|perfect|awesome|ta-?da|congratul|finished|complete/.test(r)) {
      return pick(['Congratulate', 'GetAttention']);
    }
    if (/tip|suggest|recommend|try |you could|you should|maybe/.test(r)) return 'Suggest';
    if (/hmm|let me think|interesting|good question|not sure/.test(r)) {
      return pick(['Thinking', 'CheckingSomething', 'LookUp', 'LookUpLeft', 'LookUpRight']);
    }
    if (/look|see|check|here|there/.test(r)) {
      return pick(['LookLeft', 'LookRight', 'LookDown', 'LookDownLeft', 'LookDownRight']);
    }

    // Default: a small wave/greeting or a subtle idle gesture
    return pick(['Wave', 'Greeting', 'GestureUp', 'Explain']);
  }

  private isSimilarToLast(message: string): boolean {
    if (!this.lastProactiveMessage) return false;
    const words = (s: string) => new Set(s.toLowerCase().match(/\b\w{3,}\b/g) || []);
    const a = words(message);
    const b = words(this.lastProactiveMessage);
    if (a.size === 0 || b.size === 0) return false;
    let overlap = 0;
    for (const w of a) if (b.has(w)) overlap++;
    return overlap / Math.min(a.size, b.size) > 0.5;
  }

  private pushHistory(msg: Content): void {
    this.history.push(msg);
    if (this.history.length > Brain.MAX_HISTORY) {
      this.history = this.history.slice(-Brain.MAX_HISTORY);
    }
  }

  private errorMessage(error: string, detail?: string): string {
    const map: Record<string, string> = {
      limit_reached: 'Monthly quota used up! Upgrade for more.',
      invalid_key: 'License key invalid.',
      subscription_inactive: 'Subscription inactive.',
      feature_locked: "That's a Pro feature! I can chat all day — for desktop control, upgrade at clippyai.app 📎",
      ai_error: 'Brain hiccup! Try again.',
      timeout: 'Took too long — try again!',
      network: "Can't reach my brain. Check your internet.",
      parse_error: 'Got a garbled response. Try again!',
    };
    return map[error] || detail || 'Something went wrong.';
  }

  private emit(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  // ========== API call ==========

  private callTurn(
    contents: Content[],
    opts: { user_profile?: string; proactive?: boolean; max_tokens?: number } = {},
  ): Promise<TurnResponse> {
    const licenseKey = getLicenseKey();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const req = net.request({ url: TURN_ENDPOINT, method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${licenseKey}`);

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
            log.error('Turn parse error', String(err));
            resolve({ error: 'parse_error' });
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Turn network error', String(err));
        resolve({ error: 'network' });
      });

      req.write(JSON.stringify({ contents, ...opts }));
      req.end();
    });
  }
}

export { settingsStore as brainSettingsStore };
