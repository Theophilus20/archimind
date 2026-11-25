/**
 * Standard plan editing commands (split, offset, extend, corner, join…). Each one returns ordinary validated edit operations,
 * so undo, revisions, review and sync all work exactly as for any other change.
 */
import { add, dist, dot, lineIntersection, mul, pointAlongWall, projectOnSegment, sub, wallDir, wallLength, wallNormal } from './geometry';
import { nextId } from './edits';
import type { BuildingModel, EditOp, Id, Opening, Vec2, Wall } from './types';

const r1 = (n: number) => Math.round(n);
const pt = (p: Vec2): Vec2 => ({ x: r1(p.x), y: r1(p.y) });

/** Ids for several new elements in one command (nextId alone would hand out the same one twice). */
function ids(model: BuildingModel, prefix: string, count: number): Id[] {
  const out: Id[] = [];
  let m = model;
  for (let i = 0; i < count; i++) {
    const id = nextId(m, prefix);
    out.push(id);
    m = { ...m, walls: [...m.walls, { id } as Wall] };
  }
  return out;
}

/** Split a wall in two at a distance along it (doors and windows stay where they are). */
export function splitWall(model: BuildingModel, wallId: Id, at: number): EditOp[] | string {
  const w = model.walls.find((x) => x.id === wallId);
  if (!w) return 'That wall no longer exists.';
  const L = wallLength(w);
  if (at < 200 || at > L - 200) return 'Split at least 200 mm from either end of the wall.';
  const hosted = model.openings.filter((o) => o.wallId === w.id);
  if (hosted.some((o) => Math.abs(o.offset - at) < o.width / 2 + 20)) return 'That point is inside a door or window. Split the wall somewhere else.';
  const [idA, idB] = ids(model, 'W', 2);
  const p = pt(pointAlongWall(w, at));
  const base = { thickness: w.thickness, height: w.height, materialId: w.materialId, exterior: w.exterior, prov: { ...w.prov } };
  const ops: EditOp[] = [
    { op: 'addWall', wall: { id: idA, a: { ...w.a }, b: p, ...base } },
    { op: 'addWall', wall: { id: idB, a: p, b: { ...w.b }, ...base } },
  ];
  for (const o of hosted) ops.push(o.offset < at ? { op: 'relocateOpening', openingId: o.id, wallId: idA, offset: o.offset } : { op: 'relocateOpening', openingId: o.id, wallId: idB, offset: o.offset - at });
  ops.push({ op: 'removeWall', wallId: w.id });
  return ops;
}

/** A parallel copy of a wall, `distance` mm away on the side of `towards` (OFFSET). */
export function offsetWall(model: BuildingModel, wallId: Id, distance: number, towards?: Vec2): EditOp[] | string {
  const w = model.walls.find((x) => x.id === wallId);
  if (!w) return 'That wall no longer exists.';
  const n = wallNormal(w);
  const mid = pointAlongWall(w, wallLength(w) / 2);
  const side = towards ? (dot(sub(towards, mid), n) >= 0 ? 1 : -1) : 1;
  const shift = mul(n, side * distance);
  const [id] = ids(model, 'W', 1);
  return [{ op: 'addWall', wall: { ...w, id, a: pt(add(w.a, shift)), b: pt(add(w.b, shift)), prov: { geometry: 'confirmed', height: w.prov.height ?? 'assumed' } } }];
}

/** Turn a wall 90 degrees about its midpoint (its doors and windows go with it). */
export function rotateWall(model: BuildingModel, wallId: Id): EditOp[] | string {
  const w = model.walls.find((x) => x.id === wallId);
  if (!w) return 'That wall no longer exists.';
  const mid = pointAlongWall(w, wallLength(w) / 2);
  const rot = (p: Vec2): Vec2 => {
    const d = sub(p, mid);
    return pt({ x: mid.x - d.y, y: mid.y + d.x });
  };
  return [
    { op: 'moveWallEndpoint', wallId: w.id, end: 'a', to: rot(w.a) },
    { op: 'moveWallEndpoint', wallId: w.id, end: 'b', to: rot(w.b) },
  ];
}

