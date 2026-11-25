import { describe, expect, it } from 'vitest';
import { furnitureFromBoxes } from './furniture';
import { furnitureFootprint } from '../model/geometry';

describe('furniture read from a drawing', () => {
  // A 1000 × 800 px image at 10 mm per px, building from (100, 100) px.
  const toMm = (p: { x: number; y: number }) => ({ x: (p.x - 100) * 10, y: (p.y - 100) * 10 });
  const bounds = { minX: 0, minY: 0, maxX: 8000, maxY: 6000 };

  it('places items at the drawing scale and keeps their footprint', () => {
    // a bed drawn lying across the page: a 200 × 160 px box from (300, 200) to (500, 360) px
    const [bed] = furnitureFromBoxes([{ kind: 'bed', box: [250, 300, 450, 500] }], 1000, 800, toMm, bounds);
    expect(bed.x).toBe(3000);
    expect(bed.y).toBe(1800);
    // a bed's length is its depth, so a wide box turns it
    expect(bed.rotation).toBe(90);
    const fp = furnitureFootprint(bed);
    const xs = fp.map((p) => p.x);
    const ys = fp.map((p) => p.y);
    expect(Math.round(Math.max(...xs) - Math.min(...xs))).toBe(2000);
    expect(Math.round(Math.max(...ys) - Math.min(...ys))).toBe(1600);
  });

  it('takes the side a piece faces from the tile, unless it makes a long piece deeper than wide', () => {
    // a bed 2000 x 1600 px-box with its head at the top: 2000 wide, 1600 deep as read
    const [bed] = furnitureFromBoxes([{ kind: 'bed', box: [250, 300, 450, 500], back: 'top' }], 1000, 800, toMm, bounds);
    expect([bed.rotation, bed.w, bed.d]).toEqual([0, 2000, 1600]);
    // a wardrobe 2000 wide along the bottom, read as facing left: the side is ignored
    const [ward] = furnitureFromBoxes([{ kind: 'wardrobe', box: [300, 300, 360, 500], back: 'left' }], 1000, 800, toMm, bounds);
    expect([ward.w, ward.d]).toEqual([2000, 480]);
  });

  it('drops things outside the building and things the wrong size', () => {
    const out = furnitureFromBoxes(
      [
        { kind: 'sofa', box: [200, 200, 240, 400] }, // fine: 2000 × 320 mm
        { kind: 'chair', box: [10, 10, 12, 12] }, // a speck
        { kind: 'table', box: [950, 950, 990, 990] }, // outside the building
      ],
      1000,
      800,
      toMm,
      bounds,
    );
    expect(out.map((f) => f.kind)).toEqual(['sofa']);
    expect(out[0].rotation).toBe(0);
  });
});

import { arrangeFurniture, backToWall, worktopRuns } from './furniture';
import { emptyModel } from '../model/sample';
import type { BuildingModel, Furniture, RoomType, Wall } from '../model/types';

