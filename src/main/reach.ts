/**
 * reach.ts — Agent Reach (github.com/Panniantong/Agent-Reach, MIT): a
 * read-only command-line tool for the sites the web tools can't read
 * (YouTube transcripts, GitHub, and Reddit / X once the user asks for them).
 *
 * Installed the first time a task needs it, after one Yes card, into
 * ~/.clippyai/tools. What is verified, and what is only pinned:
 *   - uv (the installer) and the Agent Reach release zip: downloaded from
 *     their GitHub releases and checked against a sha256 before anything runs.
 *   - the tools that build Agent Reach from its zip: exact versions with
 *     sha256 hashes (reach-constraints.ts, --require-build-hashes).
 *   - the Python interpreter: an exact version, downloaded by uv.
 *   - Agent Reach's Python dependencies: exact versions from PyPI
 *     (reach-constraints.ts), NOT hash-checked: `uv tool install` cannot
 *     require hashes for them.
 *   - what `agent-reach setup` and `agent-reach add <site>` fetch themselves
 *     (setup: imageio-ffmpeg and bilibili-cli from PyPI with pip; a login
 *     site: Node.js, the OpenCLI npm package and browser extension, and the
 *     CloakBrowser package with its browser): chosen and versioned by Agent
 *     Reach, not by this file.
 * Nothing is added to PATH and no script is piped into a shell. The PyPI
 * package named agent-reach is a different project: only the GitHub release
 * asset is used.
 *
 * Every process is execFile with an argument array and windowsHide. No
 * Electron in here: tools.ts supplies the card, the progress line and the
 * user's message, tests supply fakes.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import dns from 'dns';
import fs from 'fs';
import fsp from 'fs/promises';
import https from 'https';
import net from 'net';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ToolResult } from './types/tool-result';
import { RUNTIME_CONSTRAINTS, BUILD_CONSTRAINTS } from './reach-constraints';

export const UV_VERSION = '0.13.9';
export const REACH_VERSION = '1.6.1';
/** The interpreter uv downloads for Agent Reach: an exact build uv 0.13.9 offers for all four platforms. */
export const PYTHON_VERSION = '3.12.16';

export interface Pin { url: string; sha256: string }
export interface Pins { uv: Record<string, Pin>; reach: Pin }

const UV_RELEASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/`;
/** sha256 of each release asset, computed from the downloaded files on 2026-11-21. */
export const PINS: Pins = {
  uv: {
    'win32-x64': { url: `${UV_RELEASE}uv-x86_64-pc-windows-msvc.zip`, sha256: 'edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb' },
    'win32-arm64': { url: `${UV_RELEASE}uv-aarch64-pc-windows-msvc.zip`, sha256: '72eed595983a4d7d22d79f21065b0f4479cc7e5c7a89104bb410c8f47559a878' },
    'darwin-arm64': { url: `${UV_RELEASE}uv-aarch64-apple-darwin.tar.gz`, sha256: '5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca' },
    'darwin-x64': { url: `${UV_RELEASE}uv-x86_64-apple-darwin.tar.gz`, sha256: '617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041' },
  },
  reach: {
    url: `https://github.com/Panniantong/Agent-Reach/releases/download/v${REACH_VERSION}/agent-reach.zip`,
    sha256: '51443d733bcb26064262442083a8f8abf6ba5e3e7df54beebafe98c88be04a60',
  },
};

export const RUN_MS = 30_000;
export const INSTALL_MS = 600_000;
/** Agent Reach's own limit, under ours, so a slow site ends as its JSON error and not a killed process. */
const SITE_TIMEOUT_S = '25';

// ── What the user sees ──────────────────────────────────────────────
// The bubble shows a card as "Can I <summary>?" with the reason on the next line.
export const INSTALL_SUMMARY = 'Install a free reading add-on so I can read YouTube transcripts, GitHub, Reddit and similar sites';
export const INSTALL_REASON = "It is Agent Reach, a free open-source tool. The add-on and its installer are verified; its dependencies are pinned to exact versions. It goes into ClippyAI's own folder, only reads, and takes about a minute.";
export const INSTALL_PROGRESS = 'Installing the reading add-on… about a minute';
export const LINUX_TEXT = '(error:PLATFORM_UNSUPPORTED) Reading these sites is not available on Linux yet. Use web_search instead.';

