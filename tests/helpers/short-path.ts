/**
 * Test helper: the Windows 8.3 short form of an existing folder
 * ("C:\Users\RUNNER~1\..."), or '' when there is none (not Windows, or short
 * names are off on the volume). GitHub's Windows runners hand out TEMP in
 * this form while USERPROFILE is the long one, which is how a guard that
 * compares the two unresolved breaks.
 */
import { execFileSync } from 'child_process';

export function shortFormOf(dir: string): string {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true,
    }).trim();
    return out && out.toLowerCase() !== dir.toLowerCase() && out.includes('~') ? out : '';
  } catch {
    return '';
  }
}
