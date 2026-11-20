/**
 * sendkeys.ts — key_press on Windows: "ctrl+enter" → the SendKeys string "^{ENTER}".
 *
 * The old code lowercased the combo and then looked the key up in a map with
 * capitalised names, so the lookup always missed: ctrl+enter sent Ctrl+E and
 * then typed "nter", alt+f4 sent Alt+F and typed "4". Now the lookup ignores
 * case, a key that is not known is an error (never typed out as letters), and
 * raw SendKeys syntax (%{F4}, ^{ENTER}, ~) is refused: the model writes the
 * combo by name. Pure (no Electron) so it unit-tests.
 */

/** Key name (lower case) → SendKeys token. */
const NAMED_KEYS: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}', esc: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}', del: '{DELETE}',
  insert: '{INSERT}', ins: '{INSERT}',
  space: ' ', spacebar: ' ',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', page_up: '{PGUP}', pgup: '{PGUP}',
  pagedown: '{PGDN}', page_down: '{PGDN}', pgdn: '{PGDN}',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `{F${i + 1}}`])),
};

const MODIFIERS: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' };
const WIN_NAMES = new Set(['win', 'windows', 'meta', 'cmd', 'command', 'super']);

/** Characters SendKeys gives a meaning to: sent literally only inside braces. */
const SENDKEYS_SPECIAL = new Set(['+', '^', '%', '~', '(', ')', '{', '}', '[', ']']);

export type SendKeysResult = { ok: true; keys: string } | { ok: false; error: string };

const fail = (error: string): SendKeysResult => ({ ok: false, error });
const EXAMPLES = 'Write the keys by name, joined with +: enter, ctrl+enter, alt+f4, ctrl+shift+s, shift+tab';

/** One key (no modifiers) as a SendKeys token. */
function keyToken(key: string): SendKeysResult {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return { ok: true, keys: named };
  if (key.length === 1) {
    if (key === '~') return fail('"~" is SendKeys for Enter, not a key name. Use "enter"; to type the character use type_text');
    // Inside a single-quoted PowerShell string: printable ASCII only, never a quote.
    if (key < ' ' || key > '~' || key === "'") return fail(`"${key}" cannot be pressed as a key; use type_text for characters`);
    return { ok: true, keys: SENDKEYS_SPECIAL.has(key) ? `{${key}}` : key };
  }
  return fail(`unknown key "${key}". ${EXAMPLES}. To type text use type_text`);
}

/**
 * The SendKeys string for a key or a combo. Case and spaces around + do not
 * matter ("Ctrl + Enter" = "ctrl+enter").
 */
export function toSendKeys(raw: string): SendKeysResult {
  const s = String(raw ?? '').trim();
  if (!s) return fail('no key given');
  // Raw SendKeys: a braced token, or its modifier prefixes on a key name (%{F4}, ^s, ~).
  if (/[{}]/.test(s) || (s.length > 1 && /^[\^%~]/.test(s))) {
    return fail(`"${s}" is raw SendKeys syntax, which key_press does not take. ${EXAMPLES}`);
  }
  // "ctrl++" is ctrl and the + key: a trailing + is the key itself.
  let parts: string[];
  if (s === '+') parts = ['+'];
  else if (s.endsWith('++')) parts = [...s.slice(0, -2).split('+'), '+'];
  else parts = s.split('+');
  parts = parts.map((p) => p.trim());
  if (parts.some((p) => !p)) return fail(`"${s}" is not a key combo. ${EXAMPLES}`);

  const main = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  // SendKeys cannot hold the Windows key. Alone it opens Start (Ctrl+Esc does
  // the same); in a combo there is nothing honest to send.
  if (WIN_NAMES.has(main.toLowerCase()) && mods.length === 0) return { ok: true, keys: '^{ESC}' };
  if (mods.some((m) => WIN_NAMES.has(m)) || WIN_NAMES.has(main.toLowerCase())) {
    return fail(`"${s}": the Windows key cannot be sent in a combo on Windows (cmd is a Mac key: the shortcut modifier here is ctrl, e.g. ctrl+s). ` +
      'Use show_desktop, minimize_all_windows, open_app or focus_window for what win+… would do');
  }
  let prefix = '';
  for (const m of mods) {
    const p = MODIFIERS[m];
    if (!p) return fail(`unknown modifier "${m}" in "${s}". Modifiers are ctrl, alt, shift`);
    if (!prefix.includes(p)) prefix += p;
  }
  // With a modifier, "ctrl+S" means the s key: an upper-case letter would add Shift.
  const key = keyToken(prefix && main.length === 1 ? main.toLowerCase() : main);
  if (!key.ok) return key;
  return { ok: true, keys: prefix + key.keys };
}
