import type { Furniture, Opening, Vec2, Wall } from './types';

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
export const len = (a: Vec2) => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
/** Left normal in a y-down plan (rotates the direction 90° counter-clockwise on screen). */
export const perp = (a: Vec2): Vec2 => ({ x: a.y, y: -a.x });
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const round = (n: number, step = 1) => Math.round(n / step) * step;

export function wallLength(w: Pick<Wall, 'a' | 'b'>) {
  return dist(w.a, w.b);
}
export function wallDir(w: Pick<Wall, 'a' | 'b'>) {
  return norm(sub(w.b, w.a));
}
export function wallNormal(w: Pick<Wall, 'a' | 'b'>) {
  return perp(wallDir(w));
}
export function pointAlongWall(w: Pick<Wall, 'a' | 'b'>, offset: number): Vec2 {
  return add(w.a, mul(wallDir(w), offset));
}
export function wallAngle(w: Pick<Wall, 'a' | 'b'>) {
  return Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x);
}

export function projectOnSegment(p: Vec2, a: Vec2, b: Vec2) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab) || 1;
  const tRaw = dot(sub(p, a), ab) / l2;
  const t = Math.max(0, Math.min(1, tRaw));
  const point = lerp(a, b, t);
  return { t, tRaw, point, distance: dist(p, point), along: tRaw * Math.sqrt(l2) };
}

export function segmentIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { point: Vec2; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(c, a), s) / denom;
  const u = cross(sub(c, a), r) / denom;
  return { point: add(a, mul(r, t)), t, u };
}

export function lineIntersection(p: Vec2, dirP: Vec2, q: Vec2, dirQ: Vec2): Vec2 | null {
  const denom = cross(dirP, dirQ);
  if (Math.abs(denom) < 1e-9) return null;
  const t = cross(sub(q, p), dirQ) / denom;
  return add(p, mul(dirP, t));
}

/** Signed area (positive = clockwise on screen, y-down). */
export function signedArea(poly: Vec2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
export const polygonArea = (poly: Vec2[]) => Math.abs(signedArea(poly));

export function polygonCentroid(poly: Vec2[]): Vec2 {
  const A = signedArea(poly);
  if (Math.abs(A) < 1e-9) {
    const s = poly.reduce((acc, p) => add(acc, p), v(0, 0));
    return mul(s, 1 / Math.max(1, poly.length));
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const f = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * f;
    cy += (a.y + b.y) * f;
  }
  return { x: cx / (6 * A), y: cy / (6 * A) };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function polygonPerimeter(poly: Vec2[]) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += dist(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

export function bbox(points: Vec2[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** A point guaranteed to be inside the polygon (centroid if inside, else a scanline midpoint). */
export function interiorPoint(poly: Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  const b = bbox(poly);
  for (let k = 1; k < 20; k++) {
    const y = b.minY + (b.h * k) / 20;
    const xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const d = poly[(i + 1) % poly.length];
      if (a.y > y !== d.y > y) xs.push(a.x + ((y - a.y) * (d.x - a.x)) / (d.y - a.y));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1) return v((xs[i] + xs[i + 1]) / 2, y);
    }
  }
  return c;
}

/**
 * Inset a simple polygon by a per-edge distance (e.g. half wall thickness) to
 * get the clear internal outline. Works for the orthogonal and mildly angled
 * rooms ArchiMind reconstructs.
 */
export function insetPolygon(poly: Vec2[], distances: number[]): Vec2[] {
  const n = poly.length;
  if (n < 3) return poly;
  const sign = signedArea(poly) > 0 ? 1 : -1; // clockwise on screen → inward is right normal
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const d = norm(sub(q, p));
    // perp() is the left normal; for a clockwise polygon (y-down) the interior is on the right.
    const inward = mul(perp(d), -sign);
    const off = mul(inward, distances[i] ?? 0);
    return { p: add(p, off), d };
  });
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n;
    const prev = lines[j];
    const cur = lines[i];
    const x = lineIntersection(prev.p, prev.d, cur.p, cur.d);
    // Two nearly parallel edges (a slightly crooked wall from a scanned drawing) meet far away.
    // Cap the corner so a room outline never grows a spike kilometres long.
    const limit = 4 * Math.max(distances[i] ?? 0, distances[j] ?? 0, 50);
    if (x && dist(x, poly[i]) <= limit) out.push(x);
    else {
      const prevEnd = add(poly[i], sub(prev.p, poly[j]));
      out.push(lerp(prevEnd, cur.p, 0.5));
    }
  }
  return out;
}

// --- Convex polygon overlap (SAT) used for clearance checks -----------------

function axesOf(poly: Vec2[]) {
  const axes: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const e = sub(poly[(i + 1) % poly.length], poly[i]);
    if (len(e) > 1e-6) axes.push(norm(perp(e)));
  }
  return axes;
}

