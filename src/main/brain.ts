import { BrowserWindow, net } from 'electron';
import { executeTool } from './tools';
import { getLicenseKey, getPlan } from './license';
import Store from 'electron-store';
import { createLogger } from './logger';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const log = createLogger('Brain');
const API_BASE = 'https://api.clippyai.app';

// ========== Load Behavioral Guidance ==========

function loadGuidance(): string {
  const brainDir = path.join(__dirname, '../../assets/brain');
  const files = ['identity.md', 'core-behavior.md', 'tool-guide.md', 'app-knowledge.md', 'safety-rules.md', 'conversation-style.md'];
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

// ========== User Profile ==========

function getUserProfilePath(): string {
  return path.join(app.getPath('userData'), 'user.md');
}

function loadUserProfile(): string {
  try {
    const profilePath = getUserProfilePath();
    if (fs.existsSync(profilePath)) {
      return fs.readFileSync(profilePath, 'utf-8');
    }
  } catch (err) {
    log.warn('Could not load user profile', err);
  }
  return '';
}

export function saveUserProfile(data: Record<string, string>): void {
  const lines = ['# User Profile', ''];
  for (const [key, value] of Object.entries(data)) {
    if (value) lines.push(`- **${key}:** ${value}`);
  }
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
  let match;
  while ((match = regex.exec(content)) !== null) {
    profile[match[1]] = match[2];
  }
  return profile;
}

export function isProfileSetUp(): boolean {
  const profile = getUserProfile();
  return !!profile['Name'];
}

// ========== System Prompts ==========

function buildChatPrompt(): string {
  const profile = loadUserProfile();
  const profileSection = profile ? `\n--- USER PROFILE ---\n${profile}\n` : '';
  const plan = getPlan() || 'unknown';

  return `${GUIDANCE}

--- CURRENT SESSION ---
${profileSection}
User's plan: ${plan}

When the user asks you to DO something → short confirmation ("On it!"), then your tools handle it.
When the user asks a QUESTION → answer directly from your knowledge. NEVER open a browser for questions.

Current screen context:
{CONTEXT}`;
}

// Legacy constant aliases (for proactive + question prompts)

function buildQuestionPrompt(): string {
  const profile = loadUserProfile();
  const profileSection = profile ? `\n--- USER PROFILE ---\n${profile}\n` : '';
  const plan = getPlan() || 'unknown';

  return `${GUIDANCE}

--- CURRENT SESSION ---
${profileSection}
User's plan: ${plan}

MODE: QUESTION — The user is asking a question. Answer it directly.

CRITICAL RULES FOR QUESTIONS:
- Answer from your knowledge. You KNOW weather, facts, definitions, news, math, translations.
- NEVER open a browser, app, or website to answer a question.
- NEVER say "I don't have access to weather" or "I can't check" — just give your best answer.
- NEVER use [[ACTION:]] tags. Just answer with plain text.
- If asked "who are you?" → "I'm Clippy, your AI desktop buddy! 📎"
- If asked "what's my name?" → use the name from the user profile.
- Keep answers to 1-3 sentences. Your speech bubble is small.

Current screen context:
{CONTEXT}`;
}

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

// Used to strip legacy action tags from AI responses
const ACTION_REGEX = /\[\[ACTION:\s*(\w+)\(([^)]*)\)\s*\]\]/;
const DONE_MARKER = '[[DONE]]';

// ========== Brain Class ==========

export class Brain {
  private win: BrowserWindow;
  private intervalId: NodeJS.Timeout | null = null;
  private mode: 'awake' | 'sleep' = 'sleep';
  private conversationHistory: Array<{ role: string; content: string }> = [];
  private static readonly MAX_HISTORY = 50;
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

  // ── Animation picker ────────────────────────────────────────────
  private pickAnimation(context: 'question_processing' | 'question_answered' | 'action_start' | 'action_typing' | 'action_complete' | 'error' | 'proactive' | 'upgrade' | 'greeting'): string {
    switch (context) {
      case 'question_processing': return 'Thinking';
      case 'question_answered': return 'Wave';
      case 'action_start': return 'Searching';
      case 'action_typing': return 'Writing';
      case 'action_complete': return 'Congratulate';
      case 'error': return 'Alert';
      case 'proactive': return 'Suggest';
      case 'upgrade': return 'GetAttention';
      case 'greeting': return 'Wave';
      default: return 'Wave';
    }
  }

