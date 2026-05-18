// Clippy's startup orientation.
//
// Before he meets the user, before any IPC fires, Clippy reads his own
// brain files — soul → identity → core-behavior → tool-guide → safety-
// rules → app-knowledge. Each file must exist and be non-empty for him to
// be "oriented." If any are missing or empty, we log loudly and surface
// the bad state to the onboarding renderer, but we don't crash — a partial
// orientation is better than no app at all.
//
// The server still owns the active system prompt sent to the model. These
// files are the *canonical-truth* reference shipped with every build, and
// the orientation check is what guarantees an install hasn't been tampered
// with or arrived corrupt.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';

const log = createLogger('Orient');

// Order matters: read top-down, foundational layers first.
export const BRAIN_FILES = [
  'soul.md',
  'identity.md',
  'core-behavior.md',
  'tool-guide.md',
  'safety-rules.md',
  'app-knowledge.md',
] as const;

export type BrainFile = (typeof BRAIN_FILES)[number];

export interface OrientationResult {
  ok: boolean;
  files: Record<string, boolean>;
  bytesRead: number;
  brainDir: string;
}

// In a packaged build, electron-builder copies assets/brain → resources/brain.
// In dev (npm start, vite), we read straight from the source tree so editing
// soul.md doesn't require a rebuild.
function brainDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'brain');
  }
  return path.join(app.getAppPath(), 'assets', 'brain');
}

let cached: OrientationResult | null = null;

export function orient(): OrientationResult {
  if (cached) return cached;

  const dir = brainDir();
  const files: Record<string, boolean> = {};
  let bytesRead = 0;
  let allOk = true;

  for (const name of BRAIN_FILES) {
    const p = path.join(dir, name);
    try {
      const content = fs.readFileSync(p, 'utf8');
      const ok = content.trim().length > 0;
      files[name] = ok;
      if (ok) {
        bytesRead += content.length;
      } else {
        log.warn(`brain file is empty: ${name}`);
        allOk = false;
      }
    } catch (err) {
      files[name] = false;
      allOk = false;
      log.warn(`brain file missing: ${name} (${(err as Error).message})`);
    }
  }

  if (allOk) {
    log.info(`Clippy oriented — ${BRAIN_FILES.length} files, ${bytesRead} chars from ${dir}`);
  } else {
    const missing = BRAIN_FILES.filter((n) => !files[n]);
    log.error(`Clippy could not fully orient — missing/empty: ${missing.join(', ')}`);
  }

  cached = { ok: allOk, files, bytesRead, brainDir: dir };
  return cached;
}
