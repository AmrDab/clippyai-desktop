/**
 * shell-guard.ts — the hard floor under shell_exec (tools.ts).
 *
 * The permission prompt is the real defense (shell_exec is destructive_exec,
 * so the user sees the command first). These patterns are refused EVEN IF
 * the user approved: they have no legitimate one-line use from an assistant
 * and an approval can be a reflex click. Pure + dependency-free so it is
 * unit-tested both ways (tests/shell-guard.test.ts): every pattern must
 * catch its target AND leave the harmless look-alikes alone.
 */

import path from 'path';

interface BlockRule { what: string; re: RegExp }

// Command position: start of line, after a separator / opening paren or
// quote, or right after `cmd /c` / `powershell -c(ommand)`. Keeps `format`,
// `rd`, `del` from matching inside `git log --format` or `echo ... rd`.
const CS = String.raw`(?:^|[;&|({\r\n"']|\s/[ck]\s|\s-c(?:ommand)?\s)\s*`;

// A path the recursive deletes below must never target: a drive root, the
// Windows dir, Program Files, ProgramData, C:\Users or a user-profile root
// (C:\Users\name) — ONLY the root itself (optionally `\` or `\*`), so
// `rd /s /q C:\Users\me\project\build` stays allowed.
const END = String.raw`[\\/]?(?:\*(?:\.\*)?)?["']?(?=$|[\s;&|)])`;
const PROT = String.raw`["']?(?:` + [
  String.raw`[a-z]:`,                                              // C:  C:\  C:\*
  String.raw`[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata|users(?:[\\/][^\\/\s"';&|*]+)?)`,
  String.raw`%(?:systemdrive|systemroot|windir|programfiles(?:\(x86\))?|programdata|userprofile|homedrive)%`,
  String.raw`\$\{?env:(?:systemdrive|systemroot|windir|programfiles(?:\(x86\))?|programdata|userprofile|homedrive)\}?`,
  String.raw`\$home`,
  String.raw`~`,
].join('|') + `)${END}`;

// System directories (and anything under them) for takeown / icacls-style
// ownership grabs.
const SYSDIR = String.raw`["']?(?:[a-z]:[\\/]?(?=["'\s]|$)|[a-z]:[\\/](?:windows|program files(?: \(x86\))?|programdata)\b|%(?:systemdrive|systemroot|windir|programfiles(?:\(x86\))?)%|\$\{?env:(?:systemdrive|systemroot|windir|programfiles(?:\(x86\))?)\}?)`;

const SYSTEM_USER = String.raw`["']?(?:nt authority\\)?system\b`;
const STMT = String.raw`[^;&|\r\n]*`; // rest of the same statement

const rx = (src: string) => new RegExp(src, 'i');

