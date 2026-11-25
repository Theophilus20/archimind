import { describe, expect, it } from 'vitest';
import { detect } from './detector';
import { sampleModel } from '../model/sample';
import { openingFrame, doorSwingPolygon, wallDir, wallNormal, add, mul, furnitureFootprint } from '../model/geometry';

/** Rasterise the sample model like a clean drawing: solid walls, thin window and door marks, some text noise. */
function rasterise() {
  const m = sampleModel();
  const S = 0.1;
  const O = 120;
  const W = 1440;
  const H = 1100;
  const img = new Uint8Array(W * H);
  const dot = (x: number, y: number, r = 0) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px >= 0 && py >= 0 && px < W && py < H) img[py * W + px] = 1;
      }
  };
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let i = 0; i <= n; i++) dot(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
  };
  const P = (p: { x: number; y: number }) => ({ x: O + p.x * S, y: O + p.y * S });
  for (const w of m.walls) {
    const dir = wallDir(w);
    const n = wallNormal(w);
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const ext = w.exterior ? w.thickness / 2 : 0;
    const ops = m.openings.filter((o) => o.wallId === w.id).sort((a, b) => a.offset - b.offset);
    const spans: [number, number][] = [];
    let c = -ext;
    for (const o of ops) {
      spans.push([c, o.offset - o.width / 2]);
      c = o.offset + o.width / 2;
    }
    spans.push([c, L + ext]);
    for (const [s, e] of spans)
      for (let a = s; a <= e; a += 5)
        for (let t = -w.thickness / 2; t <= w.thickness / 2; t += 5) {
          const p = P(add(add(w.a, mul(dir, a)), mul(n, t)));
          dot(p.x, p.y);
        }
  }
  for (const o of m.openings) {
    const w = m.walls.find((x) => x.id === o.wallId)!;
    const f = openingFrame(o, w);
    if (o.kind === 'window') {
      for (const k of [-0.5, 0, 0.5]) {
        const a = P(add(f.start, mul(f.normal, w.thickness * k)));
        const b = P(add(f.end, mul(f.normal, w.thickness * k)));
        line(a.x, a.y, b.x, b.y);
      }
    } else if (o.kind === 'door') {
      const sw = doorSwingPolygon(o, w, 40).map(P);
      line(sw[0].x, sw[0].y, sw[sw.length - 1].x, sw[sw.length - 1].y);
      for (let i = 1; i + 1 < sw.length; i++) line(sw[i].x, sw[i].y, sw[i + 1].x, sw[i + 1].y);
    }
  }
  // text-like noise
  for (let i = 0; i < 40; i++) line(300 + i * 6, 400, 302 + i * 6, 412);
  return { img, W, H };
}

describe('raster plan detection', () => {
  const { img, W, H } = rasterise();
  const d = detect(img, W, H);

  it('estimates interior and exterior wall thickness', () => {
    expect(d.thickness.min).toBeGreaterThanOrEqual(9);
    expect(d.thickness.min).toBeLessThanOrEqual(12);
    expect(d.thickness.max).toBeGreaterThanOrEqual(24);
    expect(d.thickness.max).toBeLessThanOrEqual(27);
  });

  it('finds the nine walls', () => {
    expect(d.walls).toHaveLength(9);
    expect(d.walls.filter((w) => w.exterior)).toHaveLength(4);
  });

  it('finds openings and classifies them', () => {
    const kinds = d.openings.reduce<Record<string, number>>((acc, o) => ((acc[o.kind] = (acc[o.kind] ?? 0) + 1), acc), {});
    expect(d.openings.length).toBe(14);
    expect(kinds.window).toBe(8);
    expect(kinds.door).toBe(5);
    expect(kinds.opening).toBe(1);
  });

  it('snaps corners onto wall centrelines', () => {
    const top = d.walls.find((w) => w.a.y === w.b.y && Math.abs(w.a.y - 120) < 2)!;
    expect(Math.abs(top.a.x - 120)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(top.b.x - 1320)).toBeLessThanOrEqual(1.5);
  });
});

/**
 * The same home drawn the way many stock plans are: each wall as two thin lines, windows as a
 * glass line between the wall faces, doors as gaps with a leaf and an arc, plus furniture outlines
 * and text.
 */