  // ── Answer animation picker ────────────────────────────────────
  private pickAnswerAnimation(userText: string, reply: string): string {
    const lower = userText.toLowerCase();
    const replyLower = reply.toLowerCase();

    // Playful requests → fun animations
    if (/trick|dance|entertain|show me|cool|funny|surprise|perform/.test(lower)) {
      const funAnims = ['Congratulate', 'Wave', 'GetAttention', 'IdleAtom', 'IdleRopePile'];
      return funAnims[Math.floor(Math.random() * funAnims.length)];
    }
    // Greeting → Wave
    if (/^(hi|hey|hello|sup|yo|what'?s up|howdy)/i.test(lower)) return 'Wave';
    // Error/sorry in reply → Alert
    if (/sorry|error|can't|couldn't|failed|wrong/.test(replyLower)) return 'Alert';
    // Success/celebration → Congratulate
    if (/done|success|great|perfect|awesome|ta-da|congratul/.test(replyLower)) return 'Congratulate';
    // Advice/tip → Suggest
    if (/tip|suggest|recommend|try |you could|you should/.test(replyLower)) return 'Suggest';
    // Thinking/pondering → Thinking
    if (/hmm|let me think|interesting|good question/.test(replyLower)) return 'Thinking';

    return 'Wave'; // default
  }

  // ── Web-knowledge detector ────────────────────────────────────
  private isWebKnowledgeQuery(text: string): boolean {
    const lower = text.toLowerCase();
    const webTopics = [
      'weather', 'weathe', 'wetahe', 'weaher', 'wheather', // common typos
      'temperature', 'forecast',
      'stock', 'market', 'price of',
      'news', 'latest', 'headline',
      'define', 'definition', 'meaning of',
      'translate', 'translation',
      'calculate', 'convert', 'how much is',
      'what time', 'time zone', 'time in',
      'who is', 'who was', 'what is', 'what was', 'what are',
      'when is', 'when was', 'when did',
      'where is', 'where was',
      'how many', 'how old', 'how far', 'how long',
      'population', 'capital of', 'president',
      'score', 'results', 'standings',
      'exchange rate', 'currency',
      'recipe', 'ingredients',
    ];
    if (webTopics.some(topic => lower.includes(topic))) return true;

    // Fuzzy match: if the message is short and contains "like" + location pattern → probably weather
    if (/(?:like|in|at)\s+(?:la|nyc|sf|london|tokyo|paris|chicago|miami|seattle|boston|dallas)/i.test(lower)) return true;

    return false;
  }

  private isQuestionNotAction(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // Web-knowledge queries are ALWAYS questions, even if they contain "search"
    if (this.isWebKnowledgeQuery(lower)) return true;

    // Explicit action verbs ANYWHERE in the message → NOT a question
    const actionVerbs = [
      'open', 'click', 'type', 'scroll', 'save', 'close', 'navigate',
      'go to', 'draw', 'send', 'write in', 'focus',
      'switch to', 'minimize', 'maximize', 'drag', 'paste', 'copy',
      'press', 'run', 'launch', 'start', 'stop', 'create', 'delete',
    ];
    // NOTE: "search for" removed from action verbs — it's ambiguous and
    // now handled by the web-knowledge check above
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
    if (lower.split(' ').length <= 5) {
      return true;
    }

    return false;
  }

  async handleUserMessage(text: string): Promise<string> {
    log.info('User message received', text);
    this.conversationHistory.push({ role: 'user', content: text });
    // Cap history to prevent memory growth
    if (this.conversationHistory.length > Brain.MAX_HISTORY) {
      this.conversationHistory = this.conversationHistory.slice(-Brain.MAX_HISTORY);
    }

    // Detect if this is a QUESTION or an ACTION REQUEST
    const isQuestion = this.isQuestionNotAction(text);
    log.info(`Message classified as: ${isQuestion ? 'QUESTION' : 'ACTION REQUEST'}`);

    // Get screen context (with timeout so questions aren't blocked by slow tools)
    let screenContext = '';
    try {
      const contextPromise = (async () => {
        const activeWin = await executeTool('get_active_window', {});
        let ctx = `Active window: ${activeWin.text}`;
        if (!isQuestion) {
          const screenData = await executeTool('read_screen', {});
          ctx += `\nScreen elements: ${screenData.text?.substring(0, 500) || ''}`;
        }
        return ctx;
      })();
      // Don't let screen reading block questions for more than 3 seconds
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), isQuestion ? 3000 : 8000));
      screenContext = await Promise.race([contextPromise, timeout]);
    } catch {
      log.warn('Could not get screen context');
    }

