/**
 * Vendor the clawdcursor npm package + its guide JSONs into ./vendor/clawdcursor.
 *
 * macOS v1: ClawdCursor doesn't have a macOS build yet (it's the Tier-5
 * UI-automation fallback, currently Windows-only). We still need to ship
 * the guides/*.json files because brain.ts reads them at runtime to inject
 * app-specific workflows into the model's screen-context block — they're
 * a pure JSON catalog, not platform-specific code.
 *
 * Strategy:
 *   1. Try to find a local clawdcursor install:
 *        - npm global (npm root -g)/clawdcursor
 *        - ~/clawdcursor (workspace clone, common dev layout)
 *      If found: copy guides + the runtime bits to vendor/clawdcursor.
 *   2. If not found: fall back to fetching ONLY the guides JSON archive
 *      from the AmrDab/clawdcursor-guides public repo. This keeps the
 *      guide-injection feature functional on macOS without forcing every
 *      dev to install clawdcursor locally.
 *   3. If neither path works: log a warning and exit 0 — the build can
 *      still succeed; the model just won't get app-specific guides until
 *      ClawdCursor ships a Mac binary.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'vendor', 'clawdcursor');
const GUIDES_DEST = path.join(DEST, 'guides');

const SKIP_FILES = new Set(['CHANGELOG.md', 'README.md', 'readme.md', 'SKILL.md', 'LICENSE', 'eslint.config.js']);
const SKIP_EXTENSIONS = new Set(['.map', '.d.ts', '.md']);
const SKIP_DIRS = new Set(['__tests__', 'test', 'tests', 'docs', 'doc', '.github', '.vscode']);

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function cleanDest() {
  if (fs.existsSync(DEST)) fs.rmSync(DEST, { recursive: true, force: true });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return { files: 0, bytes: 0 };
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(src))) return { files: 0, bytes: 0 };
    ensureDir(dest);
    let agg = { files: 0, bytes: 0 };
    for (const entry of fs.readdirSync(src)) {
      const r = copyRecursive(path.join(src, entry), path.join(dest, entry));
      agg.files += r.files; agg.bytes += r.bytes;
    }
    return agg;
  }
  const fileName = path.basename(src);
  const ext = path.extname(fileName);
  if (SKIP_FILES.has(fileName) || SKIP_EXTENSIONS.has(ext)) return { files: 0, bytes: 0 };
  fs.copyFileSync(src, dest);
  return { files: 1, bytes: stat.size };
}

function findLocalClawdcursor() {
  try {
    const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const candidate = path.join(npmRoot, 'clawdcursor');
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* npm not in PATH or no global root */ }
  // Common dev layout: a clone next to this repo
  const sibling = path.resolve(ROOT, '..', 'clawdcursor');
  if (fs.existsSync(sibling)) return sibling;
  return null;
}

function tryLocalCopy() {
  const src = findLocalClawdcursor();
  if (!src) return false;
  console.log(`Found local clawdcursor at: ${src}`);
  cleanDest();
  const r = copyRecursive(src, DEST);
  console.log(`✓ Copied ${r.files} files (${(r.bytes / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}

function download(url, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error(`Too many redirects: ${url}`));
        res.resume();
        return resolve(download(res.headers.location, destPath, maxRedirects - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      const stream = fs.createWriteStream(destPath);
      res.pipe(stream);
      stream.on('finish', () => stream.close(resolve));
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function fetchGuidesOnly() {
  // AmrDab/clawdcursor-guides is a public companion repo with just the
  // app-knowledge JSONs (Outlook, Excel, Slack, etc.). Cheaper than cloning
  // the full clawdcursor repo for what amounts to ~50KB of JSON.
  const TARBALL = 'https://github.com/AmrDab/clawdcursor-guides/archive/refs/heads/main.tar.gz';
  ensureDir(GUIDES_DEST);
  const tmpDir = path.join(ROOT, 'vendor', '_clawd_tmp');
  ensureDir(tmpDir);
  const tarPath = path.join(tmpDir, 'guides.tar.gz');
  console.log('Fetching guides bundle from clawdcursor-guides…');
  await download(TARBALL, tarPath);
  execSync(`tar -xzf "${tarPath}" -C "${tmpDir}"`, { stdio: 'inherit' });
  const extractedRoot = path.join(tmpDir, 'clawdcursor-guides-main');
  // The guides repo's layout: each app guide is in a subfolder with a JSON
  // file. We flatten all *.json files into vendor/clawdcursor/guides/.
  function flattenJson(dir) {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        n += flattenJson(p);
      } else if (entry.endsWith('.json')) {
        fs.copyFileSync(p, path.join(GUIDES_DEST, entry));
        n++;
      }
    }
    return n;
  }
  const count = flattenJson(extractedRoot);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`✓ Vendored ${count} guide JSON file(s) from clawdcursor-guides`);
}

async function main() {
  console.log('=== Vendoring ClawdCursor (macOS) ===');
  if (tryLocalCopy()) return;
  console.log('No local clawdcursor install found — fetching guides-only bundle…');
  try {
    cleanDest();
    ensureDir(DEST);
    await fetchGuidesOnly();
  } catch (err) {
    console.warn(`[warn] Guides fetch failed: ${err.message}`);
    console.warn('       App-specific guide injection will be unavailable.');
    console.warn('       Build can still proceed — exiting 0.');
    ensureDir(GUIDES_DEST);
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err}`);
  process.exit(1);
});
