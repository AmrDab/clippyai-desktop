const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'clippyjs', 'dist', 'agents', 'clippy');
const dest = path.join(__dirname, '..', 'assets', 'agents', 'clippy');

fs.mkdirSync(dest, { recursive: true });

for (const file of ['agent.mjs', 'map.mjs']) {
  const srcFile = path.join(src, file);
  const destFile = path.join(dest, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
    console.log(`Copied ${file}`);
  } else {
    console.warn(`Warning: ${srcFile} not found`);
  }
}
