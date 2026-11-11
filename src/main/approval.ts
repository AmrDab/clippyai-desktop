/**
 * approval.ts — Phase 3 guardrails: the in-bubble "Can I …?" prompt.
 *
 * brain.ts calls requestApproval() when permission-policy.decide() says
 * 'approve'. Main sends `approval-request` to the renderer (bubble shows
 * Approve / Deny), the renderer answers via the `approval-response` IPC
 * (ipc.ts → resolveApproval). No answer within APPROVAL_TIMEOUT_MS = deny.
 * Anything that cancels the task (sleep, user override, takeover) calls
 * cancelAllApprovals() so no prompt outlives the task that asked.
 */

import type { BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { createLogger, redactArgs } from './logger';
import { TOOL_META, type ActionClass } from './tool-meta';

const log = createLogger('Approval');

export type ApprovalResult = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface ApprovalRequest {
  tool: string;
  summary: string;
  actionClass: ActionClass;
}

export const APPROVAL_TIMEOUT_MS = 60_000;

const pending = new Map<string, { resolve: (r: ApprovalResult) => void; timer: ReturnType<typeof setTimeout> }>();

function finish(id: string, result: ApprovalResult): boolean {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  log.info('Approval.resolved', { id, result });
  p.resolve(result);
  return true;
}

/** Ask the user. Resolves 'denied' immediately if there is no window to ask in. */
export function requestApproval(win: BrowserWindow | null, req: ApprovalRequest): Promise<ApprovalResult> {
  if (!win || win.isDestroyed()) return Promise.resolve('denied');
  const id = randomUUID();
  return new Promise<ApprovalResult>((resolve) => {
    const timer = setTimeout(() => finish(id, 'timeout'), APPROVAL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    log.info('Approval.request', { id, tool: req.tool, class: req.actionClass });
    win.webContents.send('approval-request', { id, ...req, timeoutMs: APPROVAL_TIMEOUT_MS });
  });
}

/** Renderer answered. Returns false for an unknown / already-settled id. */
export function resolveApproval(id: string, approved: boolean): boolean {
  return finish(id, approved ? 'approved' : 'denied');
}

/** A "Can I …?" prompt is waiting for the user. */
export function hasPendingApproval(): boolean {
  return pending.size > 0;
}

/** Settle every pending prompt as 'cancelled' (task aborted / sleep). */
export function cancelAllApprovals(): void {
  for (const id of [...pending.keys()]) finish(id, 'cancelled');
}

// ── Approval record for tools that need to double-check consent ─────
// brain marks a call approved right after the user says yes; the tool
// implementation (install_skill) consumes the mark. One-shot so a later
// un-prompted call can't ride on an earlier yes.

const approved = new Set<string>();

function approvalKey(tool: string, args: Record<string, unknown>): string {
  const key = tool === 'install_skill' ? String(args.slug ?? '') : JSON.stringify(args ?? {});
  return `${tool}:${key}`;
}

export function markApproved(tool: string, args: Record<string, unknown>): void {
  approved.add(approvalKey(tool, args));
}

/** Consume (and return) a prior approval for `tool` + key (install_skill: slug). */
export function wasApproved(tool: string, key: string): boolean {
  return approved.delete(`${tool}:${key}`);
}

// ── Human summary shown in the bubble ───────────────────────────────
// Every tool gets a plain-English line ("Type 313 characters", "Open
// https://example.com"). Never raw JSON: an unknown tool falls back to its
// TOOL_META description, then to its name in words. Typed / copied / spoken
// text is shown only when it is short, multi-word prose (never something
// that could be a password); otherwise just its length. A governor
// escalation is prefixed by the caller: "{risk.reason} — {summary}".

// Truncation is always VISIBLE: a value cut silently could hide its dangerous
// tail behind a harmless-looking prefix the user then approves.
const s = (v: unknown, max = 60): string => {
  const str = String(v ?? '');
  return str.length > max ? `${str.substring(0, max)}… (+${str.length - max} more chars)` : str;
};
const q = (v: unknown, max = 60): string => `'${s(v, max)}'`;
const cap = (str: string): string => str.charAt(0).toUpperCase() + str.slice(1);
const has = (v: unknown): boolean => v !== undefined && v !== null && String(v).trim() !== '';

const CREDENTIAL_FIELD = /pass|pwd|\bpin\b|otp|secret|token|card|cvv|cvc|ssn|security.?code|api.?key/i;
const PROSE = /^[A-Za-z][A-Za-z ,.'!?-]*$/;

/** Typed/copied text: quoted when short multi-word prose, else "N characters". */
function textPhrase(v: unknown, field?: unknown): string {
  const str = typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
  if (!str) return 'text';
  const safe = str.length <= 40 && PROSE.test(str) && /\s\S/.test(str.trim())
    && !(has(field) && CREDENTIAL_FIELD.test(String(field)));
  if (safe) return `"${str}"`;
  return `${str.length.toLocaleString()} character${str.length === 1 ? '' : 's'}`;
}

const at = (a: Record<string, unknown>) => `(${a.x ?? '?'}, ${a.y ?? '?'})`;
const inRepo = (a: Record<string, unknown>) => (has(a.owner) && has(a.repo) ? ` in ${s(a.owner, 40)}/${s(a.repo, 40)}` : '');
const into = (field: unknown) => (has(field) ? ` into ${q(field)}` : '');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

type Label = (a: Record<string, unknown>) => string | null;

/** Label that needs `keys` ("a b" = all of, "a|b" = either) — else null → description. */
const R = (keys: string, fn: Label): Label => (a) =>
  (keys.split(' ').every((k) => k.split('|').some((alt) => has(a[alt]))) ? fn(a) : null);

const LABELS: Record<string, Label> = {
  // Tier 1 — generated files
  generate_qrcode: (a) => `Create a QR code image from ${textPhrase(a.text)}`,
  generate_excel: (a) => (has(a.filename) ? `Create the Excel workbook ${s(a.filename, 80)}` : 'Create an Excel workbook'),
  generate_docx: (a) => (has(a.filename) ? `Create the Word document ${s(a.filename, 80)}` : 'Create a Word document'),
  generate_pdf: (a) => (has(a.filename) ? `Create the PDF ${s(a.filename, 80)}` : 'Create a PDF'),
  // Screen / windows (reads)
  read_screen: () => "Read what's on your screen",
  smart_read: () => "Read what's on your screen",
  get_active_window: () => 'Check which window is in front',
  get_windows: () => 'List your open windows',
  get_focused_element: () => 'Check which field has focus',
  get_selection: () => 'Read the text you have selected',
  desktop_screenshot: () => 'Take a screenshot of your screen',
  ocr_read_screen: () => 'Read the text on your screen',
  // Apps / windows (control)
  open_app: (a) => (has(a.name) ? `Open ${s(a.name)}` : 'Open an app'),
  focus_window: (a) => `Switch to ${s(a.title ?? a.processName ?? (has(a.processId) ? `window ${a.processId}` : 'another window'))}`,
  minimize_all_windows: () => 'Minimize all windows',
  show_desktop: () => 'Show the desktop',
  minimize_window: (a) => `Minimize ${s(a.title ?? a.processName ?? 'a window')}`,
  // com-kill-process.ps1 kills by PID when one is given and ignores the name.
  kill_process: R('name|procPid', (a) => (Number(a.procPid) > 0 ? `Kill process with PID ${Number(a.procPid)}` : `Kill ${s(a.name)}`)),
  windows_service_control: R('name', (a) => `${s(a.action ?? 'status')} service ${s(a.name)}`),
  // Clipboard / files
  read_clipboard: () => 'Read your clipboard',
  write_clipboard: (a) => `Copy ${textPhrase(a.text)} to the clipboard`,
  read_file: R('path', (a) => `Read ${s(a.path, 80)}`),
  write_file: R('path', (a) => `Write ${String(a.content ?? '').length.toLocaleString()} chars to ${s(a.path, 80)}`),
  delete_file: R('path', (a) => `Delete ${s(a.path, 80)}`),
  rename_file: R('from to', (a) => `Rename ${s(a.from)} to ${s(a.to)}`),
  move_file: R('from to', (a) => `Move ${s(a.from)} to ${s(a.to)}`),
  list_files: (a) => (has(a.path) ? `List the files in ${s(a.path, 80)}` : 'List files'),
  search_files_content: R('pattern', (a) => `Search files${has(a.path) ? ` in ${s(a.path, 80)}` : ''} for ${q(a.pattern, 40)}`),
  zip_files: (a) => `Zip ${plural(Array.isArray(a.inputs) ? a.inputs.length : 1, 'item')}${has(a.output) ? ` into ${s(a.output, 80)}` : ''}`,
  unzip_files: R('input', (a) => `Unzip ${s(a.input, 80)}${has(a.output) ? ` into ${s(a.output, 80)}` : ''}`),
  hash_file: R('path', (a) => `Compute the ${s(a.algo ?? 'SHA256', 10)} hash of ${s(a.path, 80)}`),
  ocr_from_image: R('path', (a) => `Read the text in the image ${s(a.path, 80)}`),
  word_to_pdf: R('input', (a) => `Convert ${s(a.input, 80)} to PDF`),
  excel_read: (a) => `Read cells from ${s(a.path ?? 'the open workbook', 80)}`,
  excel_write: (a) => `Write cells${has(a.range) ? ` ${s(a.range, 20)}` : ''}${has(a.sheet) ? ` on sheet ${q(a.sheet, 30)}` : ''} in ${s(a.path ?? 'the open workbook', 80)}`,
  // System / network
  system_info: () => 'Check your system info',
  list_processes: () => 'List running programs',
  ping_host: R('host', (a) => `Ping ${s(a.host, 80)}`),
  http_request: R('url', (a) => {
    let target = s(a.url, 80);
    let dataLen = String(a.body ?? '').length;
    try {
      const u = new URL(String(a.url));
      target = s(u.host + u.pathname, 80);
      dataLen += u.search.length; // query strings can carry data out too
    } catch { /* keep raw */ }
    const data = dataLen > 0 ? `, sending ${dataLen.toLocaleString()} chars of data` : '';
    return `${String(a.method ?? 'GET').toUpperCase()} ${target}${data}`;
  }),
  shell_exec: R('command', (a) => `Run \`${s(a.command, 240)}\``),
  web_search: R('query', (a) => `Search the web for ${q(a.query)}`),
  speak_text: (a) => `Say ${textPhrase(a.text)} out loud`,
  play_animation: (a) => (has(a.animation ?? a.name) ? `Play the ${s(a.animation ?? a.name, 30)} animation` : 'Play an animation'),
  wait: (a) => `Wait ${plural(Number(a.seconds) || 1, 'second')}`,
  plan: () => 'Note down a plan',
  detect_webview_apps: () => 'Check which apps allow browser automation',
  security_sweep: () => 'Run a read-only security check of your PC',
  get_current_time_tz: (a) => `Check the time${has(a.timezone ?? a.tz) ? ` in ${s(a.timezone ?? a.tz, 40)}` : ''}`,
  weather_current: (a) => `Check the weather${has(a.location) ? ` in ${s(a.location, 40)}` : ''}`,
  create_reminder: (a) => `Create a reminder${has(a.title) ? ` ${q(a.title)}` : ''}${has(a.datetime) ? ` for ${s(a.datetime, 40)}` : ''}`,
  // Mail / calendar (the *_send_email family is handled by suffix below)
  outlook_read_inbox: () => 'Read your Outlook inbox',
  outlook_upcoming: () => 'Check your upcoming Outlook events',
  outlook_create_event: (a) => {
    const people = Array.isArray(a.attendees) ? a.attendees.length
      : has(a.attendees) ? String(a.attendees).split(/[;,]/).filter((x) => x.trim()).length : 0;
    return `Add ${has(a.subject) ? q(a.subject) : 'an event'} to your Outlook calendar${has(a.start) ? ` at ${s(a.start, 40)}` : ''}${people ? ` and invite ${people} ${people === 1 ? 'person' : 'people'}` : ''}`;
  },
  apple_calendar_create_event: (a) => {
    const date = has(a.year) && has(a.month) && has(a.day)
      ? ` on ${a.year}-${String(a.month).padStart(2, '0')}-${String(a.day).padStart(2, '0')}` : '';
    return `Add ${has(a.title) ? q(a.title) : 'an event'} to your Calendar${date}`;
  },
  // GitHub
  github_create_issue: (a) => `Create a GitHub issue${inRepo(a)}${has(a.title) ? `: ${q(a.title)}` : ''}`,
  github_list_issues: (a) => `List GitHub issues${inRepo(a)}`,
  github_get_pr: (a) => `Look up pull request${has(a.pr_number) ? ` #${s(a.pr_number, 10)}` : ''}${inRepo(a)}`,
  // Links / browser
  navigate_browser: R('url', (a) => `Open ${s(a.url, 100)}`),
  open_url: R('url', (a) => `Open ${s(a.url, 100)}`),
  browser_navigate: R('url', (a) => `Open ${s(a.url, 100)} in the browser`),
  spotify_play_uri: R('uri', (a) => `Play ${s(a.uri, 80)} in Spotify`),
  cdp_connect: () => 'Connect to your browser',
  cdp_page_context: () => 'Check which page the browser is on',
  cdp_read_text: () => 'Read the text on the web page',
  cdp_click: R('text|selector', (a) => `Click ${q(a.text ?? a.selector)} on the web page`),
  cdp_type: (a) => `Type ${textPhrase(a.text, a.label ?? a.selector)}${into(a.label ?? a.selector)} on the web page`,
  cdp_select_option: R('value', (a) => `Choose ${q(a.value)}${has(a.selector) ? ` in ${q(a.selector)}` : ''} on the web page`),
  cdp_evaluate: (a) => `Run JavaScript in the browser page${has(a.javascript) ? `: ${s(a.javascript, 240)}` : ''}`,
  cdp_wait_for_selector: R('selector', (a) => `Wait for ${q(a.selector)} to appear on the page`),
  cdp_list_tabs: () => 'List your browser tabs',
  cdp_switch_tab: R('target', (a) => `Switch to browser tab ${q(a.target)}`),
  cdp_scroll: (a) => `Scroll the web page ${s(a.direction ?? 'down', 10)}`,
  browser_click: R('text|selector', (a) => `Click ${q(a.text ?? a.selector)} in the browser`),
  browser_type: (a) => `Type ${textPhrase(a.text, a.selector)}${into(a.selector)} in the browser`,
  browser_read_text: () => 'Read the text on the web page',
  browser_list_tabs: () => 'List your browser tabs',
  browser_switch_tab: R('tabId', (a) => `Switch to browser tab ${q(a.tabId)}`),
  // Desktop input
  smart_click: R('target', (a) => `Click ${q(a.target)}`),
  smart_type: (a) => `Type ${textPhrase(a.text, a.target)}${into(a.target)}`,
  type_text: (a) => `Type ${textPhrase(a.text)}`,
  replace_focused_text: (a) => `Replace the focused field's text with ${textPhrase(a.value ?? a.text)}`,
  key_press: R('key|combo', (a) => `Press ${s(a.key ?? a.combo, 30)}`),
  mouse_click: R('x y', (a) => `${a.button === 'right' ? 'Right-click' : Number(a.count) === 2 ? 'Double-click' : 'Click'} at ${at(a)}`),
  mouse_double_click: R('x y', (a) => `Double-click at ${at(a)}`),
  mouse_right_click: R('x y', (a) => `Right-click at ${at(a)}`),
  mouse_hover: R('x y', (a) => `Move the mouse to ${at(a)}`),
  mouse_drag: R('startX startY endX endY', (a) => `Drag from (${a.startX ?? '?'}, ${a.startY ?? '?'}) to (${a.endX ?? '?'}, ${a.endY ?? '?'})`),
  mouse_scroll: (a) => `Scroll ${s(a.direction ?? 'down', 10)}`,
  shortcuts_execute: R('intent|action', (a) => `Use the keyboard shortcut for ${q(a.intent ?? a.action)}`),
  follow_me: () => 'Follow your cursor around the screen',
  stop_following: () => 'Stop following your cursor',
  // Delegation / skills / profile
  clawd_status: () => "Check the desktop helper's status",
  clawd_task: R('task', (a) => `Hand off desktop task: ${s(a.task)}`),
  find_skill: R('query|intent', (a) => `Search ClawHub for a skill: ${q(a.query ?? a.intent)}`),
  install_skill: R('slug', (a) => `Install skill ${s(a.slug)}${has(a.version) ? ` version ${s(a.version)}` : ''}`),
  update_user_profile: (a) => (has(a.field) ? `Remember your ${s(a.field, 30).replace(/_/g, ' ')}` : 'Update your profile'),
  finish_onboarding_chat: () => 'Finish the getting-to-know-you chat',
};

/** First clause of the tool's TOOL_META description, braces dropped. */
function fromDescription(tool: string): string | null {
  const d = (TOOL_META[tool]?.description ?? '')
    .replace(/^L\d\s+LAST RESORT\s+—\s+/, '') // clawd_task's model-facing prefix
    .replace(/\s*\([^)]*\)/g, '');            // parenthetical asides
  const first = d.split(/(?<=[.;])\s|\s—\s/)[0].replace(/[{}]/g, '').replace(/[.;]$/, '').trim();
  return first ? cap(s(first, 100)) : null;
}

export function summarizeArgs(tool: string, args: Record<string, unknown> = {}): string {
  const a = args && typeof args === 'object' ? args : {};
  const label = LABELS[tool];
  if (label) {
    try {
      const out = label(a);
      if (out) return cap(out);
    } catch { /* fall through to the description */ }
  }
  if (/_send_email$/.test(tool) && has(a.to)) return `Email to ${s(a.to)}${has(a.subject) ? `, subject ${s(a.subject)}` : ''}`;
  if (tool.startsWith('skill__')) {
    return `Run skill ${tool.slice('skill__'.length)}${Object.keys(a).length ? ` ${s(JSON.stringify(redactArgs(a)), 240)}` : ''}`;
  }
  return fromDescription(tool) ?? `Use ${tool.replace(/_/g, ' ')}`;
}
