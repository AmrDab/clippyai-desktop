/**
 * vendor-whisper.js — download whisper.cpp Windows binaries (win32) or
 * build whisper.cpp from source as a universal arm64+x86_64 binary
 * (darwin), plus the quantized base.en model, into ./vendor/whisper/ so
 * electron-builder can bundle them into the installer / DMG.
 *
 * macOS needs Xcode Command Line Tools and cmake on PATH: whisper.cpp's
 * release archives only ship Windows binaries.
 *
 * Runs as part of `npm run vendor`. Idempotent: skips downloads when
 * the destination files already exist. Run with `--force` to redownload.
 *
 * Bundle layout (written to vendor/whisper/):
 *   bin/whisper-cli.exe   — the CLI we spawn from src/main/stt.ts
 *   bin/whisper.dll
 *   bin/ggml.dll          — whisper.cpp's GGML runtime dependencies
 *   bin/ggml-base.dll
 *   bin/ggml-cpu.dll
 *   models/ggml-base.en-q5_1.bin  — 5-bit quantized base.en model, ~57 MB
 *
 * Total bundle weight ≈ 60 MB. Versioned here so a future bump (e.g. to
 * a newer whisper.cpp release with better Windows perf) is a one-line
 * change. Pinned versions, not latest-tag, so the build is reproducible.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// Pinned versions — bump intentionally to upgrade.
const WHISPER_VERSION = 'v1.8.4';
const WHISPER_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`;
const WHISPER_REPO = 'https://github.com/ggml-org/whisper.cpp.git';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin?download=true';

const VENDOR_DIR = path.resolve(__dirname, '..', 'vendor', 'whisper');
const BIN_DIR = path.join(VENDOR_DIR, 'bin');
const SRC_DIR = path.join(VENDOR_DIR, '_src');
const MAC_DIR = path.join(VENDOR_DIR, 'macos');
const MODELS_DIR = path.join(VENDOR_DIR, 'models');
const MODEL_PATH = path.join(MODELS_DIR, 'ggml-base.en-q5_1.bin');
// Only these five binaries from the whisper.cpp release are needed at
// runtime — every other file in the zip is for CLIs we don't ship
// (stream, server, talk-llama, etc) and would bloat the installer.
const KEEP_FILES = new Set([
  'whisper-cli.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cpu.dll',
]);

const force = process.argv.includes('--force');

function log(msg) { process.stdout.write(`[vendor-whisper] ${msg}\n`); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** Stream a URL to a file, following redirects. Falls back to throw on
 *  any non-2xx after redirects are exhausted. */
function download(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error(`Too many redirects for ${url}`));
        res.resume();
        return resolve(download(res.headers.location, destPath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function fetchWhisperBinaries() {
  if (!force && fs.existsSync(path.join(BIN_DIR, 'whisper-cli.exe'))) {
    log('whisper-cli.exe already present, skipping (use --force to redownload)');
    return;
  }
  ensureDir(BIN_DIR);
  const zipPath = path.join(VENDOR_DIR, '_whisper.zip');
  log(`downloading whisper.cpp ${WHISPER_VERSION} from ${WHISPER_URL}`);
  await download(WHISPER_URL, zipPath);
  log(`extracting via PowerShell Expand-Archive`);
  // Use PowerShell on Windows — node has no built-in zip extractor.
  // Forward slashes confuse PS, use double-backslash. Suppress stderr
  // so the script log stays readable.
  const psSrc = zipPath.replace(/\\/g, '\\\\');
  const psDst = path.join(VENDOR_DIR, '_unpack').replace(/\\/g, '\\\\');
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${psSrc}' -DestinationPath '${psDst}' -Force"`, { stdio: 'inherit' });

  // The release zip nests everything under a Release/ directory.
  const unpackedRoot = fs.existsSync(path.join(VENDOR_DIR, '_unpack', 'Release'))
    ? path.join(VENDOR_DIR, '_unpack', 'Release')
    : path.join(VENDOR_DIR, '_unpack');

  // Copy only the files we keep; everything else is discarded.
  for (const file of fs.readdirSync(unpackedRoot)) {
    if (!KEEP_FILES.has(file)) continue;
    fs.copyFileSync(path.join(unpackedRoot, file), path.join(BIN_DIR, file));
    log(`  keep: ${file}`);
  }

  // Cleanup
  fs.rmSync(path.join(VENDOR_DIR, '_unpack'), { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
}

function buildWhisperMac() {
  if (!force && fs.existsSync(path.join(MAC_DIR, 'whisper-cli'))) {
    log('whisper-cli already present, skipping (use --force to rebuild)');
    return;
  }
  ensureDir(VENDOR_DIR);

  if (!fs.existsSync(SRC_DIR)) {
    log(`cloning whisper.cpp ${WHISPER_VERSION}…`);
    execSync(`git clone --depth=1 --branch=${WHISPER_VERSION} ${WHISPER_REPO} "${SRC_DIR}"`, { stdio: 'inherit' });
  }

  const buildDir = path.join(SRC_DIR, 'build');
  ensureDir(buildDir);

  // Build a universal (arm64+x86_64) release with Metal backend.
  // -DWHISPER_BUILD_TESTS=OFF / -DWHISPER_BUILD_EXAMPLES=ON ensures the
  // `whisper-cli` example binary is produced.
  log('configuring cmake (universal arm64+x86_64, Metal backend)');
  execSync([
    'cmake', '-S', SRC_DIR, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
  ].join(' '), { stdio: 'inherit' });

  log('compiling…');
  execSync(`cmake --build "${buildDir}" --config Release -j`, { stdio: 'inherit' });

  ensureDir(MAC_DIR);
  // The whisper-cli example lands at build/bin/whisper-cli (or
  // build/bin/Release/whisper-cli depending on generator).
  const candidates = [
    path.join(buildDir, 'bin', 'whisper-cli'),
    path.join(buildDir, 'bin', 'Release', 'whisper-cli'),
  ];
  const cli = candidates.find((p) => fs.existsSync(p));
  if (!cli) throw new Error(`whisper-cli not found in build output; checked: ${candidates.join(', ')}`);
  fs.copyFileSync(cli, path.join(MAC_DIR, 'whisper-cli'));
  fs.chmodSync(path.join(MAC_DIR, 'whisper-cli'), 0o755);
  log(`copied whisper-cli → ${MAC_DIR}`);

  // Strip debug symbols to shrink the bundle and let codesign succeed
  // without complaining about unsigned dwarf segments.
  try { execSync(`strip -x "${path.join(MAC_DIR, 'whisper-cli')}"`, { stdio: 'inherit' }); }
  catch (e) { log(`strip failed (non-fatal): ${e.message}`); }
}

async function fetchModel() {
  if (!force && fs.existsSync(MODEL_PATH)) {
    const sizeMb = (fs.statSync(MODEL_PATH).size / 1048576).toFixed(1);
    log(`model already present (${sizeMb} MB), skipping (use --force to redownload)`);
    return;
  }
  ensureDir(MODELS_DIR);
  log(`downloading ggml-base.en-q5_1 (~57 MB) from HuggingFace`);
  await download(MODEL_URL, MODEL_PATH);
  const sizeMb = (fs.statSync(MODEL_PATH).size / 1048576).toFixed(1);
  log(`model written: ${sizeMb} MB`);
}

async function main() {
  log(`starting vendor (${process.platform})`);
  if (process.platform === 'darwin') buildWhisperMac();
  else await fetchWhisperBinaries();
  await fetchModel();
  log('done');
}

main().catch((err) => {
  console.error('[vendor-whisper] FAILED:', err);
  process.exit(1);
});
