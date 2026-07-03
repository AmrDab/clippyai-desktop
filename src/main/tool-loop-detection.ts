/**
 * Tool-call loop / stall detection — self-contained, dependency-free.
 *
 * Ported + adapted from openclaw's `src/agents/tool-loop-detection.ts`
 * (a multi-detector over a rolling tool-call window). Clippy's variant is
 * trimmed to the three detectors that matter for a single desktop agent:
 *
 *   1. no-progress  — the SAME tool with the SAME args returns the SAME
 *                     result N times in a row (the model is staring at an
 *                     unchanging world and re-issuing the same action).
 *   2. ping-pong    — the model alternates A,B,A,B with no progress on
 *                     either side (e.g. focus_window ⇄ read_screen forever).
 *   3. circuit-breaker — too many total tool calls in the task window with
 *                     no distinct progress (a global runaway cap, sized to
 *                     match brain.ts's MAX_STEPS = 40).
 *
 * The class is PURE: it owns nothing but an in-memory rolling history and
 * does no I/O. It IS wired into brain.ts: imported at the top, instantiated
 * once per Brain instance as `this.loopDetector`, and `recordAndCheck(...)`
 * is invoked after each `executeTool(...)`. Construct one per task, call
 * `recordAndCheck(...)` after each `executeTool(...)`, and `reset()` when a
 * new task begins.
 *
 * No `@openclaw/*` imports — the stable-stringify and hashing helpers used
 * by openclaw (which pulled in `@openclaw/normalization-core` and
 * `node:crypto`) are inlined below as tiny string utilities.
 */

/** Outcome severity returned by {@link ToolLoopDetector.recordAndCheck}. */
export type LoopLevel = 'ok' | 'warning' | 'critical';

/** Which detector fired (for telemetry + targeted nudges). */
export type LoopDetector =
  | 'no_progress'
  | 'ping_pong'
  | 'circuit_breaker';

/** Verdict for a single recorded tool call. */
export interface LoopVerdict {
  level: LoopLevel;
  /** Present when `level !== 'ok'`: a model-facing, human-readable reason. */
  reason?: string;
  /** Structured context for logging. */
  detail?: {
    detector: LoopDetector;
    /** The repeat/streak count that tripped the detector. */
    count: number;
    tool: string;
    /** For ping-pong, the other tool in the alternating pair. */
    pairedTool?: string;
  };
}

/** One entry in the rolling history. */
interface CallRecord {
  tool: string;
  /** `tool:digest(args)` — see {@link hashToolCall}. */
  argsDigest: string;
  /** Cheap hash of the tool's result text — see {@link hashResult}. */
  resultHash: string;
}

export interface ToolLoopDetectorOptions {
  /** Rolling window cap. Default 30 (matches openclaw TOOL_CALL_HISTORY_SIZE). */
  historySize?: number;
  /** Identical no-progress repeats that escalate to 'warning'. Default 3. */
  warnThreshold?: number;
  /** Identical no-progress repeats that escalate to 'critical'. Default 5. */
  criticalThreshold?: number;
  /**
   * Total tool calls in the window with no distinct progress that trip the
   * global circuit breaker. Default 40 (matches brain.ts MAX_STEPS).
   */
  globalCap?: number;
}

const DEFAULTS = {
  historySize: 30,
  warnThreshold: 3,
  criticalThreshold: 5,
  globalCap: 40,
} as const;

/**
 * Cheap, stable digest of arbitrary tool args.
 *
 * Sorts object keys recursively so `{a:1,b:2}` and `{b:2,a:1}` hash the
 * same, then runs a cheap non-cryptographic string hash (FNV-1a-ish). We do
 * NOT need cryptographic strength here — only collision-resistance good
 * enough to tell "same call" from "different call" within a 30-entry window.
 */
export function digestArgs(value: unknown): string {
  return cheapHash(stableStringify(value));
}

/** `${tool}:${digestArgs(args)}` — the call signature used for matching. */
export function hashToolCall(tool: string, args: unknown): string {
  return `${tool}:${digestArgs(args)}`;
}

