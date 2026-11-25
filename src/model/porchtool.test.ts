import { describe, expect, it } from 'vitest';
import { porchKindOps, porchOps } from './porchtool';
import { applyEdits } from './edits';
import { derive } from './derive';
import { porchRoof } from './porch';
import { emptyModel } from './sample';
import { pointInPolygon } from './geometry';
import type { BuildingModel, Wall } from './types';

const wall = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, t = 250): Wall => ({ id, a, b, thickness: t, height: 2700, materialId: 'plaster', exterior: true, prov: {} });
/** A 6 x 4 m house, with a room called Living. */
const house = (): BuildingModel => ({
  ...emptyModel(),
  walls: [wall('W1', { x: 0, y: 0 }, { x: 6000, y: 0 }), wall('W2', { x: 6000, y: 0 }, { x: 6000, y: 4000 }), wall('W3', { x: 6000, y: 4000 }, { x: 0, y: 4000 }), wall('W4', { x: 0, y: 4000 }, { x: 0, y: 0 })],
  rooms: [{ id: 'R1', name: 'Living', type: 'living', floorMaterialId: 'oak', seed: { x: 3000, y: 2000 }, prov: {} }],
});
const build = (m: BuildingModel, at: { x: number; y: number }, kind: Parameters<typeof porchOps>[2]) => {
  const r = porchOps(m, at, kind);
  if (typeof r === 'string') throw new Error(r);
  const res = applyEdits(m, r.ops);
  expect(res.ok).toBe(true);
  return res.model;
};
const porchAt = (m: BuildingModel, p: { x: number; y: number }) => derive(m).rooms.find((r) => pointInPolygon(p, r.polygon));

describe('adding a porch', () => {
  it('puts a covered porch against the outside wall you click, with handrails and a way in', () => {
    const m = build(house(), { x: 3000, y: 4600 }, 'porch');
    const rails = m.walls.filter((w) => w.kind === 'railing');
    expect(rails).toHaveLength(3);
    expect(rails.every((w) => w.height === 1000)).toBe(true);
    // 2.4 m along the wall, centred on the click, 1.8 m out from the wall's outside face
    const xs = rails.flatMap((w) => [w.a.x, w.b.x]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([1800, 4200]);
    expect(Math.max(...rails.flatMap((w) => [w.a.y, w.b.y]))).toBe(4000 + 125 + 1800);
    expect(m.openings.filter((o) => o.kind === 'opening')).toHaveLength(1);
    const p = porchAt(m, { x: 3000, y: 5000 })!;
    expect(p).toMatchObject({ name: 'Covered porch', porchKind: 'porch' });
    // projecting from the wall: its own lean-to roof
    expect(porchRoof(m, p)).toBe('own');
  });

  it('runs a veranda the whole length of the wall, and turns a wrap-around porch round the corner', () => {
    const v = build(house(), { x: 1000, y: 4600 }, 'veranda');
    const vx = v.walls.filter((w) => w.kind === 'railing').flatMap((w) => [w.a.x, w.b.x]);
    expect([Math.min(...vx), Math.max(...vx)]).toEqual([0, 6000]);
    // clicked near the right-hand end: it turns onto the right-hand wall
    const w = build(house(), { x: 5000, y: 4600 }, 'wrap');
    const rails = w.walls.filter((x) => x.kind === 'railing');
    expect(Math.max(...rails.flatMap((x) => [x.a.x, x.b.x]))).toBe(6000 + 125 + 2400);
    expect(Math.min(...rails.flatMap((x) => [x.a.y, x.b.y]))).toBe(0);
    expect(porchAt(w, { x: 7000, y: 1000 })?.porchKind).toBe('wrap');
    expect(porchAt(w, { x: 3000, y: 5000 })?.porchKind).toBe('wrap');
  });

  it('gives a patio a low paving edge open along its sides and no roof, and a screened porch full-height screens', () => {
    const p = build(house(), { x: 3000, y: -600 }, 'patio');
    const edges = p.walls.filter((w) => w.kind === 'railing');
    expect(edges.every((w) => w.height === 150)).toBe(true);
    expect(p.openings.filter((o) => o.kind === 'opening').length).toBe(edges.length);
    const room = porchAt(p, { x: 3000, y: -1000 })!;
    expect(porchRoof(p, room)).toBe('none');
    const s = build(house(), { x: 6600, y: 2000 }, 'screened');
    expect(s.walls.filter((w) => w.kind === 'railing').every((w) => w.height === 2100)).toBe(true);
  });

  it('changes a porch to another kind, and refuses a wall inside the house', () => {
    const m = build(house(), { x: 3000, y: 4600 }, 'porch');
    const room = porchAt(m, { x: 3000, y: 5000 })!;
    const res = applyEdits(m, porchKindOps(m, room.id, 'deck'));
    expect(res.ok).toBe(true);
    const deck = porchAt(res.model, { x: 3000, y: 5000 })!;
    expect(deck).toMatchObject({ porchKind: 'deck', name: 'Open deck' });
    expect(porchRoof(res.model, deck)).toBe('none');
    // a wall with the house on both sides
    const inner = { ...house(), walls: [...house().walls, { ...wall('W5', { x: 3000, y: 0 }, { x: 3000, y: 4000 }, 120), exterior: false }] };
    expect(porchOps(inner, { x: 3100, y: 2000 }, 'porch')).toMatch(/inside the house/);
  });
});

import { pillarOp, PILLAR_TYPES } from './pillars';
import { validateModel } from './validate';

describe('adding a pillar', () => {
  it('stands a pillar of each type where you click, as tall as the walls, and on its own without a warning', () => {
    for (const t of PILLAR_TYPES) {
      const op = pillarOp(house(), { x: 3000, y: 6000 }, t.style);
      const res = applyEdits(house(), [op]);
      expect(res.ok).toBe(true);
      const p = res.model.walls.find((w) => w.kind === 'column')!;
      expect(p).toMatchObject({ columnStyle: t.style, thickness: t.size, height: 2700, materialId: t.material });
      expect(Math.abs(p.b.x - p.a.x)).toBe(t.size);
      expect((p.a.x + p.b.x) / 2).toBe(3000);
      expect(validateModel(res.model).some((i) => i.elementIds.includes(p.id))).toBe(false);
    }
  });
});
