/**
 * Getting a phone photo or a scan of a drawing ready to read, the way document scanners do:
 *  - even out the light: a shadow across the paper or a dim corner would otherwise turn grey
 *    paper into "ink". The paper's brightness is estimated in blocks (the brightest part of each
 *    block is paper, lines are thin) and every pixel is scaled against it. Clean scans and
 *    exported drawings have even paper and are left exactly as they are.
 *  - straighten it: a photo is rarely square to the paper, and a plan tilted by a few degrees has
 *    no long horizontal or vertical lines left. The tilt is the angle at which the ink lines up
 *    best into rows and columns (a projection profile, as in OCR deskewing).
 */

/** Paper brightness per pixel block, or null when the paper is evenly lit. */
export function flattenLight(lum: Uint8Array, w: number, h: number): Uint8Array | null {
  const B = Math.max(16, Math.round(Math.min(w, h) / 40));
  const gw = Math.ceil(w / B);
  const gh = Math.ceil(h / B);
  const grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < gh; by++)
    for (let bx = 0; bx < gw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++)
        for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) {
          hist[lum[y * w + x]]++;
          n++;
        }
      // the 90th percentile: paper, even with some lines in the block
      let acc = 0;
      let v = 255;
      for (let t = 0; t < 256; t++) {
        acc += hist[t];
        if (acc >= n * 0.9) {
          v = t;
          break;
        }
      }
      grid[by * gw + bx] = v;
    }
  // A block can sit inside a solid black wall: take the brightest of its neighbours, then smooth.
  const grow = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X >= 0 && Y >= 0 && X < gw && Y < gh) m = Math.max(m, grid[Y * gw + X]);
        }
      grow[y * gw + x] = m;
    }
  const bg = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const X = x + dx;
          const Y = y + dy;
          if (X >= 0 && Y >= 0 && X < gw && Y < gh) {
            s += grow[Y * gw + X];
            c++;
          }
        }
      bg[y * gw + x] = s / c;
    }
  const sorted = [...bg].sort((a, b) => a - b);
  const spread = sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)];
  if (spread < 22) return null;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const fx = gx - x0;
      const p = bg[y0 * gw + x0] * (1 - fx) * (1 - fy) + bg[y0 * gw + x1] * fx * (1 - fy) + bg[y1 * gw + x0] * (1 - fx) * fy + bg[y1 * gw + x1] * fx * fy;
      out[y * w + x] = Math.min(255, Math.round((lum[y * w + x] * 245) / Math.max(40, p)));
    }
  }
  return out;
}

/**
 * The drawing's tilt in degrees (within ±12): rotate the image by minus this to straighten it.
 * 0 when it is already square, or when no angle lines the ink up clearly better.
 */
export function estimateSkew(dark: Uint8Array, w: number, h: number): number {
  // Up to about 60 000 ink pixels, spread evenly.
  let count = 0;
  for (let i = 0; i < dark.length; i++) count += dark[i];
  if (count < 200) return 0;
  const step = Math.max(1, Math.round(count / 60000));
  const xs: number[] = [];
  const ys: number[] = [];
  let k = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (dark[y * w + x] && k++ % step === 0) {
        xs.push(x - w / 2);
        ys.push(y - h / 2);
      }
  const R = Math.ceil(Math.hypot(w, h) / 2) + 2;
  const rows = new Float64Array(2 * R + 1);
  const cols = new Float64Array(2 * R + 1);
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    rows.fill(0);
    cols.fill(0);
    for (let i = 0; i < xs.length; i++) {
      rows[Math.round(-xs[i] * s + ys[i] * c) + R]++;
      cols[Math.round(xs[i] * c + ys[i] * s) + R]++;
    }
    let t = 0;
    for (let i = 0; i < rows.length; i++) t += rows[i] * rows[i] + cols[i] * cols[i];
    return t;
  };
  let best = 0;
  let bestScore = score(0);
  const flat = bestScore;
  for (let d = -12; d <= 12; d += 0.5) {
    const v = score(d);
    if (v > bestScore) {
      bestScore = v;
      best = d;
    }
  }
  for (let d = best - 0.5; d <= best + 0.5; d += 0.05) {
    const v = score(d);
    if (v > bestScore) {
      bestScore = v;
      best = d;
    }
  }
  // Only straighten when it clearly helps (a real tilt, not noise).
  if (Math.abs(best) < 0.3 || bestScore < flat * 1.08) return 0;
  return Math.round(best * 100) / 100;
}

/** The image rotated by `deg` degrees about its centre (same size, white where nothing was). */
export function rotateImage(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, deg: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // where this output pixel comes from in the input (inverse rotation), sampled bilinearly
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sx = dx * c + dy * s + cx - 0.5;
      const sy = -dx * s + dy * c + cy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (y * w + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const i00 = (y0 * w + x0) * 4 + ch;
        const v = rgba[i00] * (1 - fx) * (1 - fy) + rgba[i00 + 4] * fx * (1 - fy) + rgba[i00 + w * 4] * (1 - fx) * fy + rgba[i00 + w * 4 + 4] * fx * fy;
        out[o + ch] = v;
      }
    }
  return out;
}

/**
 * In a photo, the table or floor round the page reads as a big dark area joined to the image
 * edge. Clear such areas (large, and along an edge or across a corner) so the page edge isn't
 * taken for walls. Lines of the drawing that merely touch the edge are far smaller and stay.
 */
export function clearPageSurround(dark: Uint8Array, w: number, h: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const comp = new Int32Array(n);
  const minArea = n * 0.03;
  const flood = (start: number) => {
    let sp = 0;
    let cn = 0;
    let edges = 0;
    let x0 = w;
    let x1 = 0;
    let y0 = h;
    let y1 = 0;
    stack[sp++] = start;
    seen[start] = 1;
    while (sp) {
      const i = stack[--sp];
      comp[cn++] = i;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0) edges |= 1;
      if (x === w - 1) edges |= 2;
      if (y === 0) edges |= 4;
      if (y === h - 1) edges |= 8;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb)
        if (j >= 0 && dark[j] && !seen[j]) {
          seen[j] = 1;
          stack[sp++] = j;
        }
    }
    const sides = ((edges & 1) && 1) + ((edges & 2) && 1) + ((edges & 4) && 1) + ((edges & 8) && 1);
    if (cn > minArea && (sides >= 2 || x1 - x0 > w * 0.6 || y1 - y0 > h * 0.6)) for (let k = 0; k < cn; k++) dark[comp[k]] = 0;
  };
  for (let x = 0; x < w; x++) {
    if (dark[x] && !seen[x]) flood(x);
    const b = (h - 1) * w + x;
    if (dark[b] && !seen[b]) flood(b);
  }
  for (let y = 0; y < h; y++) {
    const l = y * w;
    if (dark[l] && !seen[l]) flood(l);
    const r = y * w + w - 1;
    if (dark[r] && !seen[r]) flood(r);
  }
}