/**
 * Extend (or trim) a wall's ends to meet the nearest wall straight ahead of each end
 * (EXTEND / trim-extend), within 6 m.
 */
export function extendWall(model: BuildingModel, wallId: Id): EditOp[] | string {
  const w = model.walls.find((x) => x.id === wallId);
  if (!w) return 'That wall no longer exists.';
  const dir = wallDir(w);
  const ops: EditOp[] = [];
  for (const end of ['a', 'b'] as const) {
    const from = w[end];
    const outward = end === 'b' ? dir : mul(dir, -1);
    let best: { p: Vec2; d: number } | null = null;
    for (const o of model.walls) {
      if (o.id === w.id) continue;
      const hit = lineIntersection(from, outward, o.a, wallDir(o));
      if (!hit) continue;
      const pr = projectOnSegment(hit, o.a, o.b);
      if (pr.distance > 5) continue; // must land on the other wall itself
      const ahead = dot(sub(hit, from), outward);
      if (ahead < 5 || ahead > 6000) continue;
      if (!best || ahead < best.d) best = { p: hit, d: ahead };
    }
    if (best) ops.push({ op: 'moveWallEndpoint', wallId: w.id, end, to: pt(best.p) });
  }
  return ops.length ? ops : 'No wall to extend to within 6 m of either end.';
}

/** Duplicate an element next to the original (Ctrl+D). */
export function duplicate(model: BuildingModel, id: Id): EditOp[] | string {
  const w = model.walls.find((x) => x.id === id);
  if (w) return offsetWall(model, id, Math.max(1000, w.thickness * 4));
  const f = model.furniture.find((x) => x.id === id);
  if (f) {
    const nid = nextId(model, 'F');
    return [{ op: 'addFurniture', furniture: { ...f, id: nid, x: r1(f.x + 500), y: r1(f.y + 500), prov: { element: 'confirmed' } } }];
  }
  const o = model.openings.find((x) => x.id === id);
  if (o) {
    const host = model.walls.find((x) => x.id === o.wallId);
    if (!host) return 'That door or window has no wall.';
    const L = wallLength(host);
    const others = model.openings.filter((x) => x.wallId === host.id);
    const free = (off: number) => off - o.width / 2 > 50 && off + o.width / 2 < L - 50 && others.every((x) => Math.abs(x.offset - off) > (x.width + o.width) / 2 + 100);
    const candidates = [o.offset + o.width + 300, o.offset - o.width - 300, ...Array.from({ length: 20 }, (_, i) => (L * (i + 0.5)) / 20)];
    const at = candidates.find(free);
    if (at === undefined) return 'There is no room on this wall for another one.';
    const nid = nextId(model, o.kind === 'door' ? 'D' : o.kind === 'window' ? 'N' : 'O');
    return [{ op: 'addOpening', opening: { ...(o as Opening), id: nid, offset: r1(at), prov: { element: 'confirmed', height: o.prov.height ?? 'assumed' } } }];
  }
  return 'Select a wall, door, window or piece of furniture to duplicate.';
}

/** Rotate furniture by 90 degrees, or turn a wall 90 degrees. */
export function rotate(model: BuildingModel, id: Id): EditOp[] | string {
  const f = model.furniture.find((x) => x.id === id);
  if (f) return [{ op: 'moveFurniture', furnitureId: f.id, x: f.x, y: f.y, rotation: (((f.rotation ?? 0) + 90) % 360 + 360) % 360 }];
  if (model.walls.some((w) => w.id === id)) return rotateWall(model, id);
  return 'Select a wall or piece of furniture to rotate.';
}

/** Mirror: flip a door's swing to the other side of the wall, or turn furniture to face the other way. */
export function mirror(model: BuildingModel, id: Id): EditOp[] | string {
  const o = model.openings.find((x) => x.id === id);
  if (o) return [{ op: 'setOpening', openingId: o.id, patch: { swing: (o.swing === 1 ? -1 : 1) as 1 | -1 } }];
  const f = model.furniture.find((x) => x.id === id);
  if (f) return [{ op: 'moveFurniture', furnitureId: f.id, x: f.x, y: f.y, rotation: ((f.rotation ?? 0) + 180) % 360 }];
  return 'Select a door or piece of furniture to mirror.';
}

