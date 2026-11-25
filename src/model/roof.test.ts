import { describe, expect, it } from 'vitest';
import { roofRects, roofShape } from './roof';
import { roomWalls } from './edittools';
import { applyEdits } from './edits';
import { emptyModel, sampleModel } from './sample';
import type { BuildingModel, EditOp } from './types';

const run = (m: BuildingModel, ops: EditOp[] | string) => {
  if (typeof ops === 'string') throw new Error(ops);
  const r = applyEdits(m, ops);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.model;
};

describe('roofs fitted to the building', () => {
  it('a plain rectangle gets one roof piece', () => {
    const m = { ...sampleModel(), roof: { kind: 'gable' as const, pitch: 35, overhang: 400, ridge: 'auto' as const, materialId: 'roof-tile', prov: {} } };
    expect(roofRects(m)).toHaveLength(1);
    expect(roofShape(m)!.ridges).toHaveLength(1);
  });

  it('an L-shaped house gets a roof over each wing and none over the open corner', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 10000, y: 5000 }));
    const m2 = run(m1, roomWalls(m1, { x: 0, y: 5000 }, { x: 4000, y: 10000 }));
    const m = { ...m2, roof: { kind: 'hip' as const, pitch: 30, overhang: 300, ridge: 'auto' as const, materialId: 'roof-tile', prov: {} } };
    const rects = roofRects(m);
    expect(rects).toHaveLength(2);
    // nothing over the empty quarter at (7000, 8000)
    expect(rects.some((r) => 7000 > r.minX && 7000 < r.maxX && 8000 > r.minY && 8000 < r.maxY)).toBe(false);
    // one roof over both wings (as BIM tools build it from the footprint), an L-shaped outline
    const shape = roofShape(m)!;
    expect(shape.outlines).toHaveLength(1);
    expect(shape.outlines[0]).toHaveLength(6);
  });

  it('a porch with handrails stays open', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6000 }));
    const porch = roomWalls(m1, { x: 2000, y: 6000 }, { x: 5000, y: 8000 });
    if (typeof porch === 'string') throw new Error(porch);
    const m2 = run(
      m1,
      porch.map((op) => (op.op === 'addWall' ? { ...op, wall: { ...op.wall, kind: 'railing' as const, height: 1000, thickness: 60, exterior: false } } : op)),
    );
    const rects = roofRects(m2);
    expect(rects).toHaveLength(1);
    expect(rects[0].maxY).toBe(6000);
  });
});

import { derive } from './derive';
import { isPorch, porchRoof } from './porch';

describe('porch roofs', () => {
  const railing = (ops: EditOp[]) => ops.map((op) => (op.op === 'addWall' ? { ...op, wall: { ...op.wall, kind: 'railing' as const, height: 1000, thickness: 60, exterior: false } } : op));
  const roofed = (m: BuildingModel) => ({ ...m, roof: { kind: 'gable' as const, pitch: 30, overhang: 300, ridge: 'auto' as const, materialId: 'roof-tile', prov: {} } });

  it('a porch set into the corner of an L-shaped house goes under the main roof', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 10000, y: 6000 }));
    const m2 = run(m1, roomWalls(m1, { x: 7000, y: 6000 }, { x: 10000, y: 9000 })); // a laundry wing
    const porch = roomWalls(m2, { x: 4500, y: 6000 }, { x: 7000, y: 9000 });
    if (typeof porch === 'string') throw new Error(porch);
    const m3 = roofed(run(m2, railing(porch)));
    const room = derive(m3).rooms.find((r) => isPorch(m3, r))!;
    expect(porchRoof(m3, room)).toBe('main');
    // the main roof now reaches over the porch
    expect(roofRects(m3).some((r) => r.minX <= 5000 && r.maxX >= 6500 && r.maxY >= 9000)).toBe(true);
  });

  it('a porch sticking out from a flat wall keeps its own roof, and the choice can be changed', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6000 }));
    const porch = roomWalls(m1, { x: 2000, y: 6000 }, { x: 5000, y: 8000 });
    if (typeof porch === 'string') throw new Error(porch);
    const m2 = roofed(run(m1, railing(porch)));
    const room = derive(m2).rooms.find((r) => isPorch(m2, r))!;
    expect(porchRoof(m2, room)).toBe('own');
    expect(roofRects(m2)).toHaveLength(1);
    expect(roofRects(m2)[0].maxY).toBe(6000);
    // set to go under the main roof
    const m3 = run(m2, [{ op: 'setRoom', roomId: room.id, patch: { porchRoof: 'main' } }]);
    expect(roofRects(m3).some((r) => r.maxY >= 8000)).toBe(true);
  });
});

