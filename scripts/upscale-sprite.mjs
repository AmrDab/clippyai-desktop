/**
 * scripts/upscale-sprite.mjs — offline xBRZ upscale of the Clippy sprite sheet.
 *
 * Reads assets/agents/clippy/map.mjs (base64 PNG, 124×93 frame tiles), scales
 * every tile independently with xBRZ (pixel-art aware: smooth diagonals, no
 * halos, alpha-correct) and writes assets/agents/clippy/map@<N>x.mjs — one PNG
 * strip per tile ROW so the renderer only ever decodes the rows the current
 * animation touches (a single 3x sheet would be ~380 MB decoded).
 *
 * Usage:  node scripts/upscale-sprite.mjs [--scale=2|3|4]     (default 3)
 *
 * Pure JS: pngjs (devDependency) for PNG I/O, node built-ins otherwise.
 * xBRZ port follows Zenju's reference (xBRZ 1.8, GPLv3-compatible algorithm
 * description) — ARGB colour distance + alpha-weighted gradients.
 * The generated asset is committed; the app build never runs this script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import pngjs from 'pngjs';

const { PNG } = pngjs;

export const CFG = {
  luminanceWeight: 1,
  equalColorTolerance: 30,
  dominantDirectionThreshold: 3.6,
  steepDirectionThreshold: 2.2,
  // Pixels closer than this are treated as equal when deciding whether a 2x2
  // block needs blending — keeps dithered textures crisp and the PNG ~2x smaller.
  nearEqualTolerance: 45,
};

const BLEND_NONE = 0;
const BLEND_NORMAL = 1;
const BLEND_DOMINANT = 2;

// ── colour helpers (pixels are ARGB packed in a uint32) ────────────────────

function distYCbCr(p1, p2) {
  const rd = ((p1 >>> 16) & 255) - ((p2 >>> 16) & 255);
  const gd = ((p1 >>> 8) & 255) - ((p2 >>> 8) & 255);
  const bd = (p1 & 255) - (p2 & 255);
  const kB = 0.0593; // ITU-R BT.2020
  const kR = 0.2627;
  const kG = 1 - kB - kR;
  const y = kR * rd + kG * gd + kB * bd;
  const cb = (0.5 / (1 - kB)) * (bd - y);
  const cr = (0.5 / (1 - kR)) * (rd - y);
  const ly = CFG.luminanceWeight * y;
  return Math.sqrt(ly * ly + cb * cb + cr * cr);
}

function distARGB(p1, p2) {
  const a1 = (p1 >>> 24) / 255;
  const a2 = (p2 >>> 24) / 255;
  const d = distYCbCr(p1, p2);
  return a1 < a2 ? a1 * d + 255 * (a2 - a1) : a2 * d + 255 * (a1 - a2);
}

/** out[i] = gradient between out[i] (back) and front, weighted m/n, alpha-aware. */
function alphaGrad(out, i, front, m, n) {
  const back = out[i];
  const wF = (front >>> 24) * m;
  const wB = (back >>> 24) * (n - m);
  const wS = wF + wB;
  if (wS === 0) return;
  const mix = (f, b) => ((f * wF + b * wB) / wS) | 0;
  const a = (wS / n) | 0;
  out[i] = ((a << 24) |
    (mix((front >>> 16) & 255, (back >>> 16) & 255) << 16) |
    (mix((front >>> 8) & 255, (back >>> 8) & 255) << 8) |
    mix(front & 255, back & 255)) >>> 0;
}

// ── scalers (output block N×N, ref(I,J) via precomputed rotated offsets) ───

