// Builds the Clippy Dispatch phone page. Usage: node dispatch-phone/build.mjs [outDir]
// Default outDir: ../clippyai-web/dispatch (the website repo; served at https://clippyai.app/dispatch/).
// CLIPPY_DISPATCH_API=http://localhost:8787 points the page at a local relay for testing.
import { build } from 'esbuild';
import sharp from 'sharp';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, '..', '..', 'clippyai-web', 'dispatch'));
const relay = (process.env.CLIPPY_DISPATCH_API || 'https://api.clippyai.app').replace(/\/+$/, '').replace(/^http/, 'ws');

mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'main.ts')],
  outfile: join(out, 'main.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: { __RELAY__: JSON.stringify(relay) },
  logLevel: 'warning',
});
cpSync(join(here, 'index.html'), join(out, 'index.html'));
cpSync(join(here, 'style.css'), join(out, 'style.css'));

// Icons from the app icon. iOS paints a transparent icon on black, so the touch icon gets a white ground.
const icon = join(here, '..', 'build', 'icon-256.png');
await sharp(icon).resize(180, 180).flatten({ background: '#ffffff' }).png().toFile(join(out, 'apple-touch-icon.png'));
cpSync(icon, join(out, 'icon-256.png'));

// No start_url: iOS and Android keep the URL the page was added from, with its #fragment (the pairing).
writeFileSync(join(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'Clippy Dispatch',
  short_name: 'Clippy',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    { src: 'icon-256.png', sizes: '256x256', type: 'image/png' },
  ],
}, null, 2) + '\n');
console.log(`Clippy Dispatch phone page → ${out} (relay ${relay})`);
