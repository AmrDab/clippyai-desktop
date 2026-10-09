/**
 * Canonical ToolResult shape returned by every tool in TOOL_MAP.
 *
 * Single source of truth — skill modules under `src/main/skills/**` and the
 * registry in `src/main/tools.ts` both import this. Do NOT redeclare locally
 * in skills — that creates structural drift (e.g. PR 3's skills originally
 * declared `image: Buffer` and silently mismatched the registry's
 * `image: { data, mimeType }`).
 */
export interface ToolResult {
  text: string;
  image?: { data: string; mimeType: string };
  /** v0.21 — action receipt (smart_click, write_file). Stored on the
   *  action-history entry; never part of what the model sees. */
  receipt?: import('../receipt').Receipt;
}
