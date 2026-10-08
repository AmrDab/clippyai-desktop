/**
 * agent-tools.ts — v0.21 "Connect an agent".
 *
 * The seven MCP tools an outside agent gets when it connects to Clippy
 * (clippy_say / clippy_animate / clippy_point_at / clippy_ask_user /
 * clippy_screenshot / clippy_status / clippy_run_tool). Everything that
 * touches Electron, the brain, or the tool dispatcher comes in through
 * `AgentToolDeps` so the handlers are unit-testable with plain mocks;
 * agent-connect.ts wires the real implementations.
 *
 * Collision rule: an agent call is refused with a "busy" error while
 * Clippy's own brain turn is executing, and brain.ts refuses a new user /
 * proactive turn while `isAgentBusy()` — one driver at a time.
 */

import { z } from 'zod';
import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolResult } from './types/tool-result';
import type { ActionClass } from './tool-meta';
import type { ApprovalResult } from './approval';
import type { ClassDecision } from './permission-policy';
import { createLogger } from './logger';

const log = createLogger('AgentTools');

export const AGENT_ANIMATIONS = [
  'Wave', 'GoodBye', 'Greeting', 'Congratulate', 'GetArtsy', 'GetAttention',
  'GetTechy', 'GetWizardy', 'Searching', 'Thinking', 'Writing', 'Processing',
  'CheckingSomething', 'Alert', 'Explain', 'Print', 'Save', 'SendMail',
  'EmptyTrash', 'RestPose', 'GestureUp', 'GestureDown', 'GestureLeft',
  'GestureRight', 'LookUp', 'LookDown', 'LookLeft', 'LookRight',
] as const;
export type AgentAnimation = (typeof AGENT_ANIMATIONS)[number];

/** Bubble text cap — a bubble is a glance, not a document. */
export const SAY_MAX_CHARS = 600;
export const ASK_DEFAULT_TIMEOUT_S = 60;
export const ASK_MAX_TIMEOUT_S = 300;

export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayInfo { id: number; bounds: Rect; workArea: Rect; scaleFactor: number; primary: boolean }

export interface AgentToolDeps {
  platform: NodeJS.Platform;
  version: string;
  /** Names of Clippy desktop tools an agent may ask for via clippy_run_tool. */
  allowedTools: () => string[];
  isBrainBusy: () => boolean;
  /** Send an IPC event to Clippy's renderer; false when there is no window. */
  send: (channel: string, payload?: unknown) => boolean;
  getWindowBounds: () => Rect | null;
  setWindowBounds: (rect: Rect) => void;
  /** Tell the window-follow loop the placement is deliberate (30s cooldown). */
  noteManualMove: () => void;
  displays: () => DisplayInfo[];
  displayNearest: (p: { x: number; y: number }) => DisplayInfo;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  classFor: (name: string, args: Record<string, unknown>) => ActionClass;
  decide: (name: string, args: Record<string, unknown>) => ClassDecision;
  summarizeArgs: (name: string, args: Record<string, unknown>) => string;
  requestApproval: (req: { tool: string; summary: string; actionClass: ActionClass }) => Promise<ApprovalResult>;
  markApproved: (name: string, args: Record<string, unknown>) => void;
  /** Test seam for the glide timer. */
  glideMs?: number;
}

// ── Busy lock ─────────────────────────────────────────────────────────────

let agentCalls = 0;
export function isAgentBusy(): boolean { return agentCalls > 0; }

// ── clippy_ask_user plumbing (renderer answers via IPC) ───────────────────

const pendingAsks = new Map<string, { resolve: (c: string) => void; timer: ReturnType<typeof setTimeout> }>();

function settleAsk(id: string, choice: string): boolean {
  const p = pendingAsks.get(id);
  if (!p) return false;
  pendingAsks.delete(id);
  clearTimeout(p.timer);
  p.resolve(choice);
  return true;
}

/** Renderer clicked an option (or dismissed the bubble → 'dismissed'). */
export function resolveAgentAsk(id: string, choice: string): boolean {
  return settleAsk(id, choice);
}

export function cancelAllAgentAsks(): void {
  for (const id of [...pendingAsks.keys()]) settleAsk(id, 'dismissed');
}

// ── Schemas ───────────────────────────────────────────────────────────────

