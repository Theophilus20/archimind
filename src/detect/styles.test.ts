/**
 * The same small house drawn in the drawing styles found in real floor plans, read by the
 * detector from the coloured image (binarise, then detect). Each style must give the walls and
 * most of the doors and windows.
 */
import { describe, expect, it } from 'vitest';
import { binarize, detect } from './detector';

type Style = 'solid' | 'outline' | 'grey' | 'hatched' | 'mixed';

interface Canvas {
  w: number;
  h: number;
  px: Uint8ClampedArray;
}

function canvas(w: number, h: number): Canvas {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  return { w, h, px };
}
function set(c: Canvas, x: number, y: number, v: number) {
  const X = Math.round(x);
  const Y = Math.round(y);
  if (X < 0 || Y < 0 || X >= c.w || Y >= c.h) return;
  const i = (Y * c.w + X) * 4;
  c.px[i] = c.px[i + 1] = c.px[i + 2] = Math.min(c.px[i], v);
}
function line(c: Canvas, x0: number, y0: number, x1: number, y1: number, v = 40, width = 1) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) || 1;
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const y = y0 + ((y1 - y0) * i) / n;
    for (let k = 0; k < width; k++) set(c, x0 === x1 ? x + k - (width - 1) / 2 : x, y0 === y1 ? y + k - (width - 1) / 2 : y, v);
  }
}
function rect(c: Canvas, x0: number, y0: number, x1: number, y1: number, v: number) {
  for (let y = Math.round(Math.min(y0, y1)); y <= Math.max(y0, y1); y++) for (let x = Math.round(Math.min(x0, x1)); x <= Math.max(x0, x1); x++) set(c, x, y, v);
}

