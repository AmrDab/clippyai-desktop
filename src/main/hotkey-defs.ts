/**
 * hotkey-defs.ts — the app's global accelerators + a pure helper that turns
 * an Electron accelerator string into per-platform keycaps.
 *
 * Pure: no Electron, no I/O. Imported by main (hotkey.ts registers these
 * exact strings) AND by the settings/onboarding renderers (which display
 * them), so the UI can never drift from what is actually registered.
 *
 * Electron accelerator semantics (docs/api/accelerator):
 *   - `Ctrl`/`Control` is the Control key on EVERY platform (⌃ on mac).
 *   - `CommandOrControl`/`CmdOrCtrl` is ⌘ on mac, Ctrl elsewhere.
 *   - `Alt`/`Option` is ⌥ on mac, Alt elsewhere.
 */

export const SUMMON_ACCELERATOR = 'Ctrl+Shift+C';
export const VOICE_ACCELERATOR_DEFAULT = 'CommandOrControl+Shift+Space';
export const WRITING_ASSIST_ACCELERATOR = 'Alt+G';

export type KeycapPlatform = 'mac' | 'win';

/** One keycap: the glyph/text to draw and its spoken name for aria-label. */
export interface Keycap {
  glyph: string;
  name: string;
}

const MODIFIERS: Record<string, Record<KeycapPlatform, Keycap>> = {
  commandorcontrol: { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Ctrl', name: 'Control' } },
  cmdorctrl:        { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Ctrl', name: 'Control' } },
  command:          { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Win',  name: 'Windows' } },
  cmd:              { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Win',  name: 'Windows' } },
  super:            { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Win',  name: 'Windows' } },
  meta:             { mac: { glyph: '⌘', name: 'Command' }, win: { glyph: 'Win',  name: 'Windows' } },
  control:          { mac: { glyph: '⌃', name: 'Control' }, win: { glyph: 'Ctrl', name: 'Control' } },
  ctrl:             { mac: { glyph: '⌃', name: 'Control' }, win: { glyph: 'Ctrl', name: 'Control' } },
  alt:              { mac: { glyph: '⌥', name: 'Option' },  win: { glyph: 'Alt',  name: 'Alt' } },
  option:           { mac: { glyph: '⌥', name: 'Option' },  win: { glyph: 'Alt',  name: 'Alt' } },
  altgr:            { mac: { glyph: '⌥', name: 'Option' },  win: { glyph: 'AltGr', name: 'AltGr' } },
  shift:            { mac: { glyph: '⇧', name: 'Shift' },   win: { glyph: 'Shift', name: 'Shift' } },
};

/** Map an accelerator ("CommandOrControl+Shift+Space") to keycaps for one platform. */
export function acceleratorKeycaps(accelerator: string, platform: KeycapPlatform): Keycap[] {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const mod = MODIFIERS[part.toLowerCase()];
      if (mod) return mod[platform];
      const key = part.length === 1 ? part.toUpperCase() : part;
      return { glyph: key, name: key };
    });
}

/** Inline text form: "⌘⇧Space" on mac, "Ctrl+Shift+Space" on win. */
export function acceleratorLabel(accelerator: string, platform: KeycapPlatform): string {
  const caps = acceleratorKeycaps(accelerator, platform).map((k) => k.glyph);
  return platform === 'mac' ? caps.join('') : caps.join('+');
}

/** Spoken form for aria-labels: "Control Shift C". */
export function acceleratorSpoken(accelerator: string, platform: KeycapPlatform): string {
  return acceleratorKeycaps(accelerator, platform).map((k) => k.name).join(' ');
}