/** Sites that need the user's login. Enabled one at a time, and only when the user asks for that site by name. */
export const LOGIN_SITES: Record<string, { label: string; named: RegExp }> = {
  reddit: { label: 'Reddit', named: /\breddit\b/i },
  // "X" alone is a capital letter standing by itself, or a small one right after a word that points at a site.
  twitter: { label: 'X', named: /(?<![\w.@/'-])X(?![\w.'/-])|\b(?:on|in|into|from|to|my|search|read|use|check|open)\s+x\b/ },
  instagram: { label: 'Instagram', named: /\binstagram\b|\binsta\b/i },
  facebook: { label: 'Facebook', named: /\bfacebook\b/i },
  linkedin: { label: 'LinkedIn', named: /\blinkedin\b/i },
  xiaohongshu: { label: 'Xiaohongshu', named: /\bxiaohongshu\b|\brednote\b|小红书/i },
};
const TWITTER_WORD = /\btwitter\b|\bx\.com\b/i;
const ASKS = /\b(?:read|reads|reading|use|using|log\s?in|login|sign\s?in|search|look|check|find|browse|open|show|get|see|summari[sz]e|connect|enable|add|turn\s+on|what|tell)\b/i;

/** The channel name for what the model passed as `site` ("X" and "x.com" are twitter). */
export function siteName(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?/, '').replace(/\.com\/?$/, '');
  return s === 'x' ? 'twitter' : s;
}

/**
 * True when `message`, the user's own words for this task, names the site and
 * asks to read, use or log in to it. Never page text, a tool result or model text.
 */
export function loginAsked(site: string, message: string): boolean {
  const info = LOGIN_SITES[site];
  const text = String(message ?? '');
  if (!info || !text) return false;
  const named = info.named.test(text) || (site === 'twitter' && TWITTER_WORD.test(text));
  return named && ASKS.test(text);
}

/** The card for reach_add_login: what happens, and what it can cost. */
export function loginCard(site: string): { summary: string; reason: string } | null {
  const info = LOGIN_SITES[site];
  if (!info) return null;
  return {
    summary: `Copy your ${info.label} login from Chrome into a separate hidden browser`,
    reason: `Automated reading may break ${info.label}'s rules and could put the account at risk. A second account is safer.`,
  };
}

/**
 * reach_add_login asks on every call, in every Guardrails mode: this is the
 * verdict assessRisk hands the approval gate. Null when the call will only be
 * refused (unknown site, or the user did not ask for it), so no card is shown
 * for something that will not run.
 */
export function loginRisk(params: Record<string, unknown>, userMessage: string): { class: 'destructive_web'; reason: string } | null {
  const site = siteName(params.site);
  const card = loginCard(site);
  if (!card || !loginAsked(site, userMessage)) return null;
  return { class: 'destructive_web', reason: card.reason };
}

// ── Which addresses reach_read takes ────────────────────────────────
// reach_read runs unasked (read_only), and its address can come from a page
// the model just read. It must not be a way to fetch the router, a service on
// this PC, a cloud metadata address or an intranet name.
//
// First layer: only the sites Agent Reach has a channel for. Agent Reach is a
// separate process that looks the name up again and follows redirects, so a
// check of the address here cannot hold for an arbitrary site (DNS rebinding,
// a redirect to a private address). For these sites the answer comes from
// that site's own tool, and Agent Reach's catch-all `web` channel, which
// would fetch any address, is never reached.
// Second layer, below: the host must still resolve to public addresses.

/**
 * The hosts each Agent Reach 1.6.1 channel accepts (its can_handle / domains
 * in agent_reach/channels/*.py), `web` left out. A subdomain matches too.
 */