const SCALERS = {
  2: {
    shallow(o, r, c) { alphaGrad(o, r(1, 0), c, 1, 4); alphaGrad(o, r(1, 1), c, 3, 4); },
    steep(o, r, c) { alphaGrad(o, r(0, 1), c, 1, 4); alphaGrad(o, r(1, 1), c, 3, 4); },
    steepShallow(o, r, c) { alphaGrad(o, r(1, 0), c, 1, 4); alphaGrad(o, r(0, 1), c, 1, 4); alphaGrad(o, r(1, 1), c, 5, 6); },
    diagonal(o, r, c) { alphaGrad(o, r(1, 1), c, 1, 2); },
    corner(o, r, c) { alphaGrad(o, r(1, 1), c, 21, 100); },
  },
  3: {
    shallow(o, r, c) { alphaGrad(o, r(2, 0), c, 1, 4); alphaGrad(o, r(1, 2), c, 1, 4); alphaGrad(o, r(2, 1), c, 3, 4); o[r(2, 2)] = c; },
    steep(o, r, c) { alphaGrad(o, r(0, 2), c, 1, 4); alphaGrad(o, r(2, 1), c, 1, 4); alphaGrad(o, r(1, 2), c, 3, 4); o[r(2, 2)] = c; },
    steepShallow(o, r, c) { alphaGrad(o, r(2, 0), c, 1, 4); alphaGrad(o, r(0, 2), c, 1, 4); alphaGrad(o, r(2, 1), c, 3, 4); alphaGrad(o, r(1, 2), c, 3, 4); o[r(2, 2)] = c; },
    diagonal(o, r, c) { alphaGrad(o, r(1, 2), c, 1, 8); alphaGrad(o, r(2, 1), c, 1, 8); alphaGrad(o, r(2, 2), c, 7, 8); },
    corner(o, r, c) { alphaGrad(o, r(2, 2), c, 45, 100); },
  },
  4: {
    shallow(o, r, c) {
      alphaGrad(o, r(3, 0), c, 1, 4); alphaGrad(o, r(2, 2), c, 1, 4);
      alphaGrad(o, r(3, 1), c, 3, 4); alphaGrad(o, r(2, 3), c, 3, 4);
      o[r(3, 2)] = c; o[r(3, 3)] = c;
    },
    steep(o, r, c) {
      alphaGrad(o, r(0, 3), c, 1, 4); alphaGrad(o, r(2, 2), c, 1, 4);
      alphaGrad(o, r(1, 3), c, 3, 4); alphaGrad(o, r(3, 2), c, 3, 4);
      o[r(2, 3)] = c; o[r(3, 3)] = c;
    },
    steepShallow(o, r, c) {
      alphaGrad(o, r(3, 1), c, 3, 4); alphaGrad(o, r(1, 3), c, 3, 4);
      alphaGrad(o, r(3, 0), c, 1, 4); alphaGrad(o, r(0, 3), c, 1, 4);
      alphaGrad(o, r(2, 2), c, 1, 3);
      o[r(3, 3)] = c; o[r(3, 2)] = c; o[r(2, 3)] = c;
    },
    diagonal(o, r, c) { alphaGrad(o, r(3, 2), c, 1, 2); alphaGrad(o, r(2, 3), c, 1, 2); o[r(3, 3)] = c; },
    corner(o, r, c) { alphaGrad(o, r(3, 3), c, 68, 100); alphaGrad(o, r(3, 2), c, 9, 100); alphaGrad(o, r(2, 3), c, 9, 100); },
  },
};

// 3×3 kernel index layout: a b c / d e f / g h i  → 0..8.
// One 90° rotation of the kernel (a←g, b←d, c←a, d←h, f←b, g←i, h←f, i←c).
const ROT90 = [6, 3, 0, 7, 4, 1, 8, 5, 2];
const KERNEL_ROT = [[0, 1, 2, 3, 4, 5, 6, 7, 8]];
for (let r = 1; r < 4; r++) KERNEL_ROT[r] = KERNEL_ROT[r - 1].map((k) => ROT90[k]);

/** Rotated output offsets: rot (I,J) → (N-1-J, I), applied r times. */
function buildRefOffsets(N, trgW) {
  const table = [];
  for (let r = 0; r < 4; r++) {
    const t = new Int32Array(N * N);
    for (let I = 0; I < N; I++) {
      for (let J = 0; J < N; J++) {
        let i = I, j = J;
        for (let k = 0; k < r; k++) { const ni = N - 1 - j; j = i; i = ni; }
        t[I * N + J] = i * trgW + j;
      }
    }
    table.push(t);
  }
  return table;
}

/**
 * xBRZ-scale an ARGB image (Uint32Array, w×h) by `N`. Returns Uint32Array of
 * (w*N)×(h*N). Edges clamp — so calling this per sprite tile keeps tiles from
 * bleeding into each other.
 */