/** A 12 × 9 m house: outside walls 250 mm, two inside walls 120 mm, three doors, four windows. */
function draw(style: Style, s: number) {
  const O = 60;
  const W = Math.round(12000 * s) + 2 * O;
  const H = Math.round(9000 * s) + 2 * O;
  const c = canvas(W, H);
  const P = (v: number) => O + v * s;
  // walls: [x0, y0, x1, y1, thickness, gaps measured along the wall [from, to, kind, swing side]]
  type Gap = [number, number, 'door' | 'window', (1 | -1)?];
  const walls: [number, number, number, number, number, Gap[]][] = [
    [0, 0, 12000, 0, 250, [[1500, 3000, 'window'], [7000, 9000, 'window']]],
    [0, 9000, 12000, 9000, 250, [[2000, 3500, 'window'], [9000, 10000, 'door', -1]]],
    [0, 0, 0, 9000, 250, []],
    [12000, 0, 12000, 9000, 250, [[6000, 7500, 'window']]],
    [5000, 0, 5000, 9000, 120, [[6000, 6900, 'door']]],
    [5000, 4000, 12000, 4000, 120, [[3000, 3900, 'door']]],
  ];
  for (const [x0, y0, x1, y1, t, gaps] of walls) {
    const horiz = y0 === y1;
    const L = horiz ? x1 - x0 : y1 - y0;
    const outer = t > 200;
    const st: Style = style === 'mixed' ? (outer ? 'solid' : 'outline') : style;
    const ext = outer ? t / 2 : 0;
    // Fills stop at doors and windows; the wall's face lines carry on across windows.
    const spansCut = (cuts: Gap[]) => {
      const out: [number, number][] = [];
      let a = -ext;
      for (const g of [...cuts].sort((p, q) => p[0] - q[0])) {
        out.push([a, g[0]]);
        a = g[1];
      }
      out.push([a, L + ext]);
      return out;
    };
    const fills = spansCut(gaps);
    const spans = st === 'solid' ? fills : spansCut(gaps.filter((g) => g[2] === 'door'));
    const at = (along: number, across: number) => (horiz ? [P(x0 + along), P(y0 + across)] : [P(x0 + across), P(y0 + along)]);
    for (const [p, q] of spans) {
      if (st === 'solid') {
        const [ax, ay] = at(p, -t / 2);
        const [bx, by] = at(q, t / 2);
        rect(c, ax, ay, bx, by, 20);
      } else {
        for (const side of [-t / 2, t / 2]) {
          const [ax, ay] = at(p, side);
          const [bx, by] = at(q, side);
          line(c, ax, ay, bx, by, 30, 2);
        }
      }
    }
    if (st === 'grey' || st === 'hatched')
      for (const [p, q] of fills) {
        if (st === 'grey') {
          const [ax, ay] = at(p, -t / 2);
          const [bx, by] = at(q, t / 2);
          rect(c, ax, ay, bx, by, 165);
        } else
          for (let k = p; k < q; k += 250) {
            const [ax, ay] = at(k, -t / 2);
            const [bx, by] = at(Math.min(q, k + t), t / 2);
            line(c, ax, ay, bx, by, 90, 1);
          }
      }
    for (const [g0, g1, kind, swing = 1] of gaps) {
      // jambs, then the window glass or the door leaf and swing
      if (st !== 'solid' || kind === 'door')
        for (const e of [g0, g1]) {
          const [ax, ay] = at(e, -t / 2);
          const [bx, by] = at(e, t / 2);
          line(c, ax, ay, bx, by, 30, 2);
        }
      if (kind === 'window') {
        for (const k of st === 'solid' ? [-t / 4, 0, t / 4] : [0]) {
          const [ax, ay] = at(g0, k);
          const [bx, by] = at(g1, k);
          line(c, ax, ay, bx, by, 50, 1);
        }
      } else {
        const r = (g1 - g0) * s;
        const [hx, hy] = at(g0, (swing * t) / 2);
        const [ex, ey] = horiz ? [hx, hy + swing * r] : [hx + swing * r, hy];
        line(c, hx, hy, ex, ey, 40, 2);
        for (let deg = 0; deg <= 90; deg += 1) {
          const rad = (deg * Math.PI) / 180;
          const ux = horiz ? Math.sin(rad) * r : swing * Math.cos(rad) * r;
          const uy = horiz ? swing * Math.cos(rad) * r : Math.sin(rad) * r;
          set(c, hx + ux, hy + uy, 70);
        }
      }
    }
  }
  // furniture, text and a dimension line, as drawings have
  const fx = (x: number) => P(x);
  for (const [x0, y0, x1, y1] of [
    [600, 600, 2200, 2600],
    [6000, 800, 7600, 2800],
    [800, 6600, 3400, 7600],
    [7000, 5600, 9400, 6800],
  ])
    for (const [a, b, cc, d] of [
      [x0, y0, x1, y0],
      [x1, y0, x1, y1],
      [x1, y1, x0, y1],
      [x0, y1, x0, y0],
    ])
      line(c, fx(a), fx(b), fx(cc), fx(d), 120, 1);
  for (let i = 0; i < 30; i++) line(c, P(1500) + i * 5, P(4500), P(1500) + i * 5 + 2, P(4500) + 8, 60, 1);
  line(c, P(0), P(-700), P(12000), P(-700), 90, 1);
  for (const x of [0, 5000, 12000]) line(c, P(x) - 4, P(-700) + 4, P(x) + 4, P(-700) - 4, 60, 1);
  return c;
}

describe('the detector across drawing styles', () => {
  const styles: Style[] = ['solid', 'outline', 'grey', 'hatched', 'mixed'];
  for (const style of styles)
    for (const s of [0.06, 0.1])
      it(`reads a ${style} drawing at ${s * 1000} px per metre`, () => {
        const c = draw(style, s);
        const b = binarize(c.px, c.w, c.h);
        const d = detect(b.dark, c.w, c.h, b.threshold, b.lum);
        const kinds = d.openings.reduce<Record<string, number>>((acc, o) => ((acc[o.kind] = (acc[o.kind] ?? 0) + 1), acc), {});
        const summary = `${style} @${s}: ${d.walls.length} walls (${d.walls.filter((w) => w.exterior).length} outside), doors ${kinds.door ?? 0}, windows ${kinds.window ?? 0}, openings ${kinds.opening ?? 0}`;
        expect(d.walls.length, summary).toBeGreaterThanOrEqual(6);
        expect(d.walls.length, summary).toBeLessThanOrEqual(8);
        expect(d.walls.filter((w) => w.exterior).length, summary).toBe(4);
        expect(kinds.door ?? 0, summary).toBe(3);
        expect(kinds.window ?? 0, summary).toBe(4);
      });
});
