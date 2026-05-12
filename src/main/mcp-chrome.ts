/**
 * mcp-chrome — integration with the open-source Chrome extension + bridge
 * that exposes the user's real browser session via MCP Streamable HTTP.
 * Repo: https://github.com/hangwin/mcp-chrome
 *
 * Architecture (per upstream docs):
 *   User's Chrome ──extension──► native messaging ──► mcp-chrome-bridge (Node)
 *                                                       │
 *                                                       └─ MCP Streamable HTTP @ 127.0.0.1:12306/mcp
 *                                                       │
 *   ClippyAI Electron ──@modelcontextprotocol/sdk──────►┘
 *
 * Why this matters:
 *   Our existing CDP recipes spawn a fresh debug-flagged browser — fresh
 *   profile, no cookies, no logins. mcp-chrome talks to the user's REAL
 *   Chrome/Edge/Brave process, so it can drive any tab the user has open
 *   with all their signed-in sessions intact. This is the architectural
 *   win for tasks like "send email through outlook.live.com" where the
 *   user is already signed in.
 *
 * Setup friction (user-facing — documented in Settings → Web tab):
 *   1. Download mcp-chrome extension .zip from GitHub releases
 *   2. chrome://extensions → developer mode → "Load unpacked"
 *   3. `npm install -g mcp-chrome-bridge`
 *   4. Click extension toolbar icon → Connect
 *
 * Not low-friction. Worth it for power users.
 *
 * This module:
 *   - probeMcpChrome(): MCP initialize handshake to detect ready state +
 *     populate the tool catalog
 *   - callMcpChromeTool(toolName, args): typed tool invocation via the SDK
 *   - getMcpChromeStatus(): cached state for the Settings panel
 */

import { createLogger, serializeErr } from './logger';
import type { ToolResult } from './types/tool-result';