/** Flip which side a door is hinged on (a door flip control). */
export function flipHinge(model: BuildingModel, id: Id): EditOp[] | string {
  const o = model.openings.find((x) => x.id === id);
  if (!o || o.kind !== 'door') return 'Select a door to flip its hinge.';
  return [{ op: 'setOpening', openingId: o.id, patch: { hinge: o.hinge === 'start' ? 'end' : 'start' } }];
}

/** Nearest point along a wall to `p`, snapped to 50 mm (used by the Split tool). */
export function alongWall(w: Wall, p: Vec2) {
  const pr = projectOnSegment(p, w.a, w.b);
  return { along: Math.round(pr.along / 50) * 50, distance: pr.distance, point: pr.point, length: dist(w.a, w.b) };
}

/** Delete several elements in one step (ERASE / Delete). Openings on deleted walls go with them. */
export function deleteElements(model: BuildingModel, idsToDelete: Id[]): EditOp[] | string {
  const set = new Set(idsToDelete);
  const walls = model.walls.filter((w) => set.has(w.id));
  const gone = new Set(walls.map((w) => w.id));
  const ops: EditOp[] = [];
  for (const o of model.openings) if (set.has(o.id) && !gone.has(o.wallId)) ops.push({ op: 'removeOpening', openingId: o.id });
  for (const f of model.furniture) if (set.has(f.id)) ops.push({ op: 'removeFurniture', furnitureId: f.id });
  for (const d of model.dimensions ?? []) if (set.has(d.id)) ops.push({ op: 'removeDimension', dimensionId: d.id });
  for (const w of walls) ops.push({ op: 'removeWall', wallId: w.id });
  return ops.length ? ops : 'Select walls, doors, windows, furniture or dimensions to delete.';
}

/** Elements inside a box: a window (dragged left to right) takes what is fully inside, a crossing (right to left) anything it touches. */
/** Hand-placed dimensions on the floor being shown. */
export function dimensionsOnLevel(model: BuildingModel) {
  const at = model.activeLevel ?? 0;
  return (model.dimensions ?? []).filter((d) => (d.level ?? 0) === at);
}

/** Everything inside (window) or touching (crossing) a box. Hidden dimensions can be left out. */
export function elementsInBox(model: BuildingModel, a: Vec2, b: Vec2, crossing: boolean, withDims = true): Id[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const inside = (p: Vec2) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const corners: Vec2[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const crossesEdge = (p: Vec2, q: Vec2) => {
    for (let i = 0; i < 4; i++) {
      const c = corners[i], d = corners[(i + 1) % 4];
      const den = (q.x - p.x) * (d.y - c.y) - (q.y - p.y) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) continue;
      const t = ((c.x - p.x) * (d.y - c.y) - (c.y - p.y) * (d.x - c.x)) / den;
      const u = ((c.x - p.x) * (q.y - p.y) - (c.y - p.y) * (q.x - p.x)) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return true;
    }
    return false;
  };
  const seg = (p: Vec2, q: Vec2) => (crossing ? inside(p) || inside(q) || crossesEdge(p, q) : inside(p) && inside(q));
  const out: Id[] = [];
  for (const w of model.walls) if (seg(w.a, w.b)) out.push(w.id);
  for (const o of model.openings) {
    const w = model.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const d = wallDir(w);
    if (seg(add(pointAlongWall(w, o.offset), mul(d, -o.width / 2)), add(pointAlongWall(w, o.offset), mul(d, o.width / 2)))) out.push(o.id);
  }
  if (withDims) for (const d of dimensionsOnLevel(model)) if (seg(d.a, d.b)) out.push(d.id);
  for (const f of model.furniture) {
    const h = Math.max(f.w, f.d) / 2;
    const fx = [{ x: f.x - h, y: f.y - h }, { x: f.x + h, y: f.y + h }];
    if (crossing ? !(fx[1].x < x0 || fx[0].x > x1 || fx[1].y < y0 || fx[0].y > y1) : inside(fx[0]) && inside(fx[1])) out.push(f.id);
  }
  return out;
}

