/**
 * 0.24.12 security fixes that live in the Windows PowerShell scripts. The
 * scripts drive Office / the shell, so they are checked by reading them: each
 * guard must be present AND placed before the call it protects.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const script = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'assets', 'scripts', name), 'utf8');
/** Index of `needle` in `src`; fails the test when it is missing. */
const at = (src: string, needle: string | RegExp): number => {
  const i = typeof needle === 'string' ? src.indexOf(needle) : src.search(needle);
  expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe('Office COM tools (audit #11)', () => {
  it.each([
    ['com-excel-read.ps1', '$excel.AutomationSecurity = 3', '$excel.Workbooks.Open(', '$path'],
    ['com-excel-write.ps1', '$excel.AutomationSecurity = 3', '$excel.Workbooks.Open(', '$path'],
    ['com-word-to-pdf.ps1', '$word.AutomationSecurity = 3', '$word.Documents.Open(', '$inputPath'],
  ])('%s disables macros before Open and runs the path guard first', (name, macroOff, open, pathVar) => {
    const src = script(name);
    // Macros are forced off before the file is opened.
    expect(at(src, macroOff)).toBeLessThan(at(src, open));
    // The guard is loaded and applied to the path before Office is started.
    const guardCall = at(src, `Test-PathAllowedForRead ${pathVar}`);
    expect(at(src, '. "$PSScriptRoot\\_path-guard.ps1"')).toBeLessThan(guardCall);
    expect(guardCall).toBeLessThan(at(src, 'New-Object -ComObject'));
    expect(src.slice(guardCall, guardCall + 200)).toMatch(/if \(-not \$guard\.allowed\) \{ Fail /);
    // ...and before the first filesystem touch of that path (Test-Path on a UNC path contacts the server).
    expect(guardCall).toBeLessThan(at(src, /Test-Path (-LiteralPath )?\$(path|inputPath)/));
  });

  it('word_to_pdf also guards the output path', () => {
    const src = script('com-word-to-pdf.ps1');
    expect(at(src, 'Test-PathAllowedForRead $outputPath')).toBeLessThan(at(src, 'New-Object -ComObject'));
  });

  it('the shared guard refuses UNC paths', () => {
    expect(script('_path-guard.ps1')).toMatch(/unc_path_blocked/);
  });

  it('the scripts stay ASCII (Windows PowerShell 5.1 reads a BOM-less file as ANSI)', () => {
    for (const name of ['com-excel-read.ps1', 'com-excel-write.ps1', 'com-word-to-pdf.ps1']) {
      const added = script(name).split(/\r?\n/).filter((l) => /0\.24\.12|AutomationSecurity|msoAutomation|path-guard|\$guard|\$outGuard/.test(l));
      expect(added.length).toBeGreaterThan(3);
      // eslint-disable-next-line no-control-regex
      for (const line of added) expect(line).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});

describe('kill_process (audit #15)', () => {
  const src = script('com-kill-process.ps1');
  it('rejects wildcard characters in a name before the lookup', () => {
    const reject = at(src, "if ($cleanName -match '[*?\\[\\]]') { Fail");
    expect(reject).toBeLessThan(at(src, 'Get-Process -Name $cleanName'));
    // The script's own pattern rejects every wildcard form and accepts real names.
    const pattern = src.slice(reject).match(/-match '([^']+)'/)![1];
    const re = new RegExp(pattern);
    for (const bad of ['*', 'ls*', 'l?ass', '[l]sass', 'win[il]*', 'svc]host']) expect(re.test(bad)).toBe(true);
    for (const ok of ['notepad', 'designcenter', 'msedge', 'my-app_2', 'code - insiders', 'app.v2']) expect(re.test(ok)).toBe(false);
  });
  it('re-checks every resolved process against the blocklist before anything is killed', () => {
    const lookup = at(src, 'Get-Process -Name $cleanName');
    const recheck = at(src, "if ($BLOCKLIST -contains $tn) { Fail");
    expect(recheck).toBeGreaterThan(lookup);
    expect(recheck).toBeLessThan(at(src, 'Stop-Process -Id'));
    // ...and before the resolve-only answer the approval gate reads.
    expect(recheck).toBeLessThan(at(src, 'Out-Result @{ ok = $true; targets = $rows }'));
  });
  it('the blocklist still names the OS-critical processes', () => {
    for (const p of ['lsass', 'csrss', 'winlogon', 'services', 'svchost', 'explorer', 'clippyai']) expect(src).toContain(`'${p}'`);
  });
});

describe('zip_files (audit #16)', () => {
  const src = script('zip-files.ps1');
  it('requires a .zip output and a literal path before anything is deleted', () => {
    const remove = at(src, 'Remove-Item -LiteralPath $output');
    expect(at(src, "if ([System.IO.Path]::GetExtension($output).ToLower() -ne '.zip') { Fail")).toBeLessThan(remove);
    expect(at(src, "if ($output -match '[*?\\[\\]]') { Fail")).toBeLessThan(remove);
    expect(at(src, 'if (Test-Path -LiteralPath $output -PathType Container) { Fail')).toBeLessThan(remove);
  });
  it('never uses the output or an input as a wildcard path', () => {
    expect(src).not.toMatch(/Remove-Item -Path/);
    expect(src).not.toMatch(/Test-Path \$output/);
    expect(src).not.toMatch(/Get-Item -Path/);
    expect(src).not.toMatch(/Compress-Archive -Path/);
    expect(src).toContain('Compress-Archive -LiteralPath $inputList');
  });
});

describe('olk-send-email-direct.ps1 (audit #22)', () => {
  const src = script('olk-send-email-direct.ps1');
  it('no mail field is typed with SendKeys: To, Subject and body are pasted', () => {
    // The only SendKeys calls left send fixed key names, never a variable.
    const calls = src.match(/SendKeys\]::SendWait\(([^\n]*)\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c).toMatch(/SendWait\('(\^v|\{TAB\}|\^\{ENTER\}|[^'$]*)'\)$/);
    expect(src).not.toMatch(/SendWait\(\$/);
    expect(src).not.toContain('$escapedSubject');
    expect(src).toContain('Paste-Literal (One-Line $to)');
    expect(src).toContain('Paste-Literal (One-Line $subject)');
    expect(src).toContain('Paste-Literal $body');
  });
  it('fields are pasted in order, before the send key', () => {
    const to = at(src, 'Paste-Literal (One-Line $to)');
    const subject = at(src, 'Paste-Literal (One-Line $subject)');
    const body = at(src, 'Paste-Literal $body');
    const send = at(src, "SendWait('^{ENTER}')");
    expect(to).toBeLessThan(subject);
    expect(subject).toBeLessThan(body);
    expect(body).toBeLessThan(send);
  });
  it('the single-line fields lose their line breaks, and the clipboard is put back', () => {
    expect(src).toContain("function One-Line([string]$text) { return (($text -replace '[\\r\\n\\t]+', ' ').Trim()) }");
    expect(at(src, '[System.Windows.Forms.Clipboard]::SetText($priorClip)')).toBeLessThan(at(src, "SendWait('^{ENTER}')"));
  });
});
