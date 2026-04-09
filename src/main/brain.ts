import { BrowserWindow, net } from 'electron';
import { takeScreenshot, getActiveWindow, isClawdCursorRunning, executeTool, restartClawdCursor } from './clawdbridge';
import { getLicenseKey } from './license';
import Store from 'electron-store';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';

const log = createLogger('Brain');
const API_BASE = 'https://api.clippyai.app';

// ========== Load Behavioral Guidance ==========

function loadGuidance(): string {
  const brainDir = path.join(__dirname, '../../assets/brain');
  const files = ['identity.md', 'core-behavior.md', 'tool-guide.md', 'app-knowledge.md', 'safety-rules.md'];
  const sections: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(brainDir, file), 'utf-8');
      sections.push(content);
    } catch (err) {
      log.warn(`Could not load guidance file: ${file}`, err);
    }
  }

  return sections.join('\n\n---\n\n');
}

const GUIDANCE = loadGuidance();
log.info('Loaded guidance files', { length: GUIDANCE.length });

// ========== System Prompts ==========

const CHAT_SYSTEM_PROMPT = `You are Clippy — 📎 the AI desktop buddy. You are NOT Copilot, ChatGPT, Gemini, or any other AI.

PERSONALITY: Witty, charming, concise (1-2 sentences max). Like a smart coworker.

You CAN see the user's screen and you CAN take actions on their computer (open apps, click, type, draw, browse, etc).

When the user asks you to DO something (open, click, type, draw, scroll, save, search, navigate, etc):
→ Respond with a short, enthusiastic confirmation like "On it!" or "Let me do that!" — keep it to ONE sentence.
→ Your hands (ClawdCursor agent) will handle the actual execution automatically.
→ NEVER say "I can't do that" — you CAN do everything.

When the user asks a QUESTION:
→ Just answer naturally. Be helpful and concise.

Current screen context:
{CONTEXT}`;

const QUESTION_SYSTEM_PROMPT = `You are Clippy — the AI desktop buddy. 📎 You are NOT Copilot, ChatGPT, Gemini, or any other AI. You are Clippy.

PERSONALITY: Witty, charming, concise (1-3 sentences max). Casual like a coworker.

The user is asking you a QUESTION. Answer it naturally. Be helpful and concise.

YES, you CAN see the user's screen. You have full desktop vision and screen awareness.
The screen context is provided below — use it to give contextual answers.

DO NOT use any [[ACTION:]] tags for questions. Just answer with text.

If asked "can you see my screen?" → "Of course! I can see everything on your screen. Right now you're in {app name}."
If asked "who are you?" → "I'm Clippy, your AI desktop buddy! 📎"

Current screen context:
{CONTEXT}`;

const PROACTIVE_SYSTEM_PROMPT = `You are Clippy — 📎 the AI desktop buddy. You can see the user's screen.

Glance at what they're doing. Only speak if you have a genuinely useful TIP or OBSERVATION.

RULES:
- Max 1 sentence. Be brief.
- NEVER say "I'll click that for you" or "Let me do that" — you're just OBSERVING here, not acting
- NEVER offer to perform actions — just give tips, observations, or encouragement
- If nothing useful to say, reply EXACTLY: __SILENT__
- Prefer __SILENT__ over repeating similar observations
- Don't comment on cookie banners, login screens, or routine UI elements
- Don't repeat advice about the same topic you already mentioned`;

const CONTINUE_PROMPT = `You just performed: {ACTION}
Result: {RESULT}
Current screen state: {SCREEN_STATE}

Original user request: "{USER_REQUEST}"

What's the next step? Reply with ONE action [[ACTION: ...]] or [[DONE]] if the task is complete.
Keep speech to 1 sentence max — or no speech, just the action.`;

// ========== Settings ==========

interface BrainSettings {
  proactiveInterval: number;
  proactiveEnabled: boolean;
  aiEndpoint: string;
}

const settingsStore = new Store<BrainSettings>({
  name: 'brain-settings',
  defaults: {
    proactiveInterval: 30000,
    proactiveEnabled: true,
    aiEndpoint: `${API_BASE}/chat`,
  },
});

