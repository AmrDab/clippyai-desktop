#!/usr/bin/env node
/**
 * Fails the build when the bundled main process requires a local chunk that
 * was never emitted. A lazy `require('./x')` of a module Rollup already inlined
 * (because something imports it statically) survives in out/main as
 * `require("./x")` and throws "Cannot find module" only at runtime, inside a
 * try/catch, so features die silently. Shipped 5 times (v0.18.2 .. v0.24.7).
 */
const fs = require('fs');
const path = require('path');

for (const dir of ['out/main', 'out/preload']) {
  const abs = path.join(__dirname, '..', dir);
  if (!fs.existsSync(abs)) continue;
  const bad = [];
  for (const f of fs.readdirSync(abs).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(abs, f), 'utf8');
    for (const m of src.matchAll(/require\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g)) {
      const target = path.join(abs, m[1]);
      const ok = [target, target + '.js', target + '.cjs', target + '.json', path.join(target, 'index.js')]
        .some((p) => fs.existsSync(p));
      if (!ok) bad.push(`${dir}/${f}: require("${m[1]}")`);
    }
  }
  if (bad.length) {
    console.error('[check-bundle-requires] missing chunks (import these statically):\n  ' + [...new Set(bad)].join('\n  '));
    process.exit(1);
  }
}
console.log('[check-bundle-requires] ok');