export function xbrzScale(src, w, h, N) {
  const S = SCALERS[N];
  if (!S) throw new Error(`unsupported scale ${N}`);
  const trgW = w * N;
  const out = new Uint32Array(trgW * h * N);
  const refOff = buildRefOffsets(N, trgW);

  // Palette-indexed colour-distance cache (the sheet has ~100 colours).
  const palMap = new Map();
  const pal = [];
  const idx = new Uint16Array(w * h);
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    let k = palMap.get(p);
    if (k === undefined) { k = pal.length; palMap.set(p, k); pal.push(p); }
    idx[i] = k;
  }
  const np = pal.length;
  const useTable = np <= 1024;
  const table = useTable ? new Float64Array(np * np) : null;
  if (useTable) {
    for (let a = 0; a < np; a++) for (let b = 0; b < np; b++) table[a * np + b] = distARGB(pal[a], pal[b]);
  }
  const dist = useTable ? (a, b) => table[a * np + b] : (a, b) => distARGB(pal[a], pal[b]);
  const eq = (a, b) => a === b || dist(a, b) < CFG.equalColorTolerance;

  const at = (x, y) => idx[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];

  // Pass 1 — blend info (2 bits per corner: TL | TR<<2 | BR<<4 | BL<<6).
  const blend = new Uint8Array(w * h);
  const setCorner = (x, y, shift, v) => {
    if (x < 0 || y < 0 || x >= w || y >= h || v === BLEND_NONE) return;
    blend[y * w + x] |= v << shift;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 4×4 kernel: a b c d / e f g h / i j k l / m n o p, f = (x, y)
      const b = at(x, y - 1), c = at(x + 1, y - 1);
      const e = at(x - 1, y), f = at(x, y), g = at(x + 1, y), hh = at(x + 2, y);
      const i = at(x - 1, y + 1), j = at(x, y + 1), k = at(x + 1, y + 1), l = at(x + 2, y + 1);
      const n = at(x, y + 2), o = at(x + 1, y + 2);
      if (CFG.nearEqualTolerance > 0) {
        // Dither-aware: pixels closer than the tolerance count as equal here, so
        // dithered textures stay as crisp blocks instead of dissolving into
        // random blends (which also inflates the PNG ~5x).
        const ne = (a, b) => a === b || dist(a, b) < CFG.nearEqualTolerance;
        if ((ne(f, g) && ne(j, k)) || (ne(f, j) && ne(g, k))) continue;
      } else if ((f === g && j === k) || (f === j && g === k)) continue;
      const jg = dist(i, f) + dist(f, c) + dist(n, k) + dist(k, hh) + 4 * dist(j, g);
      const fk = dist(e, j) + dist(j, o) + dist(b, g) + dist(g, l) + 4 * dist(f, k);
      if (jg < fk) {
        const v = CFG.dominantDirectionThreshold * jg < fk ? BLEND_DOMINANT : BLEND_NORMAL;
        if (f !== g && f !== j) setCorner(x, y, 4, v);           // bottom-right of f
        if (k !== j && k !== g) setCorner(x + 1, y + 1, 0, v);   // top-left of k
      } else if (fk < jg) {
        const v = CFG.dominantDirectionThreshold * fk < jg ? BLEND_DOMINANT : BLEND_NORMAL;
        if (j !== f && j !== k) setCorner(x, y + 1, 2, v);       // top-right of j
        if (g !== f && g !== k) setCorner(x + 1, y, 6, v);       // bottom-left of g
      }
    }
  }

  // Pass 2 — fill + blend the four corners of every pixel.
  const ker = new Uint16Array(9);
  const rk = new Uint16Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = y * N * trgW + x * N;
      const col = pal[idx[y * w + x]];
      for (let I = 0; I < N; I++) for (let J = 0; J < N; J++) out[base + I * trgW + J] = col;
      const bi = blend[y * w + x];
      if (bi === 0) continue;

      ker[0] = at(x - 1, y - 1); ker[1] = at(x, y - 1); ker[2] = at(x + 1, y - 1);
      ker[3] = at(x - 1, y);     ker[4] = at(x, y);     ker[5] = at(x + 1, y);
      ker[6] = at(x - 1, y + 1); ker[7] = at(x, y + 1); ker[8] = at(x + 1, y + 1);

      for (let r = 0; r < 4; r++) {
        const rb = ((bi << (2 * r)) | (bi >>> (8 - 2 * r))) & 0xff;
        const bottomR = (rb >>> 4) & 3;
        if (bottomR < BLEND_NORMAL) continue;
        const perm = KERNEL_ROT[r];
        for (let q = 0; q < 9; q++) rk[q] = ker[perm[q]];
        const [, b, c, d, e, f, g, hh, i] = rk;
        const topR = (rb >>> 2) & 3;
        const bottomL = (rb >>> 6) & 3;

        let doLine = true;
        if (bottomR < BLEND_DOMINANT) {
          // no second blending in an adjacent rotation (insular pixels, "mario eyes")
          if (topR !== BLEND_NONE && !eq(e, g)) doLine = false;
          else if (bottomL !== BLEND_NONE && !eq(e, c)) doLine = false;
          // no full blending for L-shapes; blend corner only
          else if (!eq(e, i) && eq(g, hh) && eq(hh, i) && eq(i, f) && eq(f, c)) doLine = false;
        }

        const px = pal[dist(e, f) <= dist(e, hh) ? f : hh];
        const off = refOff[r];
        const ref = (I, J) => base + off[I * N + J];

        if (doLine) {
          const fg = dist(f, g);
          const hc = dist(hh, c);
          const shallow = CFG.steepDirectionThreshold * fg <= hc && e !== g && d !== g;
          const steep = CFG.steepDirectionThreshold * hc <= fg && e !== c && b !== c;
          if (shallow) {
            if (steep) S.steepShallow(out, ref, px); else S.shallow(out, ref, px);
          } else if (steep) {
            S.steep(out, ref, px);
          } else {
            S.diagonal(out, ref, px);
          }
        } else {
          S.corner(out, ref, px);
        }
      }
    }
  }
  return out;
}

