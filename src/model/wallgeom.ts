/**
 * Wall solids shared by the 2D drawing and the Three.js scene: clean corners
 * (one wall extends, the other stops at its face), T-junctions stopping at the
 * host wall's face, and solid spans split around openings.
 */
import { add, dot, lineIntersection, mul, perp, sub, dist, projectOnSegment, wallDir, wallLength } from './geometry';
import type { Vec2 } from './types';
import type { BuildingModel, Id, Opening, Wall } from './types';

export interface WallSolid {
  wall: Wall;
  /** Extension (+) or trim (−) at end a and end b, mm along the wall. */
  extA: number;
  extB: number;
  /** Full-height spans along the wall (from a, may start < 0 when extended). */
  spans: [number, number][];
  openings: Opening[];
  /**
   * Where each face of the wall starts and ends, mm along the wall from a. L is the face on the
   * wallNormal side, R the other. They differ at mitred corners and angled T-junctions, so walls
   * meet without gaps or steps; at square joins they are equal.
   */
  ends: { startL: number; startR: number; endL: number; endR: number };
}

/**
 * Mitre two walls that share an endpoint: each face runs to where it meets the matching face of
 * the other wall (the standard clean corner in BIM tools). Returns the face positions along `w`
 * from its end `end`, or null when the walls are in line or the mitre would be a long spike.
 */
function mitre(w: Wall, end: 'a' | 'b', o: Wall): { l: number; r: number } | null {
  const P = w[end];
  const L = wallLength(w);
  const d = wallDir(w);
  const u = end === 'a' ? d : mul(d, -1);
  const v = dist(o.a, P) < 5 ? wallDir(o) : mul(wallDir(o), -1);
  if (Math.abs(u.x * v.y - u.y * v.x) < 0.035) return null; // in line (under ~2°): plain butt
  const tw = w.thickness / 2;
  const to = o.thickness / 2;
  const pu = perp(u);
  const pv = perp(v);
  const x1 = lineIntersection(add(P, mul(pu, tw)), u, sub(P, mul(pv, to)), v);
  const x2 = lineIntersection(sub(P, mul(pu, tw)), u, add(P, mul(pv, to)), v);
  if (!x1 || !x2) return null;
  const s1 = dot(sub(x1, P), u);
  const s2 = dot(sub(x2, P), u);
  const limit = 4 * Math.max(w.thickness, o.thickness);
  if (Math.abs(s1) > limit || Math.abs(s2) > limit) return null; // very sharp angle: keep a butt join
  // +perp(u) is the L face at end a, the R face at end b.
  return end === 'a' ? { l: s1, r: s2 } : { l: L - s2, r: L - s1 };
}

/** An angled T: each face of `w` stops exactly on the face of the host wall it runs into. */
function trimToHost(w: Wall, end: 'a' | 'b', host: Wall): { l: number; r: number } | null {
  const d = wallDir(w);
  const n = perp(d);
  const L = wallLength(w);
  const hn = perp(wallDir(host));
  const inside = add(w[end], mul(end === 'a' ? d : mul(d, -1), Math.min(L / 2, 500)));
  const side = dot(sub(inside, host.a), hn) >= 0 ? 1 : -1;
  const face = add(host.a, mul(hn, (side * host.thickness) / 2));
  const along = (offset: number) => {
    const x = lineIntersection(add(w.a, mul(n, offset)), d, face, wallDir(host));
    return x ? dot(sub(x, w.a), d) : null;
  };
  const l = along(w.thickness / 2);
  const r = along(-w.thickness / 2);
  if (l === null || r === null) return null;
  const nominal = end === 'a' ? 0 : L;
  if (Math.abs(l - nominal) > host.thickness * 3 || Math.abs(r - nominal) > host.thickness * 3) return null;
  return { l, r };
}

