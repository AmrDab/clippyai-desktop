/**
 * End-to-end: real HTTP listener + the SDK's MCP client over Streamable HTTP.
 * No Electron — deps are the same mocks agent-tools.test.ts uses.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startAgentServer, type AgentServerHandle } from '../src/main/agent-server';
import type { AgentToolDeps, Rect } from '../src/main/agent-tools';

const TOKEN = 'f'.repeat(64);
const WA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const sent: Array<[string, unknown]> = [];
const clientsSeen: string[][] = [];

const deps: AgentToolDeps = {
  platform: 'win32',
  version: '0.21.0-test',
  allowedTools: () => ['read_screen', 'write_file'],
  isBrainBusy: () => false,
  send: (channel, payload) => { sent.push([channel, payload]); return true; },
  getWindowBounds: () => ({ x: 10, y: 10, width: 200, height: 200 }),
  setWindowBounds: () => {},
  noteManualMove: () => {},
  displays: () => [{ id: 1, bounds: WA, workArea: WA, scaleFactor: 1, primary: true }],
  displayNearest: () => ({ id: 1, bounds: WA, workArea: WA, scaleFactor: 1, primary: true }),
  executeTool: async (name) => ({ text: `ran ${name}` }),
  classFor: (name) => (name === 'read_screen' ? 'read_only' : 'destructive_file'),
  decide: (name) => (name === 'read_screen' ? 'allow' : 'approve'),
  summarizeArgs: (name) => `do ${name}`,
  requestApproval: async () => 'denied',
  markApproved: () => {},
  glideMs: 1,
};

let server: AgentServerHandle;
let url: string;

beforeAll(async () => {
  server = await startAgentServer({ port: 0, token: TOKEN, version: '0.21.0-test', deps, onClientsChange: (c) => clientsSeen.push(c) });
  url = `http://127.0.0.1:${server.port}/mcp`;
});
afterAll(async () => { await server.close(); });

/** Raw request via node:http so a custom Host header actually goes on the wire (fetch/undici drops it). */
function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function connect(headers: Record<string, string>) {
  const client = new Client({ name: 'vitest-agent', version: '1.2.3' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  return { client, transport, connect: () => client.connect(transport) };
}

describe('agent MCP server over HTTP', () => {
  it('binds a random free port on 127.0.0.1', () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it('401s without a bearer token and 403s with a bad Host or any Origin (before the SDK sees it)', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: `127.0.0.1:${server.port}` };
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await raw('POST', '/mcp', base, body)).status).toBe(401);
    expect((await raw('POST', '/mcp', { ...base, ...auth, Host: 'evil.example' }, body)).status).toBe(403);
    expect((await raw('POST', '/mcp', { ...base, ...auth, Host: `127.0.0.1:${server.port + 1}` }, body)).status).toBe(403);
    expect((await raw('POST', '/mcp', { ...base, ...auth, Origin: 'http://127.0.0.1:1' }, body)).status).toBe(403);
    expect((await raw('GET', '/', { ...base, ...auth })).status).toBe(404);
    // a non-initialize POST with no session is refused without creating one
    const notInit = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await raw('POST', '/mcp', { ...base, ...auth }, notInit)).status).toBe(400);
    expect(server.clients()).toEqual([]);
  });

  it('SDK client refuses to connect with the wrong token', async () => {
    const { connect: go } = connect({ Authorization: 'Bearer ' + 'e'.repeat(64) });
    await expect(go()).rejects.toThrow(/unauthorized/);
    expect(server.clients()).toEqual([]);
  });

  it('initialize → list tools → call clippy_status / clippy_say / clippy_run_tool, and reports the client name', async () => {
    const { client, transport, connect: go } = connect({ Authorization: `Bearer ${TOKEN}` });
    await go();
    expect(server.clients()).toEqual(['vitest-agent 1.2.3']);
    expect(clientsSeen.at(-1)).toEqual(['vitest-agent 1.2.3']);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      'clippy_animate', 'clippy_ask_user', 'clippy_point_at', 'clippy_run_tool', 'clippy_say', 'clippy_screenshot', 'clippy_status',
    ]);
    const runTool = tools.tools.find((t) => t.name === 'clippy_run_tool')!;
    expect(runTool.description).toContain('read_screen, write_file');

    const status = await client.callTool({ name: 'clippy_status', arguments: {} });
    const parsed = JSON.parse((status.content as Array<{ text: string }>)[0].text);
    expect(parsed.version).toBe('0.21.0-test');
    expect(parsed.allowed_tools).toEqual(['read_screen', 'write_file']);

    const say = await client.callTool({ name: 'clippy_say', arguments: { text: 'hi from the test' } });
    expect(say.isError).toBeFalsy();
    expect(sent.at(-1)).toEqual(['clippy-speak', { text: 'hi from the test', animate: 'Explain' }]);

    const bad = await client.callTool({ name: 'clippy_animate', arguments: { animation: 'Moonwalk' } });
    expect(bad.isError).toBe(true);

    const ok = await client.callTool({ name: 'clippy_run_tool', arguments: { name: 'read_screen' } });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as Array<{ text: string }>)[0].text).toBe('ran read_screen');

    const denied = await client.callTool({ name: 'clippy_run_tool', arguments: { name: 'write_file', args: { path: 'x' } } });
    expect(denied.isError).toBe(true);
    expect((denied.content as Array<{ text: string }>)[0].text).toContain('(error:user_denied)');

    await transport.terminateSession(); // DELETE /mcp → onsessionclosed
    await client.close();
    expect(server.clients()).toEqual([]);
  });
});

