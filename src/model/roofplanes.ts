/**
 * Gable and hip roofs the way BIM tools build a roof from its footprint: one outline round the
 * whole building (every wing together, pushed out by the overhang), and a roof plane rising from
 * each eave at the pitch. A gable end is an edge that does not slope (its plane is the vertical
 * end wall); with every edge sloping you get a hip roof. Where planes meet they make the ridges,
 * hips and valleys, so an L, T or U shaped house gets one roof with proper valleys rather than a
 * box per wing pushed through each other.
 *
 * For a square-cornered plan the height of that roof at any point is the pitch times the distance
 * to the nearest sloping eave, measured as the larger of the two axis distances (the straight
 * skeleton of a right-angled polygon is its L-infinity medial axis). So it can be evaluated
 * anywhere and meshed finely with no special cases, whatever the shape.
 *
 * A drawing that is slightly off (walls a little out of line, a small step in the outline) is
 * tidied first: lines closer than 300 mm are already merged, and small notches in the outline are
 * filled, so the roof doesn't sprout little hips and valleys over a drawing error.
 */
import type { RoofDesign, Vec2 } from './types';
import type { P3, Rect, RoofShape } from './roof';

/** One straight edge of the roof's outline, with the side the building is on. */
interface Edge {
  hz: boolean;
  /** y of a horizontal edge, x of a vertical one */
  c: number;
  lo: number;
  hi: number;
  /** +1 when the building is on the side of larger y (horizontal) or larger x (vertical) */
  side: 1 | -1;
  slopes: boolean;
}

export function boxAround(all: Vec2[]): Vec2[] {
  const fx = all.map((p) => p.x);
  const fy = all.map((p) => p.y);
  return [
    { x: Math.min(...fx), y: Math.min(...fy) },
    { x: Math.max(...fx), y: Math.min(...fy) },
    { x: Math.max(...fx), y: Math.max(...fy) },
    { x: Math.min(...fx), y: Math.max(...fy) },
  ];
}

/** Notches narrower than this in the outline are drawing errors or tiny recesses: roof over them. */
const NOTCH = 1200;

