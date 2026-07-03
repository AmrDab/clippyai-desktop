/**
 * memory-recall.ts — Phase 1 of Clippy's on-device memory upgrade:
 * semantic recall of MEMORY.md entries.
 *
 * Instead of dumping the WHOLE MEMORY.md into every prompt (profile.ts's
 * legacy behaviour), we embed each learned bullet once, persist the
 * vectors locally, and at turn time embed the user's message and inject
 * only the top-K *semantically relevant* entries. Everything degrades to
 * the old whole-file behaviour the moment anything fails — the caller in
 * profile.ts treats an empty/throwing recall as "fall back to whole file"
 * so users are never worse off.
 *
 * MODELLED ON:
 *   - instincts.ts — seed-on-first-use, score, render a `=== … ===` block.
 *   - harper-lint.ts — lazy singleton built behind a Promise, with the
 *     "don't cache a rejected init promise (allow retry)" pattern, and a
 *     try/catch around the heavy load so a failure degrades gracefully.
 *   - memory.ts — electron-store file with a schemaVersion migration.
 *
 * EMBEDDINGS: @huggingface/transformers (transformers.js, Apache-2.0).
 * Unlike harper.js, this package HAS a `node`/`require` export condition,
 * so a normal static `import` works in the CommonJS main bundle — no
 * dynamic-import-behind-Function() dance needed.
 *
 * PRIVACY NOTE: for now the MiniLM model is allowed to download to the
 * transformers.js cache on first use. The vectors themselves never leave
 * the machine.
 *   // TODO: bundle model offline as extraResource + allowRemoteModels=false (privacy)
 *
 * NOT in this phase: consolidation / "dreaming" / summarisation of
 * MEMORY.md (that's Phase 2).
 */

import Store from 'electron-store';
import { createLogger } from './logger';
// LAZY import — loaded only inside getPipeline() on first recall (warmed in
// the background), never at module load. transformers.js is CJS-clean (it has
// a `node`/`require` export condition, so unlike harper.js a static import
// wouldn't ERR_REQUIRE_ESM), but it transitively pulls the native
// onnxruntime-node addon; keeping the import lazy guarantees a bad/missing/ABI-
// mismatched native binary can NEVER crash the main process at startup — it
// just disables recall and falls back to whole-MEMORY.md. (Hard lesson from the
// harper.js startup crash: prove it in the *packaged* app, not just in tests.)

const log = createLogger('MemoryRecall');

const SCHEMA_VERSION = 1;
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIM = 384;
/** Cosine above this between two entry vectors ⇒ treat as duplicate on index. */
const DEDUPE_THRESHOLD = 0.95;
/** Recall floor — matches below this are noise, not "relevant memory". */
const RECALL_FLOOR = 0.25;
const DEFAULT_TOP_K = 6;

export interface VectorEntry {
  id: string;
  text: string;
  vector: number[];
  ts: number;
  lastRecalled: number;
}

interface VectorFile {
  schemaVersion: number;
  modelId: string;
  dim: number;
  entries: VectorEntry[];
}

const store = new Store<VectorFile>({
  name: 'clippy-memory-vectors',
  defaults: {
    schemaVersion: SCHEMA_VERSION,
    modelId: MODEL_ID,
    dim: EMBED_DIM,
    entries: [],
  },
});

/**
 * Has this store ever been written with a schemaVersion? We snapshot the
 * on-disk value BEFORE the migration block below mutates it, so the lazy
 * background migration in profile.ts can decide whether MEMORY.md needs a
 * first-time reindex.
 */
let firstRunNeedsMigration = false;

// One-time schema handling. A model/dim change invalidates the index — we
// clear the entries so a reindex re-embeds everything under the new model.
{
  const onDiskVersion = (store as unknown as { get: (k: string, d: number) => number }).get('schemaVersion', 0);
  const onDiskModel = (store as unknown as { get: (k: string, d: string) => string }).get('modelId', '');
  const onDiskDim = (store as unknown as { get: (k: string, d: number) => number }).get('dim', 0);

  if (onDiskVersion < 1) {
    // Never initialised → first run. Flag a background reindex of MEMORY.md.
    firstRunNeedsMigration = true;
    store.set('schemaVersion', SCHEMA_VERSION);
    store.set('modelId', MODEL_ID);
    store.set('dim', EMBED_DIM);
    store.set('entries', []);
  } else if (onDiskModel !== MODEL_ID || onDiskDim !== EMBED_DIM) {
    log.info('Embedding model/dim changed — invalidating vector index', {
      from: { model: onDiskModel, dim: onDiskDim },
      to: { model: MODEL_ID, dim: EMBED_DIM },
    });
    store.set('schemaVersion', SCHEMA_VERSION);
    store.set('modelId', MODEL_ID);
    store.set('dim', EMBED_DIM);
    store.set('entries', []);
    firstRunNeedsMigration = true;
  } else if (onDiskVersion < SCHEMA_VERSION) {
    store.set('schemaVersion', SCHEMA_VERSION);
  }
}

