/**
 * approval-policy.ts — the one place that decides whether a tool call that
 * permission-policy marked 'approve' still has to ask the user.
 *
 * Owner report: "asking for too much permission, if the user asked you to do
 * it, then dont ask for permission to run scripts". Every shell_exec is class
 * destructive_exec, so even `ls`, `open -a Claude` and an AppleScript
 * `activate` prompted. Policy: in a task the USER started, a shell command
 * that is part of the request runs without asking UNLESS it can delete, close,
 * install, upload, send, change security/system settings, run opaque code,
 * fetch from the network, run through a script host, run a file out of
 * Downloads/Temp/AppData or touch a secret store (classifyShellCommand), or something in the task looks like prompt injection,
 * or the task did not come from the user, or the user picked Cautious / an
 * explicit "approve" for the class. The hard blocklist (shell-guard.ts) still
 * refuses at execution whatever this says. Skill installs, purchases, sends,
 * payments, http_request and clawd_task keep asking exactly as before. A
 * governor-escalated click or key asks too, with one exception: the user's
 * own message asked for a send or a delete and the control is a Send-type or
 * Delete-type one (isRequestedEscalation). A purchase always asks.
 *
 * One deliberate exception besides shell_exec (owner report: "force quit
 * designcenter" asked three times, then failed): quitting THE APP THE USER
 * NAMED in this task's request runs unasked (isNamedAppQuit). kill_process is
 * resolved to the processes it would end before this is called; it must be one
 * app, not a protected process, and its process name or exe description must
 * contain a word of the request (never its window title: that's content). A PID
 * or name the user did not name, a match across several apps, or a resolve that
 * found nothing or failed, still asks.
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
  /** The governor recognised a Send-type or Delete-type control or key (RiskVerdict.family). */
  riskFamily?: 'send' | 'delete';
  /** Policy mode; 'cautious' means the user wants to see every action. */
  mode: 'cautious' | 'standard' | 'trusted';
  /** The user explicitly set this class to 'approve' in Settings → Guardrails. */
  classForcedApprove: boolean;
  /** The user's request text for this task (named-app quit exception). */
  requestText?: string;
  /** kill_process only: the processes the call would end, resolved live
   *  (tools.ts resolveKillTargets). null/undefined = could not resolve → ask.
   *  Empty = the call ends nothing (no match, refused, or several apps match
   *  and the tool returns the list instead). */
  killTargets?: KillTarget[] | null;
}

export interface KillTarget { name: string; window?: string; description?: string }

const BT = '`';
// Command position: start, after a separator / opening paren / quote / backtick
// / `$(`, or after `cmd /c`; optional `env VAR=x` prefix. Same idea as shell-guard.
const CS = String.raw`(?:^|[;&|({\r\n"']|` + BT + String.raw`|\$\(|\s/[ck]\s|\s-c(?:ommand)?\s)\s*(?:env\s+(?:\w+=\S+\s+)*)?`;
const rx = (src: string) => new RegExp(src, 'i');
// End of a command keyword. Not `\b`: that also ends `format` in the read-only
// `Format-Table` / `Format-List`, and `del`, `rd`, `mi` before any hyphen.
const END = String.raw`(?![\w-])`;

interface Rule { why: string; re: RegExp }