    // Show thinking animation for questions while waiting for API
    if (isQuestion) {
      this.mainWindow.webContents.send('play-animation', this.pickAnimation('question_processing'));
    }

    // Use different prompts for questions vs actions
    const systemPrompt = isQuestion
      ? buildQuestionPrompt().replace('{CONTEXT}', screenContext)
      : buildChatPrompt().replace('{CONTEXT}', screenContext);

    let response = await this.callApi({
      message: text,
      context: screenContext,
      system: systemPrompt,
      history: this.conversationHistory.slice(-10),
      webSearch: isQuestion && this.isWebKnowledgeQuery(text),
    });

    // Log Clippy's raw response for debugging
    log.info('Clippy raw response', { isQuestion, responseLength: response?.length, response: response?.substring(0, 200) });

    // Safety net — never let undefined/null/empty reach the user
    if (!response || response === 'undefined' || response === 'null') {
      log.warn('Empty/undefined response from API — using fallback');
      response = "Hmm, my brain glitched. Try asking again! 📎";
    }

    // Auto-detect name introduction and save to profile
    if (!isProfileSetUp()) {
      const nameMatch = text.match(/(?:my name is|i'm|i am|call me|it's|its|this is|hey i'm|yo i'm|name's)\s+([A-Za-z]{2,20})/i)
        || text.match(/^([A-Z][a-z]{1,20})$/); // Just a single capitalized word like "Amr"
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        saveUserProfile({ Name: capitalized });
        log.info('User introduced themselves', { name: capitalized });
        // Override the AI response with a personalized greeting
        this.conversationHistory.push({ role: 'assistant', content: `Nice to meet you, ${capitalized}! 📎` });
        return `Nice to meet you, ${capitalized}! I'll remember that. How can I help? 📎`;
      }
    }

    // For questions, NEVER execute actions even if AI includes them
    if (isQuestion) {
      const cleanText = response.replace(new RegExp(ACTION_REGEX.source, 'g'), '').replace(DONE_MARKER, '').trim();
      log.info('Question answered (actions stripped)', cleanText?.substring(0, 100));
      this.conversationHistory.push({ role: 'assistant', content: cleanText });

      // Pick a contextual animation for the answer
      const answerAnim = this.pickAnswerAnimation(text, cleanText);
      if (answerAnim !== 'Wave') {
        this.mainWindow.webContents.send('play-animation', answerAnim);
      }

      const finalAnswer = cleanText || "I'm not sure about that.";
      log.info('Clippy says (question)', finalAnswer.substring(0, 150));
      return finalAnswer;
    }

    // For actions: delegate to agent
    // GPT-4o decides what to do, ClawdCursor's agent actually does it
    const cleanText = response.replace(new RegExp(ACTION_REGEX.source, 'g'), '').replace(DONE_MARKER, '').trim();
    const spokenText = cleanText || 'On it!';
    this.conversationHistory.push({ role: 'assistant', content: spokenText });

    log.info('Clippy says (action)', spokenText.substring(0, 150));
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
      // Tools are in-process — always available, no server to check
      this.emitToRenderer('clippy-speak', { text: 'On it!', animate: this.pickAnimation('action_start') });

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
          this.emitToRenderer('clippy-speak', { text: "Lost connection to my brain.", animate: this.pickAnimation('error') });
          break;
        }

