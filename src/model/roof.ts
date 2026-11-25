/**
 * Roof geometry from the building model. A floor plan doesn't define the roof, so the
 * roof is a separate, editable design: type, pitch, overhang, ridge direction and
 * material. Each wing of the building (L, T or U shapes) gets its own roof piece, fitted to the
 * rooms below it, so the roof never covers open ground or a porch.
 */
import type { BuildingModel, RoofDesign, Vec2 } from './types';
import { normalizeRoof } from './edits';
import { derive } from './derive';
import { pointInPolygon } from './geometry';
import { isPorch, porchRoof } from './porch';
import { planesRoof } from './roofplanes';

export type P3 = [number, number, number]; // plan x (mm), plan y (mm), height above floor (mm)

export interface RoofShape {
  design: RoofDesign;
  /** The whole roof's outline in plan (the rectangle around it). */
  footprint: Vec2[];
  /** Each roof piece's outline in plan: one per wing of the building. */
  outlines: Vec2[][];
  ridges: [Vec2, Vec2][];
  hips: [Vec2, Vec2][];
  base: number;
  peak: number;
  /** Triangles (three points each) describing the roof surfaces and gable ends. */
  triangles: [P3, P3, P3][];
  /** Triangles for vertical gable or shed end walls (drawn in wall material). */
  endWalls: [P3, P3, P3][];
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The building's outline as rectangles, from its rooms (wall centrelines). Porches and decks
 * bounded by handrails are left out unless they are recessed into the house (or set to go under
 * the main roof). A plan with angled or curved walls, or a very
 * broken-up outline, falls back to one rectangle around the outside walls.
 */
export function roofRects(model: BuildingModel): Rect[] {
  const ext = model.walls.filter((w) => w.exterior && w.kind !== 'railing');
  const solid = ext.length ? ext : model.walls.filter((w) => w.kind !== 'railing');
  const around = (): Rect[] => {
    if (!solid.length) return [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of solid)
      for (const p of [w.a, w.b]) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
    return [{ minX, minY, maxX, maxY }];
  };
  // Porches: a recessed one sits under the main roof; a projecting or open one doesn't.
  const rooms = derive(model).rooms.filter((r) => !isPorch(model, r) || porchRoof(model, r) === 'main');
  if (!rooms.length) return around();
  const orthogonal = rooms.every((r) =>
    r.polygon.every((p, i) => {
      const q = r.polygon[(i + 1) % r.polygon.length];
      // Square to the grid, allowing a slight lean (a scanned or hand-placed wall).
      const dx = Math.abs(p.x - q.x);
      const dy = Math.abs(p.y - q.y);
      return Math.min(dx, dy) <= Math.max(20, 0.03 * Math.hypot(dx, dy));
    }),
  );
  if (!orthogonal) return around();
  // Grid lines at every corner, merging lines closer than 300 mm (slightly crooked walls).
  const lines = (vals: number[]) => {
    const out: number[] = [];
    for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 300) out.push(v);
    return out;
  };
  const xs = lines(rooms.flatMap((r) => r.polygon.map((p) => p.x)));
  const ys = lines(rooms.flatMap((r) => r.polygon.map((p) => p.y)));
  if (xs.length < 2 || ys.length < 2) return around();
  const filled = (i: number, j: number) => {
    const c = { x: (xs[i] + xs[i + 1]) / 2, y: (ys[j] + ys[j + 1]) / 2 };
    return rooms.some((r) => pointInPolygon(c, r.polygon));
  };
  // Rows of filled cells, then rows with the same runs stacked into rectangles.
  const strips: { y0: number; y1: number; runs: [number, number][] }[] = [];
  for (let j = 0; j < ys.length - 1; j++) {
    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= xs.length - 1; i++) {
      const on = i < xs.length - 1 && filled(i, j);
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        runs.push([xs[start], xs[i]]);
        start = -1;
      }
    }
    const prev = strips[strips.length - 1];
    if (prev && prev.y1 === ys[j] && JSON.stringify(prev.runs) === JSON.stringify(runs)) prev.y1 = ys[j + 1];
    else strips.push({ y0: ys[j], y1: ys[j + 1], runs });
  }
  const rects: Rect[] = strips.flatMap((st) => st.runs.map(([x0, x1]) => ({ minX: x0, maxX: x1, minY: st.y0, maxY: st.y1 })));
  // One roof is built over all of them together, so many pieces are fine; past this the outline
  // is too broken up to make sense of.
  return rects.length && rects.length <= 40 ? rects : around();
}