describe('gable and hip roofs from one footprint', () => {
  const roof = (m: BuildingModel, kind: 'gable' | 'hip', overhang = 400) => ({ ...m, roof: { kind, pitch: 30, overhang, ridge: 'auto' as const, materialId: 'roof-tile', prov: {} } });
  const lShape = () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 10000, y: 5000 }));
    return run(m1, roomWalls(m1, { x: 0, y: 5000 }, { x: 4000, y: 10000 }));
  };

  it('an L-shaped hip roof has a valley at the inside corner and hips at the outside ones', () => {
    const s = roofShape(roof(lShape(), 'hip'))!;
    // six corners: five outside hips and one valley, all at 45°
    expect(s.hips).toHaveLength(6);
    for (const [a, b] of s.hips) expect(Math.abs(Math.abs(b.x - a.x) - Math.abs(b.y - a.y))).toBeLessThan(1);
    expect(s.ridges.length).toBeGreaterThanOrEqual(2);
  });

  it('the eave meets the outer face of the wall at wall-top height, and the ridge is where the pitch says', () => {
    const m = roof(lShape(), 'hip');
    const s = roofShape(m)!;
    const t = m.walls[0].thickness;
    const base = Math.max(...m.walls.map((w) => w.height));
    const tan = Math.tan((30 * Math.PI) / 180);
    // the 5 m deep wing peaks half its width (plus half a wall) above the wall top
    expect(s.peak).toBeCloseTo(base + tan * (2500 + t / 2), -1);
    // lowest point of the roof: the eave, below the wall top by the overhang's drop
    const low = s.triangles.reduce((m, tri) => Math.min(m, tri[0][2], tri[1][2], tri[2][2]), Infinity);
    expect(low).toBeCloseTo(base - 400 * tan, 0);
  });

  it('a gable roof has vertical end walls at the ends of each wing', () => {
    const s = roofShape(roof(lShape(), 'gable'))!;
    expect(s.endWalls.length).toBeGreaterThan(0);
    // the two wing ends (east and south) are gables: ridges run out to them and no hips start there
    const east = Math.max(...s.outlines[0].map((p) => p.x));
    const south = Math.max(...s.outlines[0].map((p) => p.y));
    expect(s.ridges.some(([a, b]) => Math.max(a.x, b.x) === east)).toBe(true);
    expect(s.ridges.some(([a, b]) => Math.max(a.y, b.y) === south)).toBe(true);
    expect(s.hips.some(([a]) => a.x === east || a.y === south)).toBe(false);
  });

  it('a small step in a slightly wrong drawing does not break the roof up', () => {
    // a 10 x 6 m house drawn as three rooms, leaving an 800 mm notch in the back wall
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 4600, y: 6000 }));
    const m2 = run(m1, roomWalls(m1, { x: 5400, y: 0 }, { x: 10000, y: 6000 }));
    const m3 = run(m2, roomWalls(m2, { x: 4600, y: 800 }, { x: 5400, y: 6000 }));
    const s = roofShape(roof(m3, 'gable'))!;
    expect(s.outlines).toHaveLength(1);
    expect(s.outlines[0]).toHaveLength(4);
    expect(s.ridges).toHaveLength(1);
  });
});
