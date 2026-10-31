/**
 * agent-connect.ts — v0.21 "Connect an agent": Electron glue.
 *
 * Owns the on-disk config (userData/agent-server.json), starts/stops the
 * local MCP server (agent-server.ts) with real deps (window, brain, tool
 * dispatcher, Guardrails), and answers Settings → "Connect an agent".
 */

import { app, screen, shell, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  agentConfigPath, loadAgentConfig, saveAgentConfig, generateToken, buildSetupSnippets,
  type AgentConfig, type SetupSnippets,
} from './agent-config';
import { startAgentServer, type AgentServerHandle } from './agent-server';
import type { AgentToolDeps } from './agent-tools';
import { executeTool, assessRisk } from './tools';
import { TOOL_META, isToolSupportedOnPlatform } from './tool-meta';
import * as policy from './permission-policy';
import * as approval from './approval';
import * as windowFollow from './window-follow';
import { setTrayAgentStatus } from './tray';
import { createLogger, serializeErr } from './logger';
import * as telemetry from './telemetry';
import type { Brain } from './brain';

const log = createLogger('AgentConnect');

let cfg: AgentConfig | null = null;
let handle: AgentServerHandle | null = null;
let starting: Promise<void> | null = null;
let win: BrowserWindow | null = null;
let brain: Brain | null = null;

function configFile(): string { return agentConfigPath(app.getPath('userData')); }
function config(): AgentConfig { return cfg ?? (cfg = loadAgentConfig(configFile())); }
function persist(): void { saveAgentConfig(configFile(), config()); }

/** resources/mcp/clippy-mcp-bridge.js — extraResource in a packaged build. */
export function bridgeScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mcp', 'clippy-mcp-bridge.js')
    : path.join(app.getAppPath(), 'resources', 'mcp', 'clippy-mcp-bridge.js');
}

/** assets/agent-skill/clippy/SKILL.md — extraResource in a packaged build. */
export function skillPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'agent-skill', 'clippy', 'SKILL.md')
    : path.join(app.getAppPath(), 'assets', 'agent-skill', 'clippy', 'SKILL.md');
}

/** Tools an agent may run: everything in TOOL_META that works on this OS. */
export function allowedAgentTools(): string[] {
  return Object.keys(TOOL_META).filter((n) => isToolSupportedOnPlatform(TOOL_META[n])).sort();
}

function liveWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function buildDeps(): AgentToolDeps {
  return {
    platform: process.platform,
    version: app.getVersion(),
    allowedTools: allowedAgentTools,
    isBrainBusy: () => brain?.isBusy() ?? false,
    send: (channel, payload) => {
      const w = liveWindow();
      if (!w) return false;
      if (payload === undefined) w.webContents.send(channel); else w.webContents.send(channel, payload);
      return true;
    },
    getWindowBounds: () => liveWindow()?.getBounds() ?? null,
    setWindowBounds: (rect) => { liveWindow()?.setBounds(rect); },
    noteManualMove: () => windowFollow.noteManualMove(),
    displays: () => screen.getAllDisplays().map((d) => ({
      id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),
    displayNearest: (p) => {
      const d = screen.getDisplayNearestPoint(p);
      return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id };
    },
    executeTool,
    assessRisk,
    classFor: policy.classFor,
    decide: policy.decide,
    summarizeArgs: approval.summarizeArgs,
    requestApproval: (req) => approval.requestApproval(liveWindow(), req),
    markApproved: approval.markApproved,
  };
}

async function start(): Promise<void> {
  if (handle) return;
  if (starting) return starting;
  starting = (async () => {
    const c = config();
    const deps = buildDeps();
    const onClientsChange = (clients: string[]): void => { setTrayAgentStatus(clients[0] ?? null); telemetry.trackAgentClients(clients); };
    try {
      try {
        handle = await startAgentServer({ port: c.port, token: c.token, version: app.getVersion(), deps, onClientsChange });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE' || c.port === 0) throw err;
        log.warn('Agent port in use — picking a new one', { port: c.port });
        handle = await startAgentServer({ port: 0, token: c.token, version: app.getVersion(), deps, onClientsChange });
      }
      if (handle.port !== c.port) { c.port = handle.port; persist(); }
    } catch (err) {
      log.error('Agent server failed to start', serializeErr(err));
    } finally {
      starting = null;
    }
  })();
  return starting;
}

async function stop(): Promise<void> {
  const h = handle;
  handle = null;
  if (h) {
    try { await h.close(); } catch (err) { log.warn('Agent server close failed', serializeErr(err)); }
  }
  setTrayAgentStatus(null);
}

/** Called once from index.ts after the main window + brain exist. */
export function initAgentConnect(mainWindow: BrowserWindow, b: Brain): void {
  win = mainWindow;
  brain = b;
  if (config().enabled) void start();
}

export async function shutdownAgentConnect(): Promise<void> {
  await stop();
}

export async function setAgentEnabled(enabled: boolean): Promise<void> {
  config().enabled = enabled;
  persist();
  if (enabled) await start(); else await stop();
}

export async function regenerateAgentToken(): Promise<void> {
  config().token = generateToken();
  persist();
  if (handle) { await stop(); await start(); } // existing sessions die with the old token
}

export interface AgentConnectStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  clients: string[];
  snippets: SetupSnippets;
  bridgePath: string;
  skillPath: string;
  skillMarkdown: string;
  configPath: string;
}

export function getAgentConnectStatus(): AgentConnectStatus {
  const c = config();
  let skillMarkdown = '';
  try { skillMarkdown = fs.readFileSync(skillPath(), 'utf8'); } catch { /* shown as missing */ }
  return {
    enabled: c.enabled,
    running: !!handle,
    port: handle?.port ?? c.port,
    clients: handle?.clients() ?? [],
    snippets: buildSetupSnippets({
      platform: process.platform, execPath: process.execPath, bridgePath: bridgeScriptPath(),
      port: handle?.port ?? c.port, token: c.token,
    }),
    bridgePath: bridgeScriptPath(),
    skillPath: skillPath(),
    skillMarkdown,
    configPath: configFile(),
  };
}

export function revealSkillFile(): void {
  shell.showItemInFolder(skillPath());
}
