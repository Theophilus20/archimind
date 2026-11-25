import {
  dist,
  insetPolygon,
  interiorPoint,
  mul,
  add,
  pointAlongWall,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  projectOnSegment,
  segmentIntersection,
  signedArea,
  wallNormal,
  lineIntersection,
  sub,
  norm,
  cross,
} from './geometry';
import type { BuildingModel, Id, Opening, RoomMeta, Vec2, Wall } from './types';

export interface DerivedRoom extends RoomMeta {
  polygon: Vec2[];
  inner: Vec2[];
  /** Net internal area, m². */
  area: number;
  /** Area to wall centrelines, m². */
  grossArea: number;
  perimeter: number;
  centroid: Vec2;
  wallIds: Id[];
}

export interface OpeningLink {
  openingId: Id;
  /** Room on the +normal side and on the −normal side of the host wall. */
  plus: Id | null;
  minus: Id | null;
}

export interface Derived {
  rooms: DerivedRoom[];
  roomById: Map<Id, DerivedRoom>;
  links: Map<Id, OpeningLink>;
  /** Rooms connected through doors or open openings (circulation graph). */
  connections: Map<Id, Set<Id>>;
  /** Room ids not enclosed by walls (their seed falls outside every face). */
  unenclosed: Id[];
  roomAt: (p: Vec2) => DerivedRoom | undefined;
}

interface Edge {
  u: number;
  v: number;
  wallId: Id;
}

const SNAP = 12; // mm

/** Snap wall endpoints onto nearby walls (corners and T-junctions) without mutating the model. */
function cleanedSegments(walls: Wall[]) {
  const segs = walls.map((w) => ({ a: { ...w.a }, b: { ...w.b }, wallId: w.id, t: w.thickness }));
  for (let i = 0; i < segs.length; i++) {
    for (const end of ['a', 'b'] as const) {
      const p = segs[i][end];
      // Already exactly on another wall (a clean T-junction or corner): leave it where it is.
      if (segs.some((s, j) => j !== i && projectOnSegment(p, s.a, s.b).distance < 2)) continue;
      let best: { point: Vec2; d: number } | null = null;
      for (let j = 0; j < segs.length; j++) {
        if (i === j) continue;
        const s = segs[j];
        const tol = s.t / 2 + segs[i].t / 2 + SNAP;
        const pr = projectOnSegment(p, s.a, s.b);
        if (pr.distance > tol) continue;
        // Corner where the two walls meet near their ends: use the line intersection.
        const di = norm(sub(segs[i].b, segs[i].a));
        const dj = norm(sub(s.b, s.a));
        let target = pr.point;
        if (Math.abs(cross(di, dj)) > 0.2) {
          const x = lineIntersection(segs[i].a, di, s.a, dj);
          if (x && dist(x, p) <= tol * 1.5) {
            const onJ = projectOnSegment(x, s.a, s.b);
            if (onJ.distance < SNAP + s.t) target = x;
          }
        } else continue; // parallel walls never snap end-to-side
        const d = dist(target, p);
        if (d > 0.01 && (!best || d < best.d)) best = { point: target, d };
      }
      if (best && best.d <= Math.max(segs[i].t, 400)) segs[i][end] = best.point;
    }
  }
  return segs;
}