export const REACH_HOSTS: readonly string[] = [
  'youtube.com', 'youtu.be',            // youtube
  'github.com',                         // github (gist.github.com is a subdomain)
  'reddit.com', 'redd.it',              // reddit
  'x.com', 'twitter.com',               // twitter
  'linkedin.com',                       // linkedin
  'instagram.com', 'instagr.am',        // instagram
  'facebook.com', 'fb.com', 'fb.watch', // facebook
  'bilibili.com', 'b23.tv',             // bilibili
  'v2ex.com',                           // v2ex
  'xiaohongshu.com', 'xhslink.com',     // xiaohongshu
  'xueqiu.com',                         // xueqiu
  'xiaoyuzhoufm.com',                   // xiaoyuzhou
  'zhipin.com',                         // boss
];

/** True when `hostname` is one of REACH_HOSTS or a subdomain of one. */
export function isReachHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return REACH_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

export type Resolve = (host: string) => Promise<string[]>;
export const lookupAll: Resolve = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

// Every special-purpose range (IANA registries): only ordinary public unicast passes.
// ipaddr.js is in node_modules only as another package's dependency, not one of the app's own, so the table is here.
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],          // "this network"
  ['10.0.0.0', 8],         // private
  ['100.64.0.0', 10],      // carrier-grade NAT
  ['127.0.0.0', 8],        // loopback
  ['169.254.0.0', 16],     // link-local, cloud metadata
  ['172.16.0.0', 12],      // private
  ['192.0.0.0', 24],       // IETF protocol assignments
  ['192.0.2.0', 24],       // documentation
  ['192.88.99.0', 24],     // 6to4 relay anycast
  ['192.168.0.0', 16],     // private
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // documentation
  ['203.0.113.0', 24],     // documentation
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved, and 255.255.255.255
];

const v4Number = (ip: string): number => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

function v4Blocked(n: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
}

/** The eight 16-bit groups of an IPv6 address that net.isIPv6 accepted. */
function v6Groups(ip: string): number[] {
  let text = ip;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const n = v4Number(dotted[1]);
    text = `${text.slice(0, dotted.index)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...zeros, ...right].map((g) => parseInt(g, 16));
}

/**
 * True unless `address` is an ordinary public address. Anything that is not
 * an IP address is "private" here.
 * IPv4: every special-purpose range in V4_BLOCKED.
 * IPv6 fails closed: an address passes only when it is global unicast
 * (2000::/3) and not documentation, or when it is a pure wrapper around an
 * IPv4 address (IPv4-mapped, NAT64) and that IPv4 address passes. Teredo and
 * 6to4 sit inside 2000::/3 and are judged by the IPv4 address they carry.
 * Everything else is refused: all of ::/8 (::, ::1, IPv4-compatible),
 * fc00::/7, fe80::/10, ff00::/8, 100::/64 and whatever is unassigned.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/%.*$/, ''); // fe80::1%eth0
  if (net.isIPv4(ip)) return v4Blocked(v4Number(ip));
  if (!net.isIPv6(ip)) return true;
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
  const low32 = g[6] * 65536 + g[7];
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // Wrappers around an IPv4 address: judged by that address.
  if (zero(0, 5) && g[5] === 0xffff) return v4Blocked(low32);                   // ::ffff:a.b.c.d    IPv4-mapped
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4Blocked(low32);     // ::ffff:0:a.b.c.d  IPv4-translated
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4Blocked(low32);  // 64:ff9b::/96      NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) {                         // 64:ff9b:1::/48    local NAT64
    // RFC 6052 puts the address after a /48 in bits 48-63 and 72-87; a network may also use the last 32 bits. Both must pass.
    const split = g[3] * 65536 + (g[4] & 0xff) * 256 + (g[5] >> 8);
    return v4Blocked(split) || v4Blocked(low32);
  }
  if ((g[0] & 0xe000) !== 0x2000) return true;                                  // not global unicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true;                           // 2001:db8::/32  documentation
  if (g[0] === 0x2001 && g[1] === 0) return v4Blocked(4294967295 - low32);      // 2001::/32      Teredo (client address, inverted)
  if (g[0] === 0x2002) return v4Blocked(g[1] * 65536 + g[2]);                   // 2002::/16      6to4
  return false;
}

/**
 * Why `hostname` (from a parsed URL) may not be read, or null when every
 * address it resolves to is public. A name that does not resolve is refused too.
 */
export async function privateHostReason(hostname: string, resolve: Resolve): Promise<string | null> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return isPrivateAddress(host) ? 'a local or private address' : null;
  if (!host.includes('.') || /\.(?:local|internal|lan|localhost|home\.arpa)$/.test(host)) return 'a name on the local network';
  let addresses: string[];
  try { addresses = await resolve(host); } catch { return 'a name that could not be looked up'; }
  if (addresses.length === 0) return 'a name that could not be looked up';
  return addresses.some(isPrivateAddress) ? 'a name that points at a local or private address' : null;
}

// ── Download ────────────────────────────────────────────────────────

const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_MAX_REDIRECTS = 5;

/** A release download, or a redirect of one, may only go to GitHub's own hosts over https. Throws otherwise. */
export function allowedDownloadUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !DOWNLOAD_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error(`Download from ${u.protocol}//${u.host} refused`);
  }
  return u;
}

