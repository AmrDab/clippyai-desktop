import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

// "Report a problem" said "No log file found" on a Clippy left running for days:
// the logger keeps writing to the file named after its start day, and the reader
// only looked for today's and yesterday's file.
describe('readCurrentLog', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let home = '';
  let logDir = '';

  async function loadLogger() {
    vi.resetModules();
    return import('../src/main/logger');
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-log-date-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    logDir = path.join(home, '.clippyai', 'logs');
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env.HOME = saved.HOME;
    process.env.USERPROFILE = saved.USERPROFILE;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('reads the file this run writes to after two UTC midnights', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T10:00:00Z') });
    const logger = await loadLogger();
    expect(logger.getLogDir()).toBe(logDir);
    logger.createLogger('test').info('marker-started-on-the-20th');
    logger.flushLogs();

    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    logger.createLogger('test').info('marker-written-on-the-23rd');
    const text = logger.readCurrentLog();
    expect(text).toContain('marker-started-on-the-20th');
    expect(text).toContain('marker-written-on-the-23rd');
    expect(fs.existsSync(path.join(logDir, 'clippy-2026-11-23.log'))).toBe(false);
  });

  it('falls back to the newest clippy-*.log when this run has not written yet', async () => {
    const logger = await loadLogger();
    fs.writeFileSync(path.join(logDir, 'clippy-2026-11-18.log'), 'older-run\n');
    fs.writeFileSync(path.join(logDir, 'clippy-2026-11-19.log'), 'newest-run\n');
    fs.writeFileSync(path.join(logDir, 'other.log'), 'not-a-clippy-log\n');
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(logDir, 'clippy-2026-11-18.log'), t - 3600, t - 3600);
    fs.utimesSync(path.join(logDir, 'clippy-2026-11-19.log'), t - 60, t - 60);
    fs.utimesSync(path.join(logDir, 'other.log'), t, t);
    expect(logger.readCurrentLog()).toBe('newest-run\n');
  });

  it('returns null when there is no log file', async () => {
    const logger = await loadLogger();
    expect(logger.readCurrentLog()).toBeNull();
  });
});