export function planesRoof(design: RoofDesign, rects: Rect[], base: number, o: number, overhang: number, tan: number): RoofShape {
  const grown = rects.map((r) => ({ minX: r.minX - o, minY: r.minY - o, maxX: r.maxX + o, maxY: r.maxY + o }));
  // Cells between every outline coordinate; the outline is where a filled cell meets an empty one.
  const xs = [...new Set(grown.flatMap((r) => [r.minX, r.maxX]))].sort((a, b) => a - b);
  const ys = [...new Set(grown.flatMap((r) => [r.minY, r.maxY]))].sort((a, b) => a - b);
  const NX = xs.length - 1;
  const NY = ys.length - 1;
  const cell: boolean[][] = [];
  for (let i = 0; i < NX; i++) {
    cell.push([]);
    for (let j = 0; j < NY; j++) {
      const x = (xs[i] + xs[i + 1]) / 2;
      const y = (ys[j] + ys[j + 1]) / 2;
      cell[i].push(grown.some((r) => x > r.minX && x < r.maxX && y > r.minY && y < r.maxY));
    }
  }
  const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < NX && j < NY && cell[i][j];
  // Fill small notches: an empty cell closed in on three sides and narrow across the opening.
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < NX; i++)
      for (let j = 0; j < NY; j++) {
        if (cell[i][j]) continue;
        const l = filled(i - 1, j);
        const r = filled(i + 1, j);
        const u = filled(i, j - 1);
        const d = filled(i, j + 1);
        const w = xs[i + 1] - xs[i];
        const h = ys[j + 1] - ys[j];
        if ((l && r && (u || d) && w < NOTCH) || (u && d && (l || r) && h < NOTCH)) cell[i][j] = true;
      }
  const inside = (x: number, y: number) => {
    if (x <= xs[0] || x >= xs[NX] || y <= ys[0] || y >= ys[NY]) return false;
    let i = 0;
    while (i < NX - 1 && xs[i + 1] <= x) i++;
    let j = 0;
    while (j < NY - 1 && ys[j + 1] <= y) j++;
    return cell[i][j];
  };
  const units: Edge[] = [];
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++) {
      if (!cell[i][j]) continue;
      if (!filled(i - 1, j)) units.push({ hz: false, c: xs[i], lo: ys[j], hi: ys[j + 1], side: 1, slopes: true });
      if (!filled(i + 1, j)) units.push({ hz: false, c: xs[i + 1], lo: ys[j], hi: ys[j + 1], side: -1, slopes: true });
      if (!filled(i, j - 1)) units.push({ hz: true, c: ys[j], lo: xs[i], hi: xs[i + 1], side: 1, slopes: true });
      if (!filled(i, j + 1)) units.push({ hz: true, c: ys[j + 1], lo: xs[i], hi: xs[i + 1], side: -1, slopes: true });
    }
  // Join pieces along the same line into whole edges.
  units.sort((a, b) => Number(a.hz) - Number(b.hz) || a.side - b.side || a.c - b.c || a.lo - b.lo);
  const edges: Edge[] = [];
  for (const u of units) {
    const last = edges[edges.length - 1];
    if (last && last.hz === u.hz && last.side === u.side && last.c === u.c && Math.abs(last.hi - u.lo) < 1e-6) last.hi = u.hi;
    else edges.push({ ...u });
  }
  // Corners: which edge meets which, and whether the corner points out (convex) or in.
  const key = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
  const ends = (e: Edge): [Vec2, Vec2] => (e.hz ? [{ x: e.lo, y: e.c }, { x: e.hi, y: e.c }] : [{ x: e.c, y: e.lo }, { x: e.c, y: e.hi }]);
  const at = new Map<string, number[]>();
  edges.forEach((e, k) => ends(e).forEach((p) => at.set(key(p), [...(at.get(key(p)) ?? []), k])));
  const inward = (e: Edge): Vec2 => (e.hz ? { x: 0, y: e.side } : { x: e.side, y: 0 });
  const len = (e: Edge) => e.hi - e.lo;
  const corner = (k: number, p: Vec2) => {
    const other = (at.get(key(p)) ?? []).find((j) => j !== k && edges[j].hz !== edges[k].hz);
    if (other === undefined) return null;
    const [f0, f1] = ends(edges[other]);
    const far = Math.hypot(f0.x - p.x, f0.y - p.y) < 1 ? f1 : f0;
    const n = inward(edges[k]);
    return { other, convex: (far.x - p.x) * n.x + (far.y - p.y) * n.y > 0 };
  };
  const wingEnd = (k: number) => {
    const [p0, p1] = ends(edges[k]);
    const c0 = corner(k, p0);
    const c1 = corner(k, p1);
    return !!c0 && !!c1 && c0.convex && c1.convex;
  };
  /** How far the building runs back from the middle of an edge. */
  const depth = (e: Edge) => {
    const n = inward(e);
    const m = e.hz ? { x: (e.lo + e.hi) / 2, y: e.c } : { x: e.c, y: (e.lo + e.hi) / 2 };
    let d = 25;
    while (d < 200000 && inside(m.x + n.x * d, m.y + n.y * d)) d += 50;
    return d;
  };
  if (design.kind === 'gable') {
    const single = rects.length === 1 && design.ridge !== 'auto';
    for (const [k, e] of edges.entries()) {
      if (single) {
        // a one-piece roof with its ridge along x has its gables on the x ends (the vertical edges)
        e.slopes = design.ridge === 'x' ? e.hz : !e.hz;
        continue;
      }
      // The end of a wing: both its corners point out, and the wing behind it runs further back
      // than the edge is wide (an end is short, a long side is not).
      if (wingEnd(k) && depth(e) > len(e) * 1.1) e.slopes = false;
    }
    // A square wing has no short side: put its gables on the x ends (a ridge along x).
    if (!single && edges.every((e) => e.slopes)) edges.forEach((e, k) => (e.slopes = !(wingEnd(k) && !e.hz && depth(e) >= len(e) * 0.9)));
    if (!edges.some((e) => e.slopes)) edges.forEach((e) => (e.slopes = true));
  }
  const sloped = edges.map((e, k) => ({ e, k })).filter((x) => x.e.slopes);
  /** Distance to the nearest sloping eave (and which one), measured the L-infinity way. */
  const reach = (x: number, y: number) => {
    let best = Infinity;
    let arg = -1;
    let square = false;
    for (const { e, k } of sloped) {
      const across = (e.hz ? y - e.c : x - e.c) * e.side;
      if (across < -1) continue; // the building is not on this edge's side
      const along = e.hz ? x : y;
      const beyond = Math.max(e.lo - along, along - e.hi);
      const d = Math.max(Math.abs(across), beyond);
      if (d < best - 1e-9) {
        best = d;
        arg = k;
        square = Math.abs(across) >= beyond; // on the edge's own plane, not past its end
      }
    }
    return { d: best === Infinity ? 0 : best, arg, square };
  };
  // The eave passes through the outer face of the wall at wall-top height.
  const eave = base - overhang * tan;
  const height = (x: number, y: number) => eave + reach(x, y).d * tan;

  // Mesh lines at every outline coordinate and every possible ridge line (half-way between two
  // parallel edges), filled in at a fine spacing.
  const bx0 = xs[0];
  const bx1 = xs[NX];
  const by0 = ys[0];
  const by1 = ys[NY];
  const step = Math.min(250, Math.max(50, Math.sqrt(((bx1 - bx0) * (by1 - by0)) / 30000)));
  const gridLines = (coords: number[]) => {
    const keys = new Set(coords);
    for (let a = 0; a < coords.length; a++) for (let b = a + 1; b < coords.length; b++) keys.add((coords[a] + coords[b]) / 2);
    const sorted = [...keys].sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (out.length && sorted[i] - out[out.length - 1] < 1) continue;
      out.push(sorted[i]);
      if (i + 1 < sorted.length) {
        const n = Math.ceil((sorted[i + 1] - sorted[i]) / step);
        for (let k = 1; k < n; k++) out.push(sorted[i] + ((sorted[i + 1] - sorted[i]) * k) / n);
      }
    }
    return out;
  };
  const GX = gridLines(xs);
  const GY = gridLines(ys);
  const H = GY.map((y) => GX.map((x) => height(x, y)));
  let peak = base;
  for (let j = 0; j < GY.length - 1; j++)
    for (let i = 0; i < GX.length - 1; i++)
      if (inside((GX[i] + GX[i + 1]) / 2, (GY[j] + GY[j + 1]) / 2)) peak = Math.max(peak, H[j][i], H[j][i + 1], H[j + 1][i], H[j + 1][i + 1]);

  const surfaces = () => {
    const out: [P3, P3, P3][] = [];
    for (let j = 0; j < GY.length - 1; j++)
      for (let i = 0; i < GX.length - 1; i++) {
        const cx = (GX[i] + GX[i + 1]) / 2;
        const cy = (GY[j] + GY[j + 1]) / 2;
        if (!inside(cx, cy)) continue;
        const p00: P3 = [GX[i], GY[j], H[j][i]];
        const p10: P3 = [GX[i + 1], GY[j], H[j][i + 1]];
        const p01: P3 = [GX[i], GY[j + 1], H[j + 1][i]];
        const p11: P3 = [GX[i + 1], GY[j + 1], H[j + 1][i + 1]];
        // split the cell along the diagonal that follows the roof (a hip or a valley)
        const hc = height(cx, cy);
        if (Math.abs((p00[2] + p11[2]) / 2 - hc) <= Math.abs((p10[2] + p01[2]) / 2 - hc)) out.push([p00, p10, p11], [p00, p11, p01]);
        else out.push([p00, p10, p01], [p10, p11, p01]);
      }
    return out;
  };
  // Gable end walls: on the wall's outer face, from the wall top up to just under the roof.
  const gableWalls = () => {
    const out: [P3, P3, P3][] = [];
    for (const e of edges) {
      if (e.slopes) continue;
      const c = e.c + e.side * overhang;
      const lo = e.lo + overhang;
      const hi = e.hi - overhang;
      if (hi <= lo) continue;
      const stops = [...new Set([lo, hi, ...(e.hz ? GX : GY).filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
      const pt = (v: number, h: number): P3 => (e.hz ? [v, c, h] : [c, v, h]);
      const top = (v: number) => Math.max(base, (e.hz ? height(v, c) : height(c, v)) - 15);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        out.push([pt(a, base), pt(b, base), pt(b, top(b))], [pt(a, base), pt(b, top(b)), pt(a, top(a))]);
      }
    }
    return out;
  };

  // Ridges: where the planes of two opposite eaves meet, along a mesh line.
  const argAt = (x: number, y: number) => (inside(x, y) ? reach(x, y).arg : -1);
  // for ridges, only points on an eave's own plane count (past an edge's end it is a hip or valley)
  const planeAt = (x: number, y: number) => {
    if (!inside(x, y)) return -1;
    const r = reach(x, y);
    return r.square ? r.arg : -1;
  };
  const ridges: [Vec2, Vec2][] = [];
  const addRuns = (pieces: [number, number, number][], hz: boolean) => {
    pieces.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur: [number, number, number] | null = null;
    const flush = () => {
      if (cur) ridges.push(hz ? [{ x: cur[1], y: cur[0] }, { x: cur[2], y: cur[0] }] : [{ x: cur[0], y: cur[1] }, { x: cur[0], y: cur[2] }]);
    };
    for (const pc of pieces) {
      if (cur && cur[0] === pc[0] && Math.abs(cur[2] - pc[1]) < 1e-6) cur[2] = pc[2];
      else {
        flush();
        cur = [...pc];
      }
    }
    flush();
  };
  const hzPieces: [number, number, number][] = [];
  const vtPieces: [number, number, number][] = [];
  const opposite = (a: number, b: number, hz: boolean) => a >= 0 && b >= 0 && a !== b && edges[a].hz === hz && edges[b].hz === hz && edges[a].side !== edges[b].side;
  for (let j = 1; j < GY.length - 1; j++)
    for (let i = 0; i < GX.length - 1; i++) {
      const cx = (GX[i] + GX[i + 1]) / 2;
      if (opposite(planeAt(cx, (GY[j - 1] + GY[j]) / 2), planeAt(cx, (GY[j] + GY[j + 1]) / 2), true)) hzPieces.push([GY[j], GX[i], GX[i + 1]]);
    }
  for (let i = 1; i < GX.length - 1; i++)
    for (let j = 0; j < GY.length - 1; j++) {
      const cy = (GY[j] + GY[j + 1]) / 2;
      if (opposite(planeAt((GX[i - 1] + GX[i]) / 2, cy), planeAt((GX[i] + GX[i + 1]) / 2, cy), false)) vtPieces.push([GX[i], GY[j], GY[j + 1]]);
    }
  addRuns(hzPieces, true);
  addRuns(vtPieces, false);
  // Hips and valleys: from each corner between two sloping eaves, at 45° into the roof, up to
  // where another plane takes over.
  const hips: [Vec2, Vec2][] = [];
  for (const [k, e] of edges.entries()) {
    if (!e.slopes) continue;
    for (const p of ends(e)) {
      const c = corner(k, p);
      if (!c || c.other < k || !edges[c.other].slopes) continue;
      const n1 = inward(e);
      const n2 = inward(edges[c.other]);
      // an outside corner's hip and an inside corner's valley both run between the two inward sides
      const dir = { x: n1.x + n2.x, y: n1.y + n2.y };
      const own = new Set([k, c.other]);
      const ds = step / 2;
      let s = 0;
      while (s < 100000) {
        const r = argAt(p.x + dir.x * (s + ds), p.y + dir.y * (s + ds));
        if (r < 0 || !own.has(r)) break;
        s += ds;
      }
      if (s > 0) hips.push([p, { x: p.x + dir.x * s, y: p.y + dir.y * s }]);
    }
  }
  // The outline as closed loops, for the plan.
  const outlines: Vec2[][] = [];
  const used = new Set<number>();
  for (let start = 0; start < edges.length; start++) {
    if (used.has(start)) continue;
    const loop: Vec2[] = [];
    let k = start;
    let p = ends(edges[k])[0];
    while (!used.has(k)) {
      used.add(k);
      loop.push(p);
      const [a, b] = ends(edges[k]);
      p = Math.hypot(a.x - p.x, a.y - p.y) < 1 ? b : a;
      const next = (at.get(key(p)) ?? []).find((j) => j !== k && !used.has(j));
      if (next === undefined) break;
      k = next;
    }
    if (loop.length >= 3) outlines.push(loop);
  }
  let tris: [P3, P3, P3][] | null = null;
  let walls: [P3, P3, P3][] | null = null;
  return {
    design,
    footprint: boxAround(outlines.length ? outlines.flat() : [{ x: bx0, y: by0 }, { x: bx1, y: by1 }]),
    outlines,
    ridges,
    hips,
    base,
    peak,
    // the surfaces are built when the 3D view asks for them; the plan only needs the lines
    get triangles() {
      return (tris ??= surfaces());
    },
    get endWalls() {
      return (walls ??= gableWalls());
    },
  };
}
