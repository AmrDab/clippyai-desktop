import { describe, it, expect } from 'vitest';
import {
  ToolLoopDetector,
  digestArgs,
  hashToolCall,
  hashResult,
} from '../src/main/tool-loop-detection';

describe('digest helpers', () => {
  it('digestArgs is order-independent for object keys', () => {
    expect(digestArgs({ a: 1, b: 2 })).toBe(digestArgs({ b: 2, a: 1 }));
  });

  it('digestArgs distinguishes different values', () => {
    expect(digestArgs({ x: 1 })).not.toBe(digestArgs({ x: 2 }));
  });

  it('digestArgs is order-independent recursively', () => {
    expect(digestArgs({ p: { a: 1, b: 2 } })).toBe(digestArgs({ p: { b: 2, a: 1 } }));
  });

  it('hashToolCall folds tool name into the signature', () => {
    expect(hashToolCall('read_screen', {})).not.toBe(hashToolCall('type_text', {}));
  });

  it('hashResult differs for different result text', () => {
    expect(hashResult('same page')).not.toBe(hashResult('changed page'));
    expect(hashResult('same page')).toBe(hashResult('same page'));
  });

  it('digestArgs tolerates cycles without throwing', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => digestArgs(a)).not.toThrow();
  });
});

describe('ToolLoopDetector — no-progress repeats', () => {
  it('3 identical call+result → warning', () => {
    const d = new ToolLoopDetector();
    expect(d.recordAndCheck('read_screen', { x: 1 }, 'PAGE').level).toBe('ok');
    expect(d.recordAndCheck('read_screen', { x: 1 }, 'PAGE').level).toBe('ok');
    const v = d.recordAndCheck('read_screen', { x: 1 }, 'PAGE');
    expect(v.level).toBe('warning');
    expect(v.detail?.detector).toBe('no_progress');
    expect(v.detail?.count).toBe(3);
    expect(v.reason).toContain('read_screen');
  });

  it('5 identical call+result → critical', () => {
    const d = new ToolLoopDetector();
    let v;
    for (let i = 0; i < 5; i++) v = d.recordAndCheck('read_screen', { x: 1 }, 'PAGE');
    expect(v!.level).toBe('critical');
    expect(v!.detail?.detector).toBe('no_progress');
    expect(v!.detail?.count).toBe(5);
  });

  it('a CHANGED result for same args resets the streak (progress)', () => {
    const d = new ToolLoopDetector();
    d.recordAndCheck('read_screen', { x: 1 }, 'PAGE_A');
    d.recordAndCheck('read_screen', { x: 1 }, 'PAGE_A');
    // result changed → progress → streak resets to 1
    expect(d.recordAndCheck('read_screen', { x: 1 }, 'PAGE_B').level).toBe('ok');
    expect(d.recordAndCheck('read_screen', { x: 1 }, 'PAGE_B').level).toBe('ok');
    // back to 2 of PAGE_B; need a 3rd to warn
    expect(d.recordAndCheck('read_screen', { x: 1 }, 'PAGE_B').level).toBe('warning');
  });

  it('different ARGS do not accumulate a no-progress streak', () => {
    const d = new ToolLoopDetector();
    for (let i = 0; i < 6; i++) {
      const v = d.recordAndCheck('mouse_drag', { x: i, y: i }, `dragged-${i}`);
      expect(v.level).toBe('ok');
    }
  });

  it('identical repeated ERROR text counts as no-progress', () => {
    const d = new ToolLoopDetector();
    const err = '(error:UNKNOWN_TOOL) unknown tool: frobnicate';
    let v;
    for (let i = 0; i < 5; i++) v = d.recordAndCheck('frobnicate', {}, err);
    expect(v!.level).toBe('critical');
    expect(v!.detail?.detector).toBe('no_progress');
  });
});

