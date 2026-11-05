/**
 * ocr-match.ts — OCR layout + target matching (v0.24, plan §3.4).
 *
 * Pure functions (no I/O) so smart_click's OCR fallback is unit-testable:
 *   - layoutFromRegion(): ocr-screen.ps1 returns word boxes relative to the
 *     captured region (the foreground window, or the virtual screen whose
 *     origin is negative when a monitor sits left of / above the primary).
 *     Translate them to absolute PHYSICAL screen pixels and build line boxes.
 *   - matchOcrTarget(): fuzzy-match a target against single words, runs of
 *     consecutive words within a line and whole lines, so a multi-word label
 *     like "New message" can match exactly — word-only matching never could —
 *     and the click lands on the phrase, not the middle of a long line.
 */

export interface OcrBox { text: string; x: number; y: number; width: number; height: number; line?: number; confidence?: number }

export interface OcrLayout {
  /** Word boxes in absolute screen coordinates (legacy `elements` shape). */
  elements: OcrBox[];
  /** One box per OCR line, text joined with single spaces. */
  lines: OcrBox[];
  fullText: string;
  region?: { x: number; y: number; width: number; height: number; source?: string };
}

export interface RawOcrRegion {
  region?: { x: number; y: number; width: number; height: number; source?: string };
  words?: OcrBox[];
  fullText?: string;
}

/** Smallest box containing every box in `boxes`. */
export function unionBox(boxes: Array<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Group word boxes by their `line` index (words without one are their own line), in order. */
function groupLines(words: OcrBox[]): OcrBox[][] {
  const out: OcrBox[][] = [];
  const byLine = new Map<number, OcrBox[]>();
  for (const w of words) {
    if (typeof w.line !== 'number') { out.push([w]); continue; }
    let g = byLine.get(w.line);
    if (!g) { g = []; byLine.set(w.line, g); out.push(g); }
    g.push(w);
  }
  return out;
}

export function layoutFromRegion(raw: RawOcrRegion): OcrLayout {
  const ox = raw.region?.x ?? 0;
  const oy = raw.region?.y ?? 0;
  const elements = (raw.words ?? []).map((w) => ({ ...w, x: w.x + ox, y: w.y + oy }));
  const lines = groupLines(elements).map((g) => ({
    text: g.map((w) => w.text).join(' '),
    ...unionBox(g),
    ...(typeof g[0].line === 'number' ? { line: g[0].line } : {}),
  }));
  return { elements, lines, fullText: String(raw.fullText ?? ''), region: raw.region };
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Score ladder shared with smart-find.ps1 (UIA): 1.0 exact … 0 no match. */
export function scoreText(target: string, text: string): number {
  const t = norm(target);
  const e = norm(text);
  if (!t || !e) return 0;
  if (e === t) return 1.0;
  if (new RegExp(`(^|\\W)${escapeRe(t)}($|\\W)`).test(e)) return 0.9;
  if (e.includes(t)) return 0.7 * (t.length / e.length);
  if (t.includes(e) && e.length >= 3) return 0.6 * (e.length / t.length);
  return 0;
}

export interface OcrMatch { score: number; element: OcrBox; kind: 'word' | 'span' | 'line' }

const MAX_SPAN = 8;

/**
 * Best OCR candidate for `target`, or null below 0.5. Candidates are single
 * words, consecutive-word spans inside a line (2..min(line length, target
 * words + 1, 8)) and whole lines. Equal scores prefer the tighter box
 * (word < span < line). +0.05 when the box centre is inside `fgBounds`.
 */
export function matchOcrTarget(
  target: string,
  words: OcrBox[],
  fgBounds?: { x: number; y: number; width: number; height: number },
): OcrMatch | null {
  const t = norm(target);
  if (!t) return null;
  const tWords = t.split(' ').length;
  const inFg = (b: OcrBox): boolean => {
    if (!fgBounds) return true;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    return cx >= fgBounds.x && cx <= fgBounds.x + fgBounds.width && cy >= fgBounds.y && cy <= fgBounds.y + fgBounds.height;
  };
  let best: OcrMatch | null = null;
  const consider = (element: OcrBox, kind: OcrMatch['kind']): void => {
    let score = scoreText(t, element.text);
    if (score <= 0) return;
    if (inFg(element)) score += 0.05;
    if (!best || score > best.score + 1e-9) best = { score, element, kind };
  };
  for (const g of groupLines(words)) {
    for (const w of g) consider(w, 'word');
    const maxN = Math.min(g.length, tWords + 1, MAX_SPAN);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i + n <= g.length; i++) {
        const run = g.slice(i, i + n);
        consider({ text: run.map((w) => w.text).join(' '), ...unionBox(run), line: run[0].line }, 'span');
      }
    }
    if (g.length > maxN) consider({ text: g.map((w) => w.text).join(' '), ...unionBox(g), line: g[0].line }, 'line');
  }
  const b = best as OcrMatch | null;
  return b && b.score >= 0.5 ? b : null;
}
