/**
 * proactive/seen-context.ts — v0.20.0 "Lumiere" PR-A
 *
 * Tiny LRU of recently-seen (app, normalizedWindowTitle) keys with first-seen
 * / last-seen / count metadata (memo §4 item 7). Powers scorer signal (d):
 * a NOVEL context (one the user rarely lands on) is weak evidence the user is
 * more likely to need help — the Lumiere "expertise" proxy (unfamiliar screen
 * ⇒ higher need). The schema is intentionally extensible
 * ({seenCount, firstSeen, lastSeen}) so a future expertise model can build on
 * it without a migration (memo §6 defer list, v0.22).
 *
 * Design invariants:
 *   - Pure data structure. The persistence layer is INJECTED (load/save fns)
 *     so the store can be electron-store in production and an in-memory map in
 *     tests — no Electron import here.
 *   - Static named exports only (bundle-anchor rule).
 *   - Bounded: capped at MAX_ENTRIES (2000, memo §4 item 7) with LRU eviction.
 *
 * Signal provenance: REAL — app + windowTitle come from get_active_window,
 * which the proactive loop already reads every tick.
 */

export const MAX_ENTRIES = 2000;

export interface SeenEntry {
  seenCount: number;
  /** epoch ms */
  firstSeen: number;
  /** epoch ms */
  lastSeen: number;
}

/** Serializable shape persisted by the caller (electron-store JSON). */
export type SeenStore = Record<string, SeenEntry>;

/** Normalize a window title so trivially-different titles collapse to one key. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#') // collapse counters/timestamps ("(3)", page numbers)
    .trim()
    .slice(0, 120);
}

export function keyFor(app: string, windowTitle: string): string {
  return `${app}${normalizeTitle(windowTitle)}`;
}

export class SeenContext {
  private store: SeenStore;
  private readonly maxEntries: number;

  constructor(initial: SeenStore = {}, maxEntries: number = MAX_ENTRIES) {
    this.store = { ...initial };
    this.maxEntries = maxEntries;
  }

  /** True if this (app, title) has never been recorded before. */
  isNovel(app: string, windowTitle: string): boolean {
    return this.store[keyFor(app, windowTitle)] === undefined;
  }

  get(app: string, windowTitle: string): SeenEntry | undefined {
    return this.store[keyFor(app, windowTitle)];
  }

  /**
   * Record a sighting. Returns whether it was NOVEL (first ever sighting) so
   * the caller can fold that into the scorer in the same pass without a second
   * lookup.
   */
  record(app: string, windowTitle: string, now: number = Date.now()): { novel: boolean; entry: SeenEntry } {
    const key = keyFor(app, windowTitle);
    const existing = this.store[key];
    if (existing === undefined) {
      const entry: SeenEntry = { seenCount: 1, firstSeen: now, lastSeen: now };
      this.store[key] = entry;
      this.evict();
      return { novel: true, entry };
    }
    existing.seenCount += 1;
    existing.lastSeen = now;
    return { novel: false, entry: existing };
  }

  /** Evict least-recently-seen entries when over the cap. */
  private evict(): void {
    const keys = Object.keys(this.store);
    if (keys.length <= this.maxEntries) return;
    keys
      .sort((a, b) => this.store[a].lastSeen - this.store[b].lastSeen)
      .slice(0, keys.length - this.maxEntries)
      .forEach((k) => delete this.store[k]);
  }

  /** Snapshot for persistence. */
  toJSON(): SeenStore {
    return { ...this.store };
  }

  get size(): number {
    return Object.keys(this.store).length;
  }
}
