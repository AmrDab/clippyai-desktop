import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const hook = require('../build/signing/notarize-dmg.js');

describe('notarize-dmg (afterAllArtifactBuild)', () => {
  it('prefers the API key trio, falls back to Apple ID, else null', () => {
    expect(hook.credentialArgs({ APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I', APPLE_ID: 'a' }))
      .toEqual(['--key', '/k.p8', '--key-id', 'K', '--issuer', 'I']);
    expect(hook.credentialArgs({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PWD: 'p', APPLE_TEAM_ID: 't' }))
      .toEqual(['--apple-id', 'a', '--password', 'p', '--team-id', 't']);
    expect(hook.credentialArgs({ APPLE_API_KEY: '/k.p8' })).toBeNull();
    expect(hook.credentialArgs({})).toBeNull();
  });

  it('is a no-op without DMGs or without credentials', async () => {
    const saved = { ...process.env };
    for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PWD', 'APPLE_TEAM_ID']) delete process.env[k];
    try {
      expect(await hook.default({ artifactPaths: ['/x/ClippyAI-1.0.0-arm64.zip'], outDir: '/x' })).toEqual([]);
      expect(await hook.default({ artifactPaths: ['/x/ClippyAI-1.0.0-arm64.dmg'], outDir: '/x' })).toEqual([]);
    } finally {
      process.env = saved;
    }
  });

  it('rewrites only the DMG entries of latest-mac.yml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndmg-'));
    const yml = path.join(dir, 'latest-mac.yml');
    fs.writeFileSync(yml, [
      'version: 1.0.0',
      'files:',
      '  - url: ClippyAI-1.0.0-arm64.zip',
      '    sha512: ZIPHASH',
      '    size: 10',
      '  - url: ClippyAI-1.0.0-arm64.dmg',
      '    sha512: OLDDMG',
      '    size: 20',
      'path: ClippyAI-1.0.0-arm64.zip',
      'sha512: ZIPHASH',
      "releaseDate: '2026-11-15T00:00:00.000Z'",
      '',
    ].join('\n'));
    const n = hook.patchUpdateInfo(yml, new Map([['ClippyAI-1.0.0-arm64.dmg', { sha512: 'NEWDMG', size: 21 }]]));
    expect(n).toBe(1);
    const doc = require('js-yaml').load(fs.readFileSync(yml, 'utf8'));
    expect(doc.files[0]).toEqual({ url: 'ClippyAI-1.0.0-arm64.zip', sha512: 'ZIPHASH', size: 10 });
    expect(doc.files[1]).toEqual({ url: 'ClippyAI-1.0.0-arm64.dmg', sha512: 'NEWDMG', size: 21 });
    expect(doc.path).toBe('ClippyAI-1.0.0-arm64.zip');
    expect(doc.sha512).toBe('ZIPHASH');
  });
});
