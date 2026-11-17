/**
 * approval-policy.ts — the one place that decides whether a tool call that
 * permission-policy marked 'approve' still has to ask the user.
 *
 * Owner report: "asking for too much permission, if the user asked you to do
 * it, then dont ask for permission to run scripts". Every shell_exec is class
 * destructive_exec, so even `ls`, `open -a Claude` and an AppleScript
 * `activate` prompted. Policy: in a task the USER started, a shell command
 * that is part of the request runs without asking UNLESS it can delete, close,
 * install, upload, send, change security/system settings, or run opaque code
 * (classifyShellCommand), or something in the task looks like prompt injection,
 * or the task did not come from the user, or the user picked Cautious / an
 * explicit "approve" for the class. The hard blocklist (shell-guard.ts) still
 * refuses at execution whatever this says. Only shell_exec is relaxed: skill
 * installs, purchases, sends, payments, http_request, clawd_task, kill_process
 * and every governor-escalated click keep asking exactly as before.
 *
 * Pure + dependency-light so each branch is unit-tested (tests/approval-policy.test.ts).
 */

import { shellBlockReason } from './shell-guard';
import type { ActionClass } from './tool-meta';

export type TaskOrigin = 'user' | 'agent' | 'proactive';

export interface ApprovalCtx {
  /** Where the task came from. Only 'user' (a chat message) is trusted. */
  origin: TaskOrigin;
  /** The injection detector fired on screen/tool content in this task. */
  injectionSeen: boolean;
  /** What permission-policy decided (after governor escalation was applied). */
  decision: 'allow' | 'approve' | 'block';
  actionClass: ActionClass;
  /** The governor escalated this call (looks like a purchase / send / delete click). */
  escalated: boolean;
  /** Policy mode; 'cautious' means the user wants to see every action. */
  mode: 'cautious' | 'standard' | 'trusted';
  /** The user explicitly set this class to 'approve' in Settings → Guardrails. */
  classForcedApprove: boolean;
}

const BT = '`';
// Command position: start, after a separator / opening paren / quote / backtick
// / `$(`, or after `cmd /c`; optional `env VAR=x` prefix. Same idea as shell-guard.
const CS = String.raw`(?:^|[;&|({\r\n"']|` + BT + String.raw`|\$\(|\s/[ck]\s|\s-c(?:ommand)?\s)\s*(?:env\s+(?:\w+=\S+\s+)*)?`;
const rx = (src: string) => new RegExp(src, 'i');

interface Rule { why: string; re: RegExp }

