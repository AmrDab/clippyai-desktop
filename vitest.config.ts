import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

// Tests must never write to the real ~/.clippyai (logs, installed skills):
// logger.ts and clawhub.ts build their paths from os.homedir() when they load.
// Same throwaway home as scripts/run-tests.js.
const testHome = path.join(os.tmpdir(), 'clippy-test-home');

export default defineConfig({
  test: { env: { HOME: testHome, USERPROFILE: testHome } },
});
