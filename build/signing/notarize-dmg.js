/**
 * afterAllArtifactBuild hook: notarize + staple the macOS DMGs.
 *
 * notarize.js (afterSign) notarizes and staples the .app, so the app inside
 * every DMG and ZIP already passes Gatekeeper. The DMG container itself is
 * signed by electron-builder (`dmg.sign: true`); this hook submits each DMG to
 * Apple's notary service, staples the ticket, and fails the build if Apple
 * rejects it. ZIPs are left alone: the updater uses them and the stapled .app
 * inside is enough.
 *
 * Stapling rewrites the DMG, but dmg-builder already wrote its .blockmap and
 * handed the old sha512/size to the update-info writer, which writes
 * latest-mac.yml only after this hook returns. So: regenerate the blockmap
 * here, then correct the DMG entries in latest-mac.yml once it exists.
 *
 * Same credentials as notarize.js (App Store Connect API key trio, or Apple ID
 * + app-specific password + team). Skips off darwin and without credentials.
 * Never prints the credentials or the notarytool command line.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { stapleWithRetry } = require('./staple');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // err.message embeds the command line (credentials) — never surface it.
        reject(Object.assign(new Error(`${path.basename(cmd)} ${args[0]} failed (exit ${err.code ?? 'signal ' + err.signal})`), {
          stdout: String(stdout || ''), stderr: String(stderr || ''),
        }));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function credentialArgs(env = process.env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PWD && env.APPLE_TEAM_ID) {
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PWD, '--team-id', env.APPLE_TEAM_ID];
  }
  return null;
}

async function notarizeDmg(dmg, creds) {
  const name = path.basename(dmg);
  await run('/usr/bin/codesign', ['--verify', '--strict', dmg], 60_000).catch(() => {
    throw new Error(`[notarize-dmg] ${name} is not signed — is dmg.sign true and a Developer ID identity in the keychain?`);
  });
  console.log(`[notarize-dmg] submitting ${name} to Apple…`);
  const t0 = Date.now();
  let out;
  try {
    out = await run('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--wait', '--timeout', '30m', '--output-format', 'json', ...creds], 35 * 60_000);
  } catch (err) {
    throw new Error(`[notarize-dmg] notarytool submit failed for ${name}: ${(err.stderr || err.stdout || err.message).trim().slice(0, 500)}`);
  }
  let result = {};
  try { result = JSON.parse(out.stdout); } catch { /* fall through to status check */ }
  if (result.status !== 'Accepted') {
    let detail = '';
    if (result.id) {
      try {
        const log = await run('/usr/bin/xcrun', ['notarytool', 'log', result.id, ...creds], 120_000);
        detail = `\n${log.stdout.trim().slice(0, 2000)}`;
      } catch { /* the status alone still fails the build */ }
    }
    throw new Error(`[notarize-dmg] Apple did not accept ${name}: status=${result.status || 'unknown'} id=${result.id || '?'} ${result.message || ''}${detail}`);
  }
  console.log(`[notarize-dmg] ${name} accepted (id ${result.id}) in ${Math.round((Date.now() - t0) / 1000)}s`);
  await stapleWithRetry(dmg);
  console.log(`[notarize-dmg] ${name} stapled`);
}

/** Rebuild the .blockmap for the stapled DMG; returns {sha512, size} as electron-builder records them. */
async function refreshBlockmap(dmg) {
  const { appBuilderPath } = require('app-builder-bin');
  const { stdout } = await run(appBuilderPath, ['blockmap', '--input', dmg, '--output', `${dmg}.blockmap`], 300_000);
  const info = JSON.parse(stdout);
  return { sha512: info.sha512, size: info.size };
}

/** Point the DMG entries of latest-mac.yml at the stapled files. */
function patchUpdateInfo(ymlPath, fixes) {
  const yaml = require('js-yaml');
  const doc = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
  let changed = 0;
  for (const f of doc.files || []) {
    const fix = fixes.get(f.url);
    if (!fix) continue;
    f.sha512 = fix.sha512;
    f.size = fix.size;
    changed++;
  }
  // Same serializer settings electron-builder uses for update info files.
  fs.writeFileSync(ymlPath, yaml.dump(doc, { lineWidth: 8000 }));
  return changed;
}

exports.default = async function notarizeDmgs(buildResult) {
  if (process.platform !== 'darwin') return [];
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];
  const creds = credentialArgs();
  if (!creds) {
    console.warn('[notarize-dmg] no Apple credentials in env — skipping DMG notarization');
    return [];
  }

  const fixes = new Map();
  for (const dmg of dmgs) {
    await notarizeDmg(dmg, creds);
    fixes.set(path.basename(dmg), await refreshBlockmap(dmg));
  }

  // latest-mac.yml is written after this hook (PublishManager.awaitTasks), from
  // the pre-staple hashes. Correct it once the build has finished writing.
  const outDir = buildResult.outDir;
  process.once('beforeExit', () => {
    try {
      for (const yml of fs.readdirSync(outDir).filter((f) => /^latest.*-mac\.yml$|^latest-mac\.yml$/.test(f))) {
        const n = patchUpdateInfo(path.join(outDir, yml), fixes);
        console.log(`[notarize-dmg] ${yml}: updated ${n} DMG entr${n === 1 ? 'y' : 'ies'} to the stapled files`);
      }
    } catch (err) {
      console.error(`[notarize-dmg] could not update latest-mac.yml: ${err.message}`);
      process.exitCode = 1;
    }
  });
  return [];
};

exports.credentialArgs = credentialArgs;
exports.patchUpdateInfo = patchUpdateInfo;
