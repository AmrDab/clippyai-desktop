/**
 * screen-lines.ts — read_screen as lines the model can act on.
 *
 * read_screen used to return nested JSON (bounds, automation ids, the window
 * list first), which the result cut reduced to a list of window handles. Now:
 * the foreground window first, one line per control —
 *
 *   e7 Edit "Subject" = "Hello" focused (setvalue)
 *   e8 CheckBox "Remember me" unchecked (toggle)
 *
 * — then the other open windows in brief. Pure (no Electron) so it unit-tests.
 */

export interface ScreenNode {
  /** Depth among the shown nodes (layout nodes do not count). */
  d: number;
  role: string;
  name: string;
  value?: string;
  /** checked/unchecked/mixed, selected, expanded/collapsed, disabled, focused, offscreen, password. */
  state?: string;
  /** invoke, setvalue, toggle, select, expand — comma separated. */
  actions?: string;
  /** [x, y, width, height] on screen (Windows: physical pixels; macOS: points). Sent only with `find`. */
  rect?: [number, number, number, number];
}

export interface ScreenLinesInput {
  /** e.g. `Foreground window: "Inbox" (OUTLOOK)`. */
  header: string;
  nodes: ScreenNode[];
  /** The walk stopped early (node cap or time budget). */
  truncated?: boolean;
  /** Other windows, already formatted (`"Title" (proc)`). */
  others?: string[];
  find?: string;
}

export interface ScreenLines {
  text: string;
  /** id → control name, so a later smart_click("e7") can be resolved. */
  ids: Map<string, string>;
}

export const MAX_SCREEN_LINES = 150;
/** Room for the controls inside the 6000-char read budget (result-budget.ts). */
const MAX_CONTROL_CHARS = 4600;

const flat = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function nodeLine(id: string, n: ScreenNode): string {
  const name = flat(n.name ?? '', 100);
  const value = typeof n.value === 'string' ? flat(n.value, 120) : undefined;
  return `${' '.repeat(Math.min(Math.max(n.d, 0), 6))}${id} ${n.role}` +
    (name ? ` "${name}"` : '') +
    (value !== undefined && value !== name ? ` = "${value}"` : '') +
    (n.state ? ` ${n.state}` : '') +
    (n.actions ? ` (${n.actions.split(',').join(', ')})` : '') +
    (Array.isArray(n.rect) && n.rect.length === 4 ? ` @${n.rect[0]},${n.rect[1]} ${n.rect[2]}x${n.rect[3]}` : '');
}

export function renderScreenLines(input: ScreenLinesInput, maxLines = MAX_SCREEN_LINES): ScreenLines {
  const ids = new Map<string, string>();
  const out: string[] = [input.header];
  let chars = 0;
  let cut = !!input.truncated;
  let shown = 0;
  for (const n of input.nodes) {
    if (shown >= maxLines) { cut = true; break; }
    const id = `e${shown + 1}`;
    const line = nodeLine(id, n);
    if (chars + line.length > MAX_CONTROL_CHARS) { cut = true; break; }
    out.push(line);
    chars += line.length + 1;
    shown++;
    if (n.name?.trim()) ids.set(id, n.name.trim());
  }
  if (shown === 0) {
    out.push(input.find
      ? `(no control with "${flat(input.find, 60)}" in its name in this window)`
      : '(this window exposes no controls: use ocr_read_screen or desktop_screenshot)');
  } else if (cut) {
    out.push(`[only the first ${shown} controls are shown: call read_screen with find:"<part of a name>" to list the ones you need]`);
  }
  if (shown > 0 && input.find && input.nodes.some((n) => n.rect)) {
    out.push('[@x,y WxH is each control\'s rectangle on screen: its centre (x+W/2, y+H/2) can go straight to mouse_click]');
  }
  if (input.others?.length) out.push(`Other windows: ${input.others.join('; ')}`);
  return { text: out.join('\n'), ids };
}

// ── Windows: get-screen-context.ps1 JSON ─────────────────────────────

interface WinDump {
  error?: unknown;
  focusedHandle?: unknown;
  focusedTitle?: unknown;
  focusedProcess?: unknown;
  nodes?: unknown;
  truncated?: unknown;
  windows?: unknown;
}