export const SHELL_BLOCKLIST: BlockRule[] = [
  // ── Unix (unchanged since v0.20.0) ──
  { what: 'rm -rf /', re: /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+(--no-preserve-root\s+)?[/~](\s|$|\*)/ },
  { what: 'dd to /dev/', re: /\bdd\s+[^|;&]*\bof=\/dev\// },
  { what: 'mkfs', re: /\bmkfs(\.[a-z0-9]+)?\s+/ },
  { what: 'forkbomb', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },

  // ── macOS ──
  { what: 'recursive delete of a macOS system folder or home root',
    re: /\brm\s+(?:-[a-zA-Z-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-[a-zA-Z-]+\s+)*["']?\/(?:System|Library|Applications|private|usr|bin|sbin|etc|var|opt|Volumes|Users(?:\/[^/\s"';&|*]+)?)\/?\*?["']?(?=$|[\s;&|)])/ },
  { what: 'erasing or repartitioning a disk (diskutil)',
    re: rx(String.raw`\bdiskutil\b${STMT}\b(?:erase\w*|zero\w*|random\w*|secure\w*|partitiondisk|reformat|apfs\s+deletecontainer|apfs\s+deletevolume)\b`) },
  { what: 'disabling System Integrity Protection', re: rx(String.raw`\bcsrutil\s+(?:disable|authenticated-root\s+disable)\b`) },
  { what: 'disabling Gatekeeper', re: rx(String.raw`\bspctl\b${STMT}--(?:global-disable|master-disable)\b`) },
  { what: 'tampering with Time Machine backups', re: rx(String.raw`\btmutil\s+(?:delete|deletelocalsnapshots|disable)\b`) },

  // ── Windows ──
  { what: 'formatting a drive', re: rx(CS + String.raw`format(?:\.com)?\s+["']?[a-z]:`) },
  { what: 'formatting a drive', re: rx(String.raw`\b(?:format-volume|clear-disk)\b`) },
  { what: 'recursive delete of a drive root or system folder',
    re: rx(CS + String.raw`(?:rd|rmdir|del|erase)\b(?=${STMT}\s/s\b)${STMT}?\s${PROT}`) },
  { what: 'recursive delete of a drive root or system folder',
    re: rx(String.raw`\b(?:remove-item|ri|rm|rmdir|del|erase|rd)\b(?=${STMT}\s-r[a-z]*\b)${STMT}?\s(?:-(?:literal)?path\s+)?${PROT}`) },
  { what: 'deleting HKLM registry keys', re: rx(String.raw`\breg(?:\.exe)?\s+delete\s+["']?(?:hklm|hkey_local_machine)\b`) },
  { what: 'deleting HKLM registry keys', re: rx(String.raw`\b(?:remove-item|ri|remove-itemproperty)\b${STMT}\s["']?(?:hklm:|registry::hkey_local_machine)`) },
  { what: 'deleting shadow copies', re: rx(String.raw`\bvssadmin(?:\.exe)?\s+delete\s+shadows\b`) },
  { what: 'deleting shadow copies', re: rx(String.raw`\bwmic(?:\.exe)?\b${STMT}\bshadowcopy\b${STMT}\bdelete\b`) },
  { what: 'deleting system backups', re: rx(String.raw`\bwbadmin(?:\.exe)?\s+delete\b`) },
  // bcdedit with no args or /enum only reads; anything else edits boot config.
  { what: 'editing boot configuration (bcdedit)', re: rx(String.raw`\bbcdedit(?:\.exe)?\b(?!\s*(?:$|[;&|]|/enum\b|/v\b|/\?))`) },
  { what: 'wiping free disk space (cipher /w)', re: rx(String.raw`\bcipher(?:\.exe)?\b${STMT}\s/w(?::|\b)`) },
  { what: 'disabling Microsoft Defender', re: rx(String.raw`\bset-mppreference\b[^;|\r\n]*-disable[a-z]*(?:\s+|:)\$?(?:true|1)\b`) },
  { what: 'disabling Microsoft Defender', re: rx(String.raw`\breg(?:\.exe)?\s+add\b${STMT}\b(?:disableantispyware|disableantivirus|disablerealtimemonitoring)\b`) },
  { what: 'stopping Defender / firewall services',
    re: rx(String.raw`\b(?:sc(?:\.exe)?\s+(?:stop|config|delete)|net\s+stop|stop-service|set-service)\b${STMT}\b(?:windefend|mpssvc|wscsvc|sense|wdnissvc)\b`) },
  { what: 'turning off the firewall', re: rx(String.raw`\bnetsh(?:\.exe)?\b${STMT}\badvfirewall\s+set\s+\w+\s+state\s+off\b`) },
  { what: 'turning off the firewall', re: rx(String.raw`\bnetsh(?:\.exe)?\s+firewall\s+set\s+opmode\s+(?:mode=)?disable`) },
  { what: 'turning off the firewall', re: rx(String.raw`\bset-netfirewallprofile\b[^;|\r\n]*-enabled(?:\s+|:)\$?(?:false|0)\b`) },
  { what: 'creating a SYSTEM scheduled task',
    re: rx(String.raw`\bschtasks(?:\.exe)?\b(?=${STMT}\s/create\b)(?=${STMT}\s/ru\s+${SYSTEM_USER})`) },
  { what: 'creating a SYSTEM scheduled task', re: rx(String.raw`\bregister-scheduledtask\b[^;|\r\n]*-user\s+${SYSTEM_USER}`) },
  { what: 'creating a SYSTEM scheduled task', re: rx(String.raw`\bnew-scheduledtaskprincipal\b[^;|\r\n]*-userid\s+${SYSTEM_USER}`) },
  { what: 'taking ownership of system folders',
    re: rx(String.raw`\btakeown(?:\.exe)?\b(?=${STMT}\s/r\b)${STMT}\s/f\s+${SYSDIR}`) },
];

/**
 * Why `command` is refused, or null if it isn't on the blocklist. cmd's `^`
 * and PowerShell's backtick escapes are dropped before matching so `r^d /s`
 * can't slip past.
 */
export function shellBlockReason(command: string): string | null {
  const norm = command.replace(/[\^`]/g, '');
  for (const rule of SHELL_BLOCKLIST) {
    if (rule.re.test(command) || rule.re.test(norm)) return rule.what;
  }
  return null;
}

/**
 * shell_exec refuses to run with these as cwd even if approved: `/`,
 * `/System…`, any drive root, the Windows dir and Program Files (and below).
 */
export function isProtectedShellCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (cwd === '/' || cwd === '/System' || cwd.startsWith('/System/')) return true;
  if (!/^[a-z]:/i.test(cwd)) return false;
  if (/^[a-z]:[\\/.]*$/i.test(cwd)) return true; // C:  C:\  C:/
  const norm = (p: string) => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const p = norm(cwd);
  if (/^[a-z]:$/.test(p)) return true;
  const roots = [
    env.SystemRoot, env.windir, env.ProgramFiles, env['ProgramFiles(x86)'],
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  ].filter((r): r is string => !!r && /^[a-z]:/i.test(r)).map(norm);
  return roots.some((r) => p === r || p.startsWith(r + '\\'));
}
