import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory electron-store stand-in that, like the real one, returns the
// constructor `defaults` for keys that were never written.
const disk = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('electron-store', () => ({
  default: class {
    private defaults: Record<string, unknown>;
    constructor(opts: { defaults?: Record<string, unknown> }) { this.defaults = opts.defaults ?? {}; }
    get(k: string, d?: unknown) {
      if (k in disk.data) return disk.data[k];
      if (k in this.defaults) return this.defaults[k];
      return d;
    }
    set(k: string, v: unknown) { disk.data[k] = v; }
  },
}));
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (text: string) => {
    const v = new Float32Array(384);
    v[text.length % 384] = 1; // distinct unit vector per text length
    return { data: v };
  },
}));

async function load() {
  vi.resetModules();
  return import('../src/main/memory-recall');
}

beforeEach(() => { disk.data = {}; });

describe('migration detection', () => {
  it('flags a fresh install (no schemaVersion on disk) even though the store has defaults', async () => {
    const m = await load();
    expect(m.needsMigration()).toBe(true);
  });
  it('does not flag an initialised store', async () => {
    disk.data = { schemaVersion: 1, modelId: 'Xenova/all-MiniLM-L6-v2', dim: 384, entries: [] };
    const m = await load();
    expect(m.needsMigration()).toBe(false);
  });
});

describe('shouldReindex', () => {
  it('reindexes when flagged and bullets exist', async () => {
    const m = await load();
    expect(m.shouldReindex({ flagged: true, indexSize: 0, bulletCount: 3 })).toBe(true);
  });
  it('reindexes an empty index with bullets even when not flagged (older initialised stores)', async () => {
    const m = await load();
    expect(m.shouldReindex({ flagged: false, indexSize: 0, bulletCount: 3 })).toBe(true);
  });
  it('does not reindex a populated index, or when there are no bullets, or when unsupported', async () => {
    const m = await load();
    expect(m.shouldReindex({ flagged: false, indexSize: 2, bulletCount: 3 })).toBe(false);
    expect(m.shouldReindex({ flagged: true, indexSize: 0, bulletCount: 0 })).toBe(false);
    expect(m.shouldReindex({ flagged: true, indexSize: 0, bulletCount: 3, supported: false })).toBe(false);
  });
});

describe('indexMemoryBestEffort', () => {
  it('indexes a new memory in the background without throwing', async () => {
    const m = await load();
    expect(() => m.indexMemoryBestEffort({ text: 'prefers Apple Mail', ts: Date.now() })).not.toThrow();
    await vi.waitFor(() => expect(m.indexSize()).toBe(1));
  });
  it('ignores empty text and never throws', async () => {
    const m = await load();
    expect(() => m.indexMemoryBestEffort({ text: '  ', ts: 0 })).not.toThrow();
    expect(() => m.indexMemoryBestEffort(undefined as never)).not.toThrow();
    expect(m.indexSize()).toBe(0);
  });
});