const RISKY: Rule[] = [
  { why: 'elevated privileges', re: rx(CS + String.raw`(?:sudo|doas|su|runas)\b`) },
  { why: 'administrator privileges', re: rx(String.raw`with\s+administrator\s+privileges|-verb\s+runas`) },
  { why: 'deletes files', re: rx(CS + String.raw`(?:rm|rmdir|unlink|shred|trash|del|erase|rd|remove-item|ri|srm)\b`) },
  { why: 'deletes files', re: rx(String.raw`(?:\s-delete\b|\bxargs\s+(?:-\S+\s+)*(?:rm|mv|kill)\b|-exec\s+(?:rm|mv)\b)`) },
  { why: 'moves/overwrites files', re: rx(CS + String.raw`(?:mv|move|ren|rename|cp|copy|xcopy|robocopy|ditto|rsync|move-item|copy-item|mi|ci|rename-item|dd|truncate|ln)\b`) },
  { why: 'edits files in place', re: rx(String.raw`\b(?:sed|perl)\s+(?:-\S+\s+)*-i\b|\btee\b|\bset-content\b|\badd-content\b|\bout-file\b|\bclear-content\b`) },
  { why: 'changes permissions/ownership', re: rx(CS + String.raw`(?:chmod|chown|chgrp|chflags|xattr|icacls|takeown|attrib|setfacl)\b`) },
  { why: 'kills or quits apps/processes', re: rx(CS + String.raw`(?:kill|pkill|killall|taskkill|stop-process|spps|shutdown|reboot|halt|poweroff)\b`) },
  { why: 'quits or closes an app', re: rx(String.raw`\b(?:quit|close|terminate)\b`) },
  { why: 'system or security settings', re: rx(CS + String.raw`(?:defaults\s+(?:write|delete|import)|spctl|csrutil|tccutil|security|systemsetup|pmset|networksetup|scutil|launchctl|crontab|schtasks|at|reg(?:\.exe)?\s+(?:add|delete|import|load)|set-executionpolicy|set-mppreference|netsh|bcdedit|sc(?:\.exe)?\s+(?:stop|config|delete|create)|set-service|new-service|dscl|sysadminctl|diskutil|hdiutil|mount|umount|eject|fdisk|format)\b`) },
  { why: 'installs software', re: rx(CS + String.raw`(?:brew|port|apt|apt-get|dpkg|dnf|yum|rpm|pacman|snap|apk|flatpak|winget|choco|scoop|installer|softwareupdate|msiexec|pkgutil|npx|pnpx|bunx)\b`) },
  { why: 'installs software', re: rx(CS + String.raw`(?:npm|pnpm|yarn|bun|pip3?|pipx|uv|gem|cargo|go|composer|dotnet|conda|mamba|code)\s+(?:\S+\s+)*?(?:install|i|add|ci|global|-g|upgrade|update|uninstall|remove|publish|tool|--install-extension|--uninstall-extension)\b`) },
  { why: 'installs software', re: rx(String.raw`-m\s+pip\s+(?:install|uninstall)\b|\binstall-(?:module|package|script|windowsfeature)\b|\benable-windowsoptionalfeature\b`) },
  { why: 'runs downloaded code', re: rx(String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\r\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|iex|invoke-expression|powershell|pwsh)\b`) },
  { why: 'runs downloaded code', re: rx(String.raw`\b(?:iex|invoke-expression)\b|downloadstring|downloadfile|\$\(\s*(?:curl|wget)\b`) },
  { why: 'opaque PowerShell', re: rx(String.raw`(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:e|enc|encodedcommand|ep|executionpolicy|file|windowstyle\s+hidden)\b`) },
  { why: 'opens an installer or executable', re: rx(String.raw`\b(?:open|start|invoke-item|ii)\b[^\r\n]*\.(?:dmg|pkg|mpkg|app|command|sh|bat|cmd|ps1|msi|exe|vbs|jse?|scr|jar|workflow)\b`) },
  { why: 'upload / send over the network', re: rx(String.raw`\bcurl\b[^\r\n]*\s(?:-[a-zA-Z]*[dFTX]\b|--(?:data|data-\w+|form|form-string|upload-file|json|request)\b)`) },
  { why: 'upload / send over the network', re: rx(String.raw`\bwget\b[^\r\n]*--(?:post-data|post-file|body-data|body-file|method)\b`) },
  { why: 'upload / send over the network', re: rx(String.raw`\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\r\n]*\s-(?:method|body|infile|form)\b`) },
  { why: 'upload / send over the network', re: rx(CS + String.raw`(?:scp|sftp|ftp|tftp|ssh|rclone|nc|ncat|netcat|telnet|socat|smbclient|gsutil|aws|az|gcloud|s3cmd|sendmail|mail|mailx|mutt|msmtp|send-mailmessage|git\s+push|gh|docker\s+push|twine)\b`) },
  { why: 'upload / send over the network', re: rx(String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|nc|ncat)\b[^\r\n]*(?:\$\(|` + BT + String.raw`|<\s*\S)`) },
  { why: 'upload / send over the network', re: rx(String.raw`\|\s*(?:curl|wget|nc|ncat|netcat|iwr|irm|invoke-webrequest|invoke-restmethod)\b`) },
  { why: 'sends a message', re: rx(String.raw`\b(?:imessage|messages|mail|outlook|slack|teams|whatsapp|telegram|signal)\b[^\r\n]*\b(?:send|post|reply|forward)\b|\bsend\s+(?:message|email|mail)\b|mailto:|\bsms:|imessage:`) },
  { why: 'AppleScript UI scripting / shell / edits', re: rx(String.raw`\b(?:keystroke|key\s+code|key\s+down|click|perform\s+action|do\s+shell\s+script|make\s+new|delete|move|duplicate|empty|restart|shut\s+down|log\s+out|paste|open\s+location|set\s+(?:the\s+)?(?:value|contents?|volume|text|name|password)|press|select\s+menu)\b`) },
  { why: 'writes a file', re: rx(String.raw`(?<![0-9&<>=-])>>?(?![&>=])\s*(?!\/dev\/null\b|nul\b|\$null\b)["']?[^\s|;&)"']`) },
];

/** `null` when the command is safe to run unasked; otherwise why it still asks. */
export function classifyShellCommand(command: string): string | null {
  const cmd = String(command ?? '').trim();
  if (!cmd) return 'empty command';
  const hard = shellBlockReason(cmd);
  if (hard) return `blocklist: ${hard}`;
  const norm = cmd.replace(/\^/g, '');
  for (const rule of RISKY) {
    if (rule.re.test(cmd) || rule.re.test(norm)) return rule.why;
  }
  return null;
}

/**
 * True when the user must be asked. Anything that is not an eligible
 * user-started shell command defers to permission-policy's own decision.
 */
export function needsApproval(tool: string, args: Record<string, unknown> | undefined, ctx: ApprovalCtx): boolean {
  if (ctx.decision === 'allow') return false;
  if (ctx.decision === 'block') return true;
  // decision === 'approve' from here: ask unless every relaxation condition holds.
  if (ctx.escalated) return true;                 // purchase / send / delete click: never loosened
  if (ctx.origin !== 'user') return true;         // remote agent or proactive tip
  if (ctx.injectionSeen) return true;             // untrusted content in play
  if (ctx.mode === 'cautious' || ctx.classForcedApprove) return true; // the user asked to see everything
  if (tool !== 'shell_exec' || ctx.actionClass !== 'destructive_exec') return true;
  return classifyShellCommand(String(args?.command ?? '')) !== null;
}
