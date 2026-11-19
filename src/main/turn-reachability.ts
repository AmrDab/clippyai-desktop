/**
 * turn-reachability.ts: fail fast when Clippy's server can't be reached.
 *
 * A /v1/turn reply arrives only when the model has finished, so a slow model
 * and an unreachable server look the same for the whole 60 s turn timeout,
 * and with one retry the user waited two minutes for "Took too long" (owner
 * report 2026-11-19: neither request ever reached the server). A turn still
 * waiting after REACH_CHECK_AFTER_MS probes the server's /health; if that
 * fails too, the turn ends as 'unreachable' (not retried).
 */

export const REACH_CHECK_AFTER_MS = 15_000;
export const REACH_PROBE_TIMEOUT_MS = 5_000;

/** Starts the check; returns cancel(). onUnreachable runs at most once, never after cancel(). */
export function watchReachability(opts: {
  probe: () => Promise<boolean>;
  onUnreachable: () => void;
  afterMs?: number;
}): () => void {
  let cancelled = false;
  const timer = setTimeout(() => {
    opts.probe().then((ok) => {
      if (!ok && !cancelled) opts.onUnreachable();
    }, () => { if (!cancelled) opts.onUnreachable(); });
  }, opts.afterMs ?? REACH_CHECK_AFTER_MS);
  return () => { cancelled = true; clearTimeout(timer); };
}