// ========== Parsing ==========

const ACTION_REGEX = /\[\[ACTION:\s*(\w+)\(([^)]*)\)\s*\]\]/;
const DONE_MARKER = '[[DONE]]';
const MAX_STEPS = 5; // Keep tasks short and safe

function parseActionParam(toolName: string, raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // JSON object
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }

  // Clean quotes
  const cleaned = trimmed.replace(/^["']|["']$/g, '');
  const parts = cleaned.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));

  // Numeric pairs → coordinates
  if (parts.length === 2 && !isNaN(Number(parts[0])) && !isNaN(Number(parts[1]))) {
    return { x: Number(parts[0]), y: Number(parts[1]) };
  }
  if (parts.length === 4 && !isNaN(Number(parts[0]))) {
    return { startX: Number(parts[0]), startY: Number(parts[1]), endX: Number(parts[2]), endY: Number(parts[3]) };
  }
  if (parts.length === 3 && !isNaN(Number(parts[0]))) {
    // mouse_scroll: x, y, direction
    return { x: Number(parts[0]), y: Number(parts[1]), direction: parts[2] };
  }
  if (!isNaN(Number(cleaned))) {
    return { seconds: Number(cleaned) };
  }

  // Map single string param to the right key per tool
  const paramKeyMap: Record<string, string> = {
    open_app: 'name',
    smart_click: 'target',
    smart_type: 'target', // first param is target
    type_text: 'text',
    key_press: 'key',
    navigate_browser: 'url',
    focus_window: 'title',
  };

  const key = paramKeyMap[toolName] || 'target';
  return { [key]: cleaned };
}

// ========== Brain Class ==========

export class Brain {
  private win: BrowserWindow;
  private intervalId: NodeJS.Timeout | null = null;
  private mode: 'awake' | 'sleep' = 'sleep';
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private lastMessage: string = '';
  private noRepeatUntil: number = 0;
  private greetedOnWake: boolean = false;
  private isExecutingTask: boolean = false;

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

  private isSimilarToLast(message: string): boolean {
    if (!this.lastMessage) return false;
    // Extract key words (3+ chars, lowercase) and compare overlap
    const getWords = (s: string) => new Set(s.toLowerCase().match(/\b\w{3,}\b/g) || []);
    const currentWords = getWords(message);
    const lastWords = getWords(this.lastMessage);
    if (currentWords.size === 0 || lastWords.size === 0) return false;
    let overlap = 0;
    for (const word of currentWords) {
      if (lastWords.has(word)) overlap++;
    }
    // If more than 50% of words overlap, it's too similar
    const similarity = overlap / Math.min(currentWords.size, lastWords.size);
    return similarity > 0.5;
  }

  private isQuestionNotAction(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // Explicit action verbs ANYWHERE in the message → NOT a question
    const actionVerbs = [
      'open', 'click', 'type', 'scroll', 'save', 'close', 'navigate',
      'go to', 'search for', 'draw', 'send', 'write in', 'focus',
      'switch to', 'minimize', 'maximize', 'drag', 'paste', 'copy',
      'press', 'run', 'launch', 'start', 'stop', 'create', 'delete',
    ];
    // Check if ANY action verb appears anywhere in the text
    for (const verb of actionVerbs) {
      if (lower.includes(verb)) return false;
    }

    // Question indicators → IS a question
    const questionPatterns = [
      /^(what|who|why|how|when|where|which|can you explain|tell me|describe|explain|help me|do you know|is there|are there|could you|would you)/,
      /\?$/,  // Ends with question mark
    ];
    for (const pattern of questionPatterns) {
      if (pattern.test(lower)) return true;
    }

    // Default: if short and no clear action verb, treat as question
    if (lower.split(' ').length <= 5 && !actionVerbs.some(v => lower.includes(v))) {
      return true;
    }

    return false;
  }

