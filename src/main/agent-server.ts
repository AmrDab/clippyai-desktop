/**
 * agent-server.ts — v0.21 "Connect an agent".
 *
 * The local MCP endpoint (Streamable HTTP, 127.0.0.1 only) that an outside
 * agent connects to. One McpServer + transport per MCP session, keyed by
 * Mcp-Session-Id. Every request passes checkAgentRequest() (path, Host,
 * Origin, bearer token) BEFORE the SDK sees it. No Electron import — the
 * Electron glue (config file, deps) lives in agent-connect.ts so this file
 * can be exercised end-to-end in vitest with the SDK client.
 */

import http from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkAgentRequest } from './agent-config';
import { registerAgentTools, type AgentToolDeps } from './agent-tools';
import { createLogger } from './logger';

const log = createLogger('AgentServer');

export interface AgentServerOptions {
  /** 0 = pick a free port. */
  port: number;
  token: string;
  version: string;
  deps: AgentToolDeps;
  /** Called whenever the set of connected clients changes. */
  onClientsChange?: (clients: string[]) => void;
}

interface Session { transport: StreamableHTTPServerTransport; server: McpServer; clientName: string }

export interface AgentServerHandle {
  port: number;
  /** Names of currently connected clients (from MCP initialize clientInfo). */
  clients: () => string[];
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage, max = 4 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === 'object' && (m as { method?: string }).method === 'initialize');
}

export async function startAgentServer(opts: AgentServerOptions): Promise<AgentServerHandle> {
  const sessions = new Map<string, Session>();
  const notify = (): void => opts.onClientsChange?.([...sessions.values()].map((s) => s.clientName).filter(Boolean));

  async function newSession(): Promise<Session> {
    const server = new McpServer({ name: 'clippyai', version: opts.version });
    registerAgentTools(server, opts.deps);
    const session: Session = { transport: null as unknown as StreamableHTTPServerTransport, server, clientName: '' };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // One JSON body per request keeps the stdio bridge trivial; nothing
      // here streams mid-call.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session);
        log.info('Agent.session_open', { id, client: session.clientName });
        notify();
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        log.info('Agent.session_closed', { id });
        notify();
      },
    });
    session.transport = transport;
    server.server.oninitialized = () => {
      const info = server.server.getClientVersion();
      session.clientName = info ? `${info.name}${info.version ? ' ' + info.version : ''}` : 'unknown client';
      log.info('Agent.connected', { client: session.clientName });
      notify();
    };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) notify();
    };
    await server.connect(transport);
    return session;
  }

  const httpServer = http.createServer(async (req, res) => {
    const gate = checkAgentRequest({ method: req.method || 'GET', url: req.url || '/', headers: req.headers }, { port, token: opts.token });
    if (!gate.ok) {
      log.warn('Agent.rejected', { status: gate.status, reason: gate.message, method: req.method });
      res.writeHead(gate.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: gate.message }, id: null }));
      return;
    }
    try {
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (existing) return await existing.transport.handleRequest(req, res, body);
        if (!sessionId && isInitialize(body)) return await (await newSession()).transport.handleRequest(req, res, body);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session — send initialize first' }, id: null }));
        return;
      }
      if (existing) return await existing.transport.handleRequest(req, res);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'no valid session' }, id: null }));
    } catch (err) {
      log.warn('Agent.request_failed', { err: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
      }
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
    });
  });
  log.info('Agent.listening', { port });

  return {
    port,
    clients: () => [...sessions.values()].map((s) => s.clientName).filter(Boolean),
    close: async () => {
      for (const [id, s] of [...sessions]) {
        sessions.delete(id);
        try { await s.transport.close(); } catch { /* already gone */ }
      }
      notify();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeAllConnections?.();
      log.info('Agent.stopped');
    },
  };
}