/**
 * Cheap hash of a tool result. Caller passes the result text (Clippy tools
 * return `{ text }`). We cap the input length before hashing so a giant
 * screenshot dump doesn't dominate; the cap is generous enough that two
 * genuinely-different reads almost always differ within the first slice.
 */
export function hashResult(resultText: string): string {
  const capped = resultText.length > 4096 ? resultText.slice(0, 4096) : resultText;
  return cheapHash(capped);
}

/**
 * Deterministic JSON-ish serialization with sorted object keys.
 * Inlined so the module has zero dependencies. Handles cycles defensively.
 */
function stableStringify(value: unknown, seen: Set<unknown> = new Set()): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (t === 'boolean') return String(value);
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '"[Circular]"';
    seen.add(value);
    const out = `[${value.map((v) => stableStringify(v, seen)).join(',')}]`;
    seen.delete(value);
    return out;
  }

  // plain object
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`)
    .join(',');
  seen.delete(value);
  return `{${body}}`;
}

/**
 * FNV-1a 32-bit string hash, hex-encoded. Fast, allocation-light, and
 * deterministic across runs (no crypto, no Buffer).
 */
function cheapHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space via the shift-sum trick.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // Mix in length so two same-prefix strings of different length diverge.
  h = (h ^ input.length) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Stateful loop detector. One instance per task. All detection logic runs
 * inside {@link recordAndCheck}; nothing else mutates state.
 */
export class ToolLoopDetector {
  private readonly historySize: number;
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly globalCap: number;

  private history: CallRecord[] = [];
  /** Total calls recorded this task (NOT capped by the window). */
  private totalCalls = 0;
  /** Count of distinct (argsDigest → resultHash) pairs seen — "progress". */
  private readonly distinctOutcomes = new Set<string>();

  constructor(opts: ToolLoopDetectorOptions = {}) {
    this.historySize = positiveInt(opts.historySize, DEFAULTS.historySize);
    this.warnThreshold = positiveInt(opts.warnThreshold, DEFAULTS.warnThreshold);
    let critical = positiveInt(opts.criticalThreshold, DEFAULTS.criticalThreshold);
    if (critical <= this.warnThreshold) critical = this.warnThreshold + 1;
    this.criticalThreshold = critical;
    let cap = positiveInt(opts.globalCap, DEFAULTS.globalCap);
    if (cap <= this.criticalThreshold) cap = this.criticalThreshold + 1;
    this.globalCap = cap;
  }

  /** Clear all state. Call at the start of each new task. */
  reset(): void {
    this.history = [];
    this.totalCalls = 0;
    this.distinctOutcomes.clear();
  }

  /** Read-only snapshot for debugging / telemetry. */
  stats(): { totalCalls: number; windowSize: number; distinctOutcomes: number } {
    return {
      totalCalls: this.totalCalls,
      windowSize: this.history.length,
      distinctOutcomes: this.distinctOutcomes.size,
    };
  }

  /**
   * Record a completed tool call and return a verdict.
   *
   * @param tool        tool name, e.g. `'read_screen'`.
   * @param args        the args object passed to the tool.
   * @param resultText  the tool's result text (Clippy tools return `{text}`;
   *                    pass that string). Error sentinels like
   *                    `(error:CODE) ...` are just text and hash like any
   *                    other result — an identical repeated error counts as
   *                    no-progress, which is exactly what we want.
   */
  recordAndCheck(tool: string, args: unknown, resultText: string): LoopVerdict {
    const argsDigest = hashToolCall(tool, args);
    const resultHash = hashResult(resultText);
    const record: CallRecord = { tool, argsDigest, resultHash };

    this.history.push(record);
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
    this.totalCalls += 1;
    this.distinctOutcomes.add(`${argsDigest}=>${resultHash}`);

    // Detector order: no-progress and ping-pong describe the *shape* of the
    // stall and give the most actionable nudge, so they win over the blunt
    // global breaker. Within each, critical is checked before warning.
    const noProgress = this.noProgressStreak(argsDigest, resultHash);
    if (noProgress >= this.criticalThreshold) {
      return critical('no_progress', noProgress, tool,
        `Called ${tool} with identical arguments and got the identical result ${noProgress} times in a row — no progress. Stopping to avoid a runaway loop.`);
    }

    const pingPong = this.pingPongStreak();
    if (pingPong && pingPong.count >= this.criticalThreshold) {
      return critical('ping_pong', pingPong.count, tool,
        `Alternating between ${tool} and ${pingPong.pairedTool} (${pingPong.count} calls) with no progress — this is a stuck ping-pong loop. Stopping.`,
        pingPong.pairedTool);
    }

    // Global circuit breaker: lots of calls but few distinct outcomes means
    // the whole task is spinning even if no single pattern tripped above.
    if (
      this.totalCalls >= this.globalCap &&
      this.distinctOutcomes.size * 2 <= this.totalCalls
    ) {
      return critical('circuit_breaker', this.totalCalls, tool,
        `Made ${this.totalCalls} tool calls but only ${this.distinctOutcomes.size} produced distinct results — the task isn't progressing. Stopping.`);
    }

    if (noProgress >= this.warnThreshold) {
      return warning('no_progress', noProgress, tool,
        `You've called ${tool} ${noProgress} times with identical arguments and the same result each time. If this isn't making progress, change approach or report that it's stuck instead of retrying.`);
    }

    if (pingPong && pingPong.count >= this.warnThreshold) {
      return warning('ping_pong', pingPong.count, tool,
        `You seem to be alternating between ${tool} and ${pingPong.pairedTool} without making progress. Break the pattern — try a different action or report the task as stuck.`,
        pingPong.pairedTool);
    }

    return { level: 'ok' };
  }

  /**
   * How many times in a row (counting back from the most recent call) the
   * SAME `argsDigest` produced the SAME `resultHash`. A different result for
   * the same args (= progress) resets the streak.
   */
  private noProgressStreak(argsDigest: string, resultHash: string): number {
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const rec = this.history[i];
      if (rec.argsDigest !== argsDigest) continue;
      if (rec.resultHash !== resultHash) break;
      streak += 1;
    }
    return streak;
  }

  /**
   * Detect an A,B,A,B,… alternating tail anchored at the most recent call,
   * where BOTH sides keep returning a stable (no-progress) result.
   *
   * Returns the length of the alternating run (≥ 2 entries) and the paired
   * tool name, or `null` if the tail isn't a no-progress ping-pong.
   */
  private pingPongStreak(): { count: number; pairedTool: string } | null {
    const n = this.history.length;
    if (n < 2) return null;
    const last = this.history[n - 1];

    // Find the nearest earlier call with a DIFFERENT signature — the "B".
    let bIdx = -1;
    for (let i = n - 2; i >= 0; i--) {
      if (this.history[i].argsDigest !== last.argsDigest) {
        bIdx = i;
        break;
      }
    }
    if (bIdx === -1) return null;
    const sigA = last.argsDigest;
    const sigB = this.history[bIdx].argsDigest;

    // Walk backwards requiring strict A,B,A,B alternation.
    let count = 0;
    for (let i = n - 1; i >= 0; i--) {
      const expected = count % 2 === 0 ? sigA : sigB;
      if (this.history[i].argsDigest !== expected) break;
      count += 1;
    }
    if (count < 2) return null;

    // No-progress evidence: each side must return a STABLE result across the
    // alternating tail. If either side's result changes, real work happened.
    let resA: string | undefined;
    let resB: string | undefined;
    for (let i = n - count; i < n; i++) {
      const rec = this.history[i];
      if (rec.argsDigest === sigA) {
        if (resA === undefined) resA = rec.resultHash;
        else if (resA !== rec.resultHash) return null;
      } else {
        if (resB === undefined) resB = rec.resultHash;
        else if (resB !== rec.resultHash) return null;
      }
    }

    return { count, pairedTool: this.history[bIdx].tool };
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function critical(
  detector: LoopDetector,
  count: number,
  tool: string,
  reason: string,
  pairedTool?: string,
): LoopVerdict {
  return { level: 'critical', reason, detail: { detector, count, tool, pairedTool } };
}

function warning(
  detector: LoopDetector,
  count: number,
  tool: string,
  reason: string,
  pairedTool?: string,
): LoopVerdict {
  return { level: 'warning', reason, detail: { detector, count, tool, pairedTool } };
}