export interface Clip {
  walls: Wall[];
  openings: Opening[];
  furniture: BuildingModel['furniture'];
}

/** Copy elements (Ctrl+C). Doors and windows come along only with their walls. */
export function copyElements(model: BuildingModel, idsToCopy: Id[]): Clip {
  const set = new Set(idsToCopy);
  const walls = model.walls.filter((w) => set.has(w.id));
  const wallIds = new Set(walls.map((w) => w.id));
  return {
    walls: structuredClone(walls),
    openings: structuredClone(model.openings.filter((o) => wallIds.has(o.wallId))),
    furniture: structuredClone(model.furniture.filter((f) => set.has(f.id))),
  };
}

/** Paste copied elements, shifted by `by` (Ctrl+V). Returns the edit and the new ids to select. */
export function pasteElements(model: BuildingModel, clip: Clip, by: Vec2): { ops: EditOp[]; ids: Id[] } {
  let m = model;
  const fresh = (prefix: string) => {
    const id = nextId(m, prefix);
    m = { ...m, walls: [...m.walls, { id } as Wall] };
    return id;
  };
  const ops: EditOp[] = [];
  const created: Id[] = [];
  const wallMap = new Map<Id, Id>();
  for (const w of clip.walls) {
    const id = fresh('W');
    wallMap.set(w.id, id);
    created.push(id);
    ops.push({ op: 'addWall', wall: { ...w, id, a: pt(add(w.a, by)), b: pt(add(w.b, by)) } });
  }
  for (const o of clip.openings) {
    const host = wallMap.get(o.wallId);
    if (!host) continue;
    const id = fresh(o.kind === 'door' ? 'D' : o.kind === 'window' ? 'N' : 'O');
    created.push(id);
    ops.push({ op: 'addOpening', opening: { ...o, id, wallId: host } });
  }
  for (const f of clip.furniture) {
    const id = fresh('F');
    created.push(id);
    ops.push({ op: 'addFurniture', furniture: { ...f, id, x: r1(f.x + by.x), y: r1(f.y + by.y) } });
  }
  return { ops, ids: created };
}

/**
 * Corner two walls (FILLET with radius 0 / trim-extend to corner): each wall's
 * nearer end moves to where their centre lines cross, so they meet in a clean corner.
 */
export function cornerWalls(model: BuildingModel, idA: Id, idB: Id): EditOp[] | string {
  const a = model.walls.find((x) => x.id === idA);
  const b = model.walls.find((x) => x.id === idB);
  if (!a || !b || a.id === b.id) return 'Select two different walls to join into a corner.';
  const hit = lineIntersection(a.a, wallDir(a), b.a, wallDir(b));
  if (!hit) return 'Those walls are parallel, so they cannot meet in a corner. Use Join for walls in a line.';
  const end = (w: Wall) => (dist(w.a, hit) < dist(w.b, hit) ? 'a' : 'b');
  return [
    { op: 'moveWallEndpoint', wallId: a.id, end: end(a), to: pt(hit) },
    { op: 'moveWallEndpoint', wallId: b.id, end: end(b), to: pt(hit) },
  ];
}