/** Returns penetration depth (mm) along the separating axis with the least overlap; 0 if disjoint. */
export function convexOverlap(p: Vec2[], q: Vec2[]): number {
  let min = Infinity;
  for (const axis of [...axesOf(p), ...axesOf(q)]) {
    let pMin = Infinity,
      pMax = -Infinity,
      qMin = Infinity,
      qMax = -Infinity;
    for (const pt of p) {
      const d = dot(pt, axis);
      pMin = Math.min(pMin, d);
      pMax = Math.max(pMax, d);
    }
    for (const pt of q) {
      const d = dot(pt, axis);
      qMin = Math.min(qMin, d);
      qMax = Math.max(qMax, d);
    }
    const o = Math.min(pMax, qMax) - Math.max(pMin, qMin);
    if (o <= 0) return 0;
    min = Math.min(min, o);
  }
  return min === Infinity ? 0 : min;
}

// --- Element geometry --------------------------------------------------------

export function furnitureFootprint(f: Pick<Furniture, 'x' | 'y' | 'w' | 'd' | 'rotation'>): Vec2[] {
  const r = (f.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const hw = f.w / 2;
  const hd = f.d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([x, y]) => v(f.x + x * c - y * s, f.y + x * s + y * c));
}

export interface OpeningFrame {
  center: Vec2;
  start: Vec2;
  end: Vec2;
  dir: Vec2;
  normal: Vec2;
  hingePoint: Vec2;
  closedTip: Vec2;
  swingDir: Vec2;
}

export function openingFrame(o: Opening, w: Wall): OpeningFrame {
  const dir = wallDir(w);
  const normal = wallNormal(w);
  const center = pointAlongWall(w, o.offset);
  const start = add(center, mul(dir, -o.width / 2));
  const end = add(center, mul(dir, o.width / 2));
  const swingDir = mul(normal, o.swing);
  const face = add(center, mul(swingDir, w.thickness / 2));
  const hingeOnFace = add(face, mul(dir, o.hinge === 'start' ? -o.width / 2 : o.width / 2));
  const tipOnFace = add(face, mul(dir, o.hinge === 'start' ? o.width / 2 : -o.width / 2));
  return { center, start, end, dir, normal, hingePoint: hingeOnFace, closedTip: tipOnFace, swingDir };
}

/** Quarter-disc swept by a door leaf, as a convex polygon (hinge + arc points). */
export function doorSwingPolygon(o: Opening, w: Wall, segments = 10): Vec2[] {
  const f = openingFrame(o, w);
  const r = o.width;
  const startVec = norm(sub(f.closedTip, f.hingePoint));
  const pts: Vec2[] = [f.hingePoint];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * (Math.PI / 2);
    const dirv = add(mul(startVec, Math.cos(t)), mul(f.swingDir, Math.sin(t)));
    pts.push(add(f.hingePoint, mul(dirv, r)));
  }
  return pts;
}

export function wallPolygon(w: Wall): Vec2[] {
  const n = mul(wallNormal(w), w.thickness / 2);
  return [add(w.a, n), add(w.b, n), sub(w.b, n), sub(w.a, n)];
}

export function fmtMm(mm: number) {
  return `${Math.round(mm).toLocaleString('en-GB')} mm`;
}
export function fmtM2(m2: number) {
  return `${m2.toFixed(1)} m²`;
}

/** Doors 2.5 m or wider are roller shutters: they roll up instead of swinging. */
/** A roller shutter: only wide doors in an industrial building (a home's wide door is a pair of doors). */
export const isRollerDoor = (o: Pick<Opening, 'kind' | 'width'>, industrial = false) => industrial && o.kind === 'door' && o.width >= 2500;
/**
 * A pair of doors, drawn as two leaves hinged at each side: one you made a double door, or a wide
 * hinged door that isn't a roller shutter.
 */
export const isDoubleDoor = (o: Pick<Opening, 'kind' | 'width' | 'style'>, industrial = false) => o.kind === 'door' && (o.style === 'double' || (!o.style && o.width > 1500)) && !isRollerDoor(o, industrial);
/** A sliding door: two panels that slide past each other, no swing. */
export const isSlidingDoor = (o: Pick<Opening, 'kind' | 'style'>) => o.kind === 'door' && o.style === 'sliding';
/** A door that slides or folds within its opening (sliding, pocket, folding): no swing into the room. */
export const noSwing = (o: Pick<Opening, 'kind' | 'style'>) => o.kind === 'door' && (o.style === 'sliding' || o.style === 'pocket' || o.style === 'folding');
/** The two leaves of a pair of doors, as two half-width doors hinged at the outer ends. */
export function doorLeaves<T extends Pick<Opening, 'offset' | 'width' | 'hinge'>>(o: T): T[] {
  return [
    { ...o, offset: o.offset - o.width / 4, width: o.width / 2, hinge: 'start' },
    { ...o, offset: o.offset + o.width / 4, width: o.width / 2, hinge: 'end' },
  ];
}