describe('ToolLoopDetector — ping-pong', () => {
  it('detects A,B,A,B alternation with stable results (warning)', () => {
    const d = new ToolLoopDetector();
    // A=focus_window result FOCUSED, B=read_screen result SAME_PAGE.
    // After 4 calls (A,B,A,B) the alternating run length is 4 (>= crit 5? no),
    // ping-pong count = 4 → warning. (A 5th call would tip it to critical, so
    // we stop at 4 to assert the warning band specifically.)
    const seq: Array<[string, string]> = [
      ['focus_window', 'FOCUSED'],
      ['read_screen', 'SAME_PAGE'],
      ['focus_window', 'FOCUSED'],
      ['read_screen', 'SAME_PAGE'],
    ];
    let v;
    for (const [tool, res] of seq) v = d.recordAndCheck(tool, {}, res);
    expect(v!.level).toBe('warning');
    expect(v!.detail?.detector).toBe('ping_pong');
    expect(v!.detail?.count).toBe(4);
    expect(v!.detail?.pairedTool).toBe('focus_window');
  });

  it('ping-pong escalates to critical when long enough', () => {
    const d = new ToolLoopDetector();
    const tools = ['focus_window', 'read_screen'];
    let v;
    for (let i = 0; i < 6; i++) {
      v = d.recordAndCheck(tools[i % 2], {}, i % 2 === 0 ? 'FOCUSED' : 'SAME_PAGE');
    }
    expect(v!.level).toBe('critical');
    expect(v!.detail?.detector).toBe('ping_pong');
  });

  it('alternation with CHANGING results is NOT flagged (real progress)', () => {
    const d = new ToolLoopDetector();
    const tools = ['focus_window', 'read_screen'];
    let v;
    for (let i = 0; i < 6; i++) {
      // read_screen returns a new page each time → progress
      v = d.recordAndCheck(tools[i % 2], {}, i % 2 === 0 ? 'FOCUSED' : `PAGE_${i}`);
    }
    expect(v!.level).toBe('ok');
  });
});

describe('ToolLoopDetector — global circuit breaker', () => {
  it('a steadily-spinning task escalates to critical (no_progress wins, more specific)', () => {
    // Two stable args with sticky per-arg results: the no-progress detector is
    // the more specific shape here and fires first — exactly what we want for
    // a clear nudge. The global breaker is the catch-all for when no single
    // pattern matches (see next test).
    const d = new ToolLoopDetector({ historySize: 60 });
    let v;
    for (let i = 0; i < 40; i++) {
      v = d.recordAndCheck('poll', { which: i % 2 }, i % 2 === 0 ? 'R0' : 'R1');
    }
    expect(v!.level).toBe('critical');
    expect(v!.detail?.detector).toBe('no_progress');
    expect(d.stats().totalCalls).toBe(40);
  });

  it('circuit breaker fires at the global cap when no per-pattern detector matches', () => {
    // Defaults: warn 3, critical 5, cap 40, history 30. SAME arg every call so
    // there is no second signature for ping-pong, but the result CYCLES across
    // a small set (R0..R3) so:
    //   - no_progress streak resets every call (result differs from the prior
    //     same-arg call) → never reaches the warn/critical thresholds,
    //   - distinct outcomes stay at 4 (4 arg=>result pairs) while totalCalls
    //     climbs to 40, so `distinct*2 (8) <= total (40)` holds → breaker.
    const d = new ToolLoopDetector(); // defaults
    let v;
    for (let i = 0; i < 40; i++) {
      v = d.recordAndCheck('poll', { fixed: true }, `R${i % 4}`);
    }
    expect(v!.level).toBe('critical');
    expect(v!.detail?.detector).toBe('circuit_breaker');
    expect(v!.detail?.count).toBe(40);
    expect(d.stats().distinctOutcomes).toBe(4);
  });

  it('does NOT trip the breaker when calls keep making distinct progress', () => {
    const d = new ToolLoopDetector({ globalCap: 12 });
    let v;
    for (let i = 0; i < 12; i++) {
      v = d.recordAndCheck('type_text', { text: `line ${i}` }, `typed line ${i}`);
    }
    // every call distinct → distinctOutcomes == totalCalls → breaker condition false
    expect(v!.level).toBe('ok');
  });
});

describe('ToolLoopDetector — reset + stats', () => {
  it('reset() clears history so streaks start over', () => {
    const d = new ToolLoopDetector();
    for (let i = 0; i < 5; i++) d.recordAndCheck('read_screen', {}, 'PAGE');
    d.reset();
    expect(d.stats().totalCalls).toBe(0);
    expect(d.recordAndCheck('read_screen', {}, 'PAGE').level).toBe('ok');
  });

  it('stats() reports window vs total correctly under the cap', () => {
    const d = new ToolLoopDetector({ historySize: 5 });
    for (let i = 0; i < 8; i++) d.recordAndCheck('t', { i }, `r${i}`);
    const s = d.stats();
    expect(s.totalCalls).toBe(8);
    expect(s.windowSize).toBe(5); // capped
    expect(s.distinctOutcomes).toBe(8); // distinct set is not window-capped
  });

  it('constructor coerces invalid thresholds into a sane ordering', () => {
    // critical <= warn should be bumped above warn; cap above critical.
    const d = new ToolLoopDetector({ warnThreshold: 5, criticalThreshold: 2, globalCap: 1 });
    // warn at 5: first 4 identical are ok, 5th warns
    let v;
    for (let i = 0; i < 5; i++) v = d.recordAndCheck('x', {}, 'same');
    // because critical got bumped to warn+1 = 6, the 5th call is a warning not critical
    expect(v!.level).toBe('warning');
    const sixth = d.recordAndCheck('x', {}, 'same');
    expect(sixth.level).toBe('critical');
  });
});
