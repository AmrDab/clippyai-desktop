/**
 * Support bundle assembly for the "Report issue" flow.
 *
 * v0.11.28 — replaces the old single-string log upload. The bundle now
 * stitches together:
 *   1) System fingerprint (OS, version, monitors, DPI, electron version)
 *   2) Boot log (last 4KB) — pre-whenReady crash diagnostics
 *   3) Task slice — last user request's log lines, isolated by task_id
 *      so an engineer can read just the failing flow without scrolling
 *      through unrelated proactive ticks
 *   4) Full clippy.log content (PII-scrubbed)
 *   5) Crash dump filenames (not the dumps themselves)
 *
 * All sections are PII-scrubbed before assembly. Output is capped to
 * 50000 chars to fit the /report KV value limit.
 */
import { app, screen } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scrubPII } from './logger';

const MAX_BUNDLE_CHARS = 50000;
const BOOT_LOG_TAIL = 4000;
const TASK_SLICE_MAX_LINES = 200;

interface SystemInfo {
  app_version: string;
  electron_version: string;
  node_version: string;
  os_platform: string;
  os_release: string;
  os_arch: string;
  total_mem_gb: number;
  cpu_count: number;
  display_count: number;
  primary_display: { width: number; height: number; scale: number } | null;
}

function collectSystemInfo(): SystemInfo {
  let primary: SystemInfo['primary_display'] = null;
  let displayCount = 0;
  try {
    const displays = screen.getAllDisplays();
    displayCount = displays.length;
    const p = screen.getPrimaryDisplay();
    primary = {
      width: p.size.width,
      height: p.size.height,
      scale: p.scaleFactor,
    };
  } catch { /* screen API unavailable pre-ready, fine */ }

  return {
    app_version: app.getVersion(),
    electron_version: process.versions.electron || 'unknown',
    node_version: process.versions.node || 'unknown',
    os_platform: process.platform,
    os_release: os.release(),
    os_arch: process.arch,
    total_mem_gb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    cpu_count: os.cpus().length,
    display_count: displayCount,
    primary_display: primary,
  };
}

function readBootLog(): string {
  try {
    const p = path.join(app.getPath('appData'), 'ClippyAI', 'boot.log');
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8').slice(-BOOT_LOG_TAIL);
  } catch { return ''; }
}

function listCrashDumps(): string[] {
  try {
    const dir = app.getPath('crashDumps');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.dmp')).slice(-5);
  } catch { return []; }
}

/**
 * Pull the lines belonging to the most recent task_id from the log content.
 * Each line is JSONL with an optional `task_id` field. Taking the last
 * non-empty task_id and grabbing its lines isolates the failing turn for
 * the engineer reviewing the bundle.
 */
function extractLastTaskSlice(content: string): { task_id: string | null; slice: string } {
  const lines = content.split('\n');
  // Walk backwards to find the most recent task_id
  let lastTaskId: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.task_id === 'string' && obj.task_id) {
        lastTaskId = obj.task_id;
        break;
      }
    } catch { /* skip non-JSON lines */ }
  }
  if (!lastTaskId) return { task_id: null, slice: '(no task_id seen — older log format or no recent task)' };

  // Now collect all lines with that task_id (forward pass)
  const sliceLines: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.task_id === lastTaskId) sliceLines.push(line);
    } catch { /* skip non-JSON */ }
    if (sliceLines.length >= TASK_SLICE_MAX_LINES) break;
  }
  return { task_id: lastTaskId, slice: sliceLines.join('\n') };
}

export function buildBundle(content: string): { logs: string; manifest: Record<string, unknown> } {
  const sys = collectSystemInfo();
  const boot = readBootLog();
  const dumps = listCrashDumps();
  const { task_id, slice } = extractLastTaskSlice(content);

  const sections: string[] = [];

  sections.push('=== system info ===');
  sections.push(JSON.stringify(sys, null, 2));

  sections.push('\n=== last task slice ===');
  sections.push(`task_id: ${task_id || '(none)'}`);
  sections.push(slice);

  if (boot) {
    sections.push('\n=== boot.log (last 4KB) ===');
    sections.push(boot);
  }

  sections.push('\n=== clippy.log ===');
  sections.push(content);

  if (dumps.length > 0) {
    sections.push('\n=== crash dumps on disk ===');
    sections.push(dumps.join('\n'));
  }

  // Scrub PII across the assembled bundle (boot.log + system info added
  // fresh paths/usernames that the per-line scrub at writeLog never saw).
  let bundle = sections.join('\n');
  bundle = scrubPII(bundle);

  // Cap to /report endpoint limit (50KB stored, server clips at 50000 chars)
  if (bundle.length > MAX_BUNDLE_CHARS) {
    const head = bundle.substring(0, MAX_BUNDLE_CHARS - 100);
    bundle = `${head}\n\n[truncated to ${MAX_BUNDLE_CHARS} chars]`;
  }

  const manifest: Record<string, unknown> = {
    schema_version: 1,
    created_at: new Date().toISOString(),
    app_version: sys.app_version,
    // v0.17.7 — surface OS in the manifest itself so triage doesn't have
    // to scan the system-info header. The KV report viewer keys by
    // manifest fields; having os_platform here makes mac-vs-windows
    // filtering trivial.
    os_platform: sys.os_platform,
    os_release: sys.os_release,
    last_task_id: task_id,
    has_boot_log: !!boot,
    crash_dump_count: dumps.length,
    bundle_chars: bundle.length,
  };

  return { logs: bundle, manifest };
}
