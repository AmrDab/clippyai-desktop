import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createReach, parseReachJson, reachError, formatItems, loginAsked, loginCard, loginRisk, siteName, allowedDownloadUrl,
  isPrivateAddress, privateHostReason, isReachHost, REACH_HOSTS,
  PINS, INSTALL_SUMMARY, INSTALL_REASON, INSTALL_PROGRESS, LINUX_TEXT, PYTHON_VERSION,
  type ReachDeps, type ExecResult, type Pins,
} from '../src/main/reach';
import { RUNTIME_CONSTRAINTS, BUILD_CONSTRAINTS } from '../src/main/reach-constraints';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const UV_BYTES = 'fake uv archive';
const ZIP_BYTES = 'fake agent-reach zip';
const GOOD_PINS: Pins = {
  uv: { 'win32-x64': { url: PINS.uv['win32-x64'].url, sha256: sha(UV_BYTES) } },
  reach: { url: PINS.reach.url, sha256: sha(ZIP_BYTES) },
};
const out = (json: unknown, code = 0): ExecResult => ({ code, stdout: `${JSON.stringify(json)}\n`, stderr: '', timedOut: false });

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-test-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

/** A fake machine: downloads write fixed bytes, every process is recorded and answered by `reply`. */
function setup(over: Partial<ReachDeps> = {}, reply: (args: string[]) => ExecResult | undefined = () => undefined) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const asked: string[] = [];
  const said: string[] = [];
  const downloads: string[] = [];
  const resolved: string[] = [];
  const seen: Record<string, string> = {};
  const state = { answer: true, task: 1, message: '' };
  const tools = path.join(home, '.clippyai', 'tools');
  const reachExe = path.join(tools, 'bin', 'agent-reach.exe');
  const deps: ReachDeps = {
    platform: 'win32',
    arch: 'x64',
    home,
    env: { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
    exec: async (file, args, opts) => {
      calls.push({ file, args, env: opts.env, timeoutMs: opts.timeoutMs });
      if (path.basename(file) === 'uv.exe') { // `uv tool install` leaves the program in the bin folder
        for (const flag of ['--constraints', '--build-constraints']) seen[flag] = fs.readFileSync(args[args.indexOf(flag) + 1], 'utf8');
        fs.mkdirSync(path.dirname(reachExe), { recursive: true });
        fs.writeFileSync(reachExe, '');
      }
      if (file !== reachExe) return { code: 0, stdout: '', stderr: '', timedOut: false };
      return reply(args)
        ?? (args[0] === 'skill' ? out({ ok: true, result: { links: [], copies: [] } })
          : args[0] === 'channels' ? out({ ok: true, channels: [
            { name: 'youtube', level: 'default', actions: [{ name: 'read' }, { name: 'search' }] },
            { name: 'v2ex', level: 'default', actions: [{ name: 'read' }] },
            { name: 'reddit', level: 'optional', actions: [{ name: 'read' }, { name: 'search' }] },
          ] })
          : args[0] === 'doctor' ? out({ ok: true, result: { channels: [
            { channel: 'youtube', status: 'unverified' }, { channel: 'v2ex', status: 'unverified' }, { channel: 'reddit', status: 'not_added' },
          ] } })
          : out({ ok: true, items: [{ title: 'T', url: 'https://e.x/', text: 'body' }] }));
    },
    download: async (url, dest) => {
      downloads.push(url);
      fs.writeFileSync(dest, url.endsWith('agent-reach.zip') ? ZIP_BYTES : UV_BYTES);
    },
    resolve: async (host) => {
      resolved.push(host);
      if (host === 'rebind.github.com') return ['93.184.216.34', '192.168.1.1'];
      if (host === 'nowhere.github.com') throw new Error('ENOTFOUND');
      return ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
    },
    ask: async (summary) => { asked.push(summary); return state.answer; },
    say: (line) => { said.push(line); },
    userMessage: () => state.message,
    taskId: () => state.task,
    pins: GOOD_PINS,
    ...over,
  };
  return { reach: createReach(deps), calls, asked, said, downloads, resolved, seen, state, tools, reachExe };
}