// ── Embedding pipeline (lazy singleton) ──────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | null = null;
let pipelineReady = false;

/**
 * Lazily build (once) the feature-extraction pipeline. Heavy: it pulls the
 * MiniLM ONNX weights from the transformers.js cache (downloading them on
 * first ever use). We wrap construction in try/catch via the async IIFE's
 * rejection so a load failure (offline, disk, native onnxruntime missing)
 * leaves recall disabled rather than crashing the main process.
 *
 * Like harper-lint.getLinter(), we DON'T cache a rejected promise — a
 * transient failure (e.g. first-run download blip) can retry next turn.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        // Lazy-load transformers.js here (never at module import). Has a CJS
        // `require` condition so this resolves in the CommonJS main.
        const transformers = await import('@huggingface/transformers');
        // quantized:true keeps the model ~23MB instead of ~90MB.
        // TODO: bundle model offline as extraResource + allowRemoteModels=false (privacy)
        const pipe = await transformers.pipeline('feature-extraction', MODEL_ID, {
          // @ts-expect-error — `quantized` is honoured by transformers.js but
          // isn't in the public option type for every backend variant.
          quantized: true,
        });
        pipelineReady = true;
        log.info('Embedding pipeline ready', { model: MODEL_ID });
        return pipe;
      } catch (err) {
        log.warn('Embedding pipeline failed to load (recall disabled, will retry)', err);
        throw err;
      }
    })();
    // Don't cache a rejected promise — allow a retry on the next call.
    pipelinePromise.catch(() => {
      pipelinePromise = null;
      pipelineReady = false;
    });
  }
  return pipelinePromise;
}

/** True once the embedding pipeline has successfully initialised. */
export function isReady(): boolean {
  return pipelineReady;
}

/**
 * Embed text → a mean-pooled, L2-normalised 384-dim Float32Array. Returns
 * null on ANY failure so every caller can treat embedding as best-effort.
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  try {
    const pipe = await getPipeline();
    // pooling:'mean' + normalize:true gives us exactly the 384-dim unit
    // vector we want; .data is a Float32Array.
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    const data: Float32Array = output?.data instanceof Float32Array
      ? output.data
      : Float32Array.from(output?.data ?? []);
    if (data.length !== EMBED_DIM) {
      log.warn('Unexpected embedding dim', { got: data.length, want: EMBED_DIM });
      return null;
    }
    return data;
  } catch (err) {
    log.warn('embedText failed (non-fatal)', err);
    return null;
  }
}

// ── Pure, testable helpers ───────────────────────────────────────────────

/**
 * Cosine similarity of two equal-length vectors. Returns 0 on length
 * mismatch or a zero-magnitude vector. Inputs are assumed finite.
 */