  async handleUserMessage(text: string): Promise<string> {
    log.info('User message received', text);
    this.conversationHistory.push({ role: 'user', content: text });

    // Detect if this is a QUESTION or an ACTION REQUEST
    const isQuestion = this.isQuestionNotAction(text);
    log.info(`Message classified as: ${isQuestion ? 'QUESTION' : 'ACTION REQUEST'}`);

    // Get screen context (lightweight for questions, full for actions)
    let screenContext = '';
    try {
      const activeWin = await getActiveWindow();
      screenContext = `Active window: ${activeWin.text}`;
      if (!isQuestion) {
        // Full screen read only for action requests
        const screenData = await executeTool('read_screen', {});
        screenContext += `\nScreen elements: ${screenData.text?.substring(0, 500) || ''}`;
      }
    } catch {
      log.warn('Could not get screen context');
    }

    // Use different prompts for questions vs actions
    const systemPrompt = isQuestion
      ? QUESTION_SYSTEM_PROMPT.replace('{CONTEXT}', screenContext)
      : CHAT_SYSTEM_PROMPT.replace('{CONTEXT}', screenContext);

    const response = await this.callApi({
      message: text,
      context: screenContext,
      system: systemPrompt,
      history: this.conversationHistory.slice(-10),
      // webSearch disabled — googleSearchRetrieval not supported on current Gemini plan
      // webSearch: isQuestion,
    });

    // For questions, NEVER execute actions even if AI includes them
    if (isQuestion) {
      const cleanText = response.replace(new RegExp(ACTION_REGEX.source, 'g'), '').replace(DONE_MARKER, '').trim();
      log.info('Question answered (actions stripped)', cleanText?.substring(0, 100));
      this.conversationHistory.push({ role: 'assistant', content: cleanText });
      return cleanText || "I'm not sure about that.";
    }

    // For actions: delegate to ClawdCursor's agent (proper vision-based desktop agent)
    // GPT-4o decides what to do, ClawdCursor's agent actually does it
    const cleanText = response.replace(new RegExp(ACTION_REGEX.source, 'g'), '').replace(DONE_MARKER, '').trim();
    const spokenText = cleanText || 'On it!';
    this.conversationHistory.push({ role: 'assistant', content: spokenText });

    log.info('Action request — delegating to ClawdCursor agent', { userRequest: text });
    this.delegateToAgent(text);
    return spokenText;
  }

