import { describe, expect, it } from 'vitest';
import { insetPolygon, polygonArea } from './geometry';

describe('room outlines', () => {
  it('never grows a spike where two walls are almost in line', () => {
    // A 4 m × 3 m room whose top wall is drawn in two pieces with a tiny kink (as a scanned
    // drawing produces), the two pieces having different thicknesses.
    const poly = [
      { x: 0, y: 0 },
      { x: 2000, y: 1 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    const inner = insetPolygon(poly, [150, 75, 100, 100, 100]);
    const area = polygonArea(inner) / 1e6;
    expect(area).toBeGreaterThan(9.5);
    expect(area).toBeLessThan(12);
    for (const p of inner) {
      expect(p.x).toBeGreaterThan(-1);
      expect(p.x).toBeLessThan(4001);
      expect(p.y).toBeGreaterThan(-1);
      expect(p.y).toBeLessThan(3001);
    }
  });
});