const RISKY: Rule[] = [
  { why: 'elevated privileges', re: rx(CS + String.raw`(?:sudo|doas|su|runas)\b`) },
  { why: 'administrator privileges', re: rx(String.raw`with\s+administrator\s+privileges|-verb\s+runas`) },
  { why: 'deletes files', re: rx(CS + String.raw`(?:rm|rmdir|unlink|shred|trash|del|erase|rd|remove-item|ri|srm|clear-recyclebin)${END}`) },
  { why: 'deletes files', re: rx(String.raw`(?:\s-delete\b|\bxargs\s+(?:-\S+\s+)*(?:rm|mv|kill)\b|-exec\s+(?:rm|mv)\b)`) },
  { why: 'moves/overwrites files', re: rx(CS + String.raw`(?:mv|move|ren|rename|cp|copy|xcopy|robocopy|ditto|rsync|move-item|copy-item|mi|ci|rename-item|dd|truncate|ln)${END}`) },
  { why: 'edits files in place', re: rx(String.raw`\b(?:sed|perl)\s+(?:-\S+\s+)*-i\b|\btee\b|\bset-content\b|\badd-content\b|\bout-file\b|\bclear-content\b`) },
  { why: 'changes permissions/ownership', re: rx(CS + String.raw`(?:chmod|chown|chgrp|chflags|xattr|icacls|takeown|attrib|setfacl)\b`) },
  { why: 'kills or quits apps/processes', re: rx(CS + String.raw`(?:kill|pkill|killall|taskkill|stop-process|spps|shutdown|reboot|halt|poweroff)\b`) },
  { why: 'quits or closes an app', re: rx(String.raw`\b(?:quit|close|terminate)\b`) },
  { why: 'system or security settings', re: rx(CS + String.raw`(?:defaults\s+(?:write|delete|import)|spctl|csrutil|tccutil|security|systemsetup|pmset|networksetup|scutil|launchctl|crontab|schtasks|at|reg(?:\.exe)?\s+(?:add|delete|import|load)|set-executionpolicy|set-mppreference|netsh|bcdedit|sc(?:\.exe)?\s+(?:stop|config|delete|create)|set-service|new-service|dscl|sysadminctl|diskutil|hdiutil|mount|umount|eject|fdisk|format|format-volume|clear-disk|initialize-disk|remove-partition|mount-diskimage|dismount-diskimage|(?:set|new|remove|clear)-itemproperty)${END}`) },
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
  // Inline code through an interpreter can do anything (python -c "shutil.rmtree(...)"),
  // so the deny-list above can't vouch for it.
  { why: 'runs inline code', re: rx(CS + String.raw`(?:python[0-9.]*|py|node|deno|bun|ruby|perl|php|lua|Rscript|osascript\s+-l\s+JavaScript)\b[^\r\n]*(?:\s-(?:c|e|-eval|p|-print|r)\b|\s<<|\s-\s*$)`) },
  { why: 'runs a script file', re: rx(CS + String.raw`(?:python[0-9.]*|py|node|deno|bun|ruby|perl|php|bash|sh|zsh|fish|source|\.|osascript)\s+(?:-\S+\s+)*[^\s-][^\s]*\.(?:py|js|mjs|cjs|ts|rb|pl|php|sh|zsh|bash|command|scpt|applescript)\b`) },
  { why: 'changes a git repository', re: rx(String.raw`\bgit\s+(?:-\S+\s+)*(?:reset|clean|checkout|restore|rm|mv|rebase|merge|commit|stash|branch\s+-[dD]|tag\s+-d|push|pull|apply|am|cherry-pick|revert|switch|filter-branch|gc|prune|reflog\s+expire|update-ref)\b`) },
  { why: 'writes a file', re: rx(String.raw`(?<![0-9&<>=-])>>?(?![&>=])\s*(?!\/dev\/null\b|nul\b|\$null\b)["']?[^\s|;&)"']`) },
];

// ── Remote code and secrets (0.24.12 audit #1) ──
// A command that fetches from the network, runs through a script host, or
// touches a secret store is how a prompt injection turns into code execution
// or exfiltration, so these ask whatever the request said.
const EXEC_EXT = String.raw`(?:exe|com|scr|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|jar|lnk|cpl|dll|py|sh)`;
// A path under Downloads, Temp or AppData (Programs and WindowsApps are where
// installed apps live, so launching those stays unasked).
const DROP_DIR = String.raw`(?:[^\s"'|;&<>]*[\\/])?(?:downloads|temp|tmp|appdata(?![\\/]local[\\/](?:programs|microsoft[\\/]windowsapps)[\\/]))[\\/]`;
const DROP_VAR = String.raw`(?:%(?:temp|tmp|appdata|localappdata)%|\$\{?env:(?:temp|tmp|appdata|localappdata)\}?|\$\{?TMPDIR\}?|/tmp|/var/tmp)[\\/]`;
const DROP_PATH = String.raw`["']?(?:${DROP_DIR}|${DROP_VAR})[^"'|;&<>\r\n]*?\.${EXEC_EXT}(?![\w.-])`;
const RUNNER = String.raw`(?:(?:start|call|start-process|saps|invoke-item|ii)\s+(?:""\s+)?(?:-filepath\s+)?|[&.]\s*)?`;