export function httpsDownload(url: string, dest: string, hops = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = allowedDownloadUrl(url); } catch (err) { reject(err); return; }
    const req = https.get(target, { timeout: 60_000, headers: { 'User-Agent': 'ClippyAI' } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        if (hops >= DOWNLOAD_MAX_REDIRECTS || !res.headers.location) { reject(new Error('Too many redirects')); return; }
        let next: string;
        try { next = new URL(res.headers.location, target).toString(); } catch (err) { reject(err); return; }
        resolve(httpsDownload(next, dest, hops + 1));
        return;
      }
      if (status !== 200) { res.resume(); reject(new Error(`HTTP ${status}`)); return; }
      let seen = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > DOWNLOAD_MAX_BYTES) cb(new Error('Download too large')); else cb(null, chunk);
        },
      });
      pipeline(res, cap, fs.createWriteStream(dest)).then(resolve, reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// ── Processes ───────────────────────────────────────────────────────

export interface ExecResult { code: number; stdout: string; stderr: string; timedOut: boolean }
export type Exec = (file: string, args: string[], opts: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

/** execFile: the program by absolute path, the arguments as an array, never a shell. */
export const runFile: Exec = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeoutMs, env: opts.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
    const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
    resolve({
      code: !e ? 0 : typeof e.code === 'number' ? e.code : 1,
      stdout: String(stdout ?? ''),
      stderr: e && typeof e.code !== 'number' ? `${stderr ?? ''}\n${e.message}` : String(stderr ?? ''),
      timedOut: !!e?.killed,
    });
  });
});

export interface ReachDeps {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  env: NodeJS.ProcessEnv;
  exec: Exec;
  download: (url: string, dest: string) => Promise<void>;
  /** Every address a host name resolves to. */
  resolve: Resolve;
  /** The Yes card. True only on an explicit Yes. */
  ask: (summary: string, reason: string) => Promise<boolean>;
  /** A short line in Clippy's bubble. */
  say: (line: string) => void;
  /** The user's own message this task started from. */
  userMessage: () => string;
  /** Changes when a new task starts. */
  taskId: () => number;
  pins?: Pins;
}

interface ReachJson {
  ok?: boolean;
  channel?: string;
  items?: Array<{ title?: unknown; url?: unknown; author?: unknown; published_at?: unknown; text?: unknown; raw?: unknown }>;
  result?: Record<string, unknown>;
  channels?: Array<{ name?: unknown; level?: unknown; actions?: Array<{ name?: unknown }> }>;
  error?: { code?: unknown; message?: unknown; hint?: unknown } | null;
}

