import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { warn, home } = vi.hoisted(() => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawhub-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { warn: vi.fn(), home };
});

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  serializeErr: (e: unknown) => e,
}));

import { listInstalledSkills } from '../src/main/clawhub';

describe('listInstalledSkills malformed-skill logging', () => {
  it('warns once per folder per session, without a stack', async () => {
    fs.mkdirSync(path.join(home, '.clippyai', 'skills', 'calendar'), { recursive: true });
    await listInstalledSkills();
    await listInstalledSkills();
    await listInstalledSkills();
    const calls = warn.mock.calls.filter((c) => c[0] === 'Skipping malformed skill');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ dir: 'calendar' });
    expect(JSON.stringify(calls[0][1])).not.toMatch(/\bat\s.+:\d+/);
  });
});
