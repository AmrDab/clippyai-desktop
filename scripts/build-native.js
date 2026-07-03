/**
 * build-native.js — build all macOS-native Swift helpers shipped inside
 * the ClippyAI .app bundle.
 *
 * Packages (universal macOS arm64 + x86_64):
 *   • native/screenshot-helper      — silent CGWindowList screenshot CLI.
 *   • native/clippy-mac-bridge      — unified automation CLI (AX, OCR,
 *                                     window mgmt, input, system state).
 *                                     Replaces the PowerShell dispatch
 *                                     path on darwin (v0.20.0).
 *
 * Idempotent: skips a package if its output binary exists and is newer
 * than every source file under Sources/ + Package.swift. Use `--force`
 * (or `npm run build-native -- --force`) to override.
 *
 * Bundle layout (written to <pkg>/.build/release/<name>):
 *   each helper is a universal arm64+x86_64 binary, copied verbatim
 *   into Contents/Resources/<name> by electron-builder.yml's
 *   `extraResources` block. The .app's existing codesign +
 *   notarization pipeline picks up the embedded binaries automatically;
 *   we do NOT sign or notarize them separately.
 *
 * Requires Swift toolchain (ships with Xcode Command Line Tools, which
 * are already required to sign the macOS app, so no new dep).
 *
 * Why a JS script instead of an `npm` shell one-liner?
 *   1. Idempotency check needs `fs.statSync` mtime comparison.
 *   2. Universal binary requires either `swift build --arch arm64
 *      --arch x86_64` (single-pass, works on Sonoma+) OR two passes +
 *      `lipo -create`. We try the single-pass route first, fall back
 *      to lipo if the toolchain doesn't support multi-arch flags.
 *   3. Non-darwin platforms must skip cleanly — Windows + Linux dev
 *      builds shouldn't fail just because they can't run `swift`.
 *   4. We honor SKIP_NATIVE_BUILD=1 so CI can decouple the Swift step
 *      from the JS build when caching the binary artifact.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Packages built by this script. Adding a new package = adding an entry
// here + a matching extraResources block in electron-builder.yml.
const PKGS = [
  { name: 'screenshot-helper', dir: path.join(ROOT, 'native', 'screenshot-helper') },
  { name: 'clippy-mac-bridge', dir: path.join(ROOT, 'native', 'clippy-mac-bridge') },
];

const force = process.argv.includes('--force');

function log(msg) { process.stdout.write(`[build-native] ${msg}\n`); }

function fail(msg) {
  process.stderr.write(`[build-native] ERROR: ${msg}\n`);
  process.exit(1);
}

/**
 * Walk a directory tree, collecting mtimes of every regular file.
 * Used to decide whether the binary is newer than the slowest source.
 */
function collectMtimes(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectMtimes(full));
    else if (e.isFile()) out.push(fs.statSync(full).mtimeMs);
  }
  return out;
}

function isUpToDate(pkg) {
  const releaseBin = path.join(pkg.dir, '.build', 'release', pkg.name);
  const srcDir = path.join(pkg.dir, 'Sources');
  const packageSwift = path.join(pkg.dir, 'Package.swift');
  if (!fs.existsSync(releaseBin)) return false;
  if (!fs.existsSync(packageSwift)) return false;
  const binMtime = fs.statSync(releaseBin).mtimeMs;
  const sourceMtimes = [
    ...collectMtimes(srcDir),
    fs.statSync(packageSwift).mtimeMs,
  ];
  const newestSrc = Math.max(...sourceMtimes);
  return binMtime > newestSrc;
}

function runSwift(args, pkg) {
  log(`(${pkg.name}) swift ${args.join(' ')}`);
  const res = spawnSync('swift', args, {
    cwd: pkg.dir,
    stdio: 'inherit',
    env: process.env,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      fail('`swift` not on PATH. Install Xcode Command Line Tools: xcode-select --install');
    }
    fail(`swift failed: ${res.error.message}`);
  }
  if (res.status !== 0) fail(`swift exited with code ${res.status}`);
}

function tryMultiArchBuild(pkg) {
  // Swift 5.9+ supports a single multi-arch build invocation that
  // emits a fat binary directly. Faster than two passes + lipo when
  // the toolchain supports it.
  log(`(${pkg.name}) attempting universal build (arm64 + x86_64) in one pass`);
  const res = spawnSync('swift', [
    'build',
    '-c', 'release',
    '--arch', 'arm64',
    '--arch', 'x86_64',
  ], { cwd: pkg.dir, stdio: 'pipe', env: process.env });
  if (res.status === 0) {
    log(`(${pkg.name}) universal build OK`);
    return true;
  }
  // If it failed with "unknown argument" or similar, fall back to lipo.
  const stderr = (res.stderr || '').toString();
  if (stderr) process.stderr.write(stderr);
  log(`(${pkg.name}) single-pass universal build failed; will try arm64-only + lipo fallback`);
  return false;
}

