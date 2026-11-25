import { describe, expect, it } from 'vitest';
import { sampleModel } from './sample';
import { applyEdits } from './edits';
import { duplicate, extendWall, mirror, offsetWall, rotate, splitWall } from './edittools';
import { pointAlongWall, wallLength } from './geometry';
import type { EditOp } from './types';

const run = (m: ReturnType<typeof sampleModel>, ops: EditOp[] | string) => {
  if (typeof ops === 'string') throw new Error(ops);
  const r = applyEdits(m, ops);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.model;
};

describe('edit tools', () => {
  it('splits a wall in two and keeps its doors and windows in the same place', () => {
    const m = sampleModel();
    const w = m.walls.find((x) => m.openings.some((o) => o.wallId === x.id))!;
    const hosted = m.openings.filter((o) => o.wallId === w.id);
    const L = wallLength(w);
    // pick a split point clear of every opening
    const at = [0.2, 0.35, 0.5, 0.65, 0.8].map((t) => Math.round(L * t)).find((a) => hosted.every((o) => Math.abs(o.offset - a) > o.width / 2 + 50))!;
    const where = new Map(hosted.map((o) => [o.id, pointAlongWall(w, o.offset)]));
    const out = run(m, splitWall(m, w.id, at));
    expect(out.walls.some((x) => x.id === w.id)).toBe(false);
    expect(out.walls.length).toBe(m.walls.length + 1);
    for (const o of hosted) {
      const moved = out.openings.find((x) => x.id === o.id)!;
      const host = out.walls.find((x) => x.id === moved.wallId)!;
      const p = pointAlongWall(host, moved.offset);
      expect(Math.hypot(p.x - where.get(o.id)!.x, p.y - where.get(o.id)!.y)).toBeLessThan(2);
    }
  });

  it('refuses to split through a door', () => {
    const m = sampleModel();
    const o = m.openings[0];
    expect(typeof splitWall(m, o.wallId, o.offset)).toBe('string');
  });

  it('offsets, duplicates, rotates and mirrors', () => {
    const m = sampleModel();
    const w = m.walls[0];
    expect(run(m, offsetWall(m, w.id, 1000)).walls.length).toBe(m.walls.length + 1);
    expect(run(m, duplicate(m, m.furniture[0].id)).furniture.length).toBe(m.furniture.length + 1);
    const f = m.furniture[0];
    expect(run(m, rotate(m, f.id)).furniture.find((x) => x.id === f.id)!.rotation).toBe(((f.rotation ?? 0) + 90) % 360);
    const door = m.openings.find((o) => o.kind === 'door')!;
    expect(run(m, mirror(m, door.id)).openings.find((o) => o.id === door.id)!.swing).toBe(door.swing === 1 ? -1 : 1);
  });

  it('extends a shortened wall back to the wall ahead of it', () => {
    const m = sampleModel();
    // shorten an interior wall at its b end, then extend it again
    const w = m.walls.find((x) => !x.exterior && !m.openings.some((o) => o.wallId === x.id))!;
    const L = wallLength(w);
    const shortened = run(m, [{ op: 'moveWallEndpoint', wallId: w.id, end: 'b', to: pointAlongWall(w, L - 600) }]);
    const back = run(shortened, extendWall(shortened, w.id));
    const nb = back.walls.find((x) => x.id === w.id)!;
    expect(Math.hypot(nb.b.x - w.b.x, nb.b.y - w.b.y)).toBeLessThan(5);
  });
});

import { copyElements, cornerWalls, deleteElements, elementsInBox, joinWalls, pasteElements } from './edittools';

