/**
 * Adding a porch (or a veranda, deck or patio) against an outside wall. Each kind follows
 * common residential practice for its edge, roof and floor:
 *  - covered porch: against part of a wall, lean-to roof on posts, handrails, timber deck, a step;
 *  - veranda: the whole length of a wall, otherwise like a covered porch;
 *  - wrap-around porch: a veranda that turns the corner onto the next wall;
 *  - screened porch: a covered porch with insect-screen panels instead of handrails;
 *  - portico: a small covered entrance on columns, paved, open at the sides;
 *  - open deck: raised timber platform with handrails, no roof;
 *  - patio: paving at ground level, no handrails and no roof;
 * The porch is a space bounded by the house walls and by edge walls of kind 'railing' whose height
 * says what they are: a low paving edge, a handrail, or full-height screens.
 */
import { applyEdits, nextId } from './edits';
import { derive } from './derive';
import { dist, pointInPolygon, projectOnSegment } from './geometry';
import type { PorchRoof } from './porch';
import type { BuildingModel, EditOp, PorchKind, Vec2, Wall } from './types';

export type { PorchKind };
export type PorchEdge = 'rail' | 'screen' | 'kerb';

export const PORCH_KINDS: { kind: PorchKind; label: string; icon: string; hint: string; width: number; depth: number; edge: PorchEdge; roof: PorchRoof | 'auto'; floor: 'timber' | 'paving' | 'slab' }[] = [
  { kind: 'porch', label: 'Covered porch', icon: 'roofing', hint: 'Against part of a wall, a lean-to roof on posts, handrails', width: 2400, depth: 1800, edge: 'rail', roof: 'auto', floor: 'timber' },
  { kind: 'veranda', label: 'Veranda', icon: 'deck', hint: 'Covered, the whole length of the wall', width: 0, depth: 2400, edge: 'rail', roof: 'auto', floor: 'timber' },
  { kind: 'wrap', label: 'Wrap-around porch', icon: 'turn_right', hint: 'A veranda that turns the corner onto the next wall', width: 0, depth: 2400, edge: 'rail', roof: 'auto', floor: 'timber' },
  { kind: 'screened', label: 'Screened porch', icon: 'grid_on', hint: 'Covered, with insect screens instead of handrails', width: 3600, depth: 3000, edge: 'screen', roof: 'auto', floor: 'timber' },
  { kind: 'portico', label: 'Portico', icon: 'account_balance', hint: 'A small covered entrance on columns, paved', width: 1800, depth: 1200, edge: 'kerb', roof: 'own', floor: 'paving' },
  { kind: 'deck', label: 'Open deck', icon: 'table_rows', hint: 'A raised timber deck with handrails, no roof', width: 4000, depth: 3000, edge: 'rail', roof: 'none', floor: 'timber' },
  { kind: 'patio', label: 'Patio', icon: 'grid_view', hint: 'Paving at ground level, no handrails, no roof', width: 4000, depth: 3000, edge: 'kerb', roof: 'none', floor: 'paving' },
];

// Kinds no longer offered (an older balcony) are treated as an open deck.
export const porchKindOf = (k: PorchKind) => PORCH_KINDS.find((p) => p.kind === k) ?? PORCH_KINDS.find((p) => p.kind === 'deck')!;

/** How tall each kind of edge is (mm): its height is what tells them apart. */
export const EDGE_HEIGHT: Record<PorchEdge, number> = { kerb: 150, rail: 1000, screen: 2100 };
export const edgeOf = (w: Pick<Wall, 'height'>): PorchEdge => (w.height <= 300 ? 'kerb' : w.height >= 1800 ? 'screen' : 'rail');

const solidWalls = (m: BuildingModel) => m.walls.filter((w) => w.kind !== 'railing' && w.kind !== 'column');
const axis = (w: Wall) => (Math.abs(w.a.y - w.b.y) < 1 ? 'h' : Math.abs(w.a.x - w.b.x) < 1 ? 'v' : null);

/**
 * The edits that add a porch of this kind where you clicked: against the nearest outside wall,
 * centred on the click (a veranda takes the whole wall; a wrap-around turns the nearer corner).
 * Returns the edits, or why it can't go there.
 */
