/**
 * Static checks on assets/scripts/*.ps1.
 *
 * v0.24.12 — unzip-files.ps1 declared a parameter named $input. $input is a
 * PowerShell automatic variable (the pipeline enumerator), so the parameter
 * was always empty and unzip_files always answered missing_input.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(__dirname, '..', 'assets', 'scripts');
const scripts = fs.readdirSync(DIR).filter((f) => f.endsWith('.ps1'));
// https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_automatic_variables
const AUTOMATIC = ['input', 'args', 'host', 'pid', 'home', 'error', 'this', 'matches', 'event', 'sender', 'foreach', 'switch', 'pwd', 'profile', 'psitem', '_', 'myinvocation', 'pscmdlet', 'stacktrace', 'lastexitcode'];

/** Names declared in the script's top-level param( ... ) block. */
function paramNames(src: string): string[] {
  const start = src.search(/^\s*param\s*\(/im);
  if (start < 0) return [];
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) { end = i; break; }
  }
  return [...src.slice(start, end).matchAll(/(?<!=\s*)\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|,|\)|$)/gm)].map((m) => m[1].toLowerCase());
}

describe('PowerShell scripts', () => {
  it('there are scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(10);
  });

  it.each(scripts)('%s: no parameter is named after an automatic variable', (file) => {
    const names = paramNames(fs.readFileSync(path.join(DIR, file), 'utf8'));
    expect(names.filter((n) => AUTOMATIC.includes(n))).toEqual([]);
  });

  it('unzip-files.ps1 takes -zipPath, and the tool passes it', () => {
    expect(paramNames(fs.readFileSync(path.join(DIR, 'unzip-files.ps1'), 'utf8'))).toEqual(['zippath', 'output', 'overwrite']);
    const tools = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'tools.ts'), 'utf8');
    expect(tools).toContain("const args = ['-zipPath', input, '-output', output];");
  });
});
