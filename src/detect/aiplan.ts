/**
 * What AI reads from a drawing, merged with what the pixel check found: doors and windows it
 * missed (snapped onto the nearest wall) and outdoor spaces such as a porch (low walls around it,
 * with a way in). Boxes are [ymin, xmin, ymax, xmax], each 0 to 1000 across the image.
 */
import { add, dist, dot, mul, sub, wallDir, wallLength, wallNormal } from '../model/geometry';
import { roomWalls } from '../model/edittools';
import { derive } from '../model/derive';
import { pointInPolygon } from '../model/geometry';
import type { BuildingModel, EditOp, Opening, OpeningKind, Vec2, Wall } from '../model/types';
import { nextId } from '../model/edits';

export type Box = [number, number, number, number];

/** A box on the image, as a rectangle in the model (mm). */
export function boxToMm(box: Box, imageW: number, imageH: number, toMm: (p: Vec2) => Vec2) {
  const [y0, x0, y1, x1] = box;
  const a = toMm({ x: (x0 / 1000) * imageW, y: (y0 / 1000) * imageH });
  const b = toMm({ x: (x1 / 1000) * imageW, y: (y1 / 1000) * imageH });
  return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

/**
 * Doors or windows read by AI that the pixel check missed: each is placed on the wall it sits
 * on, with its width along that wall, unless an opening is already there.
 */
export function openingsFromBoxes(
  boxes: Box[],
  kind: Extract<OpeningKind, 'door' | 'window'>,
  imageW: number,
  imageH: number,
  toMm: (p: Vec2) => Vec2,
  walls: Wall[],
  existing: Pick<Opening, 'wallId' | 'offset' | 'width'>[],
  sizes: { doorHeight: number; windowSill: number; windowHead: number },
): Omit<Opening, 'id'>[] {
  const taken = [...existing];
  const out: Omit<Opening, 'id'>[] = [];
  for (const box of boxes) {
    const r = boxToMm(box, imageW, imageH, toMm);
    const c = { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
    const bw = r.maxX - r.minX;
    const bh = r.maxY - r.minY;
    if (Math.max(bw, bh) < 250 || Math.max(bw, bh) > 6000) continue;
    let best: { w: Wall; t: number; d: number; along: number } | null = null;
    for (const w of walls) {
      const L = wallLength(w);
      const d = wallDir(w);
      const t = dot(sub(c, w.a), d);
      if (t < 0 || t > L) continue;
      const off = dist(c, add(w.a, mul(d, t)));
      const along = Math.abs(d.x) >= Math.abs(d.y) ? bw : bh;
      const across = Math.abs(d.x) >= Math.abs(d.y) ? bh : bw;
      // A door's box includes its swing, so its centre sits off the wall by up to its width.
      const tol = kind === 'door' ? Math.max(w.thickness, across) + 250 : w.thickness / 2 + across / 2 + 300;
      if (off <= tol && (!best || off < best.d)) best = { w, t, d: off, along };
    }
    if (!best) continue;
    const L = wallLength(best.w);
    const width = Math.min(kind === 'door' ? 1800 : 4000, Math.max(kind === 'door' ? 700 : 450, Math.round(best.along / 10) * 10));
    if (L < width + 100) continue;
    const offset = Math.round(Math.min(L - width / 2 - 50, Math.max(width / 2 + 50, best.t)));
    if (taken.some((o) => o.wallId === best!.w.id && Math.abs(o.offset - offset) < (o.width + width) / 2 + 50)) continue;
    const side = dot(sub(c, add(best.w.a, mul(wallDir(best.w), best.t))), wallNormal(best.w));
    const opening: Omit<Opening, 'id'> = {
      kind,
      wallId: best.w.id,
      offset,
      width,
      height: kind === 'door' ? sizes.doorHeight : sizes.windowHead - sizes.windowSill,
      sill: kind === 'door' ? 0 : sizes.windowSill,
      hinge: 'start',
      swing: kind === 'door' && side < 0 ? -1 : 1,
      prov: { position: 'detected', width: 'detected', kind: 'detected', height: 'assumed', sill: 'assumed' },
    };
    out.push(opening);
    taken.push(opening);
  }
  return out;
}

/**
 * An outdoor space (porch, deck, patio) read by AI: low walls around the parts not already
 * bounded by the building, with a way in through the outer side. Its edges snap onto nearby
 * outside walls so it shares them. Returns null when it overlaps a room or is too small.
 */
export function outdoorSpaceOps(model: BuildingModel, rect: { minX: number; minY: number; maxX: number; maxY: number }): { ops: EditOp[]; seed: Vec2 } | null {
  const ext = model.walls.filter((w) => w.exterior);
  const snap = (v: number, horizontal: boolean) => {
    let best = v;
    let bestD = 700;
    for (const w of ext) {
      const isH = Math.abs(w.a.y - w.b.y) < 1;
      const isV = Math.abs(w.a.x - w.b.x) < 1;
      const line = horizontal ? (isH ? w.a.y : null) : isV ? w.a.x : null;
      if (line === null) continue;
      if (Math.abs(line - v) < bestD) {
        bestD = Math.abs(line - v);
        best = line;
      }
    }
    // on a wall's line exactly (rounding it off would leave a gap and the porch would not close)
    return bestD < 700 ? best : Math.round(best / 10) * 10;
  };
  const r = { minX: snap(rect.minX, false), maxX: snap(rect.maxX, false), minY: snap(rect.minY, true), maxY: snap(rect.maxY, true) };
  if (r.maxX - r.minX < 1000 || r.maxY - r.minY < 1000) return null;
  const seed = { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
  // Already a room (for example a porch with walls all round): nothing to add.
  if (derive(model).rooms.some((room) => pointInPolygon(seed, room.polygon))) return null;
  const made = roomWalls(model, { x: r.minX, y: r.minY }, { x: r.maxX, y: r.maxY });
  if (typeof made === 'string') return null;
  const walls = made.flatMap((op) => (op.op === 'addWall' ? [{ ...op.wall, height: 1000, thickness: 60, materialId: 'ash', exterior: false, kind: 'railing' as const }] : []));
  if (!walls.length) return null;
  const ops: EditOp[] = walls.map((wall) => ({ op: 'addWall', wall }));
  // The way in: a gap in the middle of the longest stretch of railing.
  const front = walls.reduce((a, b) => (wallLength(b) > wallLength(a) ? b : a));
  const L = wallLength(front);
  const gap = Math.min(1200, L - 200);
  if (gap >= 700) {
    ops.push({ op: 'addOpening', opening: { id: nextId(model, 'O'), kind: 'opening', wallId: front.id, offset: Math.round(L / 2), width: Math.round(gap / 10) * 10, height: 1000, sill: 0, hinge: 'start', swing: 1, prov: { position: 'assumed', width: 'assumed' } } });
  }
  return { ops, seed };
}
