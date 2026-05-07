/**
 * App Guide Loader (v0.11.22)
 *
 * Mirrors ClawdCursor's guide-loader.ts: load community-contributed JSON
 * guides keyed by process name, format them into compact text, and inject
 * into the model's screen-context block.
 *
 * Why: stock LLMs don't know app-specific quirks. The guide for Outlook
 * (`olk.json`) tells the model "Send is BLUE, top-left of compose; press
 * Ctrl+Enter to send (NOT Enter, NOT click)". This collapses an entire
 * class of failures (vision-from-screenshot click guessing) into a single
 * keyboard shortcut the model already knows how to emit.
 *
 * Path resolution:
 *   Dev (electron-vite): vendor/clawdcursor/guides/*.json
 *   Packaged:            {process.resourcesPath}/clawdcursor-guides/*.json
 *
 * The guides directory is bundled via electron-builder.yml `extraResources`.
 * Updating ClawdCursor + re-running `npm run vendor` refreshes the guide
 * set automatically (vendor-clawdcursor.js no longer skips `guides/` as of
 * v0.11.22).
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { createLogger, serializeErr } from './logger';

const log = createLogger('Guides');

export interface AppGuide {
  app: string;
  processNames: string[];
  workflows?: Record<string, string>;
  shortcuts?: Record<string, string>;
  layout?: Record<string, string>;
  tips?: string[];
  // Auto-discovered workflows from previous successful tasks. Written by
  // memory.ts and read here so the model sees them inline with the
  // hand-crafted guide. Same shape as ClawdCursor's `learnedWorkflows`.
  learnedWorkflows?: Record<string, string>;
}

const guideCache = new Map<string, AppGuide | null>();
const processToGuide = new Map<string, string>();
let indexBuilt = false;

function getGuidesDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'clawdcursor-guides');
  }
  // Dev mode: read straight from the vendored copy
  return path.join(__dirname, '..', '..', 'vendor', 'clawdcursor', 'guides');
}

function buildIndex(): void {
  if (indexBuilt) return;
  indexBuilt = true;

  const dir = getGuidesDir();
  if (!fs.existsSync(dir)) {
    log.warn('Guides directory not found', { dir });
    return;
  }

  let count = 0;
  try {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const guide = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as AppGuide;
        const baseName = file.replace('.json', '');
        guideCache.set(baseName, guide);
        for (const pn of guide.processNames || []) {
          processToGuide.set(pn.toLowerCase(), baseName);
        }
        count++;
      } catch (err) {
        log.warn('Skipped malformed guide', { file, error: serializeErr(err) });
      }
    }
    log.info('Loaded app guides', { dir, count, processes: Array.from(processToGuide.keys()) });
  } catch (err) {
    log.warn('Could not enumerate guides directory', { dir, error: serializeErr(err) });
  }
}

export function loadGuide(processName: string): AppGuide | null {
  buildIndex();
  if (!processName) return null;
  const norm = processName.toLowerCase();
  const guideName = processToGuide.get(norm);
  if (guideName && guideCache.has(guideName)) return guideCache.get(guideName) || null;
  // Also accept matches by filename (e.g. "EXCEL.exe" → "EXCEL")
  const stripped = norm.replace(/\.exe$/, '');
  if (guideCache.has(stripped)) return guideCache.get(stripped) || null;
  return null;
}

/**
 * Format a guide as compact text for system-prompt injection. Matches
 * ClawdCursor's formatGuideForPrompt exactly so the model sees the same
 * surface whether it's running through CC or through Clippy.
 */
export function formatGuideForPrompt(guide: AppGuide): string {
  const lines: string[] = [];
  lines.push(`\n--- APP GUIDE: ${guide.app} ---`);

  if (guide.workflows && Object.keys(guide.workflows).length > 0) {
    lines.push('WORKFLOWS:');
    for (const [name, steps] of Object.entries(guide.workflows)) {
      lines.push(`  ${name}: ${steps}`);
    }
  }

  if (guide.learnedWorkflows && Object.keys(guide.learnedWorkflows).length > 0) {
    lines.push('LEARNED WORKFLOWS (from previous successes on this machine):');
    for (const [name, steps] of Object.entries(guide.learnedWorkflows)) {
      lines.push(`  ${name}: ${steps}`);
    }
  }

  if (guide.shortcuts && Object.keys(guide.shortcuts).length > 0) {
    const shortcutStr = Object.entries(guide.shortcuts)
      .map(([n, k]) => `${n}=${k}`)
      .join(', ');
    lines.push(`SHORTCUTS: ${shortcutStr}`);
  }

  if (guide.layout && Object.keys(guide.layout).length > 0) {
    lines.push('LAYOUT:');
    for (const [area, desc] of Object.entries(guide.layout)) {
      lines.push(`  ${area}: ${desc}`);
    }
  }

  if (guide.tips && guide.tips.length > 0) {
    lines.push('IMPORTANT TIPS:');
    for (const tip of guide.tips) {
      lines.push(`  - ${tip}`);
    }
  }

  lines.push('--- END GUIDE ---');
  return lines.join('\n');
}

/**
 * One-shot helper. Returns the formatted guide text for a process, ready
 * for prompt injection. Empty string if no guide matches.
 */
export function getGuidePrompt(processName: string): string {
  const guide = loadGuide(processName);
  if (!guide) return '';
  return formatGuideForPrompt(guide);
}

/** List process names that have a guide (debug + settings UI). */
export function listGuidedProcesses(): string[] {
  buildIndex();
  return Array.from(processToGuide.keys()).sort();
}