const REMOTE_OR_SECRET: Rule[] = [
  { why: 'fetches from or sends to the network', re: rx(String.raw`(?:^|[^\w.-])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin)(?:\.exe)?${END}`) },
  { why: 'fetches from or sends to the network', re: rx(String.raw`net\.webclient|net\.http|net\.sockets|webrequest\]|xmlhttp|\bcertutil(?:\.exe)?\b[^\r\n]*-(?:urlcache|verifyctl)\b`) },
  { why: 'script host or system binary that runs other code', re: rx(String.raw`(?:^|[^\w.-])(?:mshta|rundll32|regsvr32|wscript|cscript|msiexec|installutil|cmstp)(?:\.exe)?${END}`) },
  { why: 'runs code built at run time', re: rx(String.raw`\s-(?:e|ec|enc|encodedcommand)\s+[a-z0-9+/=]{16,}|\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|iex|invoke-expression|cmd|powershell|pwsh)(?:\.exe)?${END}|<\(`) },
  { why: 'runs a file from Downloads, Temp or AppData', re: rx(CS + RUNNER + DROP_PATH) },
  { why: 'reads a secret location', re: rx(String.raw`(?:^|[\s\\/"'=(~])\.(?:ssh|aws|gnupg|azure|kube|docker)(?![\w-])|\.git-credentials|\.netrc\b|\.npmrc\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b`) },
  { why: 'reads a secret location', re: rx(String.raw`[\\/]user data(?![\w-])|\b(?:login data|cookies\.sqlite|logins\.json|key[34]\.db)\b|agent-server\.json|microsoft[\\/](?:credentials|protect|vault)\b|\b(?:cmdkey|vaultcmd)\b|\.(?:pem|key|pfx|p12|kdbx|ppk)(?![\w-])`) },
  { why: 'reads a secret location', re: rx(String.raw`(?:^|[\s\\/"'=])\.env(?:\.[\w-]+)*(?=$|[\s"'|;&)])`) },
];

// The one URL form that stays unasked: the whole command opens one http(s)
// page in the browser ("open youtube"). No second statement, no variable.
const URL_ARG = String.raw`(?:"https?://[^"'\s` + BT + String.raw`$%^<>]+"|'https?://[^"'\s` + BT + String.raw`$%^<>]+'|https?://[^"'\s` + BT + String.raw`$%^<>|&;()]+)`;
const BROWSER = String.raw`(?:chrome|msedge|firefox|brave|safari|"[\w .]+"|'[\w .]+')`;
const PLAIN_OPEN = new RegExp(String.raw`^(?:start(?:\s+"")?(?:\s+${BROWSER})?|open(?:\s+-a\s+${BROWSER})?|xdg-open|explorer(?:\.exe)?|start-process|saps)\s+${URL_ARG}$`, 'i');
const HAS_URL = /\b(?:https?|ftps?|file|wss?):\/\//i;

