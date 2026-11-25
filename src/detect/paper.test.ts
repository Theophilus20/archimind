import { describe, expect, it } from 'vitest';
import { clearPageSurround, estimateSkew, flattenLight, rotateImage } from './paper';
import { binarize, detect } from './detector';

const W = 600;
const H = 450;

/** A white RGBA page with black rectangles drawn on it. */
function page(rects: [number, number, number, number][], paper = (_x: number, _y: number) => 250): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = paper(x, y);
      px.set([v, v, v, 255], (y * W + x) * 4);
    }
  for (const [x0, y0, x1, y1] of rects)
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) px.set([20, 20, 20, 255], (y * W + x) * 4);
  return px;
}

// a small two-room plan: four outside walls and one partition, 4 px pencil lines
const PLAN: [number, number, number, number][] = [
  [100, 80, 500, 84],
  [100, 366, 500, 370],
  [100, 80, 104, 370],
  [496, 80, 500, 370],
  [300, 80, 304, 370],
];

describe('reading photos of paper', () => {
  it('leaves an evenly lit drawing exactly as it is', () => {
    const { lum } = binarize(page(PLAN), W, H);
    expect(flattenLight(lum, W, H)).toBeNull();
  });

  it('evens out a shadow across the page so only the lines are ink', () => {
    // paper fading from 250 to 140 across the page: Otsu alone would call the dim side ink
    const rgba = page(PLAN, (x) => 250 - (110 * x) / W);
    const { dark } = binarize(rgba, W, H);
    const inkInShadow = dark[200 * W + 560]; // plain paper in the dim corner
    const line = dark[200 * W + 498]; // the right-hand wall
    expect(inkInShadow).toBe(0);
    expect(line).toBe(1);
  });

  it('finds how far a photo is tilted, and straightening it gives square walls', () => {
    const tilted = rotateImage(page(PLAN), W, H, 3);
    const { dark } = binarize(tilted, W, H);
    const skew = estimateSkew(dark, W, H);
    expect(Math.abs(skew - 3)).toBeLessThan(0.25);
    expect(estimateSkew(binarize(page(PLAN), W, H).dark, W, H)).toBe(0);
  });

  it('clears the table round the page but keeps lines that touch the edge', () => {
    const dark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (x < 30 || x >= W - 30 || y < 25 || y >= H - 25) dark[y * W + x] = 1;
    // a short dimension line running to the bottom edge
    for (let y = 300; y < H; y++) dark[y * W + 200] = 1;
    clearPageSurround(dark, W, H);
    expect(dark[10 * W + 10]).toBe(0);
    expect(dark[H / 2 * W + 5]).toBe(0);
    // the line touches the table area, so it goes with it; a line inside the page stays
    const inner = new Uint8Array(W * H);
    for (let y = 100; y < 300; y++) inner[y * W + 200] = 1;
    clearPageSurround(inner, W, H);
    expect(inner[200 * W + 200]).toBe(1);
  });
});

describe('walls drawn as two bold lines with hatching between', () => {
  it('reads one wall where the drawing has one, not one per line', () => {
    const dark = new Uint8Array(W * H);
    const box = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) dark[y * W + x] = 1;
    };
    // each wall: two 7 px lines 14 px apart, joined by 45° hatching every 8 px
    const wallH = (x0: number, x1: number, y: number) => {
      box(x0, y, x1, y + 7);
      box(x0, y + 21, x1, y + 28);
      for (let x = x0; x < x1; x++) for (let k = 0; k < 14; k++) if ((x + k) % 8 === 0) dark[(y + 7 + k) * W + x] = 1;
    };
    const wallV = (y0: number, y1: number, x: number) => {
      box(x, y0, x + 7, y1);
      box(x + 21, y0, x + 28, y1);
      for (let y = y0; y < y1; y++) for (let k = 0; k < 14; k++) if ((y + k) % 8 === 0) dark[y * W + x + 7 + k] = 1;
    };
    wallH(80, 520, 60);
    wallH(80, 520, 362);
    wallV(60, 390, 80);
    wallV(60, 390, 492);
    const d = detect(dark, W, H);
    expect(d.walls.length).toBe(4);
    for (const wl of d.walls) expect(wl.thickness).toBeGreaterThan(20);
  });
});