export const schemas = {
  say: {
    text: z.string().min(1).max(4000).describe('What Clippy says in his speech bubble. Plain text or light markdown (**bold**, `code`, - bullets). Keep it to a sentence or two.'),
    wait_for_dismiss: z.boolean().optional().describe('If true, show an OK button and do not return until the user clicks it or closes the bubble (max 2 minutes).'),
  },
  animate: {
    animation: z.enum(AGENT_ANIMATIONS).describe('Sprite animation to play. Congratulate = celebrate, GetAttention = nudge, Thinking/Searching/Writing = working, Gesture*/Look* = point in a direction, Wave/GoodBye = greet/leave.'),
  },
  pointAt: {
    x: z.number().describe('Screen X in device-independent pixels (same space as window bounds / clippy_status.displays).'),
    y: z.number().describe('Screen Y in device-independent pixels.'),
    label: z.string().max(200).optional().describe('Optional short bubble text to show while pointing, e.g. "This button".'),
  },
  askUser: {
    question: z.string().min(1).max(600).describe('The question shown in the bubble.'),
    options: z.array(z.string().min(1).max(40)).min(2).max(4).describe('2-4 short button labels. The chosen label is returned verbatim.'),
    timeout_seconds: z.number().int().min(5).max(ASK_MAX_TIMEOUT_S).optional().describe(`Seconds to wait before returning "timeout" (default ${ASK_DEFAULT_TIMEOUT_S}).`),
  },
  runTool: {
    name: z.string().min(1).max(64).describe('Clippy desktop tool name — see clippy_status.allowed_tools.'),
    args: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments object."),
  },
};

// ── Result helpers ────────────────────────────────────────────────────────

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface AgentResult { [key: string]: unknown; content: Content[]; isError?: boolean }

const ok = (text: string): AgentResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): AgentResult => ({ content: [{ type: 'text', text }], isError: true });

export function truncateSay(text: string): string {
  const t = text.trim();
  if (t.length <= SAY_MAX_CHARS) return t;
  return `${t.slice(0, SAY_MAX_CHARS)}… (+${t.length - SAY_MAX_CHARS} more chars cut)`;
}

/** Which gesture Clippy makes toward a point, given his final sprite centre. */
export function gestureToward(from: { x: number; y: number }, to: { x: number; y: number }): AgentAnimation {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'GestureLeft' : 'GestureRight';
  return dy < 0 ? 'GestureUp' : 'GestureDown';
}

/**
 * Where Clippy's window goes to stand beside a point: bottom-right of the
 * point by default (sprite's top-left ~ 40px off the point), clamped into
 * the work area of the display that owns the point. If that puts him over
 * the point, flip to the left/top side instead.
 */
export function placeBeside(point: { x: number; y: number }, win: { width: number; height: number }, wa: Rect): Rect {
  const GAP = 40;
  let x = point.x + GAP;
  let y = point.y + GAP;
  if (x + win.width > wa.x + wa.width) x = point.x - GAP - win.width;
  if (y + win.height > wa.y + wa.height) y = point.y - GAP - win.height;
  x = Math.max(wa.x, Math.min(wa.x + wa.width - win.width, x));
  y = Math.max(wa.y, Math.min(wa.y + wa.height - win.height, y));
  return { x: Math.round(x), y: Math.round(y), width: win.width, height: win.height };
}

// ── Handlers ──────────────────────────────────────────────────────────────