/** Drive resources/mcp/clippy-mcp-bridge.js over stdio with a userData dir of our choosing. */
function runBridge(userData: string, lines: object[]): Promise<{ out: object[]; err: string }> {
  const script = path.resolve(__dirname, '..', 'resources', 'mcp', 'clippy-mcp-bridge.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, CLIPPYAI_USER_DATA: userData }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', () => resolve({ out: stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)), err: stderr }));
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}

describe('stdio bridge (resources/mcp/clippy-mcp-bridge.js)', () => {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bridge-test', version: '0' } } };
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const status = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clippy_status', arguments: {} } };

  it('proxies initialize / tools/list / tools/call to the HTTP server and ends the session on stdin close', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
    fs.writeFileSync(path.join(dir, 'agent-server.json'), JSON.stringify({ enabled: true, port: server.port, token: TOKEN }));
    const { out } = await runBridge(dir, [init, initialized, list, status]);
    const byId = Object.fromEntries(out.map((m) => [(m as { id: number }).id, m as Record<string, unknown>]));
    expect((byId[1].result as { serverInfo: { name: string } }).serverInfo.name).toBe('clippyai');
    expect((byId[2].result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toContain('clippy_say');
    const text = (byId[3].result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text).version).toBe('0.21.0-test');
    expect(server.clients()).toEqual([]); // DELETE on exit closed the session
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it('returns a clear JSON-RPC error when the feature is off, the config is missing, or Clippy is not running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-bridge-'));
    const missing = await runBridge(dir, [init]);
    expect((missing.out[0] as { error: { message: string } }).error.message).toMatch(/not found.*Connect an agent/);

    fs.writeFileSync(path.join(dir, 'agent-server.json'), JSON.stringify({ enabled: false, port: server.port, token: TOKEN }));
    const off = await runBridge(dir, [init]);
    expect((off.out[0] as { error: { message: string } }).error.message).toMatch(/switched off/);

    fs.writeFileSync(path.join(dir, 'agent-server.json'), JSON.stringify({ enabled: true, port: 1, token: TOKEN }));
    const down = await runBridge(dir, [init]);
    expect((down.out[0] as { error: { message: string } }).error.message).toMatch(/not running|Could not reach/);

    fs.writeFileSync(path.join(dir, 'agent-server.json'), JSON.stringify({ enabled: true, port: server.port, token: 'wrong' }));
    const unauthorized = await runBridge(dir, [init]);
    expect((unauthorized.out[0] as { error: { message: string } }).error.message).toMatch(/HTTP 401/);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});
