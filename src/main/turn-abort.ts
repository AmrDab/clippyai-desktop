/**
 * turn-abort.ts — what Stop has to interrupt while the brain waits on the model.
 *
 * Stop / a new message / sleep set `cancelRequested`, which the agent loop
 * only reads between steps: a /v1/turn request already on the wire ran to its
 * end (8 s typical, 60 s timeout, then a retry). The brain now registers every
 * wait here (the request itself, the retry back-off) and aborts them all the
 * moment a cancel arrives. Pure (no Electron) so it unit-tests.
 */

export class AbortRegistry {
  private readonly aborts = new Set<() => void>();

  /** Register a wait. Returns the function that unregisters it (call it when the wait ends). */
  add(abort: () => void): () => void {
    this.aborts.add(abort);
    return () => { this.aborts.delete(abort); };
  }

  /** Abort every registered wait. Returns how many there were. */
  abortAll(): number {
    const all = [...this.aborts];
    this.aborts.clear();
    for (const abort of all) {
      try { abort(); } catch { /* one stuck wait must not keep the others alive */ }
    }
    return all.length;
  }

  get size(): number { return this.aborts.size; }
}

/** A delay that `registry.abortAll()` ends at once. Resolves true when it ran its full time. */
export function abortableDelay(ms: number, registry: AbortRegistry): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { remove(); resolve(true); }, ms);
    const remove = registry.add(() => { clearTimeout(timer); resolve(false); });
  });
}