function buildGraph(walls: Wall[]) {
  const segs = cleanedSegments(walls);
  const nodes: Vec2[] = [];
  const nodeIndex = (p: Vec2) => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i], p) < 2) return i;
    nodes.push({ x: p.x, y: p.y });
    return nodes.length - 1;
  };
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const L = dist(s.a, s.b);
    if (L < 1) continue;
    const ts = [0, 1];
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      const o = segs[j];
      const x = segmentIntersection(s.a, s.b, o.a, o.b);
      const eps = 3 / L;
      if (x && x.t > -eps && x.t < 1 + eps && x.u > -3 / dist(o.a, o.b) && x.u < 1 + 3 / dist(o.a, o.b)) ts.push(Math.max(0, Math.min(1, x.t)));
      for (const e of [o.a, o.b]) {
        const pr = projectOnSegment(e, s.a, s.b);
        if (pr.distance < 3 && pr.t > 0 && pr.t < 1) ts.push(pr.t);
      }
    }
    ts.sort((m, n) => m - n);
    const uniq: number[] = [];
    for (const t of ts) if (!uniq.length || (t - uniq[uniq.length - 1]) * L > 2) uniq.push(t);
    for (let k = 0; k + 1 < uniq.length; k++) {
      const p = add(s.a, mul(sub(s.b, s.a), uniq[k]));
      const q = add(s.a, mul(sub(s.b, s.a), uniq[k + 1]));
      const u = nodeIndex(p);
      const w = nodeIndex(q);
      if (u === w) continue;
      const key = u < w ? `${u}-${w}` : `${w}-${u}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ u, v: w, wallId: s.wallId });
    }
  }
  return { nodes, edges };
}

function findFaces(walls: Wall[]) {
  const { nodes, edges } = buildGraph(walls);
  // prune dangling edges
  let alive = edges.slice();
  for (;;) {
    const deg = new Map<number, number>();
    for (const e of alive) {
      deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
      deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
    }
    const next = alive.filter((e) => (deg.get(e.u) ?? 0) > 1 && (deg.get(e.v) ?? 0) > 1);
    if (next.length === alive.length) break;
    alive = next;
  }
  const adj = new Map<number, number[]>();
  const wallOf = new Map<string, Id>();
  for (const e of alive) {
    (adj.get(e.u) ?? adj.set(e.u, []).get(e.u)!).push(e.v);
    (adj.get(e.v) ?? adj.set(e.v, []).get(e.v)!).push(e.u);
    wallOf.set(`${e.u}>${e.v}`, e.wallId);
    wallOf.set(`${e.v}>${e.u}`, e.wallId);
  }
  for (const [n, list] of adj) {
    const p = nodes[n];
    list.sort((a, b) => Math.atan2(nodes[a].y - p.y, nodes[a].x - p.x) - Math.atan2(nodes[b].y - p.y, nodes[b].x - p.x));
  }
  const visited = new Set<string>();
  const faces: { polygon: Vec2[]; wallIds: Id[] }[] = [];
  for (const [u, list] of adj) {
    for (const w of list) {
      if (visited.has(`${u}>${w}`)) continue;
      const poly: Vec2[] = [];
      const wallIds: Id[] = [];
      let cu = u;
      let cv = w;
      let guard = 0;
      while (guard++ < 10000) {
        visited.add(`${cu}>${cv}`);
        poly.push(nodes[cu]);
        wallIds.push(wallOf.get(`${cu}>${cv}`)!);
        const around = adj.get(cv)!;
        const idx = around.indexOf(cu);
        const nxt = around[(idx - 1 + around.length) % around.length];
        cu = cv;
        cv = nxt;
        if (cu === u && cv === w) break;
      }
      // Bounded faces are clockwise on screen (positive area) with this turning rule.
      if (signedArea(poly) > 250_000) faces.push(simplify(poly, wallIds));
    }
  }
  return faces;
}

/** Remove collinear vertices so a room outline has one vertex per corner. */
function simplify(poly: Vec2[], wallIds: Id[]) {
  const outP: Vec2[] = [];
  const outW: Id[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const c = cross(norm(sub(cur, prev)), norm(sub(nxt, cur)));
    if (Math.abs(c) > 1e-4) {
      outP.push(cur);
      outW.push(wallIds[i]);
    }
  }
  return { polygon: outP.length >= 3 ? outP : poly, wallIds: outP.length >= 3 ? outW : wallIds };
}

const cache = new WeakMap<BuildingModel, Derived>();

export function derive(model: BuildingModel): Derived {
  const hit = cache.get(model);
  if (hit) return hit;
  const faces = findFaces(model.walls);
  const wallById = new Map(model.walls.map((w) => [w.id, w]));
  const used = new Set<number>();
  const rooms: DerivedRoom[] = [];
  const unenclosed: Id[] = [];
  const assign = new Map<number, RoomMeta>();

  for (const meta of model.rooms) {
    const fi = faces.findIndex((f, i) => !used.has(i) && pointInPolygon(meta.seed, f.polygon));
    if (fi >= 0) {
      used.add(fi);
      assign.set(fi, meta);
    }
  }
  // Rooms whose seed left every face (e.g. after a wall moved): nearest unused face.
  for (const meta of model.rooms) {
    if ([...assign.values()].includes(meta)) continue;
    let best = -1;
    let bestD = Infinity;
    faces.forEach((f, i) => {
      if (used.has(i)) return;
      const d = dist(polygonCentroid(f.polygon), meta.seed);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && bestD < 3000) {
      used.add(best);
      assign.set(best, meta);
    } else unenclosed.push(meta.id);
  }

  let autoN = 1;
  faces.forEach((f, i) => {
    const meta: RoomMeta =
      assign.get(i) ?? {
        id: `R?${autoN}`,
        name: `Unnamed space ${autoN++}`,
        type: 'other',
        floorMaterialId: 'oak',
        seed: interiorPoint(f.polygon),
        prov: { name: 'assumed', type: 'assumed' },
      };
    const distances = f.wallIds.map((id) => (wallById.get(id)?.thickness ?? 100) / 2);
    const inner = insetPolygon(f.polygon, distances);
    rooms.push({
      ...meta,
      polygon: f.polygon,
      inner,
      area: polygonArea(inner) / 1e6,
      grossArea: polygonArea(f.polygon) / 1e6,
      perimeter: polygonPerimeter(inner) / 1000,
      centroid: interiorPoint(inner),
      wallIds: [...new Set(f.wallIds)],
    });
  });

  const roomAt = (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon));
  const links = new Map<Id, OpeningLink>();
  const connections = new Map<Id, Set<Id>>();
  for (const r of rooms) connections.set(r.id, new Set());
  for (const o of model.openings) {
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const c = pointAlongWall(w, o.offset);
    const n = wallNormal(w);
    const off = w.thickness / 2 + 120;
    const plus = roomAt(add(c, mul(n, off)))?.id ?? null;
    const minus = roomAt(add(c, mul(n, -off)))?.id ?? null;
    links.set(o.id, { openingId: o.id, plus, minus });
    if (o.kind !== 'window' && plus && minus) {
      connections.get(plus)?.add(minus);
      connections.get(minus)?.add(plus);
    }
  }

  const d: Derived = { rooms, roomById: new Map(rooms.map((r) => [r.id, r])), links, connections, unenclosed, roomAt };
  cache.set(model, d);
  return d;
}

/** After geometry edits, move each room's seed to the centre of the face it now occupies. */
export function refreshSeeds(model: BuildingModel): BuildingModel {
  const d = derive(model);
  const rooms = model.rooms.map((m) => {
    const r = d.roomById.get(m.id);
    return r ? { ...m, seed: r.centroid } : m;
  });
  return { ...model, rooms };
}

export function openingWall(model: BuildingModel, o: Opening) {
  return model.walls.find((w) => w.id === o.wallId);
}