export function porchOps(model: BuildingModel, click: Vec2, kind: PorchKind): { ops: EditOp[]; label: string } | string {
  const spec = porchKindOf(kind);
  const d = derive(model);
  const inside = (p: Vec2) => d.rooms.some((r) => pointInPolygon(p, r.polygon));
  // the nearest straight wall of the house
  let best: { w: Wall; dist: number; t: number } | null = null;
  for (const w of solidWalls(model)) {
    if (!axis(w)) continue;
    const pr = projectOnSegment(click, w.a, w.b);
    if (pr.distance < 2500 && (!best || pr.distance < best.dist)) best = { w, dist: pr.distance, t: pr.along };
  }
  if (!best) return 'Click just outside an outside wall of the house.';
  const w = best.w;
  const horiz = axis(w) === 'h';
  const c = horiz ? w.a.y : w.a.x;
  const lo = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
  const hi = horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
  const along = horiz ? click.x : click.y;
  // outward: the side of the wall that is not inside the house
  const probe = (s: 1 | -1) => (horiz ? { x: Math.min(hi - 10, Math.max(lo + 10, along)), y: c + s * (w.thickness / 2 + 250) } : { x: c + s * (w.thickness / 2 + 250), y: Math.min(hi - 10, Math.max(lo + 10, along)) });
  const inPlus = inside(probe(1));
  const inMinus = inside(probe(-1));
  if (inPlus && inMinus) return 'That wall is inside the house. Click just outside an outside wall.';
  const out: 1 | -1 = inPlus ? -1 : inMinus ? 1 : (horiz ? click.y : click.x) >= c ? 1 : -1;
  const depth = w.thickness / 2 + spec.depth;
  // the stretch along the wall
  let a0: number;
  let a1: number;
  if (spec.width === 0) {
    a0 = lo;
    a1 = hi;
  } else {
    const width = Math.min(spec.width, hi - lo);
    const mid = Math.min(hi - width / 2, Math.max(lo + width / 2, along));
    a0 = mid - width / 2;
    a1 = mid + width / 2;
  }
  // points given as (along the wall, out from its centreline)
  const P = (s: number, o: number): Vec2 => (horiz ? { x: Math.round(s), y: Math.round(c + out * o) } : { x: Math.round(c + out * o), y: Math.round(s) });
  let poly: Vec2[] = [P(a0, 0), P(a0, depth), P(a1, depth), P(a1, 0)];
  if (kind === 'wrap') {
    // turn the corner nearer the click onto the wall that meets it there
    const end = along - lo < hi - along ? 'lo' : 'hi';
    const corner = P(end === 'lo' ? lo : hi, 0);
    const other = solidWalls(model).find((x) => x !== w && axis(x) === (horiz ? 'v' : 'h') && (dist(x.a, corner) < x.thickness + w.thickness || dist(x.b, corner) < x.thickness + w.thickness));
    if (other) {
      const far = dist(other.a, corner) < dist(other.b, corner) ? other.b : other.a;
      // back along the other wall, away from the porch side (into the house's other face)
      const back = horiz ? far.y - c : far.x - c; // signed, along the "out" axis of the first wall
      const sideOut = end === 'lo' ? -1 : 1; // the other wall's outside is beyond the corner
      const len = Math.abs(back);
      const dirBack = Math.sign(back) || -out;
      const ext = (end === 'lo' ? lo : hi) + sideOut * depth;
      const cornerAlong = end === 'lo' ? lo : hi;
      // L: along the first wall to beyond the corner, then back along the other wall
      const Q = (s: number, o: number): Vec2 => (horiz ? { x: Math.round(s), y: Math.round(c + o) } : { x: Math.round(c + o), y: Math.round(s) });
      const near = end === 'lo' ? a1 : a0;
      poly = [P(near, 0), P(near, depth), Q(ext, out * depth), Q(ext, dirBack * len), Q(cornerAlong, dirBack * len), Q(cornerAlong, 0)];
    }
  }
  // edge walls where the house has none
  const H = EDGE_HEIGHT[spec.edge];
  const ops: EditOp[] = [];
  let n = Number(nextId(model, 'W').slice(1));
  const edges: { id: string; len: number; a: Vec2; b: Vec2; front: boolean }[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const eh = Math.abs(p.y - q.y) < 1;
    const ec = eh ? p.y : p.x;
    const elo = eh ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
    const ehi = eh ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
    let pieces: [number, number][] = [[elo, ehi]];
    for (const x of model.walls) {
      const tol = Math.max(x.thickness / 2, 50);
      const inLine = eh ? Math.abs(x.a.y - ec) < tol && Math.abs(x.b.y - ec) < tol : Math.abs(x.a.x - ec) < tol && Math.abs(x.b.x - ec) < tol;
      if (!inLine) continue;
      const s = eh ? Math.min(x.a.x, x.b.x) : Math.min(x.a.y, x.b.y);
      const e = eh ? Math.max(x.a.x, x.b.x) : Math.max(x.a.y, x.b.y);
      pieces = pieces.flatMap(([u, v]) => {
        if (e <= u || s >= v) return [[u, v] as [number, number]];
        const keep: [number, number][] = [];
        if (s > u + 10) keep.push([u, s]);
        if (e < v - 10) keep.push([e, v]);
        return keep;
      });
    }
    // the edge farthest from the wall is the front (the way in goes there)
    const front = i === 1;
    for (const [u, v] of pieces) {
      if (v - u < 100) continue;
      const a = eh ? { x: u, y: ec } : { x: ec, y: u };
      const b = eh ? { x: v, y: ec } : { x: ec, y: v };
      const id = `W${n++}`;
      ops.push({ op: 'addWall', wall: { id, a, b, thickness: 60, height: H, materialId: 'ash', exterior: false, kind: 'railing', prov: { position: 'confirmed', kind: 'confirmed' } } });
      edges.push({ id, len: v - u, a, b, front });
    }
  }
  if (!edges.length) return 'There is already something built there.';
  // the way in: a gap in the front edge (a patio or portico is open along its edges)
  let o = Number(nextId(model, 'O').slice(1));
  const gap = (e: (typeof edges)[number], width: number) =>
    ops.push({ op: 'addOpening', opening: { id: `O${o++}`, kind: 'opening', wallId: e.id, offset: Math.round(e.len / 2), width: Math.round(width), height: H, sill: 0, hinge: 'start', swing: 1, prov: { position: 'assumed', width: 'assumed' } } });
  if (spec.edge === 'kerb') for (const e of edges) e.len >= 600 && gap(e, e.len - 200);
  else {
    const front = edges.filter((e) => e.front).sort((x, y) => y.len - x.len)[0] ?? [...edges].sort((x, y) => y.len - x.len)[0];
    if (front.len >= 900) gap(front, Math.min(spec.edge === 'screen' ? 900 : 1200, front.len - 200));
  }
  // name it: the new space appears once its edges are in
  const trial = applyEdits(model, ops);
  if (!trial.ok) return trial.errors[0] ?? 'The porch could not be added there.';
  const seed = { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 };
  const room = derive(trial.model).rooms.find((r) => pointInPolygon(seed, r.polygon));
  if (room)
    ops.push({
      op: 'setRoom',
      roomId: room.id,
      patch: { name: spec.label, type: 'other', floorMaterialId: spec.floor === 'timber' ? 'oak' : spec.floor === 'paving' ? 'terrazzo' : 'screed', porchKind: kind, porchRoof: spec.roof === 'auto' ? undefined : spec.roof },
    });
  return { ops, label: spec.label };
}

/** The edits that change a porch to another kind: its edges' height, its roof and floor, its name. */
export function porchKindOps(model: BuildingModel, roomId: string, kind: PorchKind): EditOp[] {
  const spec = porchKindOf(kind);
  const room = derive(model).roomById.get(roomId);
  if (!room) return [];
  const rails = model.walls.filter((w) => w.kind === 'railing' && room.wallIds.includes(w.id));
  const keepName = room.porchKind ? room.name !== porchKindOf(room.porchKind).label : !/^(porch|veranda|deck|patio|terrace)$/i.test(room.name);
  return [
    ...rails.map((w) => ({ op: 'setWall' as const, wallId: w.id, patch: { height: EDGE_HEIGHT[spec.edge] } })),
    { op: 'setRoom', roomId, patch: { porchKind: kind, porchRoof: spec.roof === 'auto' ? undefined : spec.roof, floorMaterialId: spec.floor === 'timber' ? 'oak' : spec.floor === 'paving' ? 'terrazzo' : 'screed', ...(keepName ? {} : { name: spec.label }) } },
  ];
}
