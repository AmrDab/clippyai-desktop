/**
 * Generate app icon from Clippy sprite sheet.
 * Takes the first Clippy frame (124x93), centers it on a beige background,
 * scales to multiple sizes, and packs into a multi-resolution .ico file.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PNG } = require('pngjs');

const FRAME_W = 124;
const FRAME_H = 93;
const BG = [253, 246, 227, 255]; // warm beige to match brand

// Find a "good" Clippy frame — Idle1_1 first frame at (0,0)
function extractFrame(sheet, sx, sy) {
  const frame = new PNG({ width: FRAME_W, height: FRAME_H });
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const si = ((sy + y) * sheet.width + (sx + x)) * 4;
      const di = (y * FRAME_W + x) * 4;
      frame.data[di] = sheet.data[si];
      frame.data[di + 1] = sheet.data[si + 1];
      frame.data[di + 2] = sheet.data[si + 2];
      frame.data[di + 3] = sheet.data[si + 3];
    }
  }
  return frame;
}

// Bilinear scale + composite onto beige background
function scaleAndComposite(frame, targetSize) {
  const out = new PNG({ width: targetSize, height: targetSize });

  // Fill with beige
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = BG[0];
    out.data[i + 1] = BG[1];
    out.data[i + 2] = BG[2];
    out.data[i + 3] = BG[3];
  }

  // Scale Clippy frame to fit (with small padding)
  const padding = targetSize * 0.1;
  const drawW = targetSize - padding * 2;
  const drawH = drawW * (FRAME_H / FRAME_W);
  const offsetX = padding;
  const offsetY = (targetSize - drawH) / 2;

  for (let y = 0; y < drawH; y++) {
    for (let x = 0; x < drawW; x++) {
      const sx = (x / drawW) * FRAME_W;
      const sy = (y / drawH) * FRAME_H;
      const sxi = Math.floor(sx);
      const syi = Math.floor(sy);
      const si = (syi * FRAME_W + sxi) * 4;
      const r = frame.data[si];
      const g = frame.data[si + 1];
      const b = frame.data[si + 2];
      const a = frame.data[si + 3];

      const dx = Math.floor(offsetX + x);
      const dy = Math.floor(offsetY + y);
      if (dx < 0 || dy < 0 || dx >= targetSize || dy >= targetSize) continue;
      const di = (dy * targetSize + dx) * 4;

      // Alpha blend onto beige
      const alpha = a / 255;
      out.data[di] = Math.round(r * alpha + BG[0] * (1 - alpha));
      out.data[di + 1] = Math.round(g * alpha + BG[1] * (1 - alpha));
      out.data[di + 2] = Math.round(b * alpha + BG[2] * (1 - alpha));
      out.data[di + 3] = 255;
    }
  }

  return PNG.sync.write(out);
}

// Build ICO from PNG buffers (Vista+ format embeds PNGs directly)
function buildIco(pngBuffers, sizes) {
  const numImages = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);          // reserved
  header.writeUInt16LE(1, 2);          // type 1 = ICO
  header.writeUInt16LE(numImages, 4);  // image count

  let dataOffset = 6 + numImages * 16;
  const entries = [];

  for (let i = 0; i < numImages; i++) {
    const png = pngBuffers[i];
    const size = sizes[i];
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;
    e[1] = size === 256 ? 0 : size;
    e[2] = 0;     // colors
    e[3] = 0;     // reserved
    e.writeUInt16LE(1, 4);            // planes
    e.writeUInt16LE(32, 6);           // bpp
    e.writeUInt32LE(png.length, 8);   // size
    e.writeUInt32LE(dataOffset, 12);  // offset
    dataOffset += png.length;
    entries.push(e);
  }

  return Buffer.concat([header, ...entries, ...pngBuffers]);
}

async function main() {
  const sheetPath = path.join(__dirname, '..', 'build', 'clippy-spritesheet.png');
  if (!fs.existsSync(sheetPath)) {
    console.error('Spritesheet not found at', sheetPath);
    process.exit(1);
  }

  const sheet = PNG.sync.read(fs.readFileSync(sheetPath));
  console.log(`Loaded spritesheet: ${sheet.width}x${sheet.height}`);

  // Use the third frame of Idle1_1 (a good neutral pose)
  // Frame coordinates: [0,0], [124,0], [248,0]...
  const frame = extractFrame(sheet, 0, 0);
  console.log(`Extracted Clippy frame: ${FRAME_W}x${FRAME_H}`);

  // Save the standalone PNG too — useful for marketing / favicons
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'clippy-icon.png'), PNG.sync.write(frame));

  // Generate multi-resolution PNGs
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = sizes.map(s => {
    console.log(`  Generating ${s}x${s}...`);
    return scaleAndComposite(frame, s);
  });

  // Save the largest size as a PNG too (for installer header, etc)
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon-256.png'), pngs[pngs.length - 1]);

  // Build ICO
  const ico = buildIco(pngs, sizes);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);
  console.log(`\n✓ Created icon.ico (${ico.length} bytes) with sizes: ${sizes.join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
