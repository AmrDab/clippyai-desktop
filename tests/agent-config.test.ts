import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkAgentRequest, buildSetupSnippets, generateToken, loadAgentConfig, saveAgentConfig, agentConfigPath,
} from '../src/main/agent-config';

const cfg = { port: 4321, token: 'a'.repeat(64) };
const good = { method: 'POST', url: '/mcp', headers: { host: '127.0.0.1:4321', authorization: `Bearer ${cfg.token}` } };

describe('checkAgentRequest', () => {
  it('accepts a well-formed local request', () => {
    expect(checkAgentRequest(good, cfg)).toEqual({ ok: true });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, host: 'localhost:4321' } }, cfg).ok).toBe(true);
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, host: '[::1]:4321' } }, cfg).ok).toBe(true);
  });

  it('401s a missing, malformed, or wrong bearer token', () => {
    const r1 = checkAgentRequest({ ...good, headers: { host: good.headers.host } }, cfg);
    expect(r1).toMatchObject({ ok: false, status: 401 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, authorization: 'Bearer ' + 'b'.repeat(64) } }, cfg)).toMatchObject({ ok: false, status: 401 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, authorization: 'Bearer ' + 'a'.repeat(63) } }, cfg)).toMatchObject({ ok: false, status: 401 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, authorization: cfg.token } }, cfg)).toMatchObject({ ok: false, status: 401 });
  });

  it('403s a Host that is not loopback:<port> (DNS rebinding)', () => {
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, host: 'evil.example' } }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, host: '127.0.0.1:9999' } }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, host: '127.0.0.1' } }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(checkAgentRequest({ ...good, headers: { authorization: good.headers.authorization } }, cfg)).toMatchObject({ ok: false, status: 403 });
  });

  it('403s any request carrying a browser Origin, even a loopback one', () => {
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, origin: 'http://127.0.0.1:4321' } }, cfg)).toMatchObject({ ok: false, status: 403 });
    expect(checkAgentRequest({ ...good, headers: { ...good.headers, origin: 'null' } }, cfg)).toMatchObject({ ok: false, status: 403 });
  });

  it('404s any path other than /mcp (checked before auth)', () => {
    expect(checkAgentRequest({ ...good, url: '/' }, cfg)).toMatchObject({ ok: false, status: 404 });
    expect(checkAgentRequest({ ...good, url: '/mcp/../x' }, cfg)).toMatchObject({ ok: false, status: 404 });
    expect(checkAgentRequest({ ...good, url: '/mcp?x=1' }, cfg).ok).toBe(true);
  });
});

describe('config file', () => {
  it('round-trips and regenerates a token when the file is missing or junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-agent-'));
    const file = agentConfigPath(dir);
    const fresh = loadAgentConfig(file);
    expect(fresh.enabled).toBe(false);
    expect(fresh.port).toBe(0);
    expect(fresh.token).toMatch(/^[0-9a-f]{64}$/);
    saveAgentConfig(file, { enabled: true, port: 5555, token: fresh.token });
    expect(loadAgentConfig(file)).toEqual({ enabled: true, port: 5555, token: fresh.token });
    fs.writeFileSync(file, '{"enabled":"yes","port":"70000","token":"short"}');
    const sanitized = loadAgentConfig(file);
    expect(sanitized.enabled).toBe(false);
    expect(sanitized.port).toBe(0);
    expect(sanitized.token).not.toBe('short');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generateToken is 256 bits of hex and unique', () => {
    expect(generateToken()).toHaveLength(64);
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('buildSetupSnippets', () => {
  const base = { port: 4321, token: 'tok' };

  it('Windows: Claude Code command, Claude Desktop JSON with escaped exe path + ELECTRON_RUN_AS_NODE, Codex TOML', () => {
    const s = buildSetupSnippets({ ...base, platform: 'win32', execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\ClippyAI\\ClippyAI.exe', bridgePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\ClippyAI\\resources\\mcp\\clippy-mcp-bridge.js' });
    expect(s.url).toBe('http://127.0.0.1:4321/mcp');
    expect(s.claudeCode).toBe('claude mcp add --transport http clippy http://127.0.0.1:4321/mcp --header "Authorization: Bearer tok"');
    const desktop = JSON.parse(s.claudeDesktop);
    expect(desktop.mcpServers.clippy).toEqual({
      command: 'C:\\Users\\me\\AppData\\Local\\Programs\\ClippyAI\\ClippyAI.exe',
      args: ['C:\\Users\\me\\AppData\\Local\\Programs\\ClippyAI\\resources\\mcp\\clippy-mcp-bridge.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(s.claudeDesktopConfigPath).toBe('%APPDATA%\\Claude\\claude_desktop_config.json');
    expect(s.codex).toBe('[mcp_servers.clippy]\nurl = "http://127.0.0.1:4321/mcp"\nhttp_headers = { "Authorization" = "Bearer tok" }');
    expect(JSON.parse(s.generic)).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp', headers: { Authorization: 'Bearer tok' } });
  });

  it('macOS: app-bundle exe path and the Library config path', () => {
    const s = buildSetupSnippets({ ...base, platform: 'darwin', execPath: '/Applications/ClippyAI.app/Contents/MacOS/ClippyAI', bridgePath: '/Applications/ClippyAI.app/Contents/Resources/mcp/clippy-mcp-bridge.js' });
    const desktop = JSON.parse(s.claudeDesktop);
    expect(desktop.mcpServers.clippy.command).toBe('/Applications/ClippyAI.app/Contents/MacOS/ClippyAI');
    expect(desktop.mcpServers.clippy.args).toEqual(['/Applications/ClippyAI.app/Contents/Resources/mcp/clippy-mcp-bridge.js']);
    expect(desktop.mcpServers.clippy.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(s.claudeDesktopConfigPath).toBe('~/Library/Application Support/Claude/claude_desktop_config.json');
  });
});
