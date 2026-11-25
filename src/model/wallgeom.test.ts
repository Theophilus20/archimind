import { describe, expect, it } from 'vitest';
import { wallSolids } from './wallgeom';
import { add, mul, wallDir, wallNormal } from './geometry';
import { emptyModel } from './sample';
import type { Wall } from './types';

const wall = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, t = 200): Wall => ({ id, a, b, thickness: t, height: 2700, materialId: 'plaster', exterior: true, prov: {} });
const face = (w: Wall, along: number, side: 1 | -1) => add(add(w.a, mul(wallDir(w), along)), mul(wallNormal(w), (side * w.thickness) / 2));
const close = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y) < 1;

describe('wall joins', () => {
  it('mitres an angled corner so both faces meet exactly (no gap, no step)', () => {
    const a = Math.PI / 6; // a 30 degree bend, like a faceted curved facade
    const w1 = wall('W1', { x: 0, y: 0 }, { x: 5000, y: 0 });
    const w2 = wall('W2', { x: 5000, y: 0 }, { x: 5000 + 5000 * Math.cos(a), y: 5000 * Math.sin(a) });
    const m = { ...emptyModel(), walls: [w1, w2] };
    const [s1, s2] = wallSolids(m);
    const e1 = [face(w1, s1.ends.endL, 1), face(w1, s1.ends.endR, -1)];
    const b2 = [face(w2, s2.ends.startL, 1), face(w2, s2.ends.startR, -1)];
    // every corner of W1's end is also a corner of W2's start
    for (const p of e1) expect(b2.some((q) => close(p, q))).toBe(true);
  });

  it('keeps square corners and stops a T-junction at the host face', () => {
    const w1 = wall('W1', { x: 0, y: 0 }, { x: 6000, y: 0 });
    const w2 = wall('W2', { x: 6000, y: 0 }, { x: 6000, y: 4000 });
    const t = wall('W3', { x: 3000, y: 0 }, { x: 3000, y: 4000 }, 100);
    const sol = wallSolids({ ...emptyModel(), walls: [w1, w2, t] });
    const st = sol[2];
    // the stem's faces both stop on the host's face, half the host thickness from its centre line
    expect(st.ends.startL).toBeCloseTo(100, 0);
    expect(st.ends.startR).toBeCloseTo(100, 0);
    // square corner: the faces of the corner walls still close the corner
    const c1 = [face(w1, sol[0].ends.endL, 1), face(w1, sol[0].ends.endR, -1)];
    const c2 = [face(w2, sol[1].ends.startL, 1), face(w2, sol[1].ends.startR, -1)];
    for (const p of c1) expect(c2.some((q) => close(p, q))).toBe(true);
  });
});


import { spanEnds } from './wallgeom';

describe('a door at the very end of a wall', () => {
  it('leaves its gap open: the stretch after it is not pulled back to the corner', () => {
    // a wall meeting a 270 mm wall at its start, with a 730 mm door right at that corner
    const host = wall('W1', { x: 0, y: 0 }, { x: 6000, y: 0 }, 270);
    const w = wall('W2', { x: 3000, y: 0 }, { x: 3000, y: 3771 }, 140);
    const m = { ...emptyModel(), walls: [host, w], openings: [{ id: 'D1', kind: 'door' as const, wallId: 'W2', offset: 498, width: 730, height: 2100, sill: 0, hinge: 'start' as const, swing: 1 as const, prov: {} }] };
    const s = wallSolids(m).find((x) => x.wall.id === 'W2')!;
    expect(s.spans[0][0]).toBeCloseTo(863, 0);
    const e = spanEnds(s, s.spans[0][0], s.spans[0][1]);
    // the stretch starts after the door, not at the host wall's face (135 mm)
    expect(e.sL).toBeCloseTo(863, 0);
    expect(e.sR).toBeCloseTo(863, 0);
  });
});
