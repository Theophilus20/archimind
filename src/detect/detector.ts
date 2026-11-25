/**
 * Raster floor-plan reader for clean, single-floor, orthogonal plans.
 *
 *  1. binarise (Otsu)
 *  2. estimate wall thicknesses from run-length statistics
 *  3. morphological opening removes text, dimension lines, door arcs and window marks
 *  4. long horizontal / vertical runs → wall pieces (connected components)
 *  5. collinear pieces separated by short gaps → one wall with an opening
 *  6. classify each opening from the original ink (window lines in the wall band,
 *     door leaf + arc beside it, or a plain opening) with a confidence score
 *  7. snap wall ends onto perpendicular wall centrelines
 *
 * Everything is in pixels; scale is confirmed by the user afterwards.
 * Runs inside a Web Worker (see detect.worker.ts).
 */
import type { OpeningKind, Vec2 } from '../model/types';
import { clearPageSurround, estimateSkew, flattenLight, rotateImage } from './paper';

export interface DetectedWall {
  id: string;
  a: Vec2;
  b: Vec2;
  thickness: number;
  exterior: boolean;
  confidence: number;
}

export interface DetectedOpening {
  id: string;
  wallId: string;
  offset: number; // px from wall start
  width: number; // px
  kind: OpeningKind;
  swing: 1 | -1;
  hinge: 'start' | 'end';
  confidence: number;
  /** A door that doesn't open on one hinged leaf (sliding: two offset panels). */
  style?: import('../model/types').DoorStyle;
  /** Changed or added after the AI read the drawing (shown so it gets checked). */
  ai?: boolean;
}

/** A pillar: a small solid square, centre and side in px. */
export interface DetectedColumn {
  x: number;
  y: number;
  size: number;
}

export interface Detection {
  width: number;
  height: number;
  walls: DetectedWall[];
  openings: DetectedOpening[];
  columns?: DetectedColumn[];
  /** Total length of wall pieces found, after lighter (furniture) lines were dropped. */
  found?: number;
  thickness: { min: number; max: number };
  threshold: number;
  ms: number;
}

export function binarize(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  const n = width * height;
  let lum: Uint8Array = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    // transparent pixels count as white paper
    lum[i] = Math.round((0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) * a + 255 * (1 - a));
  }
  // A photo with a shadow or a dim corner: even out the paper first (evenly lit drawings are unchanged).
  const flat = flattenLight(lum, width, height);
  if (flat) lum = flat;
  for (let i = 0; i < n; i++) hist[lum[i]]++;
  // Otsu
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    best = 0,
    thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  thr = Math.min(thr, 200);
  const dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) dark[i] = lum[i] <= thr ? 1 : 0;
  // A photo: the table round the page is not part of the drawing.
  if (flat) clearPageSurround(dark, width, height);
  return { dark, threshold: thr, lum };
}

/** A photographed or scanned drawing turned square to the page (skew: the tilt removed, degrees). */
export function straightenScan(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): { rgba: Uint8ClampedArray | Uint8Array; skew: number } {
  const { dark } = binarize(rgba, w, h);
  const skew = estimateSkew(dark, w, h);
  return skew ? { rgba: rotateImage(rgba, w, h, -skew), skew } : { rgba, skew: 0 };
}

function estimateThickness(dark: Uint8Array, w: number, h: number) {
  const hist = new Float64Array(120);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      const v = x < w ? dark[y * w + x] : 0;
      if (v) run++;
      else if (run) {
        if (run < 120) hist[run]++;
        run = 0;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      const v = y < h ? dark[y * w + x] : 0;
      if (v) run++;
      else if (run) {
        if (run < 120) hist[run]++;
        run = 0;
      }
    }
  }
  const score = (i: number) => hist[i] + 0.5 * ((hist[i - 1] ?? 0) + (hist[i + 1] ?? 0));
  let max = 0;
  for (let i = 4; i < 110; i++) max = Math.max(max, score(i));
  const peaks: number[] = [];
  for (let i = 4; i < 110; i++) {
    const s = score(i);
    if (s >= 0.12 * max && s >= score(i - 1) && s >= score(i + 1)) peaks.push(i);
  }
  const min = peaks[0] ?? 6;
  const mx = peaks[peaks.length - 1] ?? min;
  return { min, max: mx };
}

/** Separable binary erosion/dilation with a k×k square. */
function morph(src: Uint8Array, w: number, h: number, k: number, op: 'erode' | 'dilate') {
  const r0 = Math.floor((k - 1) / 2);
  const r1 = k - 1 - r0;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const want = op === 'erode' ? k : 1;
  const row = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    row[0] = 0;
    for (let x = 0; x < w; x++) row[x + 1] = row[x] + src[y * w + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r0);
      const b = Math.min(w, x + r1 + 1);
      const s = row[b] - row[a];
      tmp[y * w + x] = op === 'erode' ? (s >= want && b - a === k ? 1 : 0) : s >= want ? 1 : 0;
    }
  }
  const col = new Int32Array(h + 1);
  for (let x = 0; x < w; x++) {
    col[0] = 0;
    for (let y = 0; y < h; y++) col[y + 1] = col[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r0);
      const b = Math.min(h, y + r1 + 1);
      const s = col[b] - col[a];
      out[y * w + x] = op === 'erode' ? (s >= want && b - a === k ? 1 : 0) : s >= want ? 1 : 0;
    }
  }
  return out;
}

