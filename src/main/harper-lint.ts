/**
 * harper-lint.ts — on-device grammar/style linting via Harper (harper.js).
 *
 * Harper (Automattic, Apache-2.0) is a fully local, WASM-backed grammar and
 * style checker. No network, no API key, no data leaves the device.
 *
 * PACKAGING NOTES (learned the hard way — the vitest spike hid these because
 * vitest runs in an ESM context):
 *   1. harper.js is an **ESM-only** package (its `exports` map has no `require`
 *      condition). The electron-vite MAIN bundle is **CommonJS**, so a static
 *      `import … from 'harper.js'` compiles to `require("harper.js")` →
 *      `ERR_REQUIRE_ESM`, crashing the main process AT STARTUP. We therefore
 *      load harper.js with a **runtime dynamic import()**, hidden behind a
 *      `Function(...)` so esbuild can't down-level it back to `require()`. This
 *      is the one legitimate exception to the "static imports only" rule — the
 *      dep is external (node_modules), not in the Rollup graph, so there's
 *      nothing to tree-shake.
 *   2. `import.meta` is undefined in the CJS bundle, so `import.meta.resolve`
 *      throws. We resolve the .wasm path explicitly (packaged vs dev/test).
 *   3. The .wasm is `asarUnpack`'d (see electron-builder.yml) so it's a real
 *      on-disk file harper can `fs.readFile`.
 */

import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

/** A single grammar/style problem found in the text. */
export interface LintResult {
  /** Human-readable description of the problem. */
  message: string;
  /** Character index (inclusive) where the problem starts. */
  start: number;
  /** Character index (exclusive) where the problem ends. */
  end: number;
  /** Replacement strings that would resolve the problem (may be empty). */
  suggestions: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let linterPromise: Promise<any> | null = null;

/**
 * Absolute path to Harper's full WASM binary, across packaged Electron, dev,
 * and vitest. Tries the likely locations and returns the first that exists.
 */
function resolveWasmPath(): string {
  const rel = join('node_modules', 'harper.js', 'dist', 'harper_wasm_bg.wasm');
  const candidates: string[] = [];
  try {
    // Guarded — `electron` isn't a real module under vitest.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
    const electron = require('electron') as any;
    const app = electron?.app;
    if (app?.isPackaged) {
      candidates.push(join(process.resourcesPath, 'app.asar.unpacked', rel));
    } else if (typeof app?.getAppPath === 'function') {
      candidates.push(join(app.getAppPath(), rel));
    }
  } catch { /* not running under Electron (e.g. vitest) */ }
  candidates.push(join(process.cwd(), rel));
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return candidates[candidates.length - 1];
}

/**
 * Lazily build (once) a LocalLinter backed by the on-disk WASM binary. Building
 * the curated dictionary is Harper's most expensive op, so we never do it twice.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLinter(): Promise<any> {
  if (!linterPromise) {
    linterPromise = (async () => {
      const wasmPath = resolveWasmPath();
      // Import harper.js by its absolute file:// entry URL (sibling of the
      // .wasm). A non-literal specifier keeps esbuild from down-levelling this
      // dynamic import() to require() (which can't load ESM-only harper.js),
      // and an absolute URL avoids bare-specifier resolution from any context.
      const entryUrl = pathToFileURL(join(dirname(wasmPath), 'index.js')).href;
      const harper = await import(entryUrl);
      const { LocalLinter, createBinaryModuleFromUrl, Dialect } = harper;
      // Don't hand harper a file:// URL: its Node loader does
      // fs.readFile(new URL(u).pathname), and on Windows that pathname is
      // "/C:/…" which resolves to "C:\C:\…" (ENOENT). Read the bytes ourselves
      // and pass a data: URL — the same path harper's own binaryInlined uses.
      const wasmUrl = `data:application/wasm;base64,${readFileSync(wasmPath).toString('base64')}`;
      const binary = createBinaryModuleFromUrl(wasmUrl, 'full');
      const linter = new LocalLinter({ binary, dialect: Dialect.American });
      await linter.setup(); // force WASM init + dictionary build now
      return linter;
    })();
    // Don't cache a rejected promise — allow a retry on the next call.
    linterPromise.catch(() => { linterPromise = null; });
  }
  return linterPromise;
}

/**
 * Lint a piece of text → flat, serializable list of problems. Safe over IPC.
 *
 * PLAIN-TEXT ONLY: this always lints with `language: 'plaintext'`. The
 * returned `start`/`end` offsets index into the raw `text` as given. Do NOT
 * feed Markdown here expecting Markdown-aware spans — Harper would not strip
 * markup, so any `applyLints` consumer that later renders/strips Markdown
 * would see misaligned offsets. Parameterize the language first if Markdown
 * support is ever needed.
 *
 * @param text Plain text to check (not Markdown).
 */
export async function lintText(text: string): Promise<LintResult[]> {
  if (!text) return [];
  const linter = await getLinter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lints: any[] = await linter.lint(text, { language: 'plaintext' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return lints.map((lint: any) => {
    const span = lint.span();
    const suggestions = lint
      .suggestions()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((s: any) => s.get_replacement_text())
      .filter((s: string) => s.length > 0);
    return {
      message: lint.message(),
      start: span.start,
      end: span.end,
      suggestions,
    };
  });
}
