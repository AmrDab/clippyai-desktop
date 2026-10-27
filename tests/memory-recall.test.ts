import { describe, it, expect } from 'vitest';
import { cosineSim, topKByCosine, type VectorEntry } from '../src/main/memory-recall';

// These tests exercise ONLY the pure math helpers with hand-made vectors —
// no embedding model, no electron-store, no network. The real MiniLM
// pipeline is intentionally not loaded here (it would download weights and
// pull in the native onnxruntime addon, which doesn't belong in unit tests).

describe('cosineSim', () => {
  it('returns 1 for identical vectors', () => {
    const a = [0.2, 0.5, 0.1, 0.8];
    expect(cosineSim(a, a)).toBeCloseTo(1, 10);
  });

  it('returns 1 for parallel (scaled) vectors', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6];
    expect(cosineSim(a, b)).toBeCloseTo(1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSim([1, 0, 0], [0, 3, 0])).toBeCloseTo(0, 10);
  });

  it('returns -1 for anti-parallel vectors', () => {
    expect(cosineSim([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });

  it('returns 0 on length mismatch', () => {
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
  });

  it('returns 0 for a zero-magnitude vector', () => {
    expect(cosineSim([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSim([], [])).toBe(0);
  });
});

function entry(id: string, vector: number[]): VectorEntry {
  return { id, text: `text-${id}`, vector, ts: 0, lastRecalled: 0 };
}

describe('topKByCosine', () => {
  const query = [1, 0, 0];
  const entries: VectorEntry[] = [
    entry('exact', [1, 0, 0]),       // cos 1.0
    entry('close', [0.9, 0.1, 0]),   // cos ~0.994
    entry('mid', [0.5, 0.5, 0]),     // cos ~0.707
    entry('ortho', [0, 1, 0]),       // cos 0 (filtered by any positive floor)
    entry('away', [-1, 0, 0]),       // cos -1 (filtered)
  ];

  it('orders results by descending similarity', () => {
    const res = topKByCosine(query, entries, 10, 0);
    const ids = res.map((r) => r.entry.id);
    expect(ids).toEqual(['exact', 'close', 'mid']);
    // ortho (0) and away (-1) are not strictly above the 0 floor.
    expect(ids).not.toContain('ortho');
    expect(ids).not.toContain('away');
    // Scores are monotonically non-increasing.
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1].score).toBeGreaterThanOrEqual(res[i].score);
    }
  });

  it('respects the floor (strictly greater than)', () => {
    // Floor of 0.71 should drop 'mid' (~0.707) but keep exact + close.
    const res = topKByCosine(query, entries, 10, 0.71);
    expect(res.map((r) => r.entry.id)).toEqual(['exact', 'close']);
  });

  it('limits results to k', () => {
    const res = topKByCosine(query, entries, 2, 0);
    expect(res).toHaveLength(2);
    expect(res.map((r) => r.entry.id)).toEqual(['exact', 'close']);
  });

  it('returns [] when k is 0', () => {
    expect(topKByCosine(query, entries, 0, 0)).toEqual([]);
  });

  it('returns [] for an empty entry list', () => {
    expect(topKByCosine(query, [], 5, 0)).toEqual([]);
  });

  it('skips entries with a missing/invalid vector', () => {
    const mixed = [
      entry('good', [1, 0, 0]),
      { id: 'bad', text: 'x', ts: 0, lastRecalled: 0 } as unknown as VectorEntry,
    ];
    const res = topKByCosine(query, mixed, 5, 0);
    expect(res.map((r) => r.entry.id)).toEqual(['good']);
  });
});