export function createAgentToolHandlers(deps: AgentToolDeps) {
  /** Serialise with Clippy's own turns and count the call as agent activity. */
  async function guarded(name: string, fn: () => Promise<AgentResult>): Promise<AgentResult> {
    if (deps.isBrainBusy()) {
      return fail('(error:busy) Clippy is in the middle of his own task. Wait a few seconds and try again.');
    }
    agentCalls++;
    try {
      return await fn();
    } catch (err) {
      log.warn('Agent tool threw', { tool: name, err: err instanceof Error ? err.message : String(err) });
      return fail(`(error:${name}_failed) ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      agentCalls--;
    }
  }

  function askInBubble(question: string, options: string[], timeoutS: number): Promise<string> {
    const id = randomUUID();
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => settleAsk(id, 'timeout'), timeoutS * 1000);
      pendingAsks.set(id, { resolve, timer });
      if (!deps.send('agent-ask', { id, question, options })) settleAsk(id, 'dismissed');
    });
  }

  async function glideTo(target: Rect): Promise<void> {
    const from = deps.getWindowBounds();
    if (!from) throw new Error('Clippy window unavailable');
    const steps = 14;
    const total = deps.glideMs ?? 350;
    for (let i = 1; i <= steps; i++) {
      const t = 1 - Math.pow(1 - i / steps, 3); // ease-out cubic
      deps.setWindowBounds({
        x: Math.round(from.x + (target.x - from.x) * t),
        y: Math.round(from.y + (target.y - from.y) * t),
        width: target.width,
        height: target.height,
      });
      if (i < steps) await new Promise((r) => setTimeout(r, total / steps));
    }
  }

  return {
    say: (a: { text: string; wait_for_dismiss?: boolean }) => guarded('clippy_say', async () => {
      const text = truncateSay(a.text);
      if (!a.wait_for_dismiss) {
        if (!deps.send('clippy-speak', { text, animate: 'Explain' })) return fail('(error:no_window) Clippy window unavailable.');
        return ok(`Clippy said: ${text}`);
      }
      const choice = await askInBubble(text, ['OK'], 120);
      return ok(choice === 'OK' ? 'The user clicked OK.' : `The bubble was ${choice === 'timeout' ? 'left open until timeout' : 'dismissed'}.`);
    }),

    animate: (a: { animation: AgentAnimation }) => guarded('clippy_animate', async () => {
      if (!deps.send('clippy-speak', { text: '', animate: a.animation })) return fail('(error:no_window) Clippy window unavailable.');
      return ok(`Played ${a.animation}.`);
    }),

    pointAt: (a: { x: number; y: number; label?: string }) => guarded('clippy_point_at', async () => {
      const bounds = deps.getWindowBounds();
      if (!bounds) return fail('(error:no_window) Clippy window unavailable.');
      const display = deps.displayNearest({ x: a.x, y: a.y });
      const target = placeBeside({ x: a.x, y: a.y }, { width: bounds.width, height: bounds.height }, display.workArea);
      deps.noteManualMove();
      await glideTo(target);
      const centre = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
      const animation = gestureToward(centre, { x: a.x, y: a.y });
      deps.send('clippy-speak', { text: a.label ? truncateSay(a.label) : '', animate: animation });
      return ok(`Clippy is at (${target.x}, ${target.y}) on display ${display.id}, pointing ${animation.replace('Gesture', '').toLowerCase()} at (${a.x}, ${a.y}).`);
    }),

    askUser: (a: { question: string; options: string[]; timeout_seconds?: number }) => guarded('clippy_ask_user', async () => {
      const options = [...new Set(a.options.map((o) => o.trim()).filter(Boolean))];
      if (options.length < 2) return fail('(error:bad_options) Need 2-4 distinct non-empty options.');
      const choice = await askInBubble(a.question, options, a.timeout_seconds ?? ASK_DEFAULT_TIMEOUT_S);
      return ok(choice);
    }),

    screenshot: () => guarded('clippy_screenshot', async () => {
      const r = await deps.executeTool('desktop_screenshot', {});
      if (!r.image) return fail(r.text || '(error:screenshot_failed)');
      return { content: [{ type: 'text', text: r.text }, { type: 'image', data: r.image.data, mimeType: r.image.mimeType }] };
    }),

    status: async (): Promise<AgentResult> => ok(JSON.stringify({
      app: 'ClippyAI',
      version: deps.version,
      platform: deps.platform,
      busy: deps.isBrainBusy() || isAgentBusy(),
      clippy_window: deps.getWindowBounds(),
      displays: deps.displays(),
      coordinate_space: 'device-independent pixels (DIP); clippy_run_tool mouse_* tools take native pixels — see each tool result',
      animations: AGENT_ANIMATIONS,
      allowed_tools: deps.allowedTools(),
    }, null, 2)),

    runTool: (a: { name: string; args?: Record<string, unknown> }) => guarded('clippy_run_tool', async () => {
      const args = a.args ?? {};
      if (!deps.allowedTools().includes(a.name)) {
        return fail(`(error:unknown_tool) "${a.name}" is not an allowed Clippy tool on ${deps.platform}. See clippy_status.allowed_tools.`);
      }
      const actionClass = deps.classFor(a.name, args);
      let decision = deps.decide(a.name, args);
      // An outside agent never inherits "trusted" for side-effecting classes:
      // anything that writes, sends, spends, executes or publishes asks the
      // user in Clippy's bubble, whatever the Guardrails mode says.
      if (decision === 'allow' && /^destructive_|^share_public$/.test(actionClass)) decision = 'approve';
      if (decision === 'block') {
        return fail(`(error:policy_blocked) The user's Guardrails forbid this action class (${actionClass}).`);
      }
      if (decision === 'approve') {
        const summary = deps.summarizeArgs(a.name, args);
        const verdict = await deps.requestApproval({ tool: a.name, summary, actionClass });
        if (verdict !== 'approved') {
          return fail(`(error:user_denied) The user did not approve "${summary}" (${verdict}). Do not retry; ask them what they want instead.`);
        }
        deps.markApproved(a.name, args);
      }
      log.info('Agent.run_tool', { tool: a.name, class: actionClass, decision });
      const r = await deps.executeTool(a.name, args);
      const isError = /^\(error:/.test(r.text || '');
      const content: Content[] = [{ type: 'text', text: r.text || '(no output)' }];
      if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
      return { content, ...(isError ? { isError: true } : {}) };
    }),
  };
}