function rasteriseOutline() {
  const m = sampleModel();
  const S = 0.1;
  const O = 120;
  const W = 1440;
  const H = 1100;
  const img = new Uint8Array(W * H);
  const dot = (x: number, y: number) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px >= 0 && py >= 0 && px < W && py < H) img[py * W + px] = 1;
  };
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const n = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let i = 0; i <= n; i++) dot(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
  };
  const P = (p: { x: number; y: number }) => ({ x: O + p.x * S, y: O + p.y * S });
  const seg = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const A = P(a);
    const B = P(b);
    line(A.x, A.y, B.x, B.y);
  };
  for (const w of m.walls) {
    const dir = wallDir(w);
    const n = wallNormal(w);
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const ext = w.exterior ? w.thickness / 2 : 0;
    const at = (a: number, t: number) => add(add(w.a, mul(dir, a)), mul(n, t));
    // Doors and plain openings break the wall; windows keep the face lines.
    const gaps = m.openings.filter((o) => o.wallId === w.id && o.kind !== 'window').sort((a, b) => a.offset - b.offset);
    let c = -ext;
    const spans: [number, number][] = [];
    for (const o of gaps) {
      spans.push([c, o.offset - o.width / 2]);
      c = o.offset + o.width / 2;
    }
    spans.push([c, L + ext]);
    for (const [s, e] of spans) for (const t of [-w.thickness / 2, w.thickness / 2]) seg(at(s, t), at(e, t));
    for (const o of m.openings.filter((x) => x.wallId === w.id)) {
      for (const end of [o.offset - o.width / 2, o.offset + o.width / 2]) seg(at(end, -w.thickness / 2), at(end, w.thickness / 2));
      if (o.kind === 'window') seg(at(o.offset - o.width / 2, 0), at(o.offset + o.width / 2, 0));
    }
  }
  for (const o of m.openings.filter((x) => x.kind === 'door')) {
    const w = m.walls.find((x) => x.id === o.wallId)!;
    const sw = doorSwingPolygon(o, w, 40).map(P);
    line(sw[0].x, sw[0].y, sw[sw.length - 1].x, sw[sw.length - 1].y);
    for (let i = 1; i + 1 < sw.length; i++) line(sw[i].x, sw[i].y, sw[i + 1].x, sw[i + 1].y);
  }
  // furniture outlines
  for (const f of m.furniture) {
    const fp = furnitureFootprint(f);
    fp.forEach((p, i) => seg(p, fp[(i + 1) % fp.length]));
  }
  for (let i = 0; i < 40; i++) line(300 + i * 6, 400, 302 + i * 6, 412);
  return { img, W, H, m };
}

describe('raster plan detection, walls drawn as two thin lines', () => {
  const { img, W, H, m } = rasteriseOutline();
  const d = detect(img, W, H);
  const kinds = d.openings.reduce<Record<string, number>>((acc, o) => ((acc[o.kind] = (acc[o.kind] ?? 0) + 1), acc), {});

  it('finds the walls', () => {
    expect(d.walls).toHaveLength(m.walls.length);
    expect(d.walls.filter((w) => w.exterior)).toHaveLength(4);
  });

  it('finds the doors and windows', () => {
    expect(kinds.door ?? 0).toBe(5);
    expect(kinds.window ?? 0).toBeGreaterThanOrEqual(7);
    expect(kinds.window ?? 0).toBeLessThanOrEqual(10);
  });
});

describe('a door right beside a corner', () => {
  it('carries the wall on to the corner and finds the door in the gap', () => {
    const W = 700;
    const H = 500;
    const img = new Uint8Array(W * H);
    const dot = (x: number, y: number) => {
      const px = Math.round(x);
      const py = Math.round(y);
      if (px >= 0 && py >= 0 && px < W && py < H) img[py * W + px] = 1;
    };
    const line = (ax: number, ay: number, bx: number, by: number) => {
      const n = Math.ceil(Math.hypot(bx - ax, by - ay));
      for (let i = 0; i <= n; i++) dot(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
    };
    // Outside walls as two lines 20 px apart: a 600 × 400 box from (50, 50).
    for (const s of [-10, 10]) {
      line(50 - 10, 50 + s, 650 + 10, 50 + s);
      line(50 - 10, 450 + s, 650 + 10, 450 + s);
      line(50 + s, 50 - 10, 50 + s, 450 + 10);
      line(650 + s, 50 - 10, 650 + s, 450 + 10);
    }
    // An inside wall at x = 350 (lines 10 px apart) from the top wall down to y = 370, then a
    // door gap from 370 to 434 right beside the bottom wall (its inner face is at y = 440).
    for (const s of [-5, 5]) line(350 + s, 60, 350 + s, 370);
    line(345, 370, 355, 370);
    // the door: leaf and quarter-circle swing into the right-hand room
    line(355, 370, 419, 370);
    for (let a = 0; a <= 90; a += 1) dot(355 + 64 * Math.cos((a * Math.PI) / 180), 370 + 64 * Math.sin((a * Math.PI) / 180));
    const d = detect(img, W, H);
    const inside = d.walls.find((w) => w.a.x === w.b.x && Math.abs(w.a.x - 350) < 4);
    expect(inside).toBeDefined();
    expect(Math.max(inside!.a.y, inside!.b.y)).toBeGreaterThan(440);
    expect(d.openings.some((o) => o.wallId === inside!.id && o.kind === 'door')).toBe(true);
  });
});

import { splitAtJunctions } from './detector';

describe('windows either side of a partition', () => {
  it('are two windows, not one running through the partition', () => {
    const walls = [
      { id: 'W1', a: { x: 0, y: 50 }, b: { x: 600, y: 50 }, thickness: 12, exterior: true, confidence: 1 },
      // a partition from the outer wall's centreline down into the house, at x 300
      { id: 'W2', a: { x: 300, y: 50 }, b: { x: 300, y: 250 }, thickness: 6, exterior: false, confidence: 1 },
    ];
    const window = { id: 'O1', wallId: 'W1', offset: 300, width: 72, kind: 'window' as const, swing: 1 as const, hinge: 'start' as const, confidence: 0.9 };
    const out = splitAtJunctions(walls, [window]);
    expect(out).toHaveLength(2);
    expect(out.map((o) => [o.offset, o.width])).toEqual([
      [280.5, 33],
      [319.5, 33],
    ]);
    // a door there is left alone, and so is a window the partition does not meet
    expect(splitAtJunctions(walls, [{ ...window, kind: 'door' }])).toHaveLength(1);
    expect(splitAtJunctions(walls, [{ ...window, offset: 450 }])).toHaveLength(1);
  });
});
