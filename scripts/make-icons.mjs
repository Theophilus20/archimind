// Renders the ArchiMind mark (same geometry as public/favicon.svg) to PNG app icons.
// No dependencies: signed-distance shapes, 4x4 supersampling, zlib PNG encoding.
// Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));

// --- geometry on the 48-unit grid ---
const BG0 = hex('#24324a');
const BG1 = hex('#0f1724');
const ROOF0 = hex('#ffca28');
const ROOF1 = hex('#ff7043');
const WALL = hex('#e8eaed');
const SPARK0 = hex('#8ab4f8');
const SPARK1 = hex('#c58af9');

const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
};
const polyline = (pts) => (x, y) => {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(x, y, ...pts[i], ...pts[i + 1]));
  return d;
};
const roof = polyline([[9.5, 25.5], [24, 12], [38.5, 25.5]]);
const walls = polyline([[14.5, 27.5], [14.5, 36], [33.5, 36], [33.5, 27.5]]);

// Spark: four cubic curves (from the SVG path), flattened into a polygon.
function cubic(p0, p1, p2, p3, n = 16) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}
const c = [24, 30.4];
const r = 4.2;
const k = 0.5 / 4.2; // control-point offset ratio from the SVG (.5 of 4.2)
const top = [c[0], c[1] - r];
const right = [c[0] + r, c[1]];
const bottom = [c[0], c[1] + r];
const left = [c[0] - r, c[1]];
const spark = [
  top,
  ...cubic(top, [c[0] + r * k, c[1] - r + 2.5], [c[0] + 1.7, c[1] - 0.5], right),
  ...cubic(right, [c[0] + 1.7, c[1] + 0.5], [c[0] + r * k, c[1] + r - 2.5], bottom),
  ...cubic(bottom, [c[0] - r * k, c[1] + r - 2.5], [c[0] - 1.7, c[1] + 0.5], left),
  ...cubic(left, [c[0] - 1.7, c[1] - 0.5], [c[0] - r * k, c[1] - r + 2.5], top),
];
const inPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const roundRect = (x, y) => {
  const rr = 12;
  const qx = Math.abs(x - 24) - (24 - rr);
  const qy = Math.abs(y - 24) - (24 - rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr <= 0;
};

/** Colour (rgba) of one sample point on the 48 grid. */
function sample(x, y, opaque) {
  let col = null;
  let a = 0;
  if (roundRect(x, y)) {
    col = mix(BG0, BG1, (x + y) / 96);
    a = 1;
  } else if (opaque) {
    col = BG1;
    a = 1;
  }
  if (roof(x, y) <= 2.25) {
    // gradient from bottom-left (yellow) to top-right (orange)
    col = mix(ROOF0, ROOF1, (x - y + 48) / 96 + 0.1);
    a = 1;
  }
  if (walls(x, y) <= 1.6) {
    col = WALL;
    a = 1;
  }
  if (inPoly(x, y, spark)) {
    col = mix(SPARK0, SPARK1, ((x - 19.8) + (y - 26.2)) / 16.8);
    a = 1;
  }
  return col ? [...col, a] : [0, 0, 0, 0];
}

function render(size, opaque = false) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      let R = 0,
        G = 0,
        B = 0,
        A = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = ((i + (sx + 0.5) / ss) / size) * 48;
          const y = ((j + (sy + 0.5) / ss) / size) * 48;
          const [r2, g2, b2, a2] = sample(x, y, opaque);
          R += r2 * a2;
          G += g2 * a2;
          B += b2 * a2;
          A += a2;
        }
      const o = (j * size + i) * 4;
      const n = ss * ss;
      px[o] = A ? Math.round(R / A) : 0;
      px[o + 1] = A ? Math.round(G / A) : 0;
      px[o + 2] = A ? Math.round(B / A) : 0;
      px[o + 3] = Math.round((A / n) * 255);
    }
  return png(size, size, px);
}

// --- minimal PNG encoder ---
const crcTable = new Uint32Array(256).map((_, n) => {
  let c2 = n;
  for (let k2 = 0; k2 < 8; k2++) c2 = c2 & 1 ? 0xedb88320 ^ (c2 >>> 1) : c2 >>> 1;
  return c2 >>> 0;
});
const crc32 = (buf) => {
  let c2 = 0xffffffff;
  for (const b of buf) c2 = crcTable[(c2 ^ b) & 0xff] ^ (c2 >>> 8);
  return (c2 ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = [
  ['public/favicon-32.png', 32, false],
  ['public/favicon-16.png', 16, false],
  ['public/apple-touch-icon.png', 180, true],
  ['public/icon-192.png', 192, false],
  ['public/icon-512.png', 512, false],
];
for (const [file, size, opaque] of out) {
  writeFileSync(file, render(size, opaque));
  console.log('wrote', file);
}
