import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Returns the shared output directory for all Tier 1 generated artifacts.
 * Creates the directory if it does not exist.
 */
export function getOutputDir(): string {
  const dir = path.join(app.getPath('userData'), 'output');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Sanitize a caller-supplied filename and force its extension.
 * Strips path separators / Windows-reserved chars; if the result doesn't
 * end with `ext`, appends `_<timestamp><ext>` to prevent collisions across
 * calls with the same base name.
 *
 * Single source of truth — pdf-from-text, excel-from-rows, docx-from-blocks
 * all use this. Pass `ext` with the leading dot, e.g. '.pdf'.
 */
export function sanitizeFilename(raw: string, ext: string): string {
  let name = raw.replace(/[/\\:*?"<>|]/g, '_').trim();
  if (!name) name = 'output';
  if (!name.endsWith(ext)) name = `${name}_${Date.now()}${ext}`;
  return name;
}
