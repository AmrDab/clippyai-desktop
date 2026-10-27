/**
 * scripts/test-security-sweep.js — behavioral check for the security_sweep
 * tool's PowerShell backend (assets/scripts/security-scan.ps1).
 *
 * Runs only the `defender` section (read-only, ~1-3 s) and asserts the last
 * stdout line parses as JSON with ok:true and readOnly:true — the contract
 * securitySweep() in src/main/tools.ts relies on. The static read-only
 * grep lives in scripts/smoke.js layer 1; this is the "does it actually run
 * on a real Windows box" half.
 *
 * Skipped on non-win32 (no powershell.exe).
 * Run: node scripts/test-security-sweep.js
 */

const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'assets', 'scripts', 'security-scan.ps1');

console.log('=== security_sweep behavioral (security-scan.ps1 -sections defender) ===');

if (process.platform !== 'win32') {
  console.log('  \x1b[33m[SKIP]\x1b[0m not win32 — powershell.exe unavailable');
  process.exit(0);
}

let out;
try {
  out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', SCRIPT, '-sections', 'defender',
  ], { timeout: 60000, encoding: 'utf8' }).toString().trim();
} catch (err) {
  console.log(`  \x1b[31m[FAIL]\x1b[0m script exited non-zero: ${(err.stdout || err.message || '').toString().substring(0, 300)}`);
  process.exit(1);
}

const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
let parsed;
try {
  parsed = JSON.parse(lines[lines.length - 1].replace(/^﻿/, ''));
} catch {
  console.log(`  \x1b[31m[FAIL]\x1b[0m last stdout line is not JSON: ${lines[lines.length - 1]?.substring(0, 200)}`);
  process.exit(1);
}

const problems = [];
if (parsed.ok !== true) problems.push(`ok=${parsed.ok}`);
if (parsed.readOnly !== true) problems.push(`readOnly=${parsed.readOnly}`);
if (!Array.isArray(parsed.sections) || !parsed.sections.includes('defender')) problems.push('sections missing defender');
if (!Array.isArray(parsed.findings)) problems.push('findings not an array');
if (typeof parsed.verdict !== 'string') problems.push('verdict missing');

if (problems.length) {
  console.log(`  \x1b[31m[FAIL]\x1b[0m output contract: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`  \x1b[32m[PASS]\x1b[0m ok:true readOnly:true, verdict="${parsed.verdict}", ${parsed.durationMs}ms`);
