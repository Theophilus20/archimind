import { describe, expect, it } from 'vitest';
import { openingsFromBoxes, outdoorSpaceOps } from './aiplan';
import { sampleModel, emptyModel } from '../model/sample';
import { roomWalls } from '../model/edittools';
import { applyEdits } from '../model/edits';
import { derive } from '../model/derive';
import type { BuildingModel, EditOp } from '../model/types';

const run = (m: BuildingModel, ops: EditOp[] | string) => {
  if (typeof ops === 'string') throw new Error(ops);
  const r = applyEdits(m, ops);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.model;
};
// 1000 × 1000 px image at 20 mm per px from the origin: box units of 1 = 20 mm.
const toMm = (p: { x: number; y: number }) => ({ x: p.x * 20, y: p.y * 20 });
const sizes = { doorHeight: 2100, windowSill: 900, windowHead: 2100 };

describe('doors and windows read by AI', () => {
  it('puts a missed door on the wall it sits on, on the side it swings into', () => {
    const m = sampleModel();
    // W8 runs along y = 5200 from x 0 to 12000. A door drawn at x 1600..2500 swinging down (y 5200..6100).
    const box: [number, number, number, number] = [260, 80, 305, 125];
    const [door] = openingsFromBoxes([box], 'door', 1000, 1000, toMm, m.walls.filter((w) => w.id === 'W8'), [], sizes);
    expect(door.wallId).toBe('W8');
    expect(Math.abs(door.offset - 2050)).toBeLessThan(60);
    expect(door.width).toBe(900);
    // W8 runs left to right, so its left normal points up (−y); the door swings down.
    expect(door.swing).toBe(-1);
    // a second read of the same door is not added twice
    expect(openingsFromBoxes([box, box], 'door', 1000, 1000, toMm, m.walls.filter((w) => w.id === 'W8'), [], sizes)).toHaveLength(1);
  });

  it('leaves alone doors the pixel check already found, and boxes far from any wall', () => {
    const m = sampleModel();
    const known = m.openings.filter((o) => o.kind === 'door');
    const d = known[0];
    const w = m.walls.find((x) => x.id === d.wallId)!;
    const along = { x: w.a.x + ((w.b.x - w.a.x) * d.offset) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y), y: w.a.y + ((w.b.y - w.a.y) * d.offset) / Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) };
    const u = (v: number) => Math.round(v / 20);
    const onKnown: [number, number, number, number] = [u(along.y - 400), u(along.x - 400), u(along.y + 400), u(along.x + 400)];
    const farAway: [number, number, number, number] = [900, 900, 940, 940];
    expect(openingsFromBoxes([onKnown, farAway], 'door', 1000, 1000, toMm, m.walls, m.openings, sizes)).toHaveLength(0);
  });
});

describe('outdoor spaces read by AI', () => {
  it('adds a porch outside the building with low walls, a way in, and its own space', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6000 }));
    // A porch box roughly against the bottom wall (y = 6000): AI says y 6150..8000.
    const res = outdoorSpaceOps(m1, { minX: 3000, minY: 6150, maxX: 5500, maxY: 8000 });
    expect(res).not.toBeNull();
    const m2 = run(m1, res!.ops);
    const low = m2.walls.filter((w) => !m1.walls.some((x) => x.id === w.id));
    expect(low).toHaveLength(3); // the side against the house is the house wall
    expect(low.every((w) => w.height === 1000)).toBe(true);
    expect(m2.openings.some((o) => o.kind === 'opening' && low.some((w) => w.id === o.wallId))).toBe(true);
    expect(derive(m2).rooms).toHaveLength(2);
  });

  it('closes a porch against walls that are not on round numbers', () => {
    const m0 = emptyModel();
    // a house whose bottom wall is at y = 6003 and a wing whose wall ends at y = 9148
    const m1 = run(m0, [...(roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6003 }) as never[])]);
    const m2 = run(m1, roomWalls(m1, { x: 8000, y: 6003 }, { x: 10000, y: 9148 }) as never[]);
    const res = outdoorSpaceOps(m2, { minX: 5000, minY: 6100, maxX: 7990, maxY: 9120 });
    expect(res).not.toBeNull();
    const m3 = run(m2, res!.ops);
    expect(derive(m3).rooms).toHaveLength(3);
  });

  it('skips a box that is already a room', () => {
    const m0 = emptyModel();
    const m1 = run(m0, roomWalls(m0, { x: 0, y: 0 }, { x: 8000, y: 6000 }));
    expect(outdoorSpaceOps(m1, { minX: 1000, minY: 1000, maxX: 4000, maxY: 4000 })).toBeNull();
  });
});