export function cosineSim(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Rank entries by cosine similarity to a query vector. Returns up to `k`
 * entries scoring strictly above `floor`, highest first. Pure — no I/O,
 * no model — so it's unit-testable with hand-made vectors.
 */
export function topKByCosine(
  queryVec: ArrayLike<number>,
  entries: VectorEntry[],
  k: number,
  floor: number,
): Array<{ entry: VectorEntry; score: number }> {
  if (!queryVec || !entries || entries.length === 0) return [];
  const scored: Array<{ entry: VectorEntry; score: number }> = [];
  for (const e of entries) {
    if (!e || !Array.isArray(e.vector)) continue;
    const score = cosineSim(queryVec, e.vector);
    if (score > floor) scored.push({ entry: e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}

// ── Index read/write ─────────────────────────────────────────────────────

function getEntries(): VectorEntry[] {
  return (store.get('entries', []) as VectorEntry[]) ?? [];
}

function setEntries(entries: VectorEntry[]): void {
  store.set('entries', entries);
}

function makeId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Did this store come up un-initialised (or model-invalidated) and so
 * needs MEMORY.md reindexed in the background? profile.ts checks this once
 * at startup and, if true, parses MEMORY.md and calls reindexAll().
 */
export function needsMigration(): boolean {
  return firstRunNeedsMigration;
}

/** Clear the migration flag once the background reindex has been kicked off. */
export function clearMigrationFlag(): void {
  firstRunNeedsMigration = false;
}

/** Number of indexed vectors — handy for logs/debug. */
export function indexSize(): number {
  return getEntries().length;
}

/**
 * Embed one MEMORY.md entry and persist it. Deduped: if the new vector is
 * cosine > DEDUPE_THRESHOLD with an existing entry we skip (the bullet is
 * effectively already known). Best-effort — silently no-ops if embedding
 * fails so the write path in appendMemory() can fire-and-forget.
 */
export async function indexMemory(entry: { text: string; ts: number }): Promise<void> {
  if (!entry || !entry.text || !entry.text.trim()) return;
  const vec = await embedText(entry.text);
  if (!vec) return; // embedding unavailable — leave index untouched

  const vecArr = Array.from(vec);
  const entries = getEntries();
  for (const e of entries) {
    if (Array.isArray(e.vector) && cosineSim(vecArr, e.vector) > DEDUPE_THRESHOLD) {
      return; // near-duplicate already indexed
    }
  }
  entries.push({
    id: makeId(),
    text: entry.text.trim(),
    vector: vecArr,
    ts: entry.ts || Date.now(),
    lastRecalled: 0,
  });
  setEntries(entries);
  log.info('Indexed memory entry', { size: entries.length });
}

/**
 * Recall the top-K most relevant indexed entries for the user's turn text.
 * Embeds the query, brute-forces cosine over all entries (pure JS, no
 * vector-DB dep), returns those above RECALL_FLOOR. Bumps lastRecalled on
 * the winners. Returns [] (→ profile falls back to whole MEMORY.md) if the
 * pipeline isn't ready, the index is empty, or anything throws.
 */
export async function recallTopK(
  userText: string,
  k: number = DEFAULT_TOP_K,
): Promise<Array<{ text: string; ts: number }>> {
  try {
    if (!userText || !userText.trim()) return [];
    const entries = getEntries();
    if (entries.length === 0) return [];
    // Never block the turn on a cold model load. If the embedding pipeline
    // isn't ready yet (first run / still downloading MiniLM), warm it in the
    // background and fall back to whole-MEMORY.md injection THIS turn. Recall
    // kicks in automatically on later turns once the pipeline is warm.
    if (!isReady()) { void getPipeline().catch(() => {}); return []; }
    const qVec = await embedText(userText);
    if (!qVec) return [];
    const top = topKByCosine(qVec, entries, k, RECALL_FLOOR);
    if (top.length === 0) return [];

    // Bump lastRecalled on the matched entries and persist.
    const now = Date.now();
    const matchedIds = new Set(top.map((t) => t.entry.id));
    let changed = false;
    for (const e of entries) {
      if (matchedIds.has(e.id)) {
        e.lastRecalled = now;
        changed = true;
      }
    }
    if (changed) setEntries(entries);

    return top.map((t) => ({ text: t.entry.text, ts: t.entry.ts }));
  } catch (err) {
    log.warn('recallTopK failed (non-fatal — falling back to whole MEMORY.md)', err);
    return [];
  }
}

/**
 * Format recalled matches into a prompt block, styled exactly like
 * instincts' `=== … ===` block. Returns '' when there are no matches so
 * callers can unconditionally concatenate.
 */
export function renderRecallBlock(matches: Array<{ text: string; ts: number }>): string {
  if (!matches || matches.length === 0) return '';
  const lines: string[] = ['=== RELEVANT MEMORY ==='];
  for (const m of matches) {
    const date = new Date(m.ts || Date.now()).toISOString().split('T')[0];
    lines.push(`- ${m.text}  _(learned ${date})_`);
  }
  return lines.join('\n');
}

/**
 * Rebuild the index from scratch from a list of MEMORY.md entries. Used by
 * the first-run/model-change migration. Embeds each entry sequentially
 * (MiniLM is fast and MEMORY.md is small) and persists the result. Skips
 * entries that fail to embed; never throws.
 */
export async function reindexAll(entries: Array<{ text: string; ts: number }>): Promise<void> {
  try {
    const fresh: VectorEntry[] = [];
    for (const e of entries) {
      if (!e || !e.text || !e.text.trim()) continue;
      const vec = await embedText(e.text);
      if (!vec) continue;
      const vecArr = Array.from(vec);
      // Dedupe within the batch too.
      if (fresh.some((f) => cosineSim(vecArr, f.vector) > DEDUPE_THRESHOLD)) continue;
      fresh.push({
        id: makeId(),
        text: e.text.trim(),
        vector: vecArr,
        ts: e.ts || Date.now(),
        lastRecalled: 0,
      });
    }
    // Only overwrite if we actually embedded something — a total embedding
    // failure shouldn't wipe a previously-good index.
    if (fresh.length > 0 || entries.length === 0) {
      setEntries(fresh);
      store.set('modelId', MODEL_ID);
      store.set('dim', EMBED_DIM);
      log.info('Reindexed MEMORY.md', { count: fresh.length });
    }
  } catch (err) {
    log.warn('reindexAll failed (non-fatal)', err);
  }
}
