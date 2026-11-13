import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  SUMMON_ACCELERATOR, VOICE_ACCELERATOR_DEFAULT, WRITING_ASSIST_ACCELERATOR,
  acceleratorKeycaps, acceleratorLabel, acceleratorSpoken,
} from '../src/main/hotkey-defs';

const glyphs = (accel: string, p: 'mac' | 'win') => acceleratorKeycaps(accel, p).map((k) => k.glyph);

describe('acceleratorKeycaps — per-platform keycaps from Electron accelerators', () => {
  it('CommandOrControl is ⌘ on mac and Ctrl on win', () => {
    expect(glyphs(VOICE_ACCELERATOR_DEFAULT, 'mac')).toEqual(['⌘', '⇧', 'Space']);
    expect(glyphs(VOICE_ACCELERATOR_DEFAULT, 'win')).toEqual(['Ctrl', 'Shift', 'Space']);
  });
  it('Ctrl is the Control key on every platform (⌃ on mac, never ⌘)', () => {
    expect(glyphs(SUMMON_ACCELERATOR, 'mac')).toEqual(['⌃', '⇧', 'C']);
    expect(glyphs(SUMMON_ACCELERATOR, 'win')).toEqual(['Ctrl', 'Shift', 'C']);
  });
  it('Alt is ⌥ on mac and Alt on win', () => {
    expect(glyphs(WRITING_ASSIST_ACCELERATOR, 'mac')).toEqual(['⌥', 'G']);
    expect(glyphs(WRITING_ASSIST_ACCELERATOR, 'win')).toEqual(['Alt', 'G']);
  });
  it('never emits mac glyphs for win', () => {
    for (const accel of [SUMMON_ACCELERATOR, VOICE_ACCELERATOR_DEFAULT, WRITING_ASSIST_ACCELERATOR, 'Super+Alt+x']) {
      expect(acceleratorLabel(accel, 'win')).not.toMatch(/[⌘⌥⇧⌃]/);
    }
  });
  it('label + spoken forms', () => {
    expect(acceleratorLabel(VOICE_ACCELERATOR_DEFAULT, 'mac')).toBe('⌘⇧Space');
    expect(acceleratorLabel(VOICE_ACCELERATOR_DEFAULT, 'win')).toBe('Ctrl+Shift+Space');
    expect(acceleratorSpoken(VOICE_ACCELERATOR_DEFAULT, 'win')).toBe('Control Shift Space');
    expect(acceleratorSpoken(SUMMON_ACCELERATOR, 'mac')).toBe('Control Shift C');
  });
});

describe('settings.html — Windows build has no baked-in macOS leftovers', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'settings.html'), 'utf8');
  const hotkeyTs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hotkey.ts'), 'utf8');

  it('keycap rows are empty shells filled at runtime, not hardcoded ⌘/⇧', () => {
    const rows = html.match(/<div class="s-keycap"[^>]*>[\s\S]*?<\/div>/g) ?? [];
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).not.toMatch(/&#8984;|⌘|&#8679;|⇧|<kbd>/);
      expect(row).not.toMatch(/aria-label="[^"]*Command/);
    }
  });

  it('hotkey.ts registers the shared accelerator constants (no drift from the UI)', () => {
    expect(hotkeyTs).toMatch(/globalShortcut\.register\(SUMMON_ACCELERATOR/);
    expect(hotkeyTs).toMatch(/\|\| VOICE_ACCELERATOR_DEFAULT/);
    expect(hotkeyTs).toMatch(/globalShortcut\.register\(WRITING_ASSIST_ACCELERATOR/);
  });

  it('exactly the darwin-only cards are marked data-mac-only', () => {
    const cards = html.match(/<div class="s-card" data-mac-only>[\s\S]*?<h3 class="s-card__title">([^<]+)/g) ?? [];
    const titles = cards.map((c) => c.match(/s-card__title">([^<]+)/)![1].trim());
    expect(titles).toEqual(['Permissions', 'Follow focused window', 'Writing assistant', 'Typing awareness']);
  });

  it('every "Mac" mention outside mac-only cards is wrapped in [data-mac] with a [data-win] twin', () => {
    const withoutMacOnly = html.replace(/<div class="s-card" data-mac-only>[\s\S]*?\n        <\/div>/g, '');
    const withoutComments = withoutMacOnly.replace(/<!--[\s\S]*?-->/g, '');
    const withoutMacSpans = withoutComments.replace(/<span data-mac>[^<]*<\/span>/g, '');
    expect(withoutMacSpans).not.toMatch(/\bMac\b|macOS|Keychain|[⌘⌥]/);
    const macSpans = (withoutComments.match(/<span data-mac>/g) ?? []).length;
    const winSpans = (withoutComments.match(/<span data-win>/g) ?? []).length;
    expect(macSpans).toBeGreaterThan(0);
    expect(winSpans).toBe(macSpans);
  });
});
