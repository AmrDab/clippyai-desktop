import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The tray icon shipped blank: src referenced build/icon.ico inside app.asar,
// where build/ is never packed. Keep the icon an extraResource and every
// reference going through appIconPath().
describe('app icon packaging', () => {
  const root = path.join(__dirname, '..');
  it('ships build/icon.ico as an extraResource', () => {
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/- from: build\/icon\.ico\s+to: icon\.ico/);
  });
  it('no main-process file loads build/icon.ico relative to __dirname', () => {
    const dir = path.join(root, 'src', 'main');
    const offenders = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes("'../../build/icon.ico')") && f !== 'app-icon.ts');
    expect(offenders).toEqual([]);
  });
});