/** Join two walls that lie in a line into one wall (JOIN). Doors and windows keep their places. */
export function joinWalls(model: BuildingModel, idA: Id, idB: Id): EditOp[] | string {
  const a = model.walls.find((x) => x.id === idA);
  const b = model.walls.find((x) => x.id === idB);
  if (!a || !b || a.id === b.id) return 'Select two walls in a line to join.';
  const d = wallDir(a);
  const inLine = Math.abs(d.x * wallDir(b).y - d.y * wallDir(b).x) < 0.02 && projectOnSegment(b.a, add(a.a, mul(d, -1e6)), add(a.a, mul(d, 1e6))).distance < 20;
  if (!inLine) return 'Those walls are not in a line. Use Corner to make them meet.';
  const along = (p: Vec2) => dot(sub(p, a.a), d);
  const ends = [a.a, a.b, b.a, b.b].sort((p, q) => along(p) - along(q));
  const gap = Math.max(along(b.a), along(b.b)) < Math.min(along(a.a), along(a.b)) ? Math.min(along(a.a), along(a.b)) - Math.max(along(b.a), along(b.b)) : Math.min(along(b.a), along(b.b)) - Math.max(along(a.a), along(a.b));
  if (gap > 1500) return 'Those walls are more than 1.5 m apart. Move them closer first.';
  const start = ends[0];
  const [id] = ids(model, 'W', 1);
  const ops: EditOp[] = [{ op: 'addWall', wall: { ...a, id, a: pt(start), b: pt(ends[3]), thickness: Math.max(a.thickness, b.thickness) } }];
  const joined = { a: start, b: ends[3] };
  for (const o of model.openings.filter((x) => x.wallId === a.id || x.wallId === b.id)) {
    const host = o.wallId === a.id ? a : b;
    const p = pointAlongWall(host, o.offset);
    ops.push({ op: 'relocateOpening', openingId: o.id, wallId: id, offset: r1(dist(joined.a, p)) });
  }
  ops.push({ op: 'removeWall', wallId: a.id }, { op: 'removeWall', wallId: b.id });
  return ops;
}

/**
 * A rectangular room from two opposite corners (wall centrelines): four walls, leaving out any
 * stretch that already has a wall in line with it, so rooms drawn side by side share one wall.
 * Walls on the outside of what is drawn so far are outside walls; the rest are partitions.
 */
export function roomWalls(model: BuildingModel, a: Vec2, b: Vec2): EditOp[] | string {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (x1 - x0 < 600 || y1 - y0 < 600) return 'A room needs to be at least 600 mm each way.';
  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  const bb = model.walls.length ? { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } : null;
  const tallest = model.walls.reduce((h, w) => Math.max(h, w.height), model.defaults.wallHeight);
  let n = Number(nextId(model, 'W').slice(1));
  const ops: EditOp[] = [];
  const edges: [Vec2, Vec2][] = [
    [{ x: x0, y: y0 }, { x: x1, y: y0 }],
    [{ x: x1, y: y0 }, { x: x1, y: y1 }],
    [{ x: x1, y: y1 }, { x: x0, y: y1 }],
    [{ x: x0, y: y1 }, { x: x0, y: y0 }],
  ];
  for (const [p, q] of edges) {
    const horizontal = p.y === q.y;
    const c = horizontal ? p.y : p.x;
    const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
    const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
    // Stretches already covered by a wall on the same line.
    let pieces: [number, number][] = [[lo, hi]];
    for (const w of model.walls) {
      const tol = Math.max(w.thickness / 2, 50);
      const inLine = horizontal ? Math.abs(w.a.y - c) < tol && Math.abs(w.b.y - c) < tol : Math.abs(w.a.x - c) < tol && Math.abs(w.b.x - c) < tol;
      if (!inLine) continue;
      const s = horizontal ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
      const e = horizontal ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
      pieces = pieces.flatMap(([u, v]): [number, number][] => (e <= u || s >= v ? [[u, v]] : [...(s > u ? [[u, s] as [number, number]] : []), ...(e < v ? [[e, v] as [number, number]] : [])]));
    }
    for (const [s, e] of pieces) {
      if (e - s < 100) continue;
      const mid = (s + e) / 2;
      const outside = !bb || (horizontal ? c <= bb.minY + 1 || c >= bb.maxY - 1 || mid < bb.minX || mid > bb.maxX : c <= bb.minX + 1 || c >= bb.maxX - 1 || mid < bb.minY || mid > bb.maxY);
      const wall: Wall = {
        id: `W${n++}`,
        a: horizontal ? { x: s, y: c } : { x: c, y: s },
        b: horizontal ? { x: e, y: c } : { x: c, y: e },
        thickness: outside ? model.defaults.exteriorThickness : model.defaults.interiorThickness,
        height: tallest,
        materialId: outside ? 'render' : 'plaster',
        exterior: outside,
        prov: { geometry: 'confirmed', height: 'assumed' },
      };
      ops.push({ op: 'addWall', wall });
    }
  }
  return ops.length ? ops : 'Those walls are already there.';
}
