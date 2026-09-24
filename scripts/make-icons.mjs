#!/usr/bin/env node
/**
 * Generates public/icons/icon-192.png, icon-512.png and apple-touch-icon.png (180x180)
 * using only Node built-ins (zlib for PNG's DEFLATE stream) — no image library.
 *
 * Design: a rounded navy square (matches the kiosk's dark theme) with a white
 * "play/tap" glyph — a circle with a right-pointing triangle inside, echoing both
 * "press to start" and a touch target. Simple and legible at 192px and 180px.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const NAVY = [0x1b, 0x2a, 0x4a]; // matches CLAUDE.md/report palette's dark background
const ACCENT = [0x2e, 0x7d, 0x6b];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = makeCrcTable());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Encodes an RGBA pixel buffer (size*size*4 bytes) as a PNG file buffer. */
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Add a filter-type byte (0 = none) before each scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function setPx(rgba, size, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const cornerR = size * 0.22;

  // Rounded-square navy background with antialiased edges via supersampled coverage.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = roundedSquareCoverage(x + 0.5, y + 0.5, size, cornerR);
      if (inside > 0) {
        const col = NAVY;
        setPx(rgba, size, x, y, col, Math.round(inside * 255));
      }
    }
  }

  // White circle (the "tap" ring) with an accent-coloured play triangle inside.
  const ringR = size * 0.32;
  const ringW = size * 0.045;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= ringR && d >= ringR - ringW) {
        setPx(rgba, size, x, y, WHITE, 255);
      }
    }
  }

  // Play triangle, pointing right, centred with a slight optical offset.
  const triSize = size * 0.22;
  const ox = cx - triSize * 0.32;
  const oy = cy;
  const p1 = [ox - triSize / 2, oy - triSize * 0.62];
  const p2 = [ox - triSize / 2, oy + triSize * 0.62];
  const p3 = [ox + triSize * 0.68, oy];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pointInTriangle(x + 0.5, y + 0.5, p1, p2, p3)) {
        setPx(rgba, size, x, y, ACCENT, 255);
      }
    }
  }

  return rgba;
}

function roundedSquareCoverage(x, y, size, r) {
  const pad = size * 0.04;
  const left = pad;
  const top = pad;
  const right = size - pad;
  const bottom = size - pad;
  const cx = Math.min(Math.max(x, left + r), right - r);
  const cy = Math.min(Math.max(y, top + r), bottom - r);
  if (x < left || x > right || y < top || y > bottom) return 0;
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy > r * r && (x < left + r || x > right - r) && (y < top + r || y > bottom - r)) {
    return 0;
  }
  return 1;
}

function pointInTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function writeIcon(size, fileName) {
  const rgba = drawIcon(size);
  const png = encodePng(size, rgba);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, fileName), png);
  console.log(`wrote ${fileName} (${size}x${size}, ${png.length} bytes)`);
}

writeIcon(192, 'icon-192.png');
writeIcon(512, 'icon-512.png');
writeIcon(180, 'apple-touch-icon.png');