// ── RGBA <-> ARGB buffers ──────────────────────────────────────────────────

export function rgbaToArgb(data, count) {
  const out = new Uint32Array(count);
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    out[i] = ((data[j + 3] << 24) | (data[j] << 16) | (data[j + 1] << 8) | data[j + 2]) >>> 0;
  }
  return out;
}

export function argbToRgba(src, data, offset = 0) {
  for (let i = 0, j = offset; i < src.length; i++, j += 4) {
    const p = src[i];
    data[j] = (p >>> 16) & 255; data[j + 1] = (p >>> 8) & 255; data[j + 2] = p & 255; data[j + 3] = p >>> 24;
  }
}

/** Decode the base64 data-URI PNG exported by map.mjs. */
export function decodeMapPng(dataUri) {
  const buf = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
  return PNG.sync.read(buf);
}

/** Upscale one tile (fw×fh at sx,sy of an RGBA png) → ARGB Uint32Array. */
export function upscaleTile(png, sx, sy, fw, fh, N) {
  const tile = new Uint32Array(fw * fh);
  for (let y = 0; y < fh; y++) {
    let j = ((sy + y) * png.width + sx) * 4;
    for (let x = 0; x < fw; x++, j += 4) {
      tile[y * fw + x] = ((png.data[j + 3] << 24) | (png.data[j] << 16) | (png.data[j + 1] << 8) | png.data[j + 2]) >>> 0;
    }
  }
  return xbrzScale(tile, fw, fh, N);
}

// ── 256-colour quantization + indexed PNG encoder ──────────────────────────
// pngjs only writes RGBA; an RGBA 4x sheet is ~56 MB vs ~5 MB indexed. The
// blends xBRZ produces are ~2% of pixels, so median cut in premultiplied
// RGBA space is visually lossless here.

function premul(p) {
  const a = p >>> 24;
  return [((p >>> 16) & 255) * a / 255, ((p >>> 8) & 255) * a / 255, (p & 255) * a / 255, a];
}