interface Piece {
  dir: 'h' | 'v';
  c: number; // centreline coordinate (y for h, x for v)
  s: number; // start along
  e: number; // end along
  t: number; // thickness
  /** Typical darkness of its pixels (0 black to 255 white); 0 when unknown. */
  shade: number;
}

/** Median brightness of the drawing's own ink inside a piece (sampled). */
function shadeOf(m: Uint8Array, ink: Uint8Array, lum: Uint8Array, w: number, b: { x0: number; y0: number; x1: number; y1: number }) {
  const vals: number[] = [];
  const area = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
  const step = Math.max(1, Math.floor(Math.sqrt(area / 400)));
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x += (y - b.y0) % step === 0 ? 1 : b.x1 - b.x0 + 1) if (m[y * w + x] && ink[y * w + x]) vals.push(lum[y * w + x]);
  if (!vals.length) return 0;
  vals.sort((p, q) => p - q);
  return vals[Math.floor(vals.length / 2)];
}

function components(mask: Uint8Array, w: number, h: number) {
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = boxes.length;
    const box = { x0: w, y0: h, x1: 0, y1: 0, n: 0 };
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      box.n++;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) if (q >= 0 && mask[q] && label[q] < 0) (label[q] = id), stack.push(q);
    }
    boxes.push(box);
  }
  return boxes;
}

