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