const log = createLogger('McpChrome');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.CLIPPY_MCP_CHROME_PORT) || 12306;
const MCP_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}/mcp`;

// Tools advertised by mcp-chrome v1.0.0 (Dec 2025). Captured here so the
// model declarations can reference them by name without a runtime fetch.
// The actual set is reconciled against the server's tools/list response
// during probeMcpChrome() — if upstream renames/adds tools the cache
// updates automatically.
export const MCP_CHROME_TOOLS = {
  // Tab management
  GET_WINDOWS_AND_TABS: 'get_windows_and_tabs',
  NAVIGATE: 'chrome_navigate',
  SWITCH_TAB: 'chrome_switch_tab',
  CLOSE_TABS: 'chrome_close_tabs',
  GO_BACK_OR_FORWARD: 'chrome_go_back_or_forward',
  // Visual
  SCREENSHOT: 'chrome_screenshot',
  // Content
  GET_WEB_CONTENT: 'chrome_get_web_content',
  READ_PAGE: 'chrome_read_page',
  SEARCH_TABS_CONTENT: 'search_tabs_content',
  CONSOLE: 'chrome_console',
  // Interaction
  COMPUTER: 'chrome_computer',
  CLICK_ELEMENT: 'chrome_click_element',
  FILL_OR_SELECT: 'chrome_fill_or_select',
  KEYBOARD: 'chrome_keyboard',
  // Network
  NETWORK_REQUEST: 'chrome_network_request',
  // History / bookmarks
  HISTORY: 'chrome_history',
  BOOKMARK_SEARCH: 'chrome_bookmark_search',
  BOOKMARK_ADD: 'chrome_bookmark_add',
} as const;

interface McpChromeStatus {
  ready: boolean;
  url: string;
  detected_at: string | null;
  tool_count: number;
  tools: string[];
  error?: string;
}

let status: McpChromeStatus = {
  ready: false,
  url: MCP_URL,
  detected_at: null,
  tool_count: 0,
  tools: [],
};

// SDK client + transport are stateful. We hold one connection for the app's
// lifetime; mcp-chrome's HTTP transport is single-client per the upstream
// note, so opening a new transport per call would race with itself.
type AnySdkClient = {
  connect: (t: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools?: Array<{ name: string }> }>;
  callTool: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
};
let cachedClient: AnySdkClient | null = null;
let connecting: Promise<AnySdkClient | null> | null = null;

async function getOrConnect(): Promise<AnySdkClient | null> {
  if (cachedClient) return cachedClient;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      // Lazy-load the SDK so the cold start path (mcp-chrome not installed)
      // doesn't pay the import cost.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as {
        Client: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => AnySdkClient;
      };
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
        StreamableHTTPClientTransport: new (url: URL) => unknown;
      };
      const client = new Client({ name: 'clippyai', version: '0.15.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
      await client.connect(transport);
      cachedClient = client;
      return client;
    } catch (err) {
      log.debug('mcp-chrome connect failed (extension+bridge not installed/running)', { err: String(err).slice(0, 200) });
      cachedClient = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export function getMcpChromeStatus(): McpChromeStatus {
  return { ...status, tools: [...status.tools] };
}

export function isMcpChromeReady(): boolean {
  return status.ready;
}

/**
 * Probe mcp-chrome: connect via the SDK, list tools, cache results.
 * Returns the full status object so callers (Settings panel) can show
 * detailed state. Non-throwing — failure populates the error field.
 */
export async function probeMcpChrome(): Promise<McpChromeStatus> {
  try {
    const client = await getOrConnect();
    if (!client) {
      status = { ready: false, url: MCP_URL, detected_at: null, tool_count: 0, tools: [], error: 'not_connected' };
      return getMcpChromeStatus();
    }
    const list = await client.listTools();
    const toolNames = (list.tools || []).map((t) => t.name);
    status = {
      ready: true,
      url: MCP_URL,
      detected_at: new Date().toISOString(),
      tool_count: toolNames.length,
      tools: toolNames,
    };
    log.info('mcp-chrome detected', { url: MCP_URL, tool_count: toolNames.length });
    return getMcpChromeStatus();
  } catch (err) {
    status = {
      ready: false,
      url: MCP_URL,
      detected_at: null,
      tool_count: 0,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    };
    return getMcpChromeStatus();
  }
}

/**
 * Invoke an mcp-chrome tool by name. Returns the joined text content or
 * throws on error. Caller is responsible for the ToolResult shape.
 *
 * Reconnects automatically on transport failure (e.g. bridge restart).
 */
export async function callMcpChromeTool(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  let client = await getOrConnect();
  if (!client) throw new Error('mcp-chrome not ready');

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) {
      throw new Error(`Tool ${toolName} returned isError: ${JSON.stringify(result.content || []).slice(0, 300)}`);
    }
    const parts = (result.content || [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);
    return parts.join('\n').trim();
  } catch (err) {
    // Transport-level failures: close and retry once with a fresh connection.
    log.warn('mcp-chrome call failed, will attempt reconnect', { tool: toolName, err: String(err).slice(0, 200) });
    try { await client.close(); } catch { /* already dead */ }
    cachedClient = null;
    status.ready = false;
    client = await getOrConnect();
    if (!client) throw err;
    const retryResult = await client.callTool({ name: toolName, arguments: args });
    if (retryResult.isError) {
      throw new Error(`Tool ${toolName} (retry) returned isError: ${JSON.stringify(retryResult.content || []).slice(0, 300)}`);
    }
    const parts = (retryResult.content || [])
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string);
    return parts.join('\n').trim();
  }
}

/**
 * ToolResult wrapper for direct TOOL_MAP dispatch.
 */
export async function callMcpChromeAsToolResult(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  if (!isMcpChromeReady()) {
    return { text: '(error:MCP_CHROME_NOT_READY) Browser extension not connected. See Settings → Web for install instructions.' };
  }
  try {
    const text = await callMcpChromeTool(toolName, args);
    return { text: text || `(${toolName} returned no content)` };
  } catch (err) {
    return { text: `(error:MCP_CHROME_CALL_FAILED) ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Periodic re-probe — if user installs mcp-chrome AFTER Clippy started,
 * we should pick it up without a restart. Settings → Web "Refresh" button
 * also calls this directly.
 */
export async function refreshMcpChromeStatus(): Promise<McpChromeStatus> {
  // Force a reconnect on next probe
  if (cachedClient) {
    try { await cachedClient.close(); } catch { /* ignore */ }
    cachedClient = null;
  }
  return probeMcpChrome();
}