export function roofShape(model: BuildingModel): RoofShape | null {
  const design = normalizeRoof(model.roof);
  if (design.kind === 'none' || !model.walls.length) return null;
  const rects = roofRects(model);
  if (!rects.length) return null;
  const solid = model.walls.filter((w) => w.kind !== 'railing');
  const outer = solid.filter((w) => w.exterior);
  const t = Math.max(...(outer.length ? outer : solid).map((w) => w.thickness)) / 2;
  const base = Math.max(...solid.map((w) => w.height));
  const overhang = Math.max(0, design.overhang);
  const o = overhang + t;
  const tan = Math.tan((Math.min(60, Math.max(3, design.pitch)) * Math.PI) / 180);
  if (design.kind === 'gable' || design.kind === 'hip') return planesRoof(design, rects, base, o, overhang, tan);
  const tris: [P3, P3, P3][] = [];
  const ends: [P3, P3, P3][] = [];
  const ridges: [Vec2, Vec2][] = [];
  const hips: [Vec2, Vec2][] = [];
  const outlines: Vec2[][] = [];
  let peak = base;
  const quad = (a: P3, b: P3, c: P3, d: P3, out = tris) => {
    out.push([a, b, c], [a, c, d]);
  };

  for (const r of rects) {
    const minX = r.minX - o;
    const minY = r.minY - o;
    const maxX = r.maxX + o;
    const maxY = r.maxY + o;
    const W = maxX - minX;
    const D = maxY - minY;
    // Each wing's ridge runs along its length; a chosen direction applies to a one-piece roof.
    const along: 'x' | 'y' = design.ridge === 'auto' || rects.length > 1 ? (W >= D ? 'x' : 'y') : design.ridge;
    outlines.push([
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ]);
    // Local frame where the ridge runs along u; map back to plan x/y.
    const span = along === 'x' ? D : W;
    const len = along === 'x' ? W : D;
    // A sloping roof's low eave passes through the outer face of the wall at wall-top height.
    const drop = design.kind === 'shed' ? overhang * tan : 0;
    const P = (u: number, v: number, h: number): P3 => (along === 'x' ? [minX + u, minY + v, base + h - drop] : [minX + v, minY + u, base + h - drop]);
    const V = (u: number, v: number): Vec2 => (along === 'x' ? { x: minX + u, y: minY + v } : { x: minX + v, y: minY + u });

    if (design.kind === 'flat') {
      const th = 250;
      quad(P(0, 0, th), P(len, 0, th), P(len, span, th), P(0, span, th));
      quad(P(0, 0, 0), P(len, 0, 0), P(len, 0, th), P(0, 0, th), ends);
      quad(P(0, span, 0), P(len, span, 0), P(len, span, th), P(0, span, th), ends);
      quad(P(0, 0, 0), P(0, span, 0), P(0, span, th), P(0, 0, th), ends);
      quad(P(len, 0, 0), P(len, span, 0), P(len, span, th), P(len, 0, th), ends);
      peak = Math.max(peak, base + th);
    } else if (design.kind === 'shed') {
      const h = span * tan;
      quad(P(0, 0, 0), P(len, 0, 0), P(len, span, h), P(0, span, h));
      ends.push([P(0, 0, 0), P(0, span, 0), P(0, span, h)], [P(len, 0, 0), P(len, span, 0), P(len, span, h)]);
      quad(P(0, span, 0), P(len, span, 0), P(len, span, h), P(0, span, h), ends);
      ridges.push([V(0, span), V(len, span)]);
      peak = Math.max(peak, base + h);
    } else if (design.kind === 'gable') {
      const h = (span / 2) * tan;
      quad(P(0, 0, 0), P(len, 0, 0), P(len, span / 2, h), P(0, span / 2, h));
      quad(P(0, span, 0), P(len, span, 0), P(len, span / 2, h), P(0, span / 2, h));
      ends.push([P(0, 0, 0), P(0, span, 0), P(0, span / 2, h)], [P(len, 0, 0), P(len, span, 0), P(len, span / 2, h)]);
      ridges.push([V(0, span / 2), V(len, span / 2)]);
      peak = Math.max(peak, base + h);
    } else {
      // Hip: ridge shortened by half the span at each end (pyramid when square).
      const h = (span / 2) * tan;
      const inset = Math.min(span / 2, len / 2);
      const a = inset;
      const b = len - inset;
      quad(P(0, 0, 0), P(len, 0, 0), P(b, span / 2, h), P(a, span / 2, h));
      quad(P(0, span, 0), P(len, span, 0), P(b, span / 2, h), P(a, span / 2, h));
      tris.push([P(0, 0, 0), P(0, span, 0), P(a, span / 2, h)], [P(len, 0, 0), P(len, span, 0), P(b, span / 2, h)]);
      if (b - a > 1) ridges.push([V(a, span / 2), V(b, span / 2)]);
      hips.push([V(0, 0), V(a, span / 2)], [V(0, span), V(a, span / 2)], [V(len, 0), V(b, span / 2)], [V(len, span), V(b, span / 2)]);
      peak = Math.max(peak, base + h);
    }
  }
  const all = outlines.flat();
  const fx = all.map((p) => p.x);
  const fy = all.map((p) => p.y);
  const footprint: Vec2[] = [
    { x: Math.min(...fx), y: Math.min(...fy) },
    { x: Math.max(...fx), y: Math.min(...fy) },
    { x: Math.max(...fx), y: Math.max(...fy) },
    { x: Math.min(...fx), y: Math.max(...fy) },
  ];
  return { design, footprint, outlines, ridges, hips, base, peak, triangles: tris, endWalls: ends };
}

export const ROOF_LABEL: Record<RoofDesign['kind'], string> = {
  none: 'No roof',
  flat: 'Flat',
  shed: 'Mono-pitch',
  gable: 'Gable',
  hip: 'Hip',
};