describe('arranging furniture in the building', () => {
  // A 6 × 3 m box split at x = 2 m: a small room on the left, a bigger one on the right.
  const wall = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, t = 200): Wall => ({ id, a, b, thickness: t, height: 2700, materialId: 'plaster', exterior: t > 150, prov: {} });
  const house = (left: RoomType, right: RoomType): BuildingModel => ({
    ...emptyModel(),
    walls: [wall('W1', { x: 0, y: 0 }, { x: 6000, y: 0 }), wall('W2', { x: 6000, y: 0 }, { x: 6000, y: 3000 }), wall('W3', { x: 6000, y: 3000 }, { x: 0, y: 3000 }), wall('W4', { x: 0, y: 3000 }, { x: 0, y: 0 }), wall('W5', { x: 2000, y: 0 }, { x: 2000, y: 3000 }, 100)],
    rooms: [
      { id: 'R1', name: 'Left', type: left, floorMaterialId: 'oak', seed: { x: 1000, y: 1500 }, prov: {} },
      { id: 'R2', name: 'Right', type: right, floorMaterialId: 'oak', seed: { x: 4000, y: 1500 }, prov: {} },
    ],
  });
  const item = (kind: Furniture['kind'], x: number, y: number, w: number, d: number, rotation = 0): Furniture => ({ id: 'X', kind, x, y, w, d, rotation, prov: {} });

  it('keeps things out of rooms they do not belong in, moving them next door when read just over the line', () => {
    const out = arrangeFurniture(house('bathroom', 'living'), [
      item('wc', 1000, 400, 400, 650),
      item('tv', 1700, 1500, 1600, 400), // read across the bathroom wall: it belongs in the living room
      item('chair', 700, 2000, 500, 500), // deep inside the bathroom: left out
    ]);
    expect(out.map((f) => f.kind).sort()).toEqual(['tv', 'wc']);
    const tv = out.find((f) => f.kind === 'tv')!;
    expect(tv.x - tv.w / 2).toBeGreaterThanOrEqual(2050);
  });

  it('puts a bed back to the nearest wall at a usual size', () => {
    const [bed] = arrangeFurniture(house('hall', 'bedroom'), [item('bed', 4000, 1400, 500, 2000)]);
    expect(bed.w).toBe(900);
    expect(bed.rotation).toBe(0); // bedhead to the wall above
    expect(bed.y).toBe(100 + 1000 + 15);
  });

  it('leaves chairs to the table and joins worktop pieces into one run', () => {
    const out = arrangeFurniture(house('hall', 'kitchen'), [
      item('kitchen', 3000, 400, 1000, 600),
      item('kitchen', 4100, 400, 1000, 600),
      item('table', 4000, 2000, 1200, 800),
      item('chair', 4000, 1500, 450, 450),
      item('chair', 3300, 2000, 450, 450),
    ]);
    expect(out.map((f) => f.kind).sort()).toEqual(['kitchen', 'table']);
    const run = out.find((f) => f.kind === 'kitchen')!;
    expect(run.w).toBe(2100);
    expect(run.x).toBe(3550);
    expect(run.y).toBe(100 + 300 + 15);
    expect(out.map((f) => f.id).sort()).toEqual(['F1', 'F2']);
  });

  it('reads the plain cabinet symbol as a sideboard in a living room and a wardrobe in a bedroom', () => {
    const [living] = arrangeFurniture(house('hall', 'living'), [item('wardrobe', 4000, 400, 1600, 500)]);
    expect(living.kind).toBe('sideboard');
    expect(living.d).toBe(500);
    const [bedroom] = arrangeFurniture(house('hall', 'bedroom'), [item('wardrobe', 4000, 400, 1600, 500)]);
    expect(bedroom.kind).toBe('wardrobe');
    expect(bedroom.d).toBe(550);
  });

  it('finds the worktop drawn along a kitchen wall and joins the sink and hob to it', () => {
    const m = house('hall', 'kitchen');
    // the drawing: a worktop front edge 600 mm out from the top wall's face (y 100), x 2600 to 5000
    const ink = (p: { x: number; y: number }) => Math.abs(p.y - 700) <= 10 && p.x >= 2600 && p.x <= 5000;
    const runs = worktopRuns(m, ink, 20);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'kitchen', rotation: 0, d: 600 });
    expect(runs[0].y).toBe(100 + 300);
    expect(Math.round(runs[0].x - runs[0].w / 2)).toBeLessThanOrEqual(2640);
    // the run leads; a sink and a hob read by AI along the same wall join it
    const out = arrangeFurniture(m, [...runs, item('kitchen', 3200, 400, 600, 600), item('kitchen', 4400, 420, 600, 600)]);
    expect(out.filter((f) => f.kind === 'kitchen')).toHaveLength(1);
    // a long worktop the AI read along a wall with no worktop line drawn is left out
    const out2 = arrangeFurniture(m, [...runs, item('kitchen', 4000, 2500, 2500, 600)]);
    expect(out2.filter((f) => f.kind === 'kitchen')).toHaveLength(1);
    // no worktop line: nothing found
    expect(worktopRuns(m, () => false)).toHaveLength(0);
  });

  it('keeps the side a piece faces when it is known, and leaves out a reading far too big to be furniture', () => {
    // a bed read with its head at the bottom stays that way, against the wall below
    const bed: Furniture = { ...item('bed', 4000, 1500, 1600, 2000, 180), prov: { rotation: 'detected' } };
    const [placed] = arrangeFurniture(house('hall', 'bedroom'), [bed]);
    expect(placed.rotation).toBe(180);
    expect(placed.y).toBe(2900 - 1000 - 15);
    // read as facing up but standing against the wall below, with no wall above within reach: the wall below decides
    const ward: Furniture = { ...item('wardrobe', 4000, 2600, 2000, 550, 0), prov: { rotation: 'detected' } };
    const [w] = arrangeFurniture(house('hall', 'bedroom'), [ward]);
    expect(w.rotation).toBe(180);
    // a 2.6 m deep "worktop" is the floor inside a worktop's edge, not a worktop
    expect(arrangeFurniture(house('hall', 'kitchen'), [item('kitchen', 4000, 1500, 2800, 2600)])).toHaveLength(0);
  });

  it('keeps a worktop that runs wall to wall, and takes the chairs off a dining table drawn with them', () => {
    // the right room's inside runs from x 2050 to 5900: a worktop the whole way along the top wall
    const [run] = arrangeFurniture(house('hall', 'kitchen'), [item('kitchen', 3975, 400, 3850, 600)]);
    expect(run.w).toBe(3850);
    const [table] = arrangeFurniture(house('hall', 'dining'), [item('table', 4000, 1500, 2640, 1550)]);
    expect([table.w, table.d]).toEqual([1940, 850]);
  });

  it('falls back on the first reading when the closer look names something that cannot be in the room', () => {
    const coffee = { ...item('kitchen', 4000, 1500, 800, 800), alt: 'table' as const };
    const [t] = arrangeFurniture(house('hall', 'living'), [coffee]);
    expect(t.kind).toBe('table');
    expect('alt' in t).toBe(false);
    // and a long cabinet in a bedroom is a wardrobe
    const [w] = arrangeFurniture(house('hall', 'bedroom'), [item('sideboard', 4000, 400, 2400, 400)]);
    expect(w.kind).toBe('wardrobe');
  });

  it('turns a piece to the nearest wall when asked', () => {
    const m = house('hall', 'living');
    const moved = backToWall(m, item('wardrobe', 5500, 1500, 1800, 600), { turn: true })!;
    expect(moved.rotation).toBe(90); // back to the wall on the right
    expect(moved.x).toBe(5900 - 300 - 15);
    // out of reach of every wall
    expect(backToWall(m, item('wardrobe', 4000, 1500, 1000, 600), { reach: 300 })).toBeNull();
  });
});