function longRuns(mask: Uint8Array, w: number, h: number, minLen: number, dir: 'h' | 'v') {
  const out = new Uint8Array(w * h);
  const outer = dir === 'h' ? h : w;
  const inner = dir === 'h' ? w : h;
  const idx = (o: number, i: number) => (dir === 'h' ? o * w + i : i * w + o);
  for (let o = 0; o < outer; o++) {
    let start = -1;
    for (let i = 0; i <= inner; i++) {
      const v = i < inner ? mask[idx(o, i)] : 0;
      if (v && start < 0) start = i;
      else if (!v && start >= 0) {
        if (i - start >= minLen) for (let j = start; j < i; j++) out[idx(o, j)] = 1;
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Many drawings show a wall as two thin parallel lines rather than a solid band. Fill the space
 * between long parallel lines that sit a wall's thickness apart, so those walls read as solid.
 * Returns null when the drawing has no such line pairs.
 */
export function fillOutlineWalls(dark: Uint8Array, w: number, h: number): { filled: Uint8Array; gap: number } | null {
  const minLine = Math.max(24, Math.round(Math.min(w, h) * 0.05));
  const H = longRuns(dark, w, h, minLine, 'h');
  const V = longRuns(dark, w, h, minLine, 'v');
  const hist = new Float64Array(66);
  // Walk across the lines (down the columns for horizontal lines, along the rows for vertical
  // ones) and visit each white gap between two line runs.
  const gaps = (mask: Uint8Array, outer: number, inner: number, idx: (o: number, i: number) => number, visit: (o: number, from: number, to: number) => void) => {
    for (let o = 0; o < outer; o++) {
      let lastEnd = -1;
      let inRun = false;
      for (let i = 0; i < inner; i++) {
        const on = mask[idx(o, i)];
        if (on && !inRun) {
          if (lastEnd >= 0) visit(o, lastEnd, i);
          inRun = true;
        } else if (!on && inRun) {
          inRun = false;
          lastEnd = i;
        }
      }
    }
  };
  const colIdx = (x: number, y: number) => y * w + x;
  const rowIdx = (y: number, x: number) => y * w + x;
  const count = (_o: number, a: number, b: number) => {
    if (b - a < hist.length) hist[b - a]++;
  };
  gaps(H, w, h, colIdx, count);
  gaps(V, h, w, rowIdx, count);
  const score = (g: number) => hist[g] + 0.5 * (hist[g - 1] + hist[g + 1]);
  // A wall is thin next to the whole drawing; wider spacings are dimension lines or furniture.
  const maxGap = Math.min(60, Math.max(24, Math.round(Math.min(w, h) * 0.03)));
  let best = 0;
  for (let g = 3; g <= maxGap; g++) best = Math.max(best, score(g));
  if (best < minLine * 3) return null;
  // Outside walls are often thicker than inside ones: keep the two most common spacings, and
  // fill only gaps close to one of them, so furniture drawn beside a wall doesn't thicken it.
  const candidates: number[] = [];
  for (let g = 3; g <= maxGap; g++) if (score(g) >= best * 0.08 && score(g) > score(g - 1) && score(g) >= score(g + 1)) candidates.push(g);
  const peaks = candidates.sort((a, b) => score(b) - score(a)).slice(0, 2).sort((a, b) => a - b);
  if (!peaks.length) return null;
  const gap = peaks[peaks.length - 1];
  const wallGap = (g: number) => peaks.some((p) => Math.abs(g - p) <= Math.max(2, p * 0.3));
  const filled = dark.slice();
  const fillH = (o: number, a: number, b: number) => {
    if (wallGap(b - a)) for (let j = a; j < b; j++) filled[colIdx(o, j)] = 1;
  };
  const fillV = (o: number, a: number, b: number) => {
    if (wallGap(b - a)) for (let j = a; j < b; j++) filled[rowIdx(o, j)] = 1;
  };
  gaps(H, w, h, colIdx, fillH);
  gaps(V, h, w, rowIdx, fillV);
  return { filled, gap };
}

const span = (walls: DetectedWall[]) => walls.reduce((s, x) => s + Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y), 0);

/**
 * A thin wall lying inside a much thicker one along the same line is one of the thick wall's
 * own drawn lines read again: drop it, with anything placed on it.
 */
function dropInnerDuplicates(d: Detection): Detection {
  const info = (x: DetectedWall) => {
    const hz = Math.abs(x.b.x - x.a.x) >= Math.abs(x.b.y - x.a.y);
    return { hz, c: hz ? (x.a.y + x.b.y) / 2 : (x.a.x + x.b.x) / 2, lo: hz ? Math.min(x.a.x, x.b.x) : Math.min(x.a.y, x.b.y), hi: hz ? Math.max(x.a.x, x.b.x) : Math.max(x.a.y, x.b.y) };
  };
  const gone = new Set<string>();
  for (const a of d.walls) {
    const A = info(a);
    for (const b of d.walls) {
      if (b === a || gone.has(b.id) || b.thickness < a.thickness * 1.8) continue;
      const B = info(b);
      if (B.hz !== A.hz || Math.abs(B.c - A.c) > b.thickness / 2 + 1) continue;
      const overlap = Math.min(A.hi, B.hi + b.thickness) - Math.max(A.lo, B.lo - b.thickness);
      if (overlap >= (A.hi - A.lo) * 0.8) {
        gone.add(a.id);
        break;
      }
    }
  }
  if (!gone.size) return d;
  return { ...d, walls: d.walls.filter((x) => !gone.has(x.id)), openings: d.openings.filter((o) => !gone.has(o.wallId)) };
}

/**
 * Share of the wall length that has a parallel twin close beside it (centrelines further apart
 * than the two walls are thick, but no more than `near`), overlapping along its length.
 */
export function pairedShare(walls: DetectedWall[], near: number): number {
  const info = walls.map((x) => {
    const hz = Math.abs(x.b.x - x.a.x) >= Math.abs(x.b.y - x.a.y);
    return { x, hz, c: hz ? (x.a.y + x.b.y) / 2 : (x.a.x + x.b.x) / 2, lo: hz ? Math.min(x.a.x, x.b.x) : Math.min(x.a.y, x.b.y), hi: hz ? Math.max(x.a.x, x.b.x) : Math.max(x.a.y, x.b.y) };
  });
  let paired = 0;
  let total = 0;
  for (const a of info) {
    const len = a.hi - a.lo;
    total += len;
    let best = 0;
    for (const b of info) {
      if (b === a || b.hz !== a.hz) continue;
      const d = Math.abs(b.c - a.c);
      if (d <= (a.x.thickness + b.x.thickness) / 2 + 1 || d > near) continue;
      best = Math.max(best, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
    }
    paired += Math.min(len, Math.max(0, best));
  }
  return total ? paired / total : 0;
}

/**
 * Find walls in a drawing with solid walls, and in one that draws walls as two thin lines;
 * keep whichever reading finds clearly more wall.
 */
export function detect(dark: Uint8Array, w: number, h: number, threshold = 128, lum?: Uint8Array): Detection {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let out = detectFrom(dark, dark, w, h, threshold, lum);
  const outline = fillOutlineWalls(dark, w, h);
  if (outline) {
    const alt = detectFrom(outline.filled, dark, w, h, threshold, lum);
    // Walls drawn as two lines (often hatched between) can have lines bold enough to read as walls
    // on their own: then most walls come in close parallel pairs, and the filled reading, with one
    // wall where the drawing has one, is the right one even though it finds less length.
    const near = outline.gap + out.thickness.max * 1.5 + 4;
    const pairedOut = pairedShare(out.walls, near);
    const doubled = pairedOut >= 0.3 && pairedShare(alt.walls, near) < pairedOut / 2 && span(alt.walls) >= span(out.walls) * 0.3;
    if (doubled || (alt.found ?? span(alt.walls)) > (out.found ?? span(out.walls)) * 1.25) {
      addOutlineWindows(alt, dark, w, h);
      out = alt;
    }
  }
  out = dropInnerDuplicates(out);
  out = { ...out, openings: splitAtJunctions(out.walls, out.openings) };
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { ...out, ms: Math.round(t1 - t0) };
}

/**
 * A window (or open passage) cannot run through a wall that meets it. Two windows drawn close
 * either side of a partition read as one gap in the outer wall, with the partition stopping at
 * the glass; split it where the partition meets the wall, leaving the partition's end between.
 */
export function splitAtJunctions(walls: DetectedWall[], openings: DetectedOpening[]): DetectedOpening[] {
  const out: DetectedOpening[] = [];
  for (const o of openings) {
    const host = walls.find((w) => w.id === o.wallId);
    if (!host || o.kind === 'door') {
      out.push(o);
      continue;
    }
    const horiz = Math.abs(host.a.y - host.b.y) < 1;
    const lo = horiz ? Math.min(host.a.x, host.b.x) : Math.min(host.a.y, host.b.y);
    const c = horiz ? host.a.y : host.a.x;
    const s0 = lo + o.offset - o.width / 2;
    const s1 = lo + o.offset + o.width / 2;
    const cuts = walls
      .filter((p) => p !== host && (horiz ? Math.abs(p.a.x - p.b.x) < 1 : Math.abs(p.a.y - p.b.y) < 1))
      .flatMap((p) => {
        const along = horiz ? p.a.x : p.a.y;
        const ends = horiz ? [p.a.y, p.b.y] : [p.a.x, p.b.x];
        const meets = ends.some((e) => Math.abs(e - c) <= host.thickness / 2 + p.thickness + 2);
        return meets && along > s0 + p.thickness / 2 && along < s1 - p.thickness / 2 ? [{ along, half: p.thickness / 2 }] : [];
      })
      .sort((a, b) => a.along - b.along);
    if (!cuts.length) {
      out.push(o);
      continue;
    }
    const pieces: [number, number][] = [];
    let start = s0;
    for (const cut of cuts) {
      pieces.push([start, cut.along - cut.half]);
      start = cut.along + cut.half;
    }
    pieces.push([start, s1]);
    pieces
      .filter(([a, b]) => b - a >= Math.max(4, host.thickness * 0.8))
      .forEach(([a, b], i) => out.push({ ...o, id: i === 0 ? o.id : `${o.id}b${i}`, offset: (a + b) / 2 - lo, width: b - a }));
  }
  return out;
}

/**
 * In two-line drawings a window keeps the wall's face lines and adds glass lines between them,
 * so it isn't a gap. Find stretches of a wall where the original ink crosses the wall band three
 * or more times and call those windows.
 */
function addOutlineWindows(d: Detection, ink: Uint8Array, w: number, h: number) {
  // Round first, then check: a point just inside the edge can round to one outside it.
  const at = (m: Uint8Array, x: number, y: number) => {
    const X = Math.round(x);
    const Y = Math.round(y);
    return X >= 0 && Y >= 0 && X < w && Y < h ? m[Y * w + X] : 0;
  };
  let on = d.openings.length + 1;
  // Glass is drawn as straight lines along the wall; hatching between a wall's two lines is
  // diagonal and makes only short runs, so count lines on these straight-run masks.
  const runsH = longRuns(ink, w, h, 12, 'h');
  const runsV = longRuns(ink, w, h, 12, 'v');
  for (const wl of d.walls) {
    const horizontal = wl.a.y === wl.b.y;
    const lines = horizontal ? runsH : runsV;
    const s = horizontal ? Math.min(wl.a.x, wl.b.x) : Math.min(wl.a.y, wl.b.y);
    const e = horizontal ? Math.max(wl.a.x, wl.b.x) : Math.max(wl.a.y, wl.b.y);
    const c = horizontal ? wl.a.y : wl.a.x;
    const half = wl.thickness / 2 + 2;
    const crossings = (along: number) => {
      let runs = 0;
      let prev = 0;
      for (let k = -half; k <= half; k++) {
        const v = horizontal ? at(lines, along, c + k) : at(lines, c + k, along);
        if (v && !prev) runs++;
        prev = v;
      }
      return runs;
    };
    const taken = d.openings.filter((o) => o.wallId === wl.id).map((o) => [s + o.offset - o.width / 2, s + o.offset + o.width / 2]);
    const minLen = Math.max(wl.thickness * 2, 12);
    let start = -1;
    let miss = 0;
    const close = (end: number) => {
      const len = end - start;
      if (len >= minLen && !taken.some(([a, b]) => end > a && start < b)) {
        d.openings.push({ id: `O${on++}`, wallId: wl.id, offset: (start + end) / 2 - s, width: len, kind: 'window', swing: 1, hinge: 'start', confidence: 0.7 });
      }
      start = -1;
      miss = 0;
    };
    // Stay clear of the corners, where crossing walls add lines.
    for (let a = s + wl.thickness; a <= e - wl.thickness; a++) {
      if (crossings(a) >= 3) {
        if (start < 0) start = a;
        miss = 0;
      } else if (start >= 0 && ++miss > 2) close(a - miss);
    }
    if (start >= 0) close(e - wl.thickness);
  }
}

function detectFrom(mask: Uint8Array, dark: Uint8Array, w: number, h: number, threshold: number, lum?: Uint8Array): Detection {
  const thick = estimateThickness(mask, w, h);
  const k = Math.max(3, Math.round(thick.min * 0.6));
  const walls = morph(morph(mask, w, h, k, 'erode'), w, h, k, 'dilate');
  const minLen = Math.max(Math.round(thick.min * 2.5), Math.round(thick.max * 1.6));

  const pieces: Piece[] = [];
  for (const dir of ['h', 'v'] as const) {
    const m = longRuns(walls, w, h, minLen, dir);
    for (const b of components(m, w, h)) {
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      const along = dir === 'h' ? bw : bh;
      // Typical width along the piece, not its widest point: something drawn against part of a
      // wall (a bath, a cupboard) must not make the whole wall thicker.
      const { t: across, c } = bandOf(m, w, dir, b);
      if (along < minLen || across > thick.max * 1.8 || across < k || along < across * 1.6) continue;
      const shade = lum ? shadeOf(m, dark, lum, w, b) : 0;
      pieces.push(dir === 'h' ? { dir, c, s: b.x0, e: b.x1 + 1, t: across, shade } : { dir, c, s: b.y0, e: b.y1 + 1, t: across, shade });
    }
  }
  // Drawings with solid dark walls draw furniture in lighter lines: two furniture lines drawn close
  // together (a bed beside a bedside table) can look like a wall, but they are much lighter.
  if (lum && pieces.length > 3) {
    const byShade = [...pieces].sort((a, b) => a.shade - b.shade);
    const total = pieces.reduce((n, p) => n + (p.e - p.s), 0);
    let acc = 0;
    let wallShade = byShade[0].shade;
    for (const p of byShade) {
      acc += p.e - p.s;
      wallShade = p.shade;
      if (acc >= total / 2) break;
    }
    if (wallShade < 90) {
      const keep = pieces.filter((p) => p.shade <= Math.max(wallShade + 45, 70));
      pieces.splice(0, pieces.length, ...keep);
    }
  }
  const found = pieces.reduce((n, p) => n + (p.e - p.s), 0);

  // Merge collinear pieces; gaps become openings.
  const maxGap = Math.max(thick.max * 14, thick.min * 26);
  // A single door is about 7 to 10 times an inside wall's thickness (or 3 to 4 times an outside
  // wall's): anything much wider is an open passage, a sliding door or a window.
  const maxDoor = Math.max(thick.min * 11, thick.max * 5);
  const groups: { dir: 'h' | 'v'; c: number; t: number; parts: Piece[] }[] = [];
  for (const p of [...pieces].sort((a, b) => a.s - b.s)) {
    const g = groups.find((x) => x.dir === p.dir && Math.abs(x.c - p.c) <= Math.max(2, Math.min(x.t, p.t) / 2) && Math.abs(x.t - p.t) <= Math.max(3, 0.45 * Math.max(x.t, p.t)) && p.s - x.parts[x.parts.length - 1].e <= maxGap);
    if (g) {
      g.parts.push(p);
      g.c = (g.c * (g.parts.length - 1) + p.c) / g.parts.length;
    } else groups.push({ dir: p.dir, c: p.c, t: p.t, parts: [p] });
  }

  // Short pieces in line with a wall, such as the bit of wall between a door and a corner, which
  // are too short to count as walls on their own: join them to that wall so the door is found.
  const stubLen = Math.max(k * 2, Math.round(thick.min * 1.2));
  for (const dir of ['h', 'v'] as const) {
    const ms = longRuns(walls, w, h, stubLen, dir);
    for (const b of components(ms, w, h)) {
      const along = dir === 'h' ? b.x1 - b.x0 + 1 : b.y1 - b.y0 + 1;
      if (along >= minLen) continue;
      const { t: across, c } = bandOf(ms, w, dir, b);
      if (along < stubLen || across > thick.max * 1.8 || across < k || along < across * 1.2) continue;
      const p: Piece = dir === 'h' ? { dir, c, s: b.x0, e: b.x1 + 1, t: across, shade: 0 } : { dir, c, s: b.y0, e: b.y1 + 1, t: across, shade: 0 };
      const g = groups.find((x) => {
        if (x.dir !== dir || Math.abs(x.c - c) > Math.max(2, Math.min(x.t, across) / 2) || Math.abs(x.t - across) > Math.max(3, 0.45 * Math.max(x.t, across))) return false;
        const first = Math.min(...x.parts.map((q) => q.s));
        const last = Math.max(...x.parts.map((q) => q.e));
        return (p.s >= last - 1 && p.s - last <= maxGap) || (p.e <= first + 1 && first - p.e <= maxGap);
      });
      if (g) g.parts.push(p);
    }
  }

  const detected: DetectedWall[] = [];
  const openings: DetectedOpening[] = [];
  // Round first, then check: a point just inside the edge can round to one outside it.
  const at = (x: number, y: number) => {
    const X = Math.round(x);
    const Y = Math.round(y);
    return X >= 0 && Y >= 0 && X < w && Y < h ? dark[Y * w + X] : 0;
  };
  // Any ink at all, pale grey included (sliding door panels are often drawn faintly).
  const faint = (x: number, y: number) => {
    const X = Math.round(x);
    const Y = Math.round(y);
    if (X < 0 || Y < 0 || X >= w || Y >= h) return 0;
    return lum ? (lum[Y * w + X] < 225 ? 1 : 0) : dark[Y * w + X];
  };

  let wn = 1;
  let on = 1;
  for (const g of groups) {
    const parts = g.parts.sort((a, b) => a.s - b.s);
    const t = Math.round(parts.reduce((s, p) => s + p.t * (p.e - p.s), 0) / parts.reduce((s, p) => s + (p.e - p.s), 0));
    const s = parts[0].s;
    const e = parts[parts.length - 1].e;
    const id = `W${wn++}`;
    const wall: DetectedWall =
      g.dir === 'h'
        ? { id, a: { x: s, y: g.c }, b: { x: e, y: g.c }, thickness: t, exterior: t >= (thick.min + thick.max) / 2 && thick.max > thick.min * 1.3, confidence: 0.9 }
        : { id, a: { x: g.c, y: s }, b: { x: g.c, y: e }, thickness: t, exterior: t >= (thick.min + thick.max) / 2 && thick.max > thick.min * 1.3, confidence: 0.9 };
    detected.push(wall);

    for (let i = 0; i + 1 < parts.length; i++) {
      const g0 = parts[i].e;
      const g1 = parts[i + 1].s;
      const gap = g1 - g0;
      if (gap < 3) continue;
      // Sample ink in the wall band (window marks) and on each side (door leaf + arc).
      const P = (along: number, across: number) => (g.dir === 'h' ? at(along, g.c + across) : at(g.c + across, along));
      const PF = (along: number, across: number) => (g.dir === 'h' ? faint(along, g.c + across) : faint(g.c + across, along));
      let bandCols = 0;
      for (let a = g0 + 2; a < g1 - 2; a++) {
        let n = 0;
        for (let c = -t / 2 - 1; c <= t / 2 + 1; c++) n += P(a, c);
        if (n >= 2) bandCols++;
      }
      const windowScore = bandCols / Math.max(1, gap - 4);
      // A door shows its swing: a quarter circle from the hinge, as wide as the opening.
      const arc = gap <= maxDoor ? swingArc(P, g0, g1, t) : { score: 0, hinge: 'start' as const, sign: 1 as const };
      const sliding = slidingPanels(PF, g0, g1, t);
      let kind: OpeningKind = 'opening';
      let confidence = 0.45;
      let style: 'sliding' | undefined;
      if (sliding) {
        kind = 'door';
        style = 'sliding';
        confidence = 0.7;
      } else if (windowScore > 0.55) {
        kind = 'window';
        confidence = Math.min(0.98, 0.5 + windowScore / 2);
      } else if (arc.score >= 0.45) {
        kind = 'door';
        confidence = Math.min(0.95, 0.45 + arc.score / 2);
      }
      // Left normal of a→b: (0,-1) for horizontal walls, (+1,0) for vertical walls.
      const swing: 1 | -1 = g.dir === 'h' ? (arc.sign === -1 ? 1 : -1) : arc.sign === 1 ? 1 : -1;
      openings.push({ id: `O${on++}`, wallId: id, offset: (g0 + g1) / 2 - s, width: gap, kind, swing, hinge: arc.hinge, confidence, ...(style ? { style } : {}) });
    }
  }

  // Snap wall ends onto perpendicular centrelines (corners and T-junctions).
  const openEnds: { wl: DetectedWall; end: 'a' | 'b' }[] = [];
  for (const wl of detected) {
    const horizontal = wl.a.y === wl.b.y;
    for (const end of ['a', 'b'] as const) {
      const p = wl[end];
      let best: { v: number; d: number } | null = null;
      for (const o of detected) {
        if (o === wl) continue;
        const oh = o.a.y === o.b.y;
        if (oh === horizontal) continue;
        const tol = o.thickness / 2 + wl.thickness / 2 + 4;
        if (horizontal) {
          const cx = o.a.x;
          const inSpan = p.y >= Math.min(o.a.y, o.b.y) - tol && p.y <= Math.max(o.a.y, o.b.y) + tol;
          const d = Math.abs(p.x - cx);
          if (inSpan && d <= tol && (!best || d < best.d)) best = { v: cx, d };
        } else {
          const cy = o.a.y;
          const inSpan = p.x >= Math.min(o.a.x, o.b.x) - tol && p.x <= Math.max(o.a.x, o.b.x) + tol;
          const d = Math.abs(p.y - cy);
          if (inSpan && d <= tol && (!best || d < best.d)) best = { v: cy, d };
        }
      }
      if (best) {
        const shift = horizontal ? best.v - p.x : best.v - p.y;
        if (horizontal) p.x = best.v;
        else p.y = best.v;
        if (end === 'a') for (const op of openings) if (op.wallId === wl.id) op.offset -= shift;
      } else {
        wl.confidence = 0.6;
        openEnds.push({ wl, end });
      }
    }
  }

  // A wall that stops short of a crossing wall with a door swing drawn in the gap: the door sits
  // right beside the corner. Carry the wall on to the corner and put the door in the gap.
  for (const { wl, end } of openEnds) {
    const horizontal = wl.a.y === wl.b.y;
    const p = wl[end];
    const other = wl[end === 'a' ? 'b' : 'a'];
    const sign = horizontal ? Math.sign(p.x - other.x) : Math.sign(p.y - other.y);
    const across0 = horizontal ? p.y : p.x;
    let hit: { o: DetectedWall; ahead: number; at: number } | null = null;
    for (const o of detected) {
      if (o === wl || (o.a.y === o.b.y) === horizontal) continue;
      const at = horizontal ? o.a.x : o.a.y;
      const ahead = (at - (horizontal ? p.x : p.y)) * sign;
      if (ahead <= 0 || ahead > maxGap) continue;
      const lo = horizontal ? Math.min(o.a.y, o.b.y) : Math.min(o.a.x, o.b.x);
      const hi = horizontal ? Math.max(o.a.y, o.b.y) : Math.max(o.a.x, o.b.x);
      if (across0 < lo - o.thickness / 2 || across0 > hi + o.thickness / 2) continue;
      if (!hit || ahead < hit.ahead) hit = { o, ahead, at };
    }
    if (!hit) continue;
    const t = wl.thickness;
    const P = (along: number, across: number) => (horizontal ? at(along, across0 + across) : at(across0 + across, along));
    const PF = (along: number, across: number) => (horizontal ? faint(along, across0 + across) : faint(across0 + across, along));
    // Solid wall that was too short to count on its own (a block beside the opening) is wall.
    let from = horizontal ? p.x : p.y;
    let gapLen = hit.ahead - hit.o.thickness / 2;
    const solidAt = (along: number) => {
      let n = 0;
      let m = 0;
      for (let c = -t / 2 + 1; c <= t / 2 - 1; c++) {
        m++;
        n += P(along, c);
      }
      return m > 0 && n / m >= 0.6;
    };
    while (gapLen > 0 && solidAt(from + sign)) {
      from += sign;
      gapLen--;
    }
    if (gapLen < thick.min * 2) continue;
    const lo = Math.min(from, from + sign * gapLen);
    const hi = lo + gapLen;
    let bandCols = 0;
    for (let a = lo + 2; a < hi - 2; a++) {
      let n = 0;
      for (let c = -t / 2 - 1; c <= t / 2 + 1; c++) n += P(a, c);
      if (n >= 2) bandCols++;
    }
    const sliding = slidingPanels(PF, lo, hi, t);
    const glass = !sliding && bandCols / Math.max(1, gapLen - 4) > 0.55;
    const arc = !sliding && !glass && gapLen <= maxDoor ? swingArc(P, lo, hi, t) : { score: 0, hinge: 'start' as const, sign: 1 as const };
    if (!sliding && !glass && arc.score < 0.45) continue;
    const oldStart = horizontal ? Math.min(wl.a.x, wl.b.x) : Math.min(wl.a.y, wl.b.y);
    if (horizontal) p.x = hit.at;
    else p.y = hit.at;
    const newStart = horizontal ? Math.min(wl.a.x, wl.b.x) : Math.min(wl.a.y, wl.b.y);
    for (const op of openings) if (op.wallId === wl.id) op.offset += oldStart - newStart;
    const centre = (lo + hi) / 2;
    const swing: 1 | -1 = horizontal ? (arc.sign === -1 ? 1 : -1) : arc.sign === 1 ? 1 : -1;
    openings.push({ id: `O${openings.length + 1}`, wallId: wl.id, offset: centre - newStart, width: gapLen, kind: glass ? 'window' : 'door', swing, hinge: arc.hinge, confidence: 0.7, ...(sliding ? { style: 'sliding' as const } : {}) });
    wl.confidence = 0.9;
  }

  // A piece that touches no other wall at either end and is short next to the building is a
  // line from furniture (a headboard, a counter edge), not a wall.
  if (detected.length > 3) {
    const xs = detected.flatMap((x) => [x.a.x, x.b.x]);
    const ys = detected.flatMap((x) => [x.a.y, x.b.y]);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const touches = (p: Vec2, self: DetectedWall) =>
      detected.some((o) => {
        if (o === self) return false;
        const tol = o.thickness / 2 + self.thickness / 2 + 4;
        const lo = { x: Math.min(o.a.x, o.b.x) - tol, y: Math.min(o.a.y, o.b.y) - tol };
        const hi = { x: Math.max(o.a.x, o.b.x) + tol, y: Math.max(o.a.y, o.b.y) + tol };
        return p.x >= lo.x && p.x <= hi.x && p.y >= lo.y && p.y <= hi.y;
      });
    const loose = new Set(detected.filter((x) => Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y) < size * 0.25 && !touches(x.a, x) && !touches(x.b, x)).map((x) => x.id));
    if (loose.size) {
      detected.splice(0, detected.length, ...detected.filter((x) => !loose.has(x.id)));
      openings.splice(0, openings.length, ...openings.filter((o) => !loose.has(o.wallId)));
    }
  }

  // A wall is on the outside when nothing lies beyond it on one side.
  for (const wl of detected) {
    const horizontal = wl.a.y === wl.b.y;
    const mid = horizontal ? (wl.a.x + wl.b.x) / 2 : (wl.a.y + wl.b.y) / 2;
    const c = horizontal ? wl.a.y : wl.a.x;
    const beyond = (sign: 1 | -1) =>
      detected.some((o) => {
        if (o === wl || (o.a.y === o.b.y) !== horizontal) return false;
        const oc = horizontal ? o.a.y : o.a.x;
        const lo = horizontal ? Math.min(o.a.x, o.b.x) : Math.min(o.a.y, o.b.y);
        const hi = horizontal ? Math.max(o.a.x, o.b.x) : Math.max(o.a.y, o.b.y);
        return (oc - c) * sign > wl.thickness && mid >= lo && mid <= hi;
      });
    wl.exterior = !beyond(1) || !beyond(-1);
  }

  // Pillars: small, nearly square, solid blocks that are not part of any wall.
  const columns: DetectedColumn[] = [];
  const onWall = (x: number, y: number) =>
    detected.some((wl) => {
      const r = wl.thickness / 2 + 3;
      return x >= Math.min(wl.a.x, wl.b.x) - r && x <= Math.max(wl.a.x, wl.b.x) + r && y >= Math.min(wl.a.y, wl.b.y) - r && y <= Math.max(wl.a.y, wl.b.y) + r;
    });
  for (const b of components(walls, w, h)) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;
    const size = Math.max(bw, bh);
    if (size < Math.max(k + 2, thick.max * 1.1) || size > thick.max * 4 || Math.max(bw, bh) > Math.min(bw, bh) * 1.4) continue;
    if (b.n < bw * bh * 0.8) continue;
    const x = (b.x0 + b.x1) / 2;
    const y = (b.y0 + b.y1) / 2;
    if (onWall(x, y)) continue;
    columns.push({ x, y, size: Math.round((bw + bh) / 2) });
  }

  return { width: w, height: h, walls: detected, openings, columns, found, thickness: thick, threshold, ms: 0 };
}

/**
 * How well a door swing is drawn over the gap from g0 to g1: a quarter circle of the gap's width
 * from a hinge at either end, on either side of the wall. Returns the best fit.
 */
function swingArc(P: (along: number, across: number) => number, g0: number, g1: number, t: number) {
  const r = g1 - g0;
  let best = { score: 0, hinge: 'start' as 'start' | 'end', sign: 1 as 1 | -1 };
  if (r < 6) return best;
  for (const hinge of ['start', 'end'] as const)
    for (const sign of [1, -1] as const) {
      const pt = (rr: number, th: number): [number, number] => [hinge === 'start' ? g0 + rr * Math.cos(th) : g1 - rr * Math.cos(th), sign * (t / 2 + rr * Math.sin(th))];
      // the arc: a thin line close to the radius at most angles
      let arcHits = 0;
      let arcN = 0;
      for (let deg = 10; deg <= 80; deg += 5) {
        arcN++;
        const th = (deg * Math.PI) / 180;
        // every pixel across a band of radii: arcs are thin and start at the jamb or the wall face
        let on = false;
        for (let rr = Math.floor(r * 0.86); rr <= Math.ceil(r * 1.06) && !on; rr += 2) {
          const [a, c] = pt(rr, th);
          for (let da = -1; da <= 1 && !on; da++) for (let dc = -1; dc <= 1 && !on; dc++) if (P(a + da, c + dc)) on = true;
        }
        if (on) arcHits++;
      }
      // the leaf: a straight line out from the hinge, fully open (90°) or drawn part open
      let leaf = 0;
      for (const deg of [35, 45, 55, 65, 75, 90]) {
        const th = (deg * Math.PI) / 180;
        let hits = 0;
        let n = 0;
        for (let rr = 4; rr <= r * 0.9; rr += 2) {
          n++;
          const [a, c] = pt(rr, th);
          let on = false;
          for (let da = -1; da <= 1 && !on; da++) for (let dc = -1; dc <= 1 && !on; dc++) if (P(a + da, c + dc)) on = true;
          if (on) hits++;
        }
        if (n) leaf = Math.max(leaf, hits / n);
      }
      // inside the swing: mostly clear floor
      let inside = 0;
      let insideN = 0;
      for (const k of [0.35, 0.55, 0.72])
        for (let deg = 20; deg <= 70; deg += 10) {
          insideN++;
          const [a, c] = pt(r * k, (deg * Math.PI) / 180);
          inside += P(a, c);
        }
      const arc = arcHits / arcN;
      const clear = 1 - inside / insideN;
      const score = clear < 0.7 ? 0 : (arc >= 0.6 && leaf >= 0.4) || (arc >= 0.4 && leaf >= 0.6) || (clear >= 0.85 && arc >= 0.45 && leaf >= 0.5) ? (arc + leaf) / 2 : arc >= 0.85 ? arc * 0.9 : 0;
      if (score > best.score) best = { score, hinge, sign };
    }
  return best;
}

/**
 * A sliding door drawn in plan: two thin panels inside the wall line, offset from each other, each
 * covering a bit more than half the opening, one from each side. A window's lines run end to end.
 */
function slidingPanels(P: (along: number, across: number) => number, g0: number, g1: number, t: number) {
  const gap = g1 - g0;
  if (gap < 12) return false;
  const rows = (a0: number, a1: number) => {
    const out = new Set<number>();
    for (let c = Math.floor(-t / 2 - 2); c <= Math.ceil(t / 2 + 2); c++) {
      let n = 0;
      let m = 0;
      for (let a = Math.round(a0); a <= a1; a++) {
        m++;
        n += P(a, c);
      }
      if (m && n / m > 0.7) out.add(c);
    }
    return out;
  };
  // A line right across the opening (a threshold, a sill, or a window's glass) says nothing here.
  const full = rows(g0 + 2, g1 - 2);
  const only = (set: Set<number>) => new Set([...set].filter((c) => !full.has(c)));
  const left = only(rows(g0 + 2, g0 + gap * 0.3));
  const right = only(rows(g1 - gap * 0.3, g1 - 2));
  if (!left.size || !right.size) return false;
  // The panel on the left and the panel on the right sit on different lines across the wall.
  return ![...left].some((c) => right.has(c) || right.has(c - 1) || right.has(c + 1));
}

/** Median width and centre of a wall piece across its length, from its mask. */
function bandOf(m: Uint8Array, w: number, dir: 'h' | 'v', b: { x0: number; y0: number; x1: number; y1: number }) {
  const [A0, A1, C0, C1] = dir === 'h' ? [b.x0, b.x1, b.y0, b.y1] : [b.y0, b.y1, b.x0, b.x1];
  const lens: number[] = [];
  const mids: number[] = [];
  const step = Math.max(1, Math.floor((A1 - A0) / 40));
  for (let a = A0; a <= A1; a += step) {
    let best = 0;
    let bestMid = 0;
    let run = 0;
    let start = 0;
    for (let c = C0; c <= C1 + 1; c++) {
      const on = c <= C1 && m[dir === 'h' ? c * w + a : a * w + c];
      if (on) {
        if (!run) start = c;
        run++;
      } else if (run) {
        if (run > best) {
          best = run;
          bestMid = start + (run - 1) / 2;
        }
        run = 0;
      }
    }
    if (best) {
      lens.push(best);
      mids.push(bestMid);
    }
  }
  const median = (xs: number[]) => xs.sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  return lens.length ? { t: median(lens), c: median(mids) } : { t: C1 - C0 + 1, c: (C0 + C1) / 2 };
}