/** Lines for the script JSON; null when the text is not that JSON (the caller passes it on as is). */
export function formatWinScreen(raw: string, opts: { find?: string; ownProcessNames?: ReadonlySet<string> } = {}): ScreenLines | null {
  let d: WinDump;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || d.error || !Array.isArray(d.nodes)) return null;
  const own = opts.ownProcessNames ?? new Set<string>();
  const wins = (Array.isArray(d.windows) ? d.windows : []) as Array<{ handle?: unknown; title?: unknown; processName?: unknown; isMinimized?: unknown }>;
  const others = wins
    .filter((w) => w.handle !== d.focusedHandle && typeof w.title === 'string' && w.title.trim() && !own.has(String(w.processName)))
    .slice(0, 10)
    .map((w) => `"${flat(String(w.title), 60)}" (${String(w.processName ?? '?')}${w.isMinimized ? ', minimized' : ''})`);
  const title = typeof d.focusedTitle === 'string' ? d.focusedTitle : '';
  const header = d.focusedHandle
    ? `Foreground window: "${flat(title, 100)}" (${String(d.focusedProcess || '?')})`
    : 'Foreground window: (none)';
  return renderScreenLines({ header, nodes: d.nodes as ScreenNode[], truncated: !!d.truncated, others, find: opts.find });
}

// ── macOS: the Swift bridge a11y-tree ────────────────────────────────

interface AxNodeLike { role?: string; title?: string; value?: string | null; enabled?: boolean; focused?: boolean; bounds?: { x: number; y: number; width: number; height: number }; children?: AxNodeLike[] }
export interface AxTreeLike { app?: string; windows?: Array<{ title?: string; elements?: AxNodeLike[] }>; truncated?: boolean }

/** AX roles kept even with no title and no value: a control the model can act on. */
const AX_SHOWN = new Set(['Button', 'TextField', 'TextArea', 'SecureTextField', 'CheckBox', 'RadioButton', 'PopUpButton',
  'ComboBox', 'MenuItem', 'MenuButton', 'Link', 'Slider', 'Incrementor', 'DisclosureTriangle', 'SearchField']);

/** Flatten the AX tree: an untitled, valueless layout node is left out and uses up no depth. */
export function axTreeToNodes(tree: AxTreeLike, find = ''): ScreenNode[] {
  const nodes: ScreenNode[] = [];
  const f = find.trim().toLowerCase();
  const walk = (el: AxNodeLike, depth: number, raw: number): void => {
    if (!el || raw > 60) return;
    const role = String(el.role ?? '').replace(/^AX/, '') || 'Unknown';
    const secure = role === 'SecureTextField';
    const title = (el.title ?? '').trim();
    const value = !secure && typeof el.value === 'string' ? el.value.trim() : '';
    let d = depth;
    if (title || value || AX_SHOWN.has(role)) {
      // AXStaticText carries its text in `value`, with no title.
      const name = title || (role === 'StaticText' ? value : '');
      const state = [el.enabled === false ? 'disabled' : '', el.focused ? 'focused' : '', secure ? 'password' : ''].filter(Boolean).join(' ');
      if (!f || name.toLowerCase().includes(f) || value.toLowerCase().includes(f)) {
        const b = el.bounds;
        const rect = f && b && b.width > 0 && b.height > 0
          ? { rect: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] as [number, number, number, number] }
          : {};
        nodes.push({ d: depth, role, name, ...(value && value !== name ? { value } : {}), ...(state ? { state } : {}), ...rect });
      }
      d++;
    }
    for (const k of el.children ?? []) walk(k, d, raw + 1);
  };
  for (const w of tree.windows ?? []) {
    nodes.push({ d: 0, role: 'Window', name: w.title ?? '' });
    for (const el of w.elements ?? []) walk(el, 1, 1);
  }
  return nodes;
}

export function formatMacScreen(tree: AxTreeLike, opts: { find?: string } = {}): ScreenLines {
  const all = axTreeToNodes(tree, opts.find);
  // With a filter, a window line with no match under it says nothing.
  const nodes = opts.find ? all.filter((n, i) => n.role !== 'Window' || (all[i + 1] && all[i + 1].role !== 'Window')) : all;
  const real = nodes.some((n) => n.role !== 'Window');
  return renderScreenLines({
    header: `Foreground app: ${tree.app || '(unknown)'}`,
    nodes: real ? nodes : [],
    truncated: !!tree.truncated,
    find: opts.find,
  });
}
