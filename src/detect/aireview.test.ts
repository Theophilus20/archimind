import { describe, expect, it } from 'vitest';
import { applyVerdicts, describeForAI, scaleFromText } from './aireview';
import type { DetectedOpening, DetectedWall } from './detector';

describe('scale from the drawing’s dimension text', () => {
  it('reads feet and inches, millimetres and metres', () => {
    expect(scaleFromText(`41'0"`)?.unit).toBe('ft');
    expect(scaleFromText(`41'0"`)?.mm).toBeCloseTo(12496.8, 3);
    expect(scaleFromText(`30' 10"`)?.mm).toBeCloseTo(9398, 0);
    expect(scaleFromText('12500')).toMatchObject({ unit: 'mm', mm: 12500 });
    expect(scaleFromText('12.5 m')).toMatchObject({ unit: 'm', mm: 12500 });
  });
  it('refuses figures that cannot be a building’s size', () => {
    expect(scaleFromText('3')).toBeNull();
    expect(scaleFromText('kitchen')).toBeNull();
    expect(scaleFromText(undefined)).toBeNull();
  });
});

describe('the AI reviewing the openings', () => {
  const walls: DetectedWall[] = [{ id: 'W1', a: { x: 100, y: 50 }, b: { x: 500, y: 50 }, thickness: 10, exterior: true, confidence: 0.9 }];
  const op = (id: string, kind: DetectedOpening['kind'], confidence: number, extra: Partial<DetectedOpening> = {}): DetectedOpening => ({ id, wallId: 'W1', offset: 100, width: 40, kind, swing: 1, hinge: 'start', confidence, ...extra });

  it('takes a sliding-door verdict where the pixels found no clear swing, and an open passage only where they were unsure', () => {
    const { openings, changed } = applyVerdicts([op('O1', 'door', 0.8), op('O2', 'door', 0.6), op('O3', 'door', 0.8), op('O4', 'door', 0.95)], [
      { id: 'O1', kind: 'sliding' },
      { id: 'O2', kind: 'opening' },
      { id: 'O3', kind: 'opening' },
      { id: 'O4', kind: 'window' },
    ]);
    expect(changed).toBe(2);
    expect(openings[0]).toMatchObject({ kind: 'door', style: 'sliding', ai: true });
    expect(openings[1]).toMatchObject({ kind: 'opening', ai: true });
    // a door with a swing is kept: the models misread door swings more often than the pixels do
    expect(openings[2].kind).toBe('door');
    expect(openings[3].kind).toBe('door');
  });

  it('keeps a sliding door the pixels found, whatever the whole-plan reading says', () => {
    const { openings, changed } = applyVerdicts([op('O1', 'door', 0.7, { style: 'sliding' })], [{ id: 'O1', kind: 'opening' }]);
    expect(changed).toBe(0);
    expect(openings[0]).toMatchObject({ kind: 'door', style: 'sliding' });
  });

  it('never deletes, and never touches what you confirmed', () => {
    const { openings, changed } = applyVerdicts([op('O1', 'window', 0.5), op('O2', 'door', 1)], [
      { id: 'O1', kind: 'none' },
      { id: 'O2', kind: 'opening' },
    ]);
    expect(changed).toBe(0);
    expect(openings.map((o) => o.kind)).toEqual(['window', 'door']);
  });

  it('describes openings in the pixels of the image the AI sees', () => {
    const [d] = describeForAI(walls, [op('O1', 'door', 0.9, { style: 'sliding' })], 0.5);
    expect(d).toMatchObject({ id: 'O1', x: 100, y: 25, width: 20, wall: 'horizontal', kind: 'sliding door' });
  });
});