/** The http(s) URL when the whole command just opens it in the browser. */
export function plainOpenUrl(command: string): string | null {
  const cmd = String(command ?? '').trim();
  if (!PLAIN_OPEN.test(cmd)) return null;
  return cmd.match(/https?:\/\/[^"'\s]+/i)?.[0] ?? null;
}

/** `null` when the command is safe to run unasked; otherwise why it still asks. */
export function classifyShellCommand(command: string): string | null {
  const cmd = String(command ?? '').trim();
  if (!cmd) return 'empty command';
  const hard = shellBlockReason(cmd);
  if (hard) return `blocklist: ${hard}`;
  const norm = cmd.replace(/\^/g, '');
  for (const rule of [...REMOTE_OR_SECRET, ...RISKY]) {
    if (rule.re.test(cmd) || rule.re.test(norm)) return rule.why;
  }
  if (HAS_URL.test(norm) && !plainOpenUrl(norm)) return 'contains a URL';
  return null;
}

// Same list as com-kill-process.ps1's blocklist, plus the macOS equivalents.
const PROTECTED_PROCESSES = new Set([
  'system', 'smss', 'csrss', 'wininit', 'services', 'lsass', 'winlogon', 'dwm', 'explorer', 'svchost',
  'clippyai', 'clippy', 'electron',
  'finder', 'dock', 'loginwindow', 'windowserver', 'launchd', 'kernel_task', 'systemuiserver',
]);
// Request words that never name an app (verbs, filler, vendor names).
const NOT_AN_APP = new Set([
  'force', 'quit', 'close', 'kill', 'stop', 'exit', 'terminate', 'end', 'shut', 'down', 'please', 'the',
  'app', 'apps', 'application', 'program', 'process', 'window', 'windows', 'task', 'and', 'now', 'for',
  'all', 'running', 'open', 'with', 'from', 'that', 'this', 'can', 'you', 'could', 'would', 'its',
  'just', 'not', 'responding', 'frozen', 'hung', 'stuck', 'microsoft', 'google', 'apple', 'adobe',
]);
const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stripExe = (s: string) => s.replace(/\.exe$/i, '');

/** App words in the request: each word of 3+ letters, plus adjacent pairs joined ("design center"). */
function requestAppWords(requestText: string): Set<string> {
  const all = wordsOf(requestText);
  const out = new Set<string>();
  all.forEach((w, i) => {
    if (NOT_AN_APP.has(w)) return;
    if (w.length >= 3) out.add(w);
    const next = all[i + 1];
    if (next && !NOT_AN_APP.has(next)) out.add(w + next);
  });
  return out;
}

/** True when a word of the request equals the label, or one word of it. */
function namedInRequest(appWords: Set<string>, label: string | undefined): boolean {
  if (!label) return false;
  const ws = wordsOf(label);
  return appWords.has(ws.join('')) || ws.some((w) => w.length >= 3 && appWords.has(w));
}

/**
 * The exception: every target is the same, unprotected app, and the user
 * named it by process name or exe description ("Designcenter NX" for ugraf).
 * Not by window title: a title is content (a browser tab, a document name), so
 * "quit designcenter" must not end Chrome showing a "Designcenter" page.
 */
export function isNamedAppQuit(requestText: string | undefined, targets: KillTarget[] | null | undefined): boolean {
  if (!requestText || !targets || targets.length === 0) return false;
  const names = new Set(targets.map((t) => stripExe(String(t.name ?? '')).toLowerCase()));
  if (names.size !== 1) return false;
  const [name] = names;
  if (!name || PROTECTED_PROCESSES.has(name)) return false;
  const appWords = requestAppWords(requestText);
  return targets.some((t) => namedInRequest(appWords, stripExe(t.name)) || namedInRequest(appWords, t.description));
}

/**
 * A shell quit by name: the whole typed name (not one word of it) is named in
 * the request, and no word of it is a protected process.
 */
function shellQuitNamed(requestText: string | undefined, app: string): boolean {
  if (!requestText) return false;
  const ws = wordsOf(stripExe(app));
  if (ws.length === 0 || ws.some((w) => PROTECTED_PROCESSES.has(w))) return false;
  // Vendor words don't count ("Google Chrome" is named by "chrome").
  const core = ws.filter((w) => !NOT_AN_APP.has(w)).join('');
  return !!core && requestAppWords(requestText).has(core);
}

// One argument: a quoted name (spaces allowed inside the quotes only) or a single
// bare token. A bare token can't hold a space, so "killall foo Finder" never parses.
const APP = String.raw`(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([\p{L}\p{N}][\p{L}\p{N}._+-]*))`;
const PS_OPTS = String.raw`(?:\s+-force|\s+-erroraction\s+\w+|\s+-confirm:\$false)*`;
const QUIT_FORMS = [
  String.raw`(?:stop-process|spps)${PS_OPTS}\s+-name\s+${APP}${PS_OPTS}`,
  String.raw`get-process\s+(?:-name\s+)?${APP}${PS_OPTS}\s*\|\s*stop-process${PS_OPTS}`,
  String.raw`taskkill(?:\s+/[ft])*\s+/im\s+${APP}(?:\s+/[ft])*`,
  String.raw`killall(?:\s+-(?:9|kill|term))?\s+${APP}`,
  String.raw`pkill(?:\s+-(?:9|kill|term))?\s+-x\s+${APP}`,
  String.raw`osascript\s+-e\s+'(?:tell\s+app(?:lication)?\s+"([^"*?]+)"\s+to\s+quit|quit\s+app(?:lication)?\s+"([^"*?]+)")'`,
].map((src) => new RegExp(`^${src}$`, 'iu'));

/**
 * The app name when the WHOLE command is one plain "quit this one app by exact
 * name" form (no second statement, no pipe to anything else, no wildcard, no
 * PID). Anything else is null and goes through classifyShellCommand.
 */
export function parseQuitCommand(command: string): string | null {
  let cmd = String(command ?? '').trim();
  const wrapped = cmd.match(/^(?:powershell|pwsh)(?:\.exe)?(?:\s+-noprofile|\s+-noninteractive|\s+-nologo)*\s+-c(?:ommand)?\s+"([^"]+)"$/i);
  if (wrapped) cmd = wrapped[1].trim();
  for (const re of QUIT_FORMS) {
    const m = cmd.match(re);
    const app = m?.slice(1).find((g) => g !== undefined)?.trim();
    if (app) return app;
  }
  return null;
}

// Verbs in the user's own message that ask for a send or a delete. email /
// mail / reply / post are also nouns ("what does this email say?"), so they
// count only when no determiner comes right before them.
const NOUN_MARK = String.raw`(?<!\b(?:this|that|the|my|a|an|your|his|her|their|our|latest|last|new|unread|every|each|any|some|which|what|these|those)\s+)`;
const REQUEST_VERBS: Record<'send' | 'delete', RegExp> = {
  send: new RegExp(String.raw`\b(?:send|sends|sending|submit|submits|submitting|emailing|mailing|replying|posting)\b|${NOUN_MARK}\b(?:email|e-mail|mail|reply|post)\b`, 'i'),
  delete: new RegExp(String.raw`\b(?:delete|deletes|deleting|remove|removes|removing|empty|emptying)\b|${NOUN_MARK}\btrash\b`, 'i'),
};
const FAMILY_CLASS: Record<'send' | 'delete', ActionClass> = { send: 'destructive_send', delete: 'destructive_file' };

/**
 * An escalated click or key that is exactly what the user asked for: they
 * wrote "send ..." and the control is a Send button, or "delete ..." and it is
 * a Delete button. `requestText` must be the user's own message, never page
 * text, a tool result or model text. Purchases, credential fields,
 * destructive_exec and a control of the other family are never requested.
 */
export function isRequestedEscalation(ctx: ApprovalCtx): boolean {
  const family = ctx.riskFamily;
  if (!ctx.escalated || !family || !ctx.requestText) return false;
  if (ctx.actionClass !== FAMILY_CLASS[family]) return false;
  return REQUEST_VERBS[family].test(ctx.requestText);
}

/**
 * True when the user must be asked. Anything that is not an eligible
 * user-started shell command or named-app quit defers to permission-policy's
 * own decision.
 */
export function needsApproval(tool: string, args: Record<string, unknown> | undefined, ctx: ApprovalCtx): boolean {
  if (ctx.decision === 'allow') return false;
  if (ctx.decision === 'block') return true;
  // decision === 'approve' from here: ask unless every relaxation condition holds.
  if (ctx.origin !== 'user') return true;         // remote agent or proactive tip
  if (ctx.injectionSeen) return true;             // untrusted content in play
  if (ctx.mode === 'cautious' || ctx.classForcedApprove) return true; // the user asked to see everything
  // A purchase / send / delete click asks, unless it is the send or delete the user asked for.
  if (ctx.escalated) return !isRequestedEscalation(ctx);
  if (ctx.actionClass !== 'destructive_exec') return true;
  if (tool === 'kill_process') {
    // An empty or failed resolve asks (fail closed): what runs could differ from what was resolved.
    return !isNamedAppQuit(ctx.requestText, ctx.killTargets);
  }
  if (tool !== 'shell_exec') return true;
  const command = String(args?.command ?? '');
  const app = parseQuitCommand(command);
  if (app && !shellBlockReason(command) && shellQuitNamed(ctx.requestText, app)) return false;
  return classifyShellCommand(command) !== null;
}
