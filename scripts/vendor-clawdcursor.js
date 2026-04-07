/**
 * Copies the clawdcursor npm package into ./vendor/clawdcursor
 * so electron-builder can bundle it into the installer.
 *
 * This runs at build time. The bundled binary is launched at runtime
 * from process.resourcesPath/clawdcursor/dist/index.js.
 *
 * Stripping rules reduce the bundle from ~148MB to ~40MB by removing
 * tests, docs, maps, and platform-irrelevant native deps.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'clawdcursor');
const DEST = path.resolve(__dirname, '..', 'vendor', 'clawdcursor');

const SKIP_FILES = new Set([
  'CHANGELOG.md',
  'README.md',
  'readme.md',
  'SKILL.md',
  'LICENSE',
  'eslint.config.js',
]);

const SKIP_EXTENSIONS = new Set([
  '.map',
  '.d.ts',
  '.md',
]);

const SKIP_DIRS = new Set([
  '__tests__',
  'test',
  'tests',
  'docs',
  'doc',
  'guides',
  '.github',
  '.vscode',
]);

let totalFiles = 0;
let skippedFiles = 0;
let totalSize = 0;

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;

  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    const dirName = path.basename(src);
    if (SKIP_DIRS.has(dirName)) {
      return;
    }

    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  // File
  const fileName = path.basename(src);
  const ext = path.extname(fileName);

  if (SKIP_FILES.has(fileName) || SKIP_EXTENSIONS.has(ext)) {
    skippedFiles++;
    return;
  }

  fs.copyFileSync(src, dest);
  totalFiles++;
  totalSize += stat.size;
}

function cleanDest() {
  if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
  }
}

console.log('=== Vendoring ClawdCursor ===');
console.log(`Source: ${SRC}`);
console.log(`Dest:   ${DEST}`);

if (!fs.existsSync(SRC)) {
  console.error(`\n[ERROR] ClawdCursor not found at: ${SRC}`);
  console.error('Install it first: npm install -g clawdcursor');
  process.exit(1);
}

cleanDest();
copyRecursive(SRC, DEST);

console.log(`\n✓ Copied ${totalFiles} files (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  Skipped ${skippedFiles} files (tests, docs, maps)`);
console.log(`\nReady for packaging.`);