describe('install', () => {
  it('asks once, installs with pinned files and argument arrays, and never asks again', async () => {
    const t = setup();
    const first = await t.reach.read({ url: 'https://github.com/a/b' });
    expect(first.text).toContain('body');
    expect(t.asked).toEqual([INSTALL_SUMMARY]);
    expect(t.said).toEqual([INSTALL_PROGRESS]);
    expect(t.downloads).toEqual([GOOD_PINS.uv['win32-x64'].url, GOOD_PINS.reach.url]);

    const steps = t.calls.map((c) => `${path.basename(c.file)} ${c.args.slice(0, 2).join(' ')}`);
    expect(steps).toEqual(['tar.exe -xf ' + path.join(t.tools, 'tmp', 'uv-x86_64-pc-windows-msvc.zip'), 'uv.exe tool install', 'agent-reach.exe skill', 'agent-reach.exe setup', 'agent-reach.exe skill', 'agent-reach.exe read --timeout']);
    const uv = t.calls[1];
    expect(uv.file).toBe(path.join(t.tools, 'uv', 'uv.exe'));
    expect(uv.args).toEqual([
      'tool', 'install', '--force', '--python', '3.12.16',
      '--constraints', path.join(t.tools, 'tmp', 'constraints.txt'),
      '--build-constraints', path.join(t.tools, 'tmp', 'build-constraints.txt'), '--require-build-hashes',
      path.join(t.tools, 'tmp', 'agent-reach.zip'),
    ]);
    expect(t.seen['--constraints']).toBe(RUNTIME_CONSTRAINTS);
    expect(t.seen['--build-constraints']).toBe(BUILD_CONSTRAINTS);
    expect(uv.timeoutMs).toBe(600_000);
    expect(uv.env).toMatchObject({
      UV_TOOL_DIR: path.join(t.tools, 'uv-tools'),
      UV_TOOL_BIN_DIR: path.join(t.tools, 'bin'),
      UV_PYTHON_INSTALL_DIR: path.join(t.tools, 'python'),
      UV_CACHE_DIR: path.join(t.tools, 'uv-cache'),
      UV_NO_MODIFY_PATH: '1',
    });
    // PATH changes for the child only, under the name the parent used.
    expect(uv.env.Path).toBe([path.join(t.tools, 'uv'), path.join(t.tools, 'bin'), 'C:\\Windows\\System32'].join(path.delimiter));
    expect(uv.env.PATH).toBeUndefined();
    // Every program by absolute path, no shell, and no argument that is a command line.
    for (const c of t.calls) {
      expect(path.win32.isAbsolute(c.file) || path.posix.isAbsolute(c.file)).toBe(true); // the test fakes win32, also on a Mac runner
      expect(/^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/i.test(path.basename(c.file))).toBe(false);
      for (const a of c.args) expect(/[|&;`]|\biex\b|\birm\b/.test(a)).toBe(false);
    }
    expect(fs.existsSync(path.join(t.tools, 'tmp'))).toBe(false);

    await t.reach.read({ url: 'https://github.com/a/b' });
    await t.reach.search({ site: 'youtube', query: 'cats' });
    expect(t.asked).toHaveLength(1);
    expect(t.downloads).toHaveLength(2);
  });

  it('a No installs nothing and is not asked again in the same task', async () => {
    const t = setup();
    t.state.answer = false;
    const r = await t.reach.read({ url: 'https://youtu.be/abc' });
    expect(r.text).toMatch(/^\(error:user_denied\)/);
    await t.reach.search({ site: 'youtube', query: 'cats' });
    expect(t.asked).toHaveLength(1);
    expect(t.downloads).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(t.said).toEqual([]);
    // A new task may ask again.
    t.state.task = 2;
    await t.reach.read({ url: 'https://youtu.be/abc' });
    expect(t.asked).toHaveLength(2);
  });

  it('refuses a download that does not match its sha256, before anything runs', async () => {
    const t = setup({ pins: { ...GOOD_PINS, uv: { 'win32-x64': { url: PINS.uv['win32-x64'].url, sha256: sha('something else') } } } });
    const r = await t.reach.read({ url: 'https://github.com/a/b' });
    expect(r.text).toMatch(/^\(error:REACH_INSTALL_FAILED\)/);
    expect(r.text).toContain('does not match its pinned checksum');
    expect(t.calls).toEqual([]);
    expect(fs.existsSync(path.join(t.tools, 'agent-reach.json'))).toBe(false);
    expect(fs.existsSync(path.join(t.tools, 'tmp'))).toBe(false);
    // The same task does not get a second card for an install that failed.
    expect((await t.reach.read({ url: 'https://github.com/a/b' })).text).toBe(r.text);
    expect(t.asked).toHaveLength(1);
  });

  it('refuses a tampered Agent Reach zip before uv installs it', async () => {
    const t = setup({ pins: { ...GOOD_PINS, reach: { url: PINS.reach.url, sha256: sha('something else') } } });
    const r = await t.reach.read({ url: 'https://github.com/a/b' });
    expect(r.text).toMatch(/^\(error:REACH_INSTALL_FAILED\)/);
    expect(t.calls).toEqual([]);
  });

  it('takes the usage note it linked into other AI tools back out, and leaves one that was there before', async () => {
    const mine = path.join(home, '.claude', 'skills', 'agent-reach');
    const old = path.join(home, '.cursor', 'skills', 'agent-reach');
    for (const dir of [mine, old]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: agent-reach\ndescription: x\n---\nbody');
    }
    let listed = 0;
    const t = setup({}, (args) => {
      if (args[0] === 'skill' && args.length === 1) return out({ ok: true, result: { links: [], copies: listed++ === 0 ? [old] : [old, mine] } });
      // 1.6.1: there is no `skill unlink`
      if (args[0] === 'skill') return out({ ok: false, error: { code: 'BAD_INPUT', message: 'usage: agent-reach skill [link <skills-dir>]', hint: '' } }, 1);
      return undefined;
    });
    await t.reach.read({ url: 'https://github.com/a/b' });
    expect(t.calls.some((c) => c.args.join(' ') === `skill unlink ${path.dirname(mine)}`)).toBe(true);
    expect(fs.existsSync(mine)).toBe(false);
    expect(fs.existsSync(old)).toBe(true);
  });

  it('pins the interpreter and every dependency to an exact version, the build tools with hashes', () => {
    expect(PYTHON_VERSION).toMatch(/^3\.12\.\d+$/);
    const runtime = RUNTIME_CONSTRAINTS.trim().split('\n');
    expect(runtime.length).toBeGreaterThan(10);
    for (const line of runtime) expect(line).toMatch(/^[a-z0-9-]+==[0-9][0-9a-z.]*( ; .+)?$/);
    for (const name of ['requests', 'loguru', 'pyyaml', 'yt-dlp', 'yt-dlp-ejs', 'urllib3', 'certifi']) {
      expect(runtime.some((l) => l.startsWith(`${name}==`)), name).toBe(true);
    }
    const build = BUILD_CONSTRAINTS.trim().split('\n');
    const pins = build.filter((l) => !l.startsWith(' '));
    expect(pins.some((l) => l.startsWith('hatchling=='))).toBe(true);
    for (const line of pins) expect(line).toMatch(/^[a-z0-9-]+==[0-9][0-9a-z.]* \\$/);
    for (const line of build.filter((l) => l.startsWith(' '))) expect(line).toMatch(/^ {4}--hash=sha256:[0-9a-f]{64}( \\)?$/);
  });

  it('the card says what is verified and what is only pinned', () => {
    expect(INSTALL_REASON).toContain('The add-on and its installer are verified; its dependencies are pinned to exact versions.');
    expect(`${INSTALL_SUMMARY} ${INSTALL_REASON}`).not.toMatch(/checksum|everything|all of it/i);
  });

  it('pins every platform to a GitHub release asset with a sha256', () => {
    expect(Object.keys(PINS.uv).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']);
    for (const pin of [...Object.values(PINS.uv), PINS.reach]) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(allowedDownloadUrl(pin.url).hostname).toBe('github.com');
      expect(pin.url).not.toContain('/latest/');
    }
  });

  it('follows downloads only to GitHub hosts over https', () => {
    expect(() => allowedDownloadUrl('https://release-assets.githubusercontent.com/x')).not.toThrow();
    expect(() => allowedDownloadUrl('https://objects.githubusercontent.com/x')).not.toThrow();
    for (const bad of ['http://github.com/x', 'https://github.com.evil.io/x', 'https://pypi.org/agent-reach', 'https://u:p@github.com/x', 'https://github.com:8443/x']) {
      expect(() => allowedDownloadUrl(bad)).toThrow();
    }
  });
});

describe('reach_read', () => {
  it('takes http(s) addresses only', async () => {
    const t = setup();
    for (const url of ['file:///C:/Users/x/secret.txt', 'javascript:alert(1)', '--backend=x', 'github.com/a/b', '', 'https://u:p@github.com/a']) {
      expect((await t.reach.read({ url })).text).toMatch(/^\(error:BAD_INPUT\)/);
    }
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it.each([
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.5/secrets',
    'http://172.20.1.1/',
    'http://192.168.1.1/cgi-bin/config',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0:9222/json',
    'http://[fe80::1]/',
    'http://[fd12:3456::1]/',
    'http://intranet/wiki',
    'https://printer.local/',
    'https://build.corp.internal/',
    'https://nas.lan/',
    'http://93.184.216.34/',
    'https://example.com/article',
    'https://raw.githubusercontent.com/a/b/main/x',
    'https://github.com.evil.example/a/b',
    'https://evilgithub.com/a/b',
    'https://notyoutu.be/x',
  ])('refuses %s: not one of the sites it reads, and nothing is looked up or run', async (url) => {
    const t = setup();
    const r = await t.reach.read({ url });
    expect(r.text).toMatch(/^\(error:NOT_A_REACH_SITE\) /);
    expect(r.text).toContain('Use cdp_read_text / http_request for other pages');
    expect(t.resolved).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
    // The second layer refuses the same host on its own.
    const host = new URL(url).hostname;
    if (!/example|githubusercontent|evilgithub|notyoutu|^93\./.test(host)) {
      expect(await privateHostReason(host, async () => ['93.184.216.34'])).not.toBeNull();
    }
  });

  it.each([
    'https://rebind.github.com/a/b',
    'https://nowhere.github.com/a/b',
  ])('refuses %s: one of its sites by name, but not at a public address', async (url) => {
    const t = setup();
    const r = await t.reach.read({ url });
    expect(r.text).toMatch(/^\(error:REACH_PRIVATE_ADDRESS\) reach_read reads public websites only/);
    expect(r.text).toContain('http_request');
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('reads the sites Agent Reach has a channel for, after looking the name up', async () => {
    const t = setup();
    for (const url of ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://github.com/astral-sh/uv', 'https://gist.github.com/a/1', 'https://old.reddit.com/r/vim/', 'https://X.com/a/status/1', 'https://b23.tv/abc']) {
      expect((await t.reach.read({ url })).text).toContain('body');
    }
    expect(t.resolved).toEqual(['www.youtube.com', 'github.com', 'gist.github.com', 'old.reddit.com', 'x.com', 'b23.tv']);
    // The catch-all `web` channel is never the one that answers: every listed host belongs to a named channel.
    expect(REACH_HOSTS).not.toContain('web');
    for (const host of ['youtube.com', 'm.youtube.com', 'youtu.be', 'github.com', 'reddit.com', 'redd.it', 'twitter.com', 'www.linkedin.com', 'instagram.com', 'facebook.com', 'www.bilibili.com', 'v2ex.com', 'www.xiaohongshu.com', 'xueqiu.com', 'www.xiaoyuzhoufm.com', 'GitHub.com.']) {
      expect(isReachHost(host), host).toBe(true);
    }
  });

  it('judges addresses: private ranges, IPv4 written as IPv6, and what is not an address', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'febf::1', 'fc00::1', 'fdff::1', '::ffff:10.0.0.1', '::ffff:a00:1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.167.1.1', '169.253.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(await privateHostReason('GitHub.com.', async () => ['140.82.112.3'])).toBeNull();
  });

  it.each([
    // IPv4: one address inside each special-purpose range, and its first and last where that matters
    ['0.0.0.0', '0/8'], ['0.255.255.255', '0/8'],
    ['10.0.0.0', '10/8'], ['10.255.255.255', '10/8'],
    ['100.64.0.1', '100.64/10'], ['100.127.255.255', '100.64/10'],
    ['127.0.0.1', '127/8'], ['127.255.255.254', '127/8'],
    ['169.254.169.254', '169.254/16'],
    ['172.16.0.0', '172.16/12'], ['172.31.255.255', '172.16/12'],
    ['192.0.0.1', '192.0.0/24'],
    ['192.0.2.1', '192.0.2/24'],
    ['192.88.99.1', '192.88.99/24'],
    ['192.168.0.1', '192.168/16'], ['192.168.255.255', '192.168/16'],
    ['198.18.0.1', '198.18/15'], ['198.19.255.255', '198.18/15'],
    ['198.51.100.7', '198.51.100/24'],
    ['203.0.113.7', '203.0.113/24'],
    ['224.0.0.1', '224/4'], ['239.255.255.255', '224/4'],
    ['240.0.0.1', '240/4'], ['255.255.255.255', 'broadcast'],
    // IPv6
    ['::', '::/128'], ['::1', 'loopback'], ['0:0:0:0:0:0:0:1', 'loopback, written out'],
    ['fe80::1', 'fe80::/10'], ['febf:ffff::1', 'fe80::/10'], ['fe80::1%eth0', 'fe80::/10 with a zone'],
    ['fc00::1', 'fc00::/7'], ['fdff:ffff::1', 'fc00::/7'],
    ['ff02::1', 'ff00::/8'], ['ff0e::1', 'ff00::/8'],
    ['2001:db8::1', '2001:db8::/32'],
    ['100::1', '100::/64'], ['100:0:0:1::1', 'outside 2000::/3'], ['fec0::1', 'outside 2000::/3'], ['fbff::1', 'outside 2000::/3'],
    ['fd00::1', 'fc00::/7'], ['::2', '::/8'], ['0:1::1', '::/8'], ['0:0:0:0:1::', '::/8'], ['::1:0:0:1', '::/8'], ['1::1', 'outside 2000::/3'],
    ['4000::1', 'outside 2000::/3'], ['e000::1', 'outside 2000::/3'], ['::127.0.0.1', 'IPv4-compatible is not unwrapped: ::/8'], ['::8.8.8.8', '::/8'],
    ['::ffff:0:127.0.0.1', 'IPv4-translated'], ['::ffff:0:a00:1', 'IPv4-translated, hex'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'], ['64:ff9b:1::a00:1', 'local NAT64'], ['64:ff9b:1:a00:1::', 'local NAT64, RFC 6052 layout of 10.0.0.1'],
    ['64:ff9b:2::808:808', 'outside 2000::/3'], ['64::1', 'outside 2000::/3'],
    // an IPv4 address inside an IPv6 one
    ['::ffff:127.0.0.1', 'IPv4-mapped'], ['::ffff:a00:1', 'IPv4-mapped, hex'], ['0:0:0:0:0:ffff:c0a8:101', 'IPv4-mapped, written out'],
    ['::10.0.0.1', 'IPv4-compatible'], ['::a9fe:a9fe', 'IPv4-compatible, hex'],
    ['64:ff9b::192.168.1.1', 'NAT64'], ['64:ff9b::a9fe:a9fe', 'NAT64, hex'],
    ['2002:c0a8:101::1', '6to4 of 192.168.1.1'], ['2002:7f00:1::', '6to4 of 127.0.0.1'],
    ['2001:0:4136:e378:8000:63bf:f5ff:fffe', 'Teredo of 10.0.0.1'], ['2001::ffff:ffff:3f57:fefe', 'Teredo of 192.168.1.1'],
    ['not-an-ip', 'not an address'], ['1.2.3', 'not an address'], ['', 'empty'],
  ])('%s is not public (%s)', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.0.1.1', '192.0.3.1', '192.88.98.1', '192.167.255.255',
    '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.1', '203.0.112.1', '203.0.114.1', '223.255.255.255', '140.82.112.3',
    '2606:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '2001:db9::1', '2a00:1450::1', '3fff:ffff::1', '::ffff:0:8.8.8.8',
    '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1', '2001:0:4136:e378:8000:63bf:f7f7:f7f7',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('a name passes only when every address it resolves to is public', async () => {
    expect(await privateHostReason('github.com', async () => ['140.82.112.3', '64:ff9b::a00:1'])).not.toBeNull();
    expect(await privateHostReason('github.com', async () => ['140.82.112.3', '100.64.0.9'])).not.toBeNull();
    expect(await privateHostReason('github.com', async () => ['140.82.112.3', '2606:50c0:8000::154'])).toBeNull();
    expect(await privateHostReason('github.com', async () => [])).not.toBeNull();
  });

  it('reads a YouTube link as its transcript, and falls back to the page when there is none', async () => {
    const t = setup({}, (args) => (args[1] === 'subtitle'
      ? out({ ok: false, error: { code: 'NOT_FOUND', message: 'no subtitles in en for this video', hint: 'Check the link or id.' } }, 1)
      : undefined));
    const r = await t.reach.read({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
    const runs = t.calls.filter((c) => c.file === t.reachExe).map((c) => c.args).slice(-2);
    expect(runs[0]).toEqual(['youtube', 'subtitle', '--lang', 'en,en-orig', '--timeout', '25', '--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
    expect(runs[1]).toEqual(['read', '--timeout', '25', '--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
    expect(r.text).toContain('body');
    expect(r.text).toContain('No transcript');
    expect(t.calls.at(-1)!.timeoutMs).toBe(30_000);
  });

  it('is not available on Linux, and asks nothing there', async () => {
    const t = setup({ platform: 'linux' });
    expect((await t.reach.read({ url: 'https://github.com/a/b' })).text).toBe(LINUX_TEXT);
    expect((await t.reach.search({ site: 'youtube', query: 'x' })).text).toBe(LINUX_TEXT);
    expect(t.asked).toEqual([]);
  });
});

describe('reach_search', () => {
  it('passes a query that starts with "-" after "--", as one argument', async () => {
    const t = setup();
    await t.reach.search({ site: 'YouTube', query: '--backend=evil -rf "x" & calc' });
    expect(t.calls.at(-1)!.args).toEqual(['youtube', 'search', '--timeout', '25', '--', '--backend=evil -rf "x" & calc']);
  });

  it('searches only a site that is turned on and can search, from one cached listing', async () => {
    const t = setup();
    expect((await t.reach.search({ site: 'reddit', query: 'cats' })).text).toMatch(/^\(error:REACH_SITE_NOT_ENABLED\).*It can search: youtube\..*reach_add_login/);
    expect((await t.reach.search({ site: 'v2ex', query: 'cats' })).text).toMatch(/^\(error:REACH_SITE_NOT_ENABLED\)/);
    expect((await t.reach.search({ site: '--help', query: 'cats' })).text).toMatch(/^\(error:BAD_INPUT\)/);
    expect((await t.reach.search({ site: 'youtube', query: '' })).text).toMatch(/^\(error:BAD_INPUT\)/);
    await t.reach.search({ site: 'youtube', query: 'cats' });
    expect(t.calls.filter((c) => c.args[0] === 'channels')).toHaveLength(1);
    expect(t.calls.filter((c) => c.args[1] === 'search')).toHaveLength(1);
  });
});

describe('reach_add_login', () => {
  it('is refused unless the user\'s own message names the site and asks for it', async () => {
    const t = setup();
    t.state.message = 'what is the weather in Cairo?';
    const r = await t.reach.addLogin({ site: 'reddit' });
    expect(r.text).toMatch(/^\(error:REACH_LOGIN_NOT_ASKED\)/);
    expect(t.asked).toEqual([]);
    expect(t.calls).toEqual([]);
    // Naming another site does not turn this one on.
    t.state.message = 'read my LinkedIn messages';
    expect((await t.reach.addLogin({ site: 'reddit' })).text).toMatch(/^\(error:REACH_LOGIN_NOT_ASKED\)/);
    expect((await t.reach.addLogin({ site: 'youtube' })).text).toMatch(/^\(error:BAD_INPUT\)/);
    expect(t.calls).toEqual([]);
  });

  it('adds the site the user asked for, then lists the sites again', async () => {
    const t = setup({}, (args) => (args[0] === 'add' ? out({ ok: true, action: 'add', result: { channel: 'reddit', added: true } }) : undefined));
    t.state.message = 'Search Reddit for the best mechanical keyboard';
    await t.reach.search({ site: 'youtube', query: 'x' });
    const r = await t.reach.addLogin({ site: 'Reddit' });
    expect(r.text).toMatch(/^Reddit is turned on/);
    const add = t.calls.find((c) => c.args[0] === 'add')!;
    expect(add.args).toEqual(['add', 'reddit']);
    expect(add.timeoutMs).toBe(600_000);
    await t.reach.search({ site: 'youtube', query: 'x' });
    expect(t.calls.filter((c) => c.args[0] === 'channels')).toHaveLength(2);
  });

  it('knows when the message asks for a site', () => {
    expect(loginAsked('reddit', 'search reddit for vim tips')).toBe(true);
    expect(loginAsked('reddit', 'log in to Reddit')).toBe(true);
    expect(loginAsked('reddit', 'Reddit')).toBe(false);
    expect(loginAsked('reddit', 'I already read it')).toBe(false);
    expect(loginAsked('twitter', 'what is trending on X today?')).toBe(true);
    expect(loginAsked('twitter', 'read my twitter feed')).toBe(true);
    expect(loginAsked('twitter', 'check x.com for news')).toBe(true);
    expect(loginAsked('twitter', 'open the box and read the text')).toBe(false);
    expect(loginAsked('youtube', 'read youtube')).toBe(false);
    expect(siteName(' X ')).toBe('twitter');
    expect(siteName('https://www.reddit.com/')).toBe('reddit');
  });

  it('asks with the warning card every time it will run, and shows no card when it will only refuse', () => {
    expect(loginCard('reddit')).toEqual({
      summary: 'Copy your Reddit login from Chrome into a separate hidden browser',
      reason: "Automated reading may break Reddit's rules and could put the account at risk. A second account is safer.",
    });
    expect(loginRisk({ site: 'reddit' }, 'use reddit to find reviews')).toEqual({ class: 'destructive_web', reason: loginCard('reddit')!.reason });
    expect(loginRisk({ site: 'reddit' }, 'find reviews')).toBeNull();
    expect(loginRisk({ site: 'github' }, 'read github')).toBeNull();
  });
});

describe('results', () => {
  it('turns {ok:false, error:{code, message, hint}} into an error the model can act on', async () => {
    const t = setup({}, (args) => (args[0] === 'read'
      ? out({ ok: false, items: [], error: { code: 'NEED_LOGIN', message: 'reddit wants a login', hint: 'Offer site-scoped local reuse; never ask for a password.' } }, 1)
      : undefined));
    const r = await t.reach.read({ url: 'https://www.reddit.com/r/vim/comments/1' });
    expect(r.text).toMatch(/^\(error:REACH_NEED_LOGIN\) reddit wants a login\. Offer site-scoped local reuse; never ask for a password\./);
    expect(r.text).toContain('reach_add_login');
  });

  it('reads the JSON object on the last line, and says so when there is none', () => {
    expect(parseReachJson('warning: something\n{"ok":true,"items":[]}\n')).toEqual({ ok: true, items: [] });
    expect(parseReachJson('Traceback (most recent call last)')).toBeNull();
    const dead: ExecResult = { code: 1, stdout: '', stderr: 'Traceback: boom', timedOut: false };
    expect(reachError(null, dead)).toBe('(error:REACH_FAILED) The reading add-on gave no answer: Traceback: boom.');
    expect(reachError(null, { ...dead, timedOut: true })).toMatch(/^\(error:REACH_TIMEOUT\)/);
    expect(reachError({ ok: false, error: { code: 'x"; rm -rf', message: 'm', hint: 'h' } }, dead)).toMatch(/^\(error:REACH_xrmrf\) m\. h/);
  });

  it('gives the text of each item and leaves raw out', () => {
    const text = formatItems({ ok: true, items: [
      { title: 'A', url: 'https://a', author: 'me', published_at: '2026-01-01', text: 'first', raw: { secret: 1 } },
      { title: 'B', url: 'https://b', text: 'x'.repeat(9000) },
    ] });
    expect(text).toContain('1. A | https://a | me | 2026-01-01\nfirst');
    expect(text).not.toContain('secret');
    expect(text.length).toBeLessThan(6000);
    expect(formatItems({ ok: true, items: [] })).toBe('No results.');
  });
});
