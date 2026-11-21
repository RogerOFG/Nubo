// Draws Nubo into the PNG/ICO set Tauri needs. No dependencies: the icons are
// rasterised here and encoded with node:zlib, so the app icon stays "drawn in
// code" like the character itself.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Nubo ──────────────────────────────────────────────────────────────────────

const BASE_TOP = [242, 239, 255]; // #F2EFFF
const BASE_BOTTOM = [139, 124, 247]; // #8B7CF7
const INK = [24, 17, 48]; // #181130
const RIM = [96, 80, 214]; // a deeper violet edge, so it reads on light and dark themes
const GLOW = [140, 120, 255];

const SS = 4; // supersampling factor

// The cloud, in units of R: three round lobes on a flat base with rounded corners.
// The same shapes as CLOUD_LOBES / CLOUD_BASE in src/mochi/engine.ts — keep them together.
const LOBES = [
  [0.04, -0.05, 0.6],
  [-0.65, 0.36, 0.47],
  [0.64, 0.3, 0.44],
];
const BASE = { x0: -0.76, y0: 0.25, x1: 0.76, y1: 0.72, r: 0 };

/** How far (in R) the point is outside the cloud; 0 or less inside. */
function cloudDistance(x, y) {
  let d = Infinity;
  for (const [cx, cy, r] of LOBES) d = Math.min(d, Math.hypot(x - cx, y - cy) - r);
  const qx = Math.abs(x - (BASE.x0 + BASE.x1) / 2) - ((BASE.x1 - BASE.x0) / 2 - BASE.r);
  const qy = Math.abs(y - (BASE.y0 + BASE.y1) / 2) - ((BASE.y1 - BASE.y0) / 2 - BASE.r);
  const rect = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - BASE.r;
  // The cloud ends at the base line.
  return Math.max(Math.min(d, rect), y - BASE.y1);
}

function insidePill(x, y, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function renderNubo(size) {
  const px = new Uint8Array(size * size * 4);
  const R = size * 0.33;
  const cx = size / 2;
  const cy = size / 2 + R * 0.05;
  const rim = 0.045; // in R

  // Eyes — the engine's geometry: tall pills, 0.25 R either side, a little below the middle.
  const ex = 0.25 * R;
  const ey = 0.1 * R;
  const ew = R * 0.12;
  const eh = R * 0.19;
  const top = -0.65;
  const height = 1.37;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bodyHits = 0;
      let rimHits = 0;
      let eyeHits = 0;
      let glow = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = x + (sx + 0.5) / SS - cx;
          const uy = y + (sy + 0.5) / SS - cy;
          const d = cloudDistance(ux / R, uy / R);
          if (d > rim) {
            // Outside: only the halo.
            if (d < 0.5) glow += 0.55 * Math.exp(-d / 0.12);
            continue;
          }
          rimHits++;
          if (d > 0) continue;
          bodyHits++;
          if (insidePill(ux + ex, uy - ey, ew, eh) || insidePill(ux - ex, uy - ey, ew, eh)) eyeHits++;
        }
      }
      const total = SS * SS;
      const glowA = Math.min(0.7, glow / total);
      if (rimHits === 0 && glowA < 0.01) continue;

      const rimA = rimHits / total;
      const bodyA = bodyHits / total;
      const eyeA = eyeHits / total;

      // Body: light on top, violet below, as the gradient on the canvas.
      const t = Math.min(1, Math.max(0, ((y - cy) / R - top) / height));
      const u = Math.max(0, (t - 0.45) / 0.55);
      const body = [0, 1, 2].map((i) => BASE_TOP[i] + (BASE_BOTTOM[i] - BASE_TOP[i]) * u);

      // halo, then rim, then body, then eyes — composited over transparent
      let col = GLOW.slice();
      let alpha = glowA;
      const over = (c, a) => {
        const outA = a + alpha * (1 - a);
        if (outA > 0) col = col.map((v, i) => (c[i] * a + v * alpha * (1 - a)) / outA);
        alpha = outA;
      };
      if (rimA > 0) over(RIM, rimA);
      if (bodyA > 0) over(body, bodyA);
      if (eyeA > 0) over(INK, eyeA);

      const o = (y * size + x) * 4;
      px[o] = Math.round(col[0]);
      px[o + 1] = Math.round(col[1]);
      px[o + 2] = Math.round(col[2]);
      px[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderNubo(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