describe('selection, delete, copy/paste, corner and join', () => {
  it('deletes several elements at once, openings on deleted walls included', () => {
    const m = sampleModel();
    const w = m.walls.find((x) => m.openings.some((o) => o.wallId === x.id))!;
    const out = run(m, deleteElements(m, [w.id, m.furniture[0].id, ...m.openings.filter((o) => o.wallId === w.id).map((o) => o.id)]));
    expect(out.walls.some((x) => x.id === w.id)).toBe(false);
    expect(out.openings.some((o) => o.wallId === w.id)).toBe(false);
    expect(out.furniture.length).toBe(m.furniture.length - 1);
  });

  it('window selects only what is fully inside; crossing also takes what it touches', () => {
    const m = sampleModel();
    // a box around the left half of the top wall W1 (0,0)-(12000,0)
    const window = elementsInBox(m, { x: -500, y: -500 }, { x: 6000, y: 500 }, false);
    const crossing = elementsInBox(m, { x: -500, y: -500 }, { x: 6000, y: 500 }, true);
    expect(window).not.toContain('W1');
    expect(crossing).toContain('W1');
    const all = elementsInBox(m, { x: -1000, y: -1000 }, { x: 13000, y: 10000 }, false);
    expect(all).toEqual(expect.arrayContaining(m.walls.map((x) => x.id)));
  });

  it('pastes copies with new ids, doors moving with their walls', () => {
    const m = sampleModel();
    const w = m.walls.find((x) => m.openings.some((o) => o.wallId === x.id))!;
    const clip = copyElements(m, [w.id, m.furniture[0].id]);
    const { ops, ids } = pasteElements(m, clip, { x: 1000, y: 1000 });
    const out = run(m, ops);
    expect(out.walls.length).toBe(m.walls.length + 1);
    expect(out.furniture.length).toBe(m.furniture.length + 1);
    expect(out.openings.length).toBe(m.openings.length + clip.openings.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('corners two walls and joins two walls in a line', () => {
    const m = sampleModel();
    // two separate walls that stop short of each other, then corner them
    const base = m.walls[0];
    const apart = run(m, [
      { op: 'addWall', wall: { ...base, id: 'X1', a: { x: 2000, y: -3000 }, b: { x: 2000, y: -1000 } } },
      { op: 'addWall', wall: { ...base, id: 'X2', a: { x: 2500, y: -500 }, b: { x: 5000, y: -500 } } },
    ]);
    const cornered = run(apart, cornerWalls(apart, 'X1', 'X2'));
    expect(cornered.walls.find((x) => x.id === 'X1')!.b).toEqual({ x: 2000, y: -500 });
    expect(cornered.walls.find((x) => x.id === 'X2')!.a).toEqual({ x: 2000, y: -500 });
    const w3 = m.walls.find((x) => x.id === 'W3')!;
    const hosted = m.openings.filter((o) => o.wallId === 'W3');
    const at = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((t) => Math.round(wallLength(w3) * t)).find((p) => hosted.every((o) => Math.abs(o.offset - p) > o.width / 2 + 50))!;
    const split = run(m, splitWall(m, 'W3', at));
    const parts = split.walls.filter((x) => !m.walls.some((y) => y.id === x.id)).map((x) => x.id);
    const rejoined = run(split, joinWalls(split, parts[0], parts[1]));
    expect(rejoined.walls.length).toBe(m.walls.length);
    expect(rejoined.openings.length).toBe(m.openings.length);
  });
});

describe('hand-placed dimensions', () => {
  it('adds, selects in a box, and deletes a dimension; ids never clash', () => {
    const m = sampleModel();
    const withDim = run(m, [{ op: 'addDimension', dimension: { id: 'DIM1', a: { x: 0, y: 0 }, b: { x: 4500, y: 0 }, offset: -800 } }]);
    expect(withDim.dimensions).toHaveLength(1);
    expect(elementsInBox(withDim, { x: -200, y: -200 }, { x: 4700, y: 200 }, false)).toContain('DIM1');
    const gone = run(withDim, deleteElements(withDim, ['DIM1']));
    expect(gone.dimensions ?? []).toHaveLength(0);
    // a dimension needs two different points
    expect(applyEdits(m, [{ op: 'addDimension', dimension: { id: 'DIM2', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, offset: 500 } }]).ok).toBe(false);
  });
});

import { dimensionsOnLevel } from './edittools';

describe('dimensions per floor and when hidden', () => {
  it('shows a dimension only on the floor it was drawn on, and box select can skip hidden ones', () => {
    const m = { ...sampleModel(), activeLevel: 1 };
    const out = run(m, [
      { op: 'addDimension', dimension: { id: 'DIM1', a: { x: 0, y: 0 }, b: { x: 4500, y: 0 }, offset: -800, level: 1 } },
      { op: 'addDimension', dimension: { id: 'DIM2', a: { x: 0, y: 0 }, b: { x: 3000, y: 0 }, offset: -800 } },
    ]);
    expect(dimensionsOnLevel(out).map((d) => d.id)).toEqual(['DIM1']);
    expect(dimensionsOnLevel({ ...out, activeLevel: 0 }).map((d) => d.id)).toEqual(['DIM2']);
    expect(elementsInBox(out, { x: -200, y: -200 }, { x: 4700, y: 200 }, false)).toContain('DIM1');
    expect(elementsInBox(out, { x: -200, y: -200 }, { x: 4700, y: 200 }, false, false)).not.toContain('DIM1');
  });
});

import { roomWalls } from './edittools';
import { emptyModel } from './sample';
import { derive } from './derive';

describe('sketching rooms', () => {
  it('draws a room on an empty plan, then a second room beside it that shares a wall', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 4000, y: 3000 }));
    expect(m1.walls).toHaveLength(4);
    expect(m1.walls.every((w) => w.exterior)).toBe(true);
    expect(derive(m1).rooms).toHaveLength(1);
    // A taller room to the right: the shared stretch of x = 4000 isn't drawn twice.
    const m2 = run(m1, roomWalls(m1, { x: 4000, y: 0 }, { x: 7000, y: 4000 }));
    expect(m2.walls.length).toBe(4 + 4);
    const rooms = derive(m2).rooms;
    expect(rooms).toHaveLength(2);
    expect(rooms.map((r) => Math.round(r.grossArea)).sort((a, b) => a - b)).toEqual([12, 12]);
  });

  it('a room drawn inside the building adds partitions', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6000 }));
    const m2 = run(m1, roomWalls(m1, { x: 0, y: 0 }, { x: 3000, y: 2500 }));
    const added = m2.walls.filter((w) => !m1.walls.some((x) => x.id === w.id));
    expect(added).toHaveLength(2);
    expect(added.every((w) => !w.exterior)).toBe(true);
    expect(derive(m2).rooms).toHaveLength(2);
  });
});

describe('fixing the scale after import', () => {
  it('rescales the whole plan from one wall’s real length, keeping heights and doors on their walls', () => {
    const m = sampleModel();
    const before = derive(m).rooms.map((r) => r.grossArea);
    const out = run(m, [{ op: 'rescale', factor: 1.25 }]);
    expect(wallLength(out.walls[0])).toBeCloseTo(wallLength(m.walls[0]) * 1.25, 0);
    expect(out.walls[0].height).toBe(m.walls[0].height);
    const after = derive(out).rooms.map((r) => r.grossArea);
    expect(after).toHaveLength(before.length);
    after.forEach((a, i) => expect(a / before[i]).toBeCloseTo(1.5625, 1));
    const door = out.openings.find((o) => o.kind === 'door')!;
    expect(door.offset).toBe(Math.round(m.openings.find((o) => o.id === door.id)!.offset * 1.25));
    expect(applyEdits(m, [{ op: 'rescale', factor: 100 }]).ok).toBe(false);
  });
});