/** Face positions at one end of a wall (see WallSolid.ends). */
function endFaces(w: Wall, end: 'a' | 'b', walls: Wall[], ext: number): { l: number; r: number } {
  const L = wallLength(w);
  const butt = end === 'a' ? -ext : L + ext;
  const P: Vec2 = w[end];
  const atEnd = walls.filter((o) => o.id !== w.id && (dist(o.a, P) < 5 || dist(o.b, P) < 5));
  if (atEnd.length === 1) return mitre(w, end, atEnd[0]) ?? { l: butt, r: butt };
  if (atEnd.length === 0) {
    for (const o of walls) {
      if (o.id === w.id) continue;
      const pr = projectOnSegment(P, o.a, o.b);
      if (pr.distance < (o.thickness + w.thickness) / 2 && pr.t > 0.001 && pr.t < 0.999) return trimToHost(w, end, o) ?? { l: butt, r: butt };
    }
  }
  return { l: butt, r: butt };
}

function endAdjust(w: Wall, end: 'a' | 'b', walls: Wall[]): number {
  const p = w[end];
  let adjust = 0;
  for (const o of walls) {
    if (o.id === w.id) continue;
    const tol = (o.thickness + w.thickness) / 2;
    const atA = dist(p, o.a) < 5;
    const atB = dist(p, o.b) < 5;
    if (atA || atB) {
      // Corner: the wall with the smaller id runs through, the other stops at its face.
      const parallel = Math.abs(((w.b.x - w.a.x) * (o.b.y - o.a.y) - (w.b.y - w.a.y) * (o.b.x - o.a.x)) / (wallLength(w) * wallLength(o) || 1)) < 0.2;
      if (parallel) continue;
      const runsThrough = w.id.localeCompare(o.id, undefined, { numeric: true }) < 0;
      adjust = runsThrough ? Math.max(adjust, o.thickness / 2) : Math.min(adjust, -o.thickness / 2);
      continue;
    }
    const pr = projectOnSegment(p, o.a, o.b);
    if (pr.distance < tol && pr.t > 0.001 && pr.t < 0.999) {
      // T-junction: stop at the host wall's face.
      adjust = Math.min(adjust, -(o.thickness / 2 - Math.min(pr.distance, o.thickness / 2)));
    }
  }
  return adjust;
}

/**
 * Where one solid stretch of a wall starts and ends on each face. Only a stretch that really
 * starts (or ends) at the wall's own end takes the corner's shape (mitre or T-junction face); a
 * door right at a corner leaves the first stretch starting after it, and it must not be pulled
 * back over the door.
 */
export function spanEnds(solid: Pick<WallSolid, 'wall' | 'extA' | 'extB' | 'ends'>, s: number, e: number) {
  const first = Math.abs(s + solid.extA) < 1;
  const last = Math.abs(e - (wallLength(solid.wall) + solid.extB)) < 1;
  return { sL: first ? solid.ends.startL : s, sR: first ? solid.ends.startR : s, eL: last ? solid.ends.endL : e, eR: last ? solid.ends.endR : e };
}

export function wallSolids(model: BuildingModel): WallSolid[] {
  const byWall = new Map<Id, Opening[]>();
  for (const o of model.openings) (byWall.get(o.wallId) ?? byWall.set(o.wallId, []).get(o.wallId)!).push(o);
  return model.walls.map((w) => {
    const L = wallLength(w);
    const extA = endAdjust(w, 'a', model.walls);
    const extB = endAdjust(w, 'b', model.walls);
    const openings = (byWall.get(w.id) ?? []).slice().sort((a, b) => a.offset - b.offset);
    const spans: [number, number][] = [];
    let cursor = -extA;
    for (const o of openings) {
      const s = Math.max(cursor, o.offset - o.width / 2);
      if (s - cursor > 1) spans.push([cursor, s]);
      cursor = Math.max(cursor, o.offset + o.width / 2);
    }
    if (L + extB - cursor > 1) spans.push([cursor, L + extB]);
    const a = endFaces(w, 'a', model.walls, extA);
    const b = endFaces(w, 'b', model.walls, extB);
    return { wall: w, extA, extB, spans, openings, ends: { startL: a.l, startR: a.r, endL: b.l, endR: b.r } };
  });
}