        // Handle feature_locked (Basic plan trying to use desktop actions)
        if ((agentResponse as any)._error === 'feature_locked') {
          log.warn('Desktop actions locked for current plan');
          this.emitToRenderer('clippy-speak', {
            text: "That's a Pro feature! I can chat all day, but to control your desktop you'd need to upgrade at clippyai.app 📎",
            animate: this.pickAnimation('upgrade'),
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
                    // Pick animation based on what the agent is doing
          const stepAnim = (agentResponse.action === 'type_text' || agentResponse.action === 'smart_type')
            ? this.pickAnimation('action_typing')
            : this.pickAnimation('action_start');
          if (agentResponse.message) {
            this.emitToRenderer('clippy-speak', { text: agentResponse.message, animate: stepAnim });
          }
        }

        // 4. If done, finish
        if (agentResponse.done || !agentResponse.action) {
          this.emitToRenderer('clippy-speak', {
            text: agentResponse.message || 'Done! ✨',
            animate: this.pickAnimation('action_complete'),
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
              animate: this.pickAnimation('error'),
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
            animate: this.pickAnimation('error'),
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
          this.emitToRenderer('clippy-speak', { text: "That's a complex task! I've done what I can.", animate: this.pickAnimation('action_complete') });
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
    // Always use hardcoded API — never trust stored value (could be stale/wrong)
    const endpoint = `${API_BASE}/agent`;
    const licenseKey = getLicenseKey();

    log.debug('Agent API request', { task: task.substring(0, 80), step, historyLength: history.length });
    const startTime = Date.now();

    return new Promise((resolve) => {
      const req = net.request({ url: endpoint, method: 'POST' });
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', `Bearer ${licenseKey}`);

      // Timeout: abort after 60 seconds
      const timeout = setTimeout(() => {
        log.error('Agent API timeout (60s)');
        req.abort();
        resolve(null);
      }, 60_000);

      req.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          clearTimeout(timeout);
          const elapsed = Date.now() - startTime;
          log.debug(`Agent API response (${elapsed}ms)`, data.substring(0, 300));

          try {
            const result = JSON.parse(data);
            if (result.error) {
              log.warn('Agent API error', result.error);
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
        clearTimeout(timeout);
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
      if (!this.greetedOnWake) {
        this.greetedOnWake = true;
        this.emitToRenderer('clippy-speak', {
          text: "Hi! Click me to chat. I can help with whatever you're working on!",
          animate: 'Wave',
        });
        this.noRepeatUntil = Date.now() + 120_000;
        return;
      }

      // Read screen context for proactive tips
      const [screenText, activeWin] = await Promise.allSettled([
        executeTool('read_screen', {}),
        executeTool('get_active_window', {}),
      ]);

      const context = activeWin.status === 'fulfilled'
        ? `User is working in: ${activeWin.value.text}`
        : 'Unknown application';

      const textData = screenText.status === 'fulfilled' ? screenText.value.text : '';
      let screenshotData: string | undefined;
      if (!textData || textData.length < 30) {
        try {
          const ss = await executeTool('desktop_screenshot', {});
          screenshotData = ss.image?.data;
        } catch { /* continue without screenshot */ }
      }

      const fullContext = textData
        ? `${context}\nScreen text: ${textData.substring(0, 800)}`
        : context;

      const message = await this.callProactive(fullContext, screenshotData);

      if (message && typeof message === 'string' && message.trim() && !this.isSimilarToLast(message)) {
        this.lastMessage = message;
        this.emitToRenderer('clippy-speak', { text: message.trim(), animate: this.pickAnimation('proactive') });
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
    // Always use hardcoded API — never trust stored value (could be stale/wrong)
    const endpoint = `${API_BASE}/chat`;
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

      // Timeout: abort after 30 seconds
      const timeout = setTimeout(() => {
        log.error(`${logPrefix} API timeout (30s)`);
        req.abort();
        resolve("Took too long — try again!");
      }, 30_000);

      req.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk.toString(); });
        response.on('end', () => {
          clearTimeout(timeout);
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
        clearTimeout(timeout);
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
