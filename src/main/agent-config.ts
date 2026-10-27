/**
 * agent-config.ts — v0.21 "Connect an agent".
 *
 * Pure helpers for the local MCP server that lets an outside agent (Claude
 * Code, Claude Desktop, Codex, …) drive Clippy: on-disk config (enabled flag,
 * port, bearer token), the per-request security gate, and the ready-made
 * client setup snippets shown in Settings. No Electron import so every piece
 * is unit-testable; agent-connect.ts supplies the Electron paths.
 *
 * The config file is deliberately a plain JSON file in userData (not
 * electron-store) because resources/mcp/clippy-mcp-bridge.js — a
 * dependency-free script run by Claude Desktop — reads it directly.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';

export const AGENT_CONFIG_FILENAME = 'agent-server.json';
export const AGENT_MCP_PATH = '/mcp';

export interface AgentConfig {
  enabled: boolean;
  /** 0 = pick a free port on next start. */
  port: number;
  token: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function agentConfigPath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_CONFIG_FILENAME);
}

export function loadAgentConfig(file: string): AgentConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgentConfig>;
    const port = Number(raw.port);
    return {
      enabled: raw.enabled === true,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
      token: typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : generateToken(),
    };
  } catch {
    return { enabled: false, port: 0, token: generateToken() };
  }
}

export function saveAgentConfig(file: string, cfg: AgentConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Request gate ──────────────────────────────────────────────────────────

export interface GateInput {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

export type GateResult = { ok: true } | { ok: false; status: number; message: string };

function header(h: GateInput['headers'], name: string): string | undefined {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Every request must pass all of:
 *   - path is exactly /mcp (404 otherwise)
 *   - Host is 127.0.0.1:<port>, localhost:<port> or [::1]:<port> (403) — stops
 *     DNS-rebinding, where evil.example resolves to 127.0.0.1 but the browser
 *     still sends Host: evil.example
 *   - no Origin header at all (403) — a web page can never be a legitimate
 *     caller of a desktop agent endpoint, so any Origin is refused outright
 *   - Authorization: Bearer <token>, compared in constant time (401)
 */
export function checkAgentRequest(req: GateInput, cfg: { port: number; token: string }): GateResult {
  const pathname = req.url.split('?')[0];
  if (pathname !== AGENT_MCP_PATH) return { ok: false, status: 404, message: 'not found' };

  const host = (header(req.headers, 'host') || '').toLowerCase();
  const allowed = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, `[::1]:${cfg.port}`]);
  if (!allowed.has(host)) return { ok: false, status: 403, message: 'forbidden: bad Host header' };

  if (header(req.headers, 'origin') !== undefined) {
    return { ok: false, status: 403, message: 'forbidden: browser origins are not allowed' };
  }

  const auth = header(req.headers, 'authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const presented = m ? Buffer.from(m[1]) : Buffer.alloc(0);
  const expected = Buffer.from(cfg.token);
  const same = presented.length === expected.length && timingSafeEqual(presented, expected);
  if (!same) return { ok: false, status: 401, message: 'unauthorized: missing or invalid bearer token' };

  return { ok: true };
}

// ── Client setup snippets ─────────────────────────────────────────────────

export interface SnippetInput {
  platform: NodeJS.Platform;
  /** Path to the ClippyAI executable (process.execPath). */
  execPath: string;
  /** Absolute path to resources/mcp/clippy-mcp-bridge.js. */
  bridgePath: string;
  port: number;
  token: string;
}

export interface SetupSnippets {
  url: string;
  claudeCode: string;
  claudeDesktop: string;
  claudeDesktopConfigPath: string;
  codex: string;
  generic: string;
}

export function agentUrl(port: number): string {
  return `http://127.0.0.1:${port}${AGENT_MCP_PATH}`;
}

/**
 * Syntax verified 2026-10-08 against:
 *   Claude Code    — code.claude.com/docs/en/mcp (`claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`)
 *   Claude Desktop — modelcontextprotocol.io/quickstart/user (mcpServers → command/args/env; config path per OS)
 *   Codex          — learn.chatgpt.com/docs/extend/mcp ([mcp_servers.<name>] url + http_headers map)
 */
export function buildSetupSnippets(i: SnippetInput): SetupSnippets {
  const url = agentUrl(i.port);
  const bearer = `Bearer ${i.token}`;
  const claudeDesktop = JSON.stringify({
    mcpServers: {
      clippy: {
        command: i.execPath,
        args: [i.bridgePath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    },
  }, null, 2);
  const claudeDesktopConfigPath = i.platform === 'win32'
    ? '%APPDATA%\\Claude\\claude_desktop_config.json'
    : '~/Library/Application Support/Claude/claude_desktop_config.json';
  return {
    url,
    claudeCode: `claude mcp add --transport http clippy ${url} --header "Authorization: ${bearer}"`,
    claudeDesktop,
    claudeDesktopConfigPath,
    codex: `[mcp_servers.clippy]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${bearer}" }`,
    generic: JSON.stringify({ type: 'http', url, headers: { Authorization: bearer } }, null, 2),
  };
}