  private async delegateToAgent(userRequest: string): Promise<void> {
    if (this.isExecutingTask) {
      log.warn('Already executing a task — skipping');
      return;
    }
    this.isExecutingTask = true;

    try {
      // Check ClawdCursor
      const running = await isClawdCursorRunning();
      if (!running) {
        log.error('ClawdCursor not running — restarting');
        await restartClawdCursor();
        const retryRunning = await isClawdCursorRunning();
        if (!retryRunning) {
          this.emitToRenderer('clippy-speak', { text: "My tools aren't responding right now.", animate: 'Alert' });
          return;
        }
      }

      this.emitToRenderer('clippy-speak', { text: 'On it!', animate: 'Searching' });

      const history: Array<{ action: string; params: Record<string, unknown>; result: string }> = [];
      const MAX_AGENT_STEPS = 8;
      let lastSignature = '';
      let repeatCount = 0;
      const failedActions: Record<string, number> = {};

      for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
        log.info(`Agent step ${step}/${MAX_AGENT_STEPS}`);

        // Keep Clippy on top during long tasks
        if (!this.win.isDestroyed()) {
          this.win.setAlwaysOnTop(true, 'screen-saver');
        }

        // 1. Read screen as text (no images)
        let screenText = '';
        try {
          const screen = await executeTool('read_screen', {});
          screenText = screen.text || '';
        } catch (err) {
          log.error('Failed to read screen', err);
          screenText = 'Could not read screen';
        }

        // 2. Send to /agent endpoint
        const agentResponse = await this.callAgentApi(userRequest, screenText, history, step);

        if (!agentResponse) {
          this.emitToRenderer('clippy-speak', { text: "Lost connection to my brain.", animate: 'Alert' });
          break;
        }

        // Handle feature_locked (Basic plan trying to use desktop actions)
        if ((agentResponse as any)._error === 'feature_locked') {
          log.warn('Desktop actions locked for current plan');
          this.emitToRenderer('clippy-speak', {
            text: "Desktop automation needs Pro! 📎 Upgrade at clippyai.app/pricing to unlock me.",
            animate: 'Alert',
          });
          break;
        }

        log.info(`Agent step ${step} response`, {
          action: agentResponse.action,
          message: agentResponse.message,
          done: agentResponse.done,
        });

        // 3. Show status to user
        if (agentResponse.message) {
          this.emitToRenderer('clippy-speak', { text: agentResponse.message, animate: 'Searching' });
        }

        // 4. If done, finish
        if (agentResponse.done || !agentResponse.action) {
          this.emitToRenderer('clippy-speak', {
            text: agentResponse.message || 'Done! ✨',
            animate: 'Congratulate',
          });
          break;
        }

        // 5. Loop detection — break if same action+params repeated
        const signature = `${agentResponse.action}:${JSON.stringify(agentResponse.params)}`;
        if (signature === lastSignature) {
          repeatCount++;
          if (repeatCount >= 1) {
            log.warn(`Loop detected: ${signature} repeated — breaking`);
            this.emitToRenderer('clippy-speak', {
              text: "I'm stuck. Try giving me a more specific instruction!",
              animate: 'Alert',
            });
            break;
          }
        } else {
          repeatCount = 0;
        }
        lastSignature = signature;

        // Check if this action has already failed multiple times
        if ((failedActions[agentResponse.action] || 0) >= 2) {
          log.warn(`Action ${agentResponse.action} has failed 2+ times — breaking`);
          this.emitToRenderer('clippy-speak', {
            text: `${agentResponse.action} keeps failing. I'll stop here.`,
            animate: 'Alert',
          });
          break;
        }

        // 6. Execute the action
        try {
          const result = await executeTool(agentResponse.action, agentResponse.params);
          const resultText = result.text || 'Done';
          log.info(`Agent step ${step} executed: ${agentResponse.action}`, resultText.substring(0, 200));
          history.push({
            action: agentResponse.action,
            params: agentResponse.params,
            result: resultText,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`Agent step ${step} action failed: ${agentResponse.action}`, errMsg);
          failedActions[agentResponse.action] = (failedActions[agentResponse.action] || 0) + 1;
          history.push({
            action: agentResponse.action,
            params: agentResponse.params,
            result: `ERROR: ${errMsg.substring(0, 200)}`,
          });
        }

        // Wait briefly for UI to settle
        await new Promise((r) => setTimeout(r, 800));

        if (step === MAX_AGENT_STEPS) {
          this.emitToRenderer('clippy-speak', { text: "That's a complex task! I've done what I can.", animate: 'Wave' });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Agent loop failed', errMsg);
      this.emitToRenderer('clippy-speak', { text: `Hmm, that didn't work. ${errMsg.substring(0, 60)}`, animate: 'Alert' });
    } finally {
      this.isExecutingTask = false;
      if (!this.win.isDestroyed()) {
        this.win.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  }

  private callAgentApi(
    task: string,
    screenText: string,
    history: Array<{ action: string; params: Record<string, unknown>; result: string }>,
    step: number,
  ): Promise<{ action: string | null; params: Record<string, unknown>; message: string; done: boolean } | null> {
    const endpoint = settingsStore.get('aiEndpoint').replace('/chat', '/agent');
    const licenseKey = getLicenseKey();

    log.debug('Agent API request', { task: task.substring(0, 80), step, historyLength: history.length });
    const startTime = Date.now();

    return new Promise((resolve) => {
      const req = net.request({ url: endpoint, method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${licenseKey}`);

      req.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          const elapsed = Date.now() - startTime;
          log.debug(`Agent API response (${elapsed}ms)`, data.substring(0, 300));

          try {
            const result = JSON.parse(data);
            if (result.error) {
              log.warn('Agent API error', result.error);
              // Pass error info back so the loop can show a useful message
              resolve({
                action: null,
                params: {},
                message: result.message || result.error,
                done: true,
                _error: result.error,
              } as any);
              return;
            }
            resolve(result);
          } catch (err) {
            log.error('Agent API parse error', String(err));
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        log.error('Agent API network error', String(err));
        resolve(null);
      });

      req.write(JSON.stringify({ task, screenText, history, step }));
      req.end();
    });
  }

  // ========== Proactive Loop ==========

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
    if (this.isExecutingTask) return; // Don't interrupt active tasks

    try {
      const running = await isClawdCursorRunning();
      if (!running) {
        // Auto-restart ClawdCursor
        restartClawdCursor();
        if (!this.greetedOnWake) {
          this.greetedOnWake = true;
          this.emitToRenderer('clippy-speak', {
            text: "Hi! Click me to chat. I can help with whatever you're working on!",
            animate: 'Wave',
          });
          this.noRepeatUntil = Date.now() + 120_000;
        }
        return;
      }

      // Always take screenshot — Clippy sees everything
      const [screenshot, activeWin] = await Promise.allSettled([
        takeScreenshot(),
        getActiveWindow(),
      ]);

      const context = activeWin.status === 'fulfilled'
        ? `User is working in: ${activeWin.value.text}`
        : 'Unknown application';

      const screenshotData = screenshot.status === 'fulfilled'
        ? screenshot.value.image?.data
        : undefined;

      const message = await this.callProactive(context, screenshotData);

      if (message && message.trim() && !this.isSimilarToLast(message)) {
        this.lastMessage = message;
        this.emitToRenderer('clippy-speak', { text: message, animate: 'Suggest' });
        // After speaking, wait at least 2 minutes before next proactive message
        this.noRepeatUntil = Date.now() + 120_000;
      }
    } catch (err) {
      log.error('Proactive check failed', err);
      this.noRepeatUntil = Date.now() + 120_000;
    }
  }

  private callProactive(context: string, screenshotBase64?: string): Promise<string> {
    return this.callApi({
      message: '__PROACTIVE_CHECK__',
      context,
      screenshot: screenshotBase64,
      system: PROACTIVE_SYSTEM_PROMPT,
      history: this.conversationHistory.slice(-6),
    }).then((reply) => (reply === '__SILENT__' ? '' : reply));
  }

  // ========== API Call ==========

  private callApi(payload: Record<string, unknown>): Promise<string> {
    const endpoint = settingsStore.get('aiEndpoint');
    const licenseKey = getLicenseKey();
    const isProactive = payload.message === '__PROACTIVE_CHECK__';
    const logPrefix = isProactive ? 'Proactive' : 'Chat';

    log.debug(`${logPrefix} API request`, {
      message: typeof payload.message === 'string' ? payload.message.substring(0, 100) : '',
      hasScreenshot: !!payload.screenshot,
    });

    const startTime = Date.now();

    return new Promise((resolve) => {
      const req = net.request({ url: endpoint, method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${licenseKey}`);

      req.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          const elapsed = Date.now() - startTime;
          log.debug(`${logPrefix} API response (${elapsed}ms)`, data.substring(0, 300));

          try {
            const result = JSON.parse(data) as Record<string, string>;
            if (result.error) {
              log.warn(`${logPrefix} API error: ${result.error}`);
              const errorMessages: Record<string, string> = {
                limit_reached: "Monthly quota used up! Upgrade for more.",
                invalid_key: 'License key invalid.',
                subscription_inactive: 'Subscription inactive.',
                ai_error: 'Brain hiccup! Try again.',
              };
              resolve(errorMessages[result.error] || `Error: ${result.error}`);
            } else {
              const reply = result.reply || result.message || result.text;
              log.info(`${logPrefix} reply (${elapsed}ms)`, reply?.substring(0, 200));
              resolve(reply || "Hmm, nothing to say.");
            }
          } catch {
            log.error(`${logPrefix} parse error`, data.substring(0, 200));
            resolve("Trouble connecting. Try again!");
          }
        });
      });

      req.on('error', (err) => {
        log.error(`${logPrefix} network error`, String(err));
        resolve("Can't reach my brain. Try again!");
      });

      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  private emitToRenderer(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }
}

export { settingsStore as brainSettingsStore };
