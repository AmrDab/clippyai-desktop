#!/usr/bin/env node
/**
 * clippy-mcp-bridge.js — stdio ⇄ HTTP proxy for ClippyAI's local MCP server.
 *
 * For MCP clients that can only launch a local command (Claude Desktop).
 * Run with the ClippyAI executable so the user needs no Node install:
 *
 *   ELECTRON_RUN_AS_NODE=1 <ClippyAI exe> <this file>
 *
 * Dependency-free on purpose (Node built-ins only): it is shipped as an
 * extraResource outside app.asar and must not reach into node_modules.
 *
 * Protocol: newline-delimited JSON-RPC on stdin/stdout (MCP stdio). Every
 * message is POSTed to http://127.0.0.1:<port>/mcp with the bearer token
 * from ClippyAI's userData/agent-server.json; the reply (JSON or SSE) is
 * written back as one JSON line per message. The Mcp-Session-Id from the
 * initialize response is replayed on every later request.
 *
 * If ClippyAI isn't running or "Connect an agent" is off, every request gets
 * a JSON-RPC error that says so — the client shows it instead of hanging.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');

function userDataDir() {
  if (process.env.CLIPPYAI_USER_DATA) return process.env.CLIPPYAI_USER_DATA;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ClippyAI');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ClippyAI');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ClippyAI');
}

const CONFIG_PATH = path.join(userDataDir(), 'agent-server.json');

/** Re-read on every call so toggling the setting / regenerating the token needs no restart. */
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!c.enabled) return { error: `ClippyAI "Connect an agent" is switched off. Enable it in ClippyAI → Settings → Connect an agent.` };
    if (!c.port || !c.token) return { error: `ClippyAI agent config at ${CONFIG_PATH} is incomplete — open ClippyAI → Settings → Connect an agent.` };
    return { port: c.port, token: c.token };
  } catch {
    return { error: `ClippyAI agent config not found at ${CONFIG_PATH}. Is ClippyAI installed and "Connect an agent" enabled in its Settings?` };
  }
}

let sessionId = null;

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function rpcError(id, message, code = -32000) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/** Parse a text/event-stream body into JSON-RPC messages. */
function parseSse(body) {
  const out = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* ignore keep-alives */ }
  }
  return out;
}

function post(cfg, message) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': payload.length,
      'Authorization': `Bearer ${cfg.token}`,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/mcp', method: 'POST', headers, timeout: 330000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const sid = res.headers['mcp-session-id'];
        if (sid) sessionId = sid;
        if (res.statusCode === 202 || res.statusCode === 204 || !body.trim()) return resolve([]);
        if (res.statusCode >= 400) {
          let msg = `ClippyAI returned HTTP ${res.statusCode}`;
          try { msg += `: ${JSON.parse(body).error.message}`; } catch { /* keep */ }
          return reject(new Error(msg));
        }
        const type = String(res.headers['content-type'] || '');
        try {
          if (type.includes('text/event-stream')) return resolve(parseSse(body));
          const parsed = JSON.parse(body);
          return resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (err) {
          return reject(new Error(`ClippyAI sent an unreadable reply: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('ClippyAI did not answer in time')); });
    req.on('error', (err) => {
      reject(new Error(err.code === 'ECONNREFUSED'
        ? `ClippyAI is not running (nothing listening on 127.0.0.1:${cfg.port}). Start ClippyAI and make sure "Connect an agent" is on.`
        : `Could not reach ClippyAI: ${err.message}`));
    });
    req.end(payload);
  });
}

async function handle(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const isRequest = message && message.method !== undefined && message.id !== undefined;
  const cfg = readConfig();
  if (cfg.error) {
    if (isRequest) write(rpcError(message.id, cfg.error));
    return;
  }
  try {
    for (const reply of await post(cfg, message)) write(reply);
  } catch (err) {
    if (isRequest) write(rpcError(message.id, err.message));
    else process.stderr.write(`clippy-mcp-bridge: ${err.message}\n`);
  }
}

function endSession() {
  const cfg = readConfig();
  if (cfg.error || !sessionId) return process.exit(0);
  const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/mcp', method: 'DELETE',
    headers: { 'Authorization': `Bearer ${cfg.token}`, 'Mcp-Session-Id': sessionId }, timeout: 2000 });
  req.on('error', () => process.exit(0));
  req.on('response', () => process.exit(0));
  req.on('timeout', () => process.exit(0));
  req.end();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain = Promise.resolve();
rl.on('line', (line) => { if (line.trim()) chain = chain.then(() => handle(line)); });
rl.on('close', () => { chain.then(endSession); });
process.stdout.on('error', () => process.exit(0));
