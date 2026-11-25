/**
 * Furniture and fittings found on the drawing itself: each closed shape drawn inside the building
 * that is not a wall. Their outlines give an exact place and size; what each one is, is asked of
 * AI with the legend sheet (the same split as for doors and windows: pixels find, AI names).
 * AI's own boxes for furniture are often in the wrong place, sometimes scaled wrongly.
 */
import type { DetectedOpening, DetectedWall } from './detector';
import type { Rect } from './symbolsheet';
import { noSwing } from '../model/geometry';

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/**
 * Shapes drawn inside the building: ink (pale grey included) with the walls taken away, joined
 * into connected shapes; a shape inside another (pillows on a bed, a tap on a basin) joins it.
 * Kept: closed outlines (each row and each column across it meets its outline twice), between a
 * small basin and a large bed in size. Left out: text, straight lines (worktop edges and
 * dimensions), the swing of each door the pixel check found, anything outside the walls.
 */
export function furnitureCandidates(rgba: Uint8ClampedArray | Uint8Array, W: number, H: number, walls: DetectedWall[], openings: DetectedOpening[] = [], max = 56): Rect[] {
  if (!walls.length) return [];
  const t = median(walls.map((w) => w.thickness)) || 6;
  const ink = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) ink[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2] < 215 ? 1 : 0;
  // the walls (and whatever is drawn in them: windows, door frames) are not furniture; where they
  // were still counts as an edge, so a cupboard drawn against a wall is a closed shape
  const wallBand = new Uint8Array(W * H);
  for (const w of walls) {
    const pad = w.thickness / 2 + 3;
    const x0 = Math.max(0, Math.floor(Math.min(w.a.x, w.b.x) - pad));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(w.a.x, w.b.x) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(w.a.y, w.b.y) - pad));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(w.a.y, w.b.y) + pad));
    for (let y = y0; y <= y1; y++) {
      ink.fill(0, y * W + x0, y * W + x1 + 1);
      wallBand.fill(1, y * W + x0, y * W + x1 + 1);
    }
  }
  // inside the building: walls on all four sides (a porch's railing outline is not furniture)
  const enclosed = (x: number, y: number) => {
    const hit = (dir: 'l' | 'r' | 'u' | 'd') =>
      walls.some((w) => {
        const vert = Math.abs(w.a.x - w.b.x) < 1;
        const horiz = Math.abs(w.a.y - w.b.y) < 1;
        if (dir === 'l' || dir === 'r') return vert && Math.min(w.a.y, w.b.y) - 2 <= y && Math.max(w.a.y, w.b.y) + 2 >= y && (dir === 'l' ? w.a.x < x : w.a.x > x);
        return horiz && Math.min(w.a.x, w.b.x) - 2 <= x && Math.max(w.a.x, w.b.x) + 2 >= x && (dir === 'u' ? w.a.y < y : w.a.y > y);
      });
    return hit('l') && hit('r') && hit('u') && hit('d');
  };
  const bx0 = Math.min(...walls.flatMap((w) => [w.a.x, w.b.x]));
  const bx1 = Math.max(...walls.flatMap((w) => [w.a.x, w.b.x]));
  const by0 = Math.min(...walls.flatMap((w) => [w.a.y, w.b.y]));
  const by1 = Math.max(...walls.flatMap((w) => [w.a.y, w.b.y]));

  // connected shapes (8 neighbours)
  const label = new Int32Array(W * H);
  const comps: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [{ x0: 0, y0: 0, x1: 0, y1: 0, n: 0 }];
  const stack: number[] = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || label[start]) continue;
    const id = comps.length;
    const c = { x0: W, y0: H, x1: 0, y1: 0, n: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W;
      const y = (i - x) / W;
      c.n++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (ink[j] && !label[j]) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    comps.push(c);
  }

  // closed: most rows and columns across the shape meet its lines (or a wall) at least twice
  const closed = (g: number, b: { x0: number; y0: number; x1: number; y1: number }, useWalls = true) => {
    const mine = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const i = y * W + x;
      const l = label[i];
      return (useWalls && wallBand[i] === 1) || (l > 0 && find(l) === g);
    };
    const crossings = (along: 'row' | 'col', k: number) => {
      let runs = 0;
      let on = false;
      // a little past the shape each way, to meet a wall it stands against
      const [a0, a1] = along === 'row' ? [b.x0 - 4, b.x1 + 4] : [b.y0 - 4, b.y1 + 4];
      for (let a = a0; a <= a1; a++) {
        const m = along === 'row' ? mine(a, k) : mine(k, a);
        if (m && !on) runs++;
        on = m;
      }
      return runs;
    };
    const share = (along: 'row' | 'col') => {
      const [k0, k1] = along === 'row' ? [b.y0, b.y1] : [b.x0, b.x1];
      const lo = Math.round(k0 + (k1 - k0) * 0.2);
      const hi = Math.round(k1 - (k1 - k0) * 0.2);
      let ok = 0;
      let n = 0;
      for (let k = lo; k <= hi; k++, n++) if (crossings(along, k) >= 2) ok++;
      return n ? ok / n : 0;
    };
    return share('row') >= 0.6 && share('col') >= 0.6;
  };

  // shapes inside (or mostly over) another join it
  const group = comps.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  const big = comps.map((c, i) => ({ c, i })).filter(({ c, i }) => i > 0 && c.n >= 8);
  big.sort((a, b) => (b.c.x1 - b.c.x0) * (b.c.y1 - b.c.y0) - (a.c.x1 - a.c.x0) * (a.c.y1 - a.c.y0));
  // Only a shape closed by its own lines takes in what is inside it (pillows on a bed); the floor
  // left between a worktop's edge and the walls is not a shape and must not swallow the hob.
  for (let a = 0; a < big.length; a++) {
    const A = big[a].c;
    if (Math.max(A.x1 - A.x0, A.y1 - A.y0) < 2.2 * t || find(big[a].i) !== big[a].i || !closed(big[a].i, A, false)) continue;
    for (let b = a + 1; b < big.length; b++) {
      const B = big[b].c;
      const inside = B.x0 >= A.x0 - 2 && B.x1 <= A.x1 + 2 && B.y0 >= A.y0 - 2 && B.y1 <= A.y1 + 2;
      if (inside) group[find(big[b].i)] = find(big[a].i);
    }
  }
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number; n: number }>();
  for (const { c, i } of big) {
    const g = find(i);
    const b = boxes.get(g);
    if (!b) boxes.set(g, { ...c });
    else {
      b.x0 = Math.min(b.x0, c.x0);
      b.y0 = Math.min(b.y0, c.y0);
      b.x1 = Math.max(b.x1, c.x1);
      b.y1 = Math.max(b.y1, c.y1);
      b.n += c.n;
    }
  }

  // a door's swing: a shape about as big as the door, right beside it
  const doors = openings.flatMap((o) => {
    const w = walls.find((x) => x.id === o.wallId);
    if (!w || o.kind !== 'door' || noSwing(o)) return [];
    const horiz = Math.abs(w.a.y - w.b.y) < 1;
    const along = (horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y)) + o.offset;
    return [{ x: horiz ? along : w.a.x, y: horiz ? w.a.y : along, width: o.width, reach: w.thickness / 2 + 6 }];
  });
  const isSwing = (b: { x0: number; y0: number; x1: number; y1: number }) =>
    doors.some((d) => {
      const dx = Math.max(b.x0 - d.x, 0, d.x - b.x1);
      const dy = Math.max(b.y0 - d.y, 0, d.y - b.y1);
      return Math.hypot(dx, dy) <= d.reach && Math.max(b.x1 - b.x0, b.y1 - b.y0) <= d.width * 1.35;
    });

  const out: (Rect & { area: number })[] = [];
  for (const [g, b] of boxes) {
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    if (cx <= bx0 || cx >= bx1 || cy <= by0 || cy >= by1 || !enclosed(cx, cy)) continue;
    if (Math.max(w, h) < 2.2 * t || Math.max(w, h) > 30 * t || Math.min(w, h) < 1.2 * t) continue;
    if (isSwing(b) || !closed(g, b)) continue;
    out.push({ x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1, area: w * h });
  }
  return out
    .sort((a, b) => b.area - a.area)
    .slice(0, max)
    .map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}
