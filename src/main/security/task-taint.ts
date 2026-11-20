/**
 * task-taint.ts — "has this task read something private?"
 *
 * The exfiltration chain a prompt injection needs is read, then send. Reading
 * a file the user pointed at must stay unasked (the owner's rule: the request
 * is the permission), so the read is not where to stop it. Instead the
 * dispatcher (tools.ts executeTool) notes here that the task read a file, the
 * clipboard or a secret, and assessRisk asks before a later navigate /
 * open_url / http_request whose address carries data (net-guard.ts).
 *
 * One flag per task: brain.ts resets it when a new user request starts.
 */

import { classifyShellCommand } from '../approval-policy';

let readWhat: string | null = null;

// The line being typed into the focused window, across type_text calls, until
// it is submitted. assessRisk reads it when Enter is pressed in a terminal:
// the key press itself carries no text, the line typed before it does.
let typedLine = '';

/** Start of a new task. */
export function resetTaskTaint(): void {
  readWhat = null;
  typedLine = '';
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
  if (what && (readWhat === null || what === 'a secret')) readWhat = what;
}