export type AgentToolHandlers = ReturnType<typeof createAgentToolHandlers>;

/** Register the tool set on a fresh McpServer (one per MCP session). */
export function registerAgentTools(server: McpServer, deps: AgentToolDeps): void {
  const h = createAgentToolHandlers(deps);
  const allowed = deps.allowedTools();
  server.registerTool('clippy_say', {
    title: 'Say in Clippy\'s bubble',
    description: 'Show a short message in Clippy\'s speech bubble on the user\'s desktop (he also reads it aloud if voice is on). Use it to narrate what you are doing, explain a result, or celebrate. Max 600 characters shown; longer text is visibly cut.',
    inputSchema: schemas.say,
    annotations: { readOnlyHint: true },
  }, (a) => h.say(a));
  server.registerTool('clippy_animate', {
    title: 'Play a Clippy animation',
    description: 'Play one sprite animation (no text). Use sparingly — one animation per moment, not one per sentence.',
    inputSchema: schemas.animate,
    annotations: { readOnlyHint: true },
  }, (a) => h.animate(a));
  server.registerTool('clippy_point_at', {
    title: 'Point Clippy at a screen location',
    description: 'Glide Clippy next to a screen coordinate (DIP, multi-monitor aware) and have him gesture at it. Use it to show the user where something is ("the Save button is here"). Optional label is shown in the bubble.',
    inputSchema: schemas.pointAt,
    annotations: { readOnlyHint: true },
  }, (a) => h.pointAt(a));
  server.registerTool('clippy_ask_user', {
    title: 'Ask the user a quick question',
    description: 'Show a question in Clippy\'s bubble with 2-4 buttons and wait for the click. Returns the chosen label verbatim, "dismissed" if the user closed the bubble, or "timeout". Use it to confirm a choice before acting.',
    inputSchema: schemas.askUser,
  }, (a) => h.askUser(a));
  server.registerTool('clippy_screenshot', {
    title: 'Screenshot the user\'s screen',
    description: 'Capture the primary display (downscaled PNG). The text part explains how to map pixels in the image back to native screen coordinates.',
    annotations: { readOnlyHint: true },
  }, () => h.screenshot());
  server.registerTool('clippy_status', {
    title: 'Clippy status',
    description: 'ClippyAI version, platform, whether Clippy is busy, his window bounds, every display\'s bounds/workArea/scaleFactor, valid animation names, and the desktop tools you may call through clippy_run_tool.',
    annotations: { readOnlyHint: true },
  }, () => h.status());
  server.registerTool('clippy_run_tool', {
    title: 'Run a Clippy desktop tool',
    description: `Run one of Clippy's built-in desktop tools (read the screen, click, type, open apps, files, clipboard, browser, email…) under the user's Guardrails. Read-only tools run immediately; anything that writes, sends, executes, spends or publishes shows an Approve/Deny prompt in Clippy's bubble and returns an error if the user declines or does not answer within 25s. Always tell the user (clippy_say) what you are about to do first. Allowed names on this machine: ${allowed.join(', ')}.`,
    inputSchema: schemas.runTool,
  }, (a) => h.runTool(a));
}
