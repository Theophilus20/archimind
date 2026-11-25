// Generates public/samples/family-home.svg — a clean, single-floor drawing at 1 px = 10 mm.
// Run: node scripts/make-sample-svg.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 0.1; // px per mm
const OX = 120;
const OY = 170;
const P = (x, y) => [OX + x * S, OY + y * S];

const walls = {
  W1: [0, 0, 12000, 0, 250],
  W2: [12000, 0, 12000, 9000, 250],
  W3: [12000, 9000, 0, 9000, 250],
  W4: [0, 9000, 0, 0, 250],
  W5: [4500, 0, 4500, 5200, 100],
  W6: [6500, 0, 6500, 4000, 100],
  W7: [4500, 4000, 12000, 4000, 100],
  W8: [0, 5200, 12000, 5200, 100],
  W9: [6000, 5200, 6000, 9000, 100],
};
// [wall, offset, width, kind, swing(+1 left of a→b), hinge]
const openings = [
  ['W8', 3600, 850, 'door', 1, 'start'],
  ['W7', 1000, 750, 'door', 1, 'start'],
  ['W7', 2900, 850, 'door', 1, 'start'],
  ['W2', 4600, 1000, 'door', -1, 'end'],
  ['W8', 5250, 900, 'door', -1, 'start'],
  ['W9', 1800, 1800, 'opening'],
  ['W4', 6500, 1500, 'window'],
  ['W1', 2250, 1200, 'window'],
  ['W1', 5500, 700, 'window'],
  ['W1', 9250, 1800, 'window'],
  ['W3', 9000, 2400, 'window'],
  ['W3', 3000, 1800, 'window'],
  ['W2', 7000, 1200, 'window'],
  ['W2', 2000, 1200, 'window'],
];
const labels = [
  ['BEDROOM 1', 2250, 2900],
  ['BATH', 5500, 2300],
  ['BEDROOM 2', 9250, 2300],
  ['HALL', 8250, 4700],
  ['LIVING', 3000, 7300],
  ['KITCHEN / DINING', 9000, 7300],
];

const out = [];
const W = 1440;
const H = 1190;
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

const dirOf = ([ax, ay, bx, by]) => {
  const L = Math.hypot(bx - ax, by - ay);
  return [(bx - ax) / L, (by - ay) / L, L];
};

for (const [id, w] of Object.entries(walls)) {
  const [ax, ay, , , t] = w;
  const [dx, dy, L] = dirOf(w);
  const ext = t === 250;
  const ops = openings.filter((o) => o[0] === id).sort((a, b) => a[1] - b[1]);
  let cursor = ext ? -t / 2 : 0;
  const spans = [];
  for (const o of ops) {
    spans.push([cursor, o[1] - o[2] / 2]);
    cursor = o[1] + o[2] / 2;
  }
  spans.push([cursor, L + (ext ? t / 2 : 0)]);
  for (const [s, e] of spans) {
    if (e - s < 1) continue;
    const nx = -dy * (t / 2);
    const ny = dx * (t / 2);
    const p = [
      [ax + dx * s + nx, ay + dy * s + ny],
      [ax + dx * e + nx, ay + dy * e + ny],
      [ax + dx * e - nx, ay + dy * e - ny],
      [ax + dx * s - nx, ay + dy * s - ny],
    ].map(([x, y]) => P(x, y).map((v) => v.toFixed(1)).join(','));
    out.push(`<polygon points="${p.join(' ')}" fill="#111111"/>`);
  }
  // openings
  for (const o of ops) {
    const [, off, width, kind, swing = 1, hinge = 'start'] = o;
    const c = [ax + dx * off, ay + dy * off];
    const s0 = [c[0] - (dx * width) / 2, c[1] - (dy * width) / 2];
    const s1 = [c[0] + (dx * width) / 2, c[1] + (dy * width) / 2];
    const nL = [dy, -dx]; // left normal (y-down)
    if (kind === 'window') {
      for (const k of [-0.5, 0, 0.5]) {
        const a = P(s0[0] + nL[0] * t * k, s0[1] + nL[1] * t * k);
        const b = P(s1[0] + nL[0] * t * k, s1[1] + nL[1] * t * k);
        out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#111" stroke-width="1.4"/>`);
      }
      for (const e of [s0, s1]) {
        const a = P(e[0] + nL[0] * t * 0.5, e[1] + nL[1] * t * 0.5);
        const b = P(e[0] - nL[0] * t * 0.5, e[1] - nL[1] * t * 0.5);
        out.push(`<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#111" stroke-width="1.4"/>`);
      }
    } else if (kind === 'door') {
      const sd = [nL[0] * swing, nL[1] * swing];
      const face = [c[0] + sd[0] * (t / 2), c[1] + sd[1] * (t / 2)];
      const hingeP = hinge === 'start' ? [face[0] - (dx * width) / 2, face[1] - (dy * width) / 2] : [face[0] + (dx * width) / 2, face[1] + (dy * width) / 2];
      const tip = hinge === 'start' ? [face[0] + (dx * width) / 2, face[1] + (dy * width) / 2] : [face[0] - (dx * width) / 2, face[1] - (dy * width) / 2];
      const open = [hingeP[0] + sd[0] * width, hingeP[1] + sd[1] * width];
      const h = P(...hingeP);
      const tp = P(...tip);
      const op = P(...open);
      const r = width * S;
      // sweep direction from tip to open
      const cr = (tip[0] - hingeP[0]) * sd[1] - (tip[1] - hingeP[1]) * sd[0];
      const sweep = cr > 0 ? 1 : 0;
      out.push(`<line x1="${h[0]}" y1="${h[1]}" x2="${op[0]}" y2="${op[1]}" stroke="#111" stroke-width="2"/>`);
      out.push(`<path d="M ${tp[0]} ${tp[1]} A ${r} ${r} 0 0 ${sweep} ${op[0]} ${op[1]}" fill="none" stroke="#111" stroke-width="1.2"/>`);
    }
  }
}

for (const [text, x, y] of labels) {
  const [px, py] = P(x, y);
  out.push(`<text x="${px}" y="${py}" font-family="Arial, Helvetica, sans-serif" font-size="15" text-anchor="middle" fill="#111" letter-spacing="1">${text}</text>`);
}

// overall dimension line, outside face to outside face (as drawings are dimensioned)
const [d0x, dy0] = P(-125, -1100);
const [d1x] = P(12125, -1100);
out.push(`<line x1="${d0x}" y1="${dy0}" x2="${d1x}" y2="${dy0}" stroke="#111" stroke-width="1"/>`);
for (const x of [d0x, d1x]) out.push(`<line x1="${x}" y1="${dy0 - 10}" x2="${x}" y2="${dy0 + 10}" stroke="#111" stroke-width="1"/>`, `<line x1="${x - 6}" y1="${dy0 + 6}" x2="${x + 6}" y2="${dy0 - 6}" stroke="#111" stroke-width="1.6"/>`);
out.push(`<text x="${(d0x + d1x) / 2}" y="${dy0 - 8}" font-family="Arial, Helvetica, sans-serif" font-size="15" text-anchor="middle" fill="#111">12 250</text>`);
out.push(`<text x="${OX}" y="${H - 40}" font-family="Arial, Helvetica, sans-serif" font-size="14" fill="#111">GROUND FLOOR PLAN  1:100   -   FAMILY HOME (STUDIO 2)</text>`);
out.push('</svg>');

mkdirSync('public/samples', { recursive: true });
writeFileSync('public/samples/family-home.svg', out.join('\n'));
console.log('wrote public/samples/family-home.svg');
