// Generates the PWA PNG icons (chat bubble on rounded square, matching icon.svg)
// with a dependency-free PNG encoder. Run once: node scripts/gen-icons.ts
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { chunk } from './pngChunk.ts';

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [0x17, 0x17, 0x17];
const ACCENT = [0xe1, 0x8a, 0x24];

function renderIcon(size: number): Uint8Array {
  const SS = 4; // supersampling factor
  const s = size * SS;
  const corner = s * 0.1875;
  const inRoundedRect = (x: number, y: number): boolean => {
    const cx = Math.max(corner - x, x - (s - corner), 0);
    const cy = Math.max(corner - y, y - (s - corner), 0);
    return cx * cx + cy * cy <= corner * corner;
  };
  const inEllipse = (
    x: number,
    y: number,
    cx: number,
    cy: number,
    rx: number,
    ry: number,
  ): boolean => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  };
  const inTail = (x: number, y: number): boolean => {
    // Triangle pointing down-left from the bubble's lower-left.
    const ax = s * 0.26,
      ay = s * 0.6;
    const bx = s * 0.48,
      by = s * 0.72;
    const cx = s * 0.24,
      cy = s * 0.88;
    const sign = (x1: number, y1: number, x2: number, y2: number) =>
      (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
    const d1 = sign(ax, ay, bx, by);
    const d2 = sign(bx, by, cx, cy);
    const d3 = sign(cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  const dotY = s * 0.455;
  const dotR = s * 0.045;
  const dotXs = [s * 0.36, s * 0.5, s * 0.64];

  const rgba = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5;
          const y = py * SS + sy + 0.5;
          if (!inRoundedRect(x, y)) continue;
          let color = BG;
          if (inEllipse(x, y, s * 0.5, s * 0.455, s * 0.345, s * 0.27) || inTail(x, y)) {
            color = ACCENT;
            for (const dx of dotXs) {
              if (inEllipse(x, y, dx, dotY, dotR, dotR)) {
                color = BG;
                break;
              }
            }
          }
          r += color[0]!;
          g += color[1]!;
          b += color[2]!;
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      const covered = a / 255 || 1;
      rgba[i] = r / covered;
      rgba[i + 1] = g / covered;
      rgba[i + 2] = b / covered;
      rgba[i + 3] = alpha;
    }
  }
  return rgba;
}

for (const size of [192, 512]) {
  writeFileSync(`client/public/icon-${size}.png`, encodePng(size, renderIcon(size)));
  console.log(`wrote client/public/icon-${size}.png`);
}
