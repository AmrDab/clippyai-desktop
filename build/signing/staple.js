/**
 * Shared by notarize.js (.app) and notarize-dmg.js (.dmg).
 *
 * `xcrun stapler` downloads the notarization ticket from Apple's CloudKit
 * (api.apple-cloudkit.com). Right after acceptance, or when the connection
 * drops ("The network connection was lost", NSURLErrorDomain -1005), it exits
 * 68 and succeeds a little later. @electron/notarize retries only for a few
 * seconds, which was not enough on the build Mac, so retry here for up to
 * about a minute and a half.
 */

const { execFile } = require('child_process');
const path = require('path');

function stapler(action, target) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/xcrun', ['stapler', action, target], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = `${stdout || ''}${stderr || ''}`.trim().split('\n').slice(-2).join(' ').slice(0, 300);
        reject(new Error(`stapler ${action} exit ${err.code ?? err.signal}: ${tail}`));
      } else resolve();
    });
  });
}

/** Staple + validate `target` (a .app or .dmg), retrying transient CloudKit failures. */
async function stapleWithRetry(target, { attempts = 6, delayMs = 15_000, log = console } = {}) {
  const name = path.basename(target);
  for (let i = 1; ; i++) {
    try {
      await stapler('staple', target);
      await stapler('validate', target);
      return;
    } catch (err) {
      if (i >= attempts) throw new Error(`stapling ${name} failed after ${attempts} attempts: ${err.message}`);
      log.warn(`[staple] attempt ${i} for ${name} failed (${err.message}); retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { stapleWithRetry };
