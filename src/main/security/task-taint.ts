/**
 * task-taint.ts — "has this task read something private?"
 *
 * The exfiltration chain a prompt injection needs is read, then send. Reading
 * a file the user pointed at must stay unasked (the owner's rule: the request
 * is the permission), so the read is not where to stop it. Instead the
 * dispatcher (tools.ts executeTool) notes here that the task read a file, the
 * clipboard or a secret, and keeps the last few results. assessRisk asks
 * before a later navigate / open_url / http_request only when its address
 * actually carries some of that text (read-leak.ts).
 *
 * One record per task: brain.ts resets it, with the user's own message, when
 * a new user request starts. Memory only; nothing here is logged or stored.
 */

import { classifyShellCommand } from '../approval-policy';

let readWhat: string | null = null;
// The last few read results and the user's message, for the leak check.
const READS_KEPT = 5;
const READ_MAX_CHARS = 100_000;
let readTexts: string[] = [];
let userMessage = '';

// The line being typed into the focused window, across type_text calls, until
// it is submitted. assessRisk reads it when Enter is pressed in a terminal:
// the key press itself carries no text, the line typed before it does.
let typedLine = '';

/** Start of a new task. `message` is the user's own request text. */
export function resetTaskTaint(message = ''): void {
  readWhat = null;
  typedLine = '';
  readTexts = [];
  userMessage = String(message ?? '');
}

/** Results of the task's recent reads, newest last. */
export function taskReadTexts(): string[] {
  return readTexts;
}

/** The user's message this task started from. */
export function taskUserMessage(): string {
  return userMessage;
}

/** Text typed since the last Enter / newline ('' when nothing is pending). */
export function pendingTypedLine(): string {
  return typedLine;
}

/** What the task read ("a file", "the clipboard"), or null. */
export function taskReadSensitive(): string | null {
  return readWhat;
}

const FILE_READERS = new Set(['read_file', 'search_files_content', 'excel_read', 'ocr_from_image']);
// A shell command that prints file or clipboard contents.
const SHELL_READS = /(?:^|[\s;&|("'])(?:type|cat|more|less|head|tail|get-content|gc|select-string|sls|findstr|grep|strings|xxd|certutil\s+-encode|get-clipboard|gcb|pbpaste|xclip|xsel|reg(?:\.exe)?\s+query|get-itemproperty|printenv|set)(?![\w-])/i;

/** What a tool call reads, or null when it reads nothing private. Pure. */
export function sensitiveReadOf(tool: string, params: Record<string, unknown> = {}): string | null {
  if (FILE_READERS.has(tool)) return 'a file';
  if (tool === 'read_clipboard') return 'the clipboard';
  if (tool === 'shell_exec') {
    const command = String(params.command ?? '');
    if (/secret location/.test(classifyShellCommand(command) ?? '')) return 'a secret';
    if (SHELL_READS.test(command)) return 'a file';
  }
  return null;
}

/** Called by the dispatcher after a tool ran. Error results read nothing. */
export function noteToolRan(tool: string, params: Record<string, unknown> | undefined, resultText: string | undefined): void {
  if (/^\(error:/.test(resultText ?? '')) return;
  if (tool === 'type_text' || tool === 'smart_type') {
    const text = String(params?.text ?? '');
    const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    typedLine = cut >= 0 ? text.slice(cut + 1) : (typedLine + text).slice(-4000);
  } else if (tool === 'key_press' && /(^|\+)(enter|return)$/i.test(String(params?.key ?? params?.combo ?? ''))) {
    typedLine = '';
  }
  const what = sensitiveReadOf(tool, params ?? {});
  if (!what) return;
  if (readWhat === null || what === 'a secret') readWhat = what;
  readTexts.push(String(resultText ?? '').slice(0, READ_MAX_CHARS));
  if (readTexts.length > READS_KEPT) readTexts.shift();
}