/** The one JSON object an agent-reach command prints (its last line), or null. */
export function parseReachJson(stdout: string): ReachJson | null {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object') return v as ReachJson;
    } catch { /* not this line */ }
  }
  return null;
}

const oneLine = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A failed command, in words the model can act on. */
export function reachError(json: ReachJson | null, r: ExecResult): string {
  const e = json?.error;
  if (e && typeof e === 'object') {
    const code = String(e.code ?? 'FAILED').replace(/[^A-Za-z_]/g, '').slice(0, 30) || 'FAILED';
    const login = code === 'NEED_LOGIN' || code === 'NEED_SETUP'
      ? ' If this is a login site and the user asked for it by name, call reach_add_login; otherwise say it needs a login.' : '';
    return `(error:REACH_${code}) ${oneLine(e.message, 400) || 'It did not work'}. ${oneLine(e.hint, 400)}${login} Do not send the user to a terminal.`;
  }
  if (r.timedOut) return '(error:REACH_TIMEOUT) The site did not answer in 30 seconds. Do not retry in a loop.';
  const tail = oneLine((r.stderr || r.stdout).slice(-300), 300);
  return `(error:REACH_FAILED) The reading add-on gave no answer${tail ? `: ${tail}` : ''}.`;
}

/** The items of an answer as plain text: a heading line and the text of each, `raw` left out. */
export function formatItems(json: ReachJson): string {
  const items = Array.isArray(json.items) ? json.items : [];
  if (items.length === 0) return 'No results.';
  const each = Math.floor(5600 / items.length);
  return items.map((it, i) => {
    const head = [it.title, it.url, it.author, it.published_at].filter((v) => typeof v === 'string' && v).join(' | ');
    const body = typeof it.text === 'string' && it.text ? it.text : it.raw ? JSON.stringify(it.raw) : '';
    return [items.length > 1 ? `${i + 1}. ${head}` : head, body.length > each ? `${body.slice(0, each)} […]` : body].filter(Boolean).join('\n');
  }).join('\n\n');
}

const NO_TEXT = '(error:user_denied) The user said No to installing the reading add-on (or did not answer). Nothing was installed. Do not ask again in this task and do not install it another way; answer with what you have, or use web_search.';

