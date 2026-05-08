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