function lipoFallback(pkg) {
  // Build arm64 + x86_64 separately, then lipo them together.
  const buildDir = path.join(pkg.dir, '.build');
  const releaseBin = path.join(buildDir, 'release', pkg.name);

  log(`(${pkg.name}) arch-by-arch build with lipo merge`);
  runSwift(['build', '-c', 'release', '--arch', 'arm64'], pkg);
  const arm64Path = path.join(buildDir, 'arm64-apple-macosx', 'release', pkg.name);
  if (!fs.existsSync(arm64Path)) fail(`expected arm64 binary at ${arm64Path}`);

  // x86_64 build often fails on Apple Silicon Macs without an x86_64
  // SDK installed (Xcode normally provides one but newer CLT bundles
  // may strip it). Treat x86_64 failure as a soft warning — we still
  // ship the arm64 binary; Intel Macs will fall back to the legacy
  // codepath. Better than blocking the entire build.
  log(`(${pkg.name}) building x86_64 (may fail on toolchains without x86_64 SDK)`);
  const x64Res = spawnSync('swift', [
    'build', '-c', 'release', '--arch', 'x86_64',
  ], { cwd: pkg.dir, stdio: 'pipe', env: process.env });

  if (x64Res.status !== 0) {
    const stderr = (x64Res.stderr || '').toString();
    process.stderr.write(stderr);
    log(`(${pkg.name}) x86_64 build failed; shipping arm64-only binary (Intel Macs use fallback codepath)`);
    fs.mkdirSync(path.dirname(releaseBin), { recursive: true });
    fs.copyFileSync(arm64Path, releaseBin);
    return;
  }

  const x64Path = path.join(buildDir, 'x86_64-apple-macosx', 'release', pkg.name);
  if (!fs.existsSync(x64Path)) fail(`expected x86_64 binary at ${x64Path}`);

  fs.mkdirSync(path.dirname(releaseBin), { recursive: true });
  execFileSync('lipo', [
    '-create', arm64Path, x64Path,
    '-output', releaseBin,
  ], { stdio: 'inherit' });
  log(`(${pkg.name}) lipo merge OK`);
}

function verify(pkg) {
  const releaseBin = path.join(pkg.dir, '.build', 'release', pkg.name);
  if (!fs.existsSync(releaseBin)) fail(`(${pkg.name}) build did not produce ${releaseBin}`);
  const lipo = execFileSync('lipo', ['-info', releaseBin], { encoding: 'utf8' }).trim();
  const size = fs.statSync(releaseBin).size;
  log(`(${pkg.name}) ${lipo} — ${(size / 1024).toFixed(0)} KiB`);
}

function buildPackage(pkg) {
  if (!fs.existsSync(pkg.dir)) {
    log(`(${pkg.name}) skip: package dir ${pkg.dir} does not exist`);
    return;
  }

  if (!force && isUpToDate(pkg)) {
    const releaseBin = path.join(pkg.dir, '.build', 'release', pkg.name);
    log(`(${pkg.name}) up to date: ${releaseBin} is newer than every source file (use --force to rebuild)`);
    return;
  }

  // Try the modern single-pass universal build. If Swift doesn't
  // support multi-arch in this toolchain, fall back to two builds
  // + lipo. If x86_64 SDK is missing entirely, arm64-only ships.
  if (!tryMultiArchBuild(pkg)) {
    lipoFallback(pkg);
  } else {
    // Single-pass universal build outputs under a custom triple dir
    // (e.g. apple/Products/Release/<name>), but the release symlink
    // at .build/release should also point at it. If it's missing,
    // copy from the universal triple.
    const releaseBin = path.join(pkg.dir, '.build', 'release', pkg.name);
    if (!fs.existsSync(releaseBin)) {
      const candidates = [
        path.join(pkg.dir, '.build', 'apple', 'Products', 'Release', pkg.name),
        path.join(pkg.dir, '.build', 'release', pkg.name),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) fail(`(${pkg.name}) universal binary not found at any of: ${candidates.join(', ')}`);
      fs.mkdirSync(path.dirname(releaseBin), { recursive: true });
      fs.copyFileSync(found, releaseBin);
    }
  }

  verify(pkg);
}

function main() {
  if (process.platform !== 'darwin') {
    log(`skip: not macOS (platform=${process.platform}); native helpers are mac-only`);
    return;
  }

  if (process.env.SKIP_NATIVE_BUILD === '1') {
    log('skip: SKIP_NATIVE_BUILD=1 set in env');
    return;
  }

  for (const pkg of PKGS) {
    buildPackage(pkg);
  }
}

main();