/** Median-cut palette (≤256 entries) for an ARGB Uint32Array. Returns {palette, index}. */
export function quantize(src, maxColors = 256) {
  const counts = new Map();
  for (let i = 0; i < src.length; i++) counts.set(src[i], (counts.get(src[i]) || 0) + 1);
  const colors = [...counts].map(([p, n]) => ({ p, n, v: premul(p) }));
  let palette;
  if (colors.length <= maxColors) {
    palette = colors.map((c) => c.p);
  } else {
    let boxes = [colors];
    while (boxes.length < maxColors) {
      // split the box with the largest (count-weighted) extent along its widest axis
      let best = -1, bestScore = -1, bestAxis = 0;
      boxes.forEach((box, bi) => {
        if (box.length < 2) return;
        for (let ax = 0; ax < 4; ax++) {
          let lo = Infinity, hi = -Infinity;
          for (const c of box) { if (c.v[ax] < lo) lo = c.v[ax]; if (c.v[ax] > hi) hi = c.v[ax]; }
          const score = (hi - lo) * Math.sqrt(box.reduce((s, c) => s + c.n, 0));
          if (score > bestScore) { bestScore = score; best = bi; bestAxis = ax; }
        }
      });
      if (best < 0) break;
      const box = boxes[best].sort((a, b) => a.v[bestAxis] - b.v[bestAxis]);
      const total = box.reduce((s, c) => s + c.n, 0);
      let acc = 0, cut = 1;
      for (; cut < box.length - 1; cut++) { acc += box[cut - 1].n; if (acc >= total / 2) break; }
      boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
    }
    palette = boxes.map((box) => {
      // count-weighted mean in premultiplied space, un-premultiplied back to ARGB
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (const c of box) { r += c.v[0] * c.n; g += c.v[1] * c.n; b += c.v[2] * c.n; a += c.v[3] * c.n; n += c.n; }
      if (a === 0) return 0;
      const A = Math.round(a / n);
      const un = (x) => Math.min(255, Math.round((x / n) * 255 / (a / n)));
      return ((A << 24) | (un(r) << 16) | (un(g) << 8) | un(b)) >>> 0;
    });
  }
  // nearest palette entry per distinct colour, then index the image
  const pv = palette.map(premul);
  const lut = new Map();
  for (const c of colors) {
    let bi = 0, bd = Infinity;
    for (let k = 0; k < pv.length; k++) {
      const d = (c.v[0] - pv[k][0]) ** 2 + (c.v[1] - pv[k][1]) ** 2 + (c.v[2] - pv[k][2]) ** 2 + (c.v[3] - pv[k][3]) ** 2;
      if (d < bd) { bd = d; bi = k; }
    }
    lut.set(c.p, bi);
  }
  const index = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) index[i] = lut.get(src[i]);
  return { palette, index };
}

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode an indexed (colour type 3) PNG with a tRNS alpha table. */
export function encodeIndexedPng(index, w, h, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const plte = Buffer.alloc(palette.length * 3);
  const trns = Buffer.alloc(palette.length);
  palette.forEach((p, i) => { plte[i * 3] = (p >>> 16) & 255; plte[i * 3 + 1] = (p >>> 8) & 255; plte[i * 3 + 2] = p & 255; trns[i] = p >>> 24; });
  // try filter None and Up; keep whichever deflates smaller
  let best = null;
  for (const filter of [0, 2]) {
    const raw = Buffer.alloc((w + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w + 1)] = filter;
      for (let x = 0; x < w; x++) {
        const cur = index[y * w + x];
        raw[y * (w + 1) + 1 + x] = filter === 2 && y > 0 ? (cur - index[(y - 1) * w + x]) & 255 : cur;
      }
    }
    const z = zlib.deflateSync(raw, { level: 9 });
    if (!best || z.length < best.length) best = z;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', best), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const N = Number((process.argv.find((a) => a.startsWith('--scale=')) || '--scale=3').split('=')[1]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'assets', 'agents', 'clippy');
  const agent = (await import(pathToFileURL(path.join(dir, 'agent.mjs')).href)).default;
  const map = (await import(pathToFileURL(path.join(dir, 'map.mjs')).href)).default;
  const [fw, fh] = agent.framesize;
  const png = decodeMapPng(map);
  const cols = Math.floor(png.width / fw);
  const rows = Math.floor(png.height / fh);
  console.log(`source ${png.width}x${png.height}, ${cols}x${rows} tiles of ${fw}x${fh}, scale ${N}x`);

  const strips = [];
  const t0 = Date.now();
  for (let r = 0; r < rows; r++) {
    const sw = png.width * N, sh = fh * N, tw = fw * N;
    const strip = new Uint32Array(sw * sh);
    for (let c = 0; c < cols; c++) {
      const hd = upscaleTile(png, c * fw, r * fh, fw, fh, N);
      for (let y = 0; y < sh; y++) strip.set(hd.subarray(y * tw, (y + 1) * tw), y * sw + c * tw);
    }
    const { palette, index } = quantize(strip);
    const buf = encodeIndexedPng(index, sw, sh, palette);
    strips.push('data:image/png;base64,' + buf.toString('base64'));
    process.stdout.write(`\rrow ${r + 1}/${rows}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  console.log();

  const outFile = path.join(dir, `map@${N}x.mjs`);
  const src =
    `// Generated by scripts/upscale-sprite.mjs (xBRZ ${N}x, per-tile). Do not edit.\n` +
    `// One PNG strip per ${fh}px tile row of map.mjs; frame offsets scale by ${N}.\n` +
    `var map_hd_default = {\n  scale: ${N},\n  stripHeight: ${fh * N},\n  strips: [\n` +
    strips.map((s) => `    "${s}",\n`).join('') +
    `  ],\n};\nexport { map_hd_default as default };\n`;
  fs.writeFileSync(outFile, src);
  console.log(`wrote ${outFile} (${(src.length / 1048576).toFixed(2)} MB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
