import { describe, expect, it } from 'vitest';
import { furnitureCandidates } from './candidates';
import type { DetectedOpening, DetectedWall } from './detector';

/** A white image with black pixels drawn by the callbacks. */
function drawing(W: number, H: number, draw: (set: (x: number, y: number) => void) => void) {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  draw((x, y) => {
    const i = (y * W + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
  });
  return rgba;
}
const rect = (set: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => {
  for (let x = x0; x <= x1; x++) (set(x, y0), set(x, y1));
  for (let y = y0; y <= y1; y++) (set(x0, y), set(x1, y));
};

describe('furniture shapes found on the drawing', () => {
  // a room 200 x 160 px inside walls 8 px thick (centrelines at 20 and 220, 20 and 180)
  const walls: DetectedWall[] = [
    { id: 'W1', a: { x: 20, y: 20 }, b: { x: 220, y: 20 }, thickness: 8, exterior: true, confidence: 1 },
    { id: 'W2', a: { x: 220, y: 20 }, b: { x: 220, y: 180 }, thickness: 8, exterior: true, confidence: 1 },
    { id: 'W3', a: { x: 20, y: 180 }, b: { x: 220, y: 180 }, thickness: 8, exterior: true, confidence: 1 },
    { id: 'W4', a: { x: 20, y: 20 }, b: { x: 20, y: 180 }, thickness: 8, exterior: true, confidence: 1 },
  ];
  const W = 240;
  const H = 200;
  const wallInk = (set: (x: number, y: number) => void) => {
    for (const w of walls) for (let x = Math.min(w.a.x, w.b.x) - 4; x <= Math.max(w.a.x, w.b.x) + 4; x++) for (let y = Math.min(w.a.y, w.b.y) - 4; y <= Math.max(w.a.y, w.b.y) + 4; y++) set(x, y);
  };

  it('finds a closed shape in the room with what is drawn inside it, and a cupboard against a wall', () => {
    const rgba = drawing(W, H, (set) => {
      wallInk(set);
      rect(set, 60, 60, 120, 140); // a bed
      rect(set, 66, 66, 80, 76); // a pillow on it
      // a cupboard against the right wall: three sides drawn, the wall is the fourth
      for (let y = 40; y <= 100; y++) set(190, y);
      for (let x = 190; x <= 215; x++) (set(x, 40), set(x, 100));
    });
    const found = furnitureCandidates(rgba, W, H, walls);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({ x0: 60, y0: 60, x1: 121, y1: 141 });
    expect(found[1].x0).toBe(190);
  });

  it('leaves out text-sized marks, straight lines and door swings', () => {
    const rgba = drawing(W, H, (set) => {
      wallInk(set);
      rect(set, 100, 100, 106, 108); // a letter-sized mark
      for (let x = 40; x <= 200; x++) set(x, 60); // a line across the room
      // a door swing: a leaf against the left wall and a quarter circle
      for (let y = 120; y <= 170; y++) set(30, y);
      for (let a = 0; a <= 90; a++) set(Math.round(30 + 50 * Math.sin((a * Math.PI) / 180)), Math.round(170 - 50 * Math.cos((a * Math.PI) / 180)));
    });
    // the door the pixel check found in the left wall, 50 px wide, centred 125 px down it
    const door: DetectedOpening = { id: 'O1', wallId: 'W4', offset: 125, width: 50, kind: 'door', swing: 1, hinge: 'start', confidence: 0.8 };
    expect(furnitureCandidates(rgba, W, H, walls, [door])).toHaveLength(0);
  });
});