export function createReach(d: ReachDeps) {
  const pins = d.pins ?? PINS;
  const exe = d.platform === 'win32' ? '.exe' : '';
  const root = path.join(d.home, '.clippyai', 'tools');
  const p = {
    tmp: path.join(root, 'tmp'),
    uvDir: path.join(root, 'uv'),
    uv: path.join(root, 'uv', `uv${exe}`),
    binDir: path.join(root, 'bin'),
    reach: path.join(root, 'bin', `agent-reach${exe}`),
    marker: path.join(root, 'agent-reach.json'),
  };

  /** uv keeps everything it installs under ~/.clippyai/tools; PATH changes for the child only. */
  function childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...d.env };
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    env[key] = [p.uvDir, p.binDir, env[key]].filter(Boolean).join(path.delimiter);
    return {
      ...env,
      UV_TOOL_DIR: path.join(root, 'uv-tools'),
      UV_TOOL_BIN_DIR: p.binDir,
      UV_PYTHON_INSTALL_DIR: path.join(root, 'python'),
      UV_CACHE_DIR: path.join(root, 'uv-cache'),
      UV_NO_MODIFY_PATH: '1',
    };
  }

  async function reach(args: string[], timeoutMs = RUN_MS): Promise<{ json: ReachJson | null; r: ExecResult }> {
    const r = await d.exec(p.reach, args, { timeoutMs, env: childEnv() });
    return { json: parseReachJson(r.stdout), r };
  }

  async function must(file: string, args: string[], timeoutMs: number, what: string): Promise<void> {
    const r = await d.exec(file, args, { timeoutMs, env: childEnv() });
    if (r.timedOut) throw new Error(`${what} took too long`);
    if (r.code !== 0) throw new Error(`${what} failed: ${oneLine((r.stderr || r.stdout).slice(-300), 300) || `exit ${r.code}`}`);
  }

  async function fetchPinned(pin: Pin, dest: string): Promise<void> {
    allowedDownloadUrl(pin.url);
    await d.download(pin.url, dest);
    const got = await sha256File(dest);
    if (got !== pin.sha256) {
      await fsp.rm(dest, { force: true });
      throw new Error(`${path.basename(dest)} does not match its pinned checksum; nothing was installed`);
    }
  }

  /** Where Agent Reach has put its usage note for other AI tools (<skills folder>/agent-reach), or null. */
  async function skillNotes(): Promise<string[] | null> {
    const { json } = await reach(['skill']);
    const res = json?.ok ? json.result : null;
    if (!res) return null;
    return [res.links, res.copies].flatMap((x) => (Array.isArray(x) ? x : [])).filter((x): x is string => typeof x === 'string');
  }

  /** Take one note out by hand: a link, or a folder that is Agent Reach's own copy of its note. */
  async function removeNote(note: string): Promise<boolean> {
    try {
      const st = await fsp.lstat(note);
      if (st.isSymbolicLink()) { await fsp.unlink(note); return true; }
      if (!st.isDirectory()) return false;
      const head = (await fsp.readFile(path.join(note, 'SKILL.md'), 'utf8')).slice(0, 2000);
      if (!/^---\r?\n(?:(?!---).*\r?\n)*?name:\s*['"]?agent-reach['"]?\s*\r?\n/.test(head)) return false;
      await fsp.rm(note, { recursive: true, force: true });
      return true;
    } catch { return false; }
  }

  /**
   * Its setup links its usage note into the skills folder of every other AI
   * tool it finds (~/.claude/skills, ~/.cursor/skills …). The ones this
   * install added come out again; a note that was there before stays, and so
   * does its own copy in ~/.agents/skills. `skill unlink` is Agent Reach's
   * command for this; 1.6.1 does not have it yet, so the note is then removed
   * directly. Returns the folders that could not be cleared.
   */
  async function unlinkNotes(before: Set<string>): Promise<string[]> {
    const after = await skillNotes();
    if (!after) return ['(could not be listed)'];
    const left: string[] = [];
    for (const note of after) {
      if (before.has(note)) continue;
      const dir = path.dirname(note);
      if (path.basename(note) !== 'agent-reach' || !path.isAbsolute(note)) { left.push(dir); continue; }
      const { json } = await reach(['skill', 'unlink', dir]);
      if (!json?.ok && !(await removeNote(note))) left.push(dir);
    }
    return left;
  }

  async function install(): Promise<void> {
    const pin = pins.uv[`${d.platform}-${d.arch}`];
    if (!pin) throw new Error(`there is no build for ${d.platform} ${d.arch}`);
    await fsp.rm(p.tmp, { recursive: true, force: true });
    await fsp.mkdir(p.tmp, { recursive: true });
    try {
      const archive = path.join(p.tmp, path.basename(new URL(pin.url).pathname));
      await fetchPinned(pin, archive);
      const zip = path.join(p.tmp, 'agent-reach.zip');
      await fetchPinned(pins.reach, zip);
      await fsp.rm(p.uvDir, { recursive: true, force: true });
      await fsp.mkdir(p.uvDir, { recursive: true });
      // The system's own tar: bsdtar on Windows 10+ reads a zip; the macOS archive has one top folder.
      const tar = d.platform === 'win32'
        ? path.join(d.env.SystemRoot ?? d.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')
        : '/usr/bin/tar';
      await must(tar, ['-xf', archive, '-C', p.uvDir, ...(d.platform === 'win32' ? [] : ['--strip-components=1'])], 120_000, 'Unpacking');
      const constraints = path.join(p.tmp, 'constraints.txt');
      const buildConstraints = path.join(p.tmp, 'build-constraints.txt');
      await fsp.writeFile(constraints, RUNTIME_CONSTRAINTS, 'utf8');
      await fsp.writeFile(buildConstraints, BUILD_CONSTRAINTS, 'utf8');
      await must(p.uv, [
        'tool', 'install', '--force', '--python', PYTHON_VERSION,
        '--constraints', constraints, '--build-constraints', buildConstraints, '--require-build-hashes',
        zip,
      ], INSTALL_MS, 'The install');
      const before = new Set((await skillNotes()) ?? []);
      const setup = await reach(['setup'], INSTALL_MS);
      if (!setup.json?.ok) throw new Error(`its setup failed: ${reachError(setup.json, setup.r)}`);
      await unlinkNotes(before);
      await fsp.writeFile(p.marker, JSON.stringify({ version: REACH_VERSION, uv: UV_VERSION }), 'utf8');
    } finally {
      await fsp.rm(p.tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  const installed = (): boolean => fs.existsSync(p.marker) && fs.existsSync(p.reach);
  // A No, or an install that failed: the same answer for the rest of the task, with no second card.
  let refused: { task: number; text: string } | null = null;

  /** Null when Agent Reach is ready; otherwise the result to hand the model. Asks once, and not again in the same task. */
  async function ready(): Promise<string | null> {
    if (d.platform !== 'win32' && d.platform !== 'darwin') return LINUX_TEXT;
    if (installed()) return null;
    const task = d.taskId();
    if (refused?.task === task) return refused.text;
    if (!(await d.ask(INSTALL_SUMMARY, INSTALL_REASON))) {
      refused = { task, text: NO_TEXT };
      return NO_TEXT;
    }
    d.say(INSTALL_PROGRESS);
    try {
      await install();
      return null;
    } catch (err) {
      const text = `(error:REACH_INSTALL_FAILED) The reading add-on could not be installed: ${oneLine(err instanceof Error ? err.message : err, 500)}. Tell the user it could not be installed. Do not send them to a terminal and do not install it another way.`;
      refused = { task, text };
      return text;
    }
  }

  // name -> can it search, and is it turned on. Read once; cleared when a site is added.
  let channelCache: Map<string, { search: boolean; enabled: boolean }> | null = null;
  async function channels(): Promise<Map<string, { search: boolean; enabled: boolean }> | null> {
    if (channelCache) return channelCache;
    const list = await reach(['channels']);
    if (!list.json?.ok || !Array.isArray(list.json.channels)) return null;
    // `channels` lists every site it knows; `doctor` (no network) says which are turned on.
    const doctor = await reach(['doctor']);
    const rows = doctor.json?.ok && Array.isArray(doctor.json.result?.channels) ? doctor.json.result.channels as Array<{ channel?: unknown; status?: unknown }> : [];
    const status = new Map(rows.map((c) => [String(c.channel), String(c.status)]));
    const map = new Map<string, { search: boolean; enabled: boolean }>();
    for (const c of list.json.channels) {
      const name = String(c.name ?? '');
      if (!name) continue;
      map.set(name, {
        search: Array.isArray(c.actions) && c.actions.some((a) => a?.name === 'search'),
        enabled: status.has(name) ? status.get(name) !== 'not_added' : c.level === 'default',
      });
    }
    channelCache = map;
    return map;
  }

  async function answer(args: string[]): Promise<{ ok: boolean; text: string }> {
    const { json, r } = await reach(args);
    return json?.ok ? { ok: true, text: formatItems(json) } : { ok: false, text: reachError(json, r) };
  }

  return {
    /** reach_read({url}) */
    async read(params: Record<string, unknown>): Promise<ToolResult> {
      let url: URL;
      try { url = new URL(String(params.url ?? '').trim()); } catch { return { text: '(error:BAD_INPUT) url must be a full http(s) address.' }; }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        return { text: '(error:BAD_INPUT) url must be a plain http(s) address.' };
      }
      if (!isReachHost(url.hostname)) {
        return { text: '(error:NOT_A_REACH_SITE) reach_read reads only YouTube, GitHub, Reddit, X, LinkedIn, Instagram, Facebook, Bilibili, V2EX, Xiaohongshu, Xueqiu and Xiaoyuzhou links. Use cdp_read_text / http_request for other pages, or web_search.' };
      }
      const why = await privateHostReason(url.hostname, d.resolve);
      if (why) {
        return { text: `(error:REACH_PRIVATE_ADDRESS) reach_read reads public websites only, and ${url.hostname.slice(0, 80)} is ${why}. Do not retry with another spelling of it. If the user asked for this address, use a browser tool or http_request.` };
      }
      const blocked = await ready();
      if (blocked) return { text: blocked };
      const href = url.toString();
      // A YouTube link: what the video says. `read` gives only its title and description.
      if (/(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(url.hostname)) {
        const transcript = await answer(['youtube', 'subtitle', '--lang', 'en,en-orig', '--timeout', SITE_TIMEOUT_S, '--', href]);
        if (transcript.ok) return { text: transcript.text };
        const page = await answer(['read', '--timeout', SITE_TIMEOUT_S, '--', href]);
        return { text: page.ok ? `${page.text}\n\n(No transcript: ${transcript.text})` : transcript.text };
      }
      return { text: (await answer(['read', '--timeout', SITE_TIMEOUT_S, '--', href])).text };
    },

    /** reach_search({site, query}) */
    async search(params: Record<string, unknown>): Promise<ToolResult> {
      const site = siteName(params.site);
      const query = String(params.query ?? '').trim();
      if (!/^[a-z0-9_]{1,30}$/.test(site)) return { text: '(error:BAD_INPUT) site must be one site name, e.g. youtube or github.' };
      if (!query || query.length > 500) return { text: '(error:BAD_INPUT) query is required (at most 500 characters).' };
      const blocked = await ready();
      if (blocked) return { text: blocked };
      const all = await channels();
      if (!all) return { text: '(error:REACH_FAILED) The reading add-on could not list its sites.' };
      const ch = all.get(site);
      if (!ch?.enabled || !ch.search) {
        const usable = [...all].filter(([, c]) => c.enabled && c.search).map(([name]) => name).join(', ');
        const login = LOGIN_SITES[site] ? ` ${LOGIN_SITES[site].label} needs the user's login: only if the user asked for it by name, call reach_add_login first.` : '';
        return { text: `(error:REACH_SITE_NOT_ENABLED) reach_search cannot search "${site}" right now. It can search: ${usable || 'nothing'}.${login}` };
      }
      // The query is search words for that site's own search: an address in it is searched for, never fetched.
      // After `--` every word is the query, whatever it starts with.
      return { text: (await answer([site, 'search', '--timeout', SITE_TIMEOUT_S, '--', query])).text };
    },

    /**
     * reach_add_login({site}): the approval gate has already shown the warning
     * card (loginRisk). Runs only for a site the user's own message asked for.
     * Agent Reach copies that site's cookies itself; no password is typed or seen here.
     */
    async addLogin(params: Record<string, unknown>): Promise<ToolResult> {
      const site = siteName(params.site);
      const info = LOGIN_SITES[site];
      if (!info) return { text: `(error:BAD_INPUT) site must be one of: ${Object.keys(LOGIN_SITES).join(', ')}.` };
      if (!loginAsked(site, d.userMessage())) {
        return { text: `(error:REACH_LOGIN_NOT_ASKED) The user's message does not name ${info.label} and ask to read, use or log in to it, so it was not turned on. Do not retry; ask the user whether they want ${info.label} turned on.` };
      }
      const blocked = await ready();
      if (blocked) return { text: blocked };
      const { json, r } = await reach(['add', site], INSTALL_MS);
      channelCache = null;
      if (!json?.ok) return { text: reachError(json, r) };
      return { text: `${info.label} is turned on. Use reach_read / reach_search for it now. If a read says it needs a login, tell the user; never ask for or type a password.` };
    },
  };
}
