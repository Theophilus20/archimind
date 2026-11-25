import { describe, expect, it } from 'vitest';
import { derive } from './derive';
import { sampleModel } from './sample';
import { applyEdits } from './edits';
import { validateModel } from './validate';

describe('room derivation', () => {
  it('finds the six rooms of the sample home', () => {
    const m = sampleModel();
    const d = derive(m);
    expect(d.rooms).toHaveLength(6);
    expect(d.unenclosed).toEqual([]);
    const byName = Object.fromEntries(d.rooms.map((r) => [r.name, r]));
    expect(byName['Bedroom 1'].grossArea).toBeCloseTo(4.5 * 5.2, 1);
    // net = (4500 − 125 − 50) × (5200 − 125 − 50)
    expect(byName['Bedroom 1'].area).toBeCloseTo((4325 * 5025) / 1e6, 1);
    expect(byName['Hall'].grossArea).toBeCloseTo(7.5 * 1.2, 1);
  });

  it('links doors to the rooms on each side', () => {
    const d = derive(sampleModel());
    const d1 = d.links.get('D1')!;
    expect([d1.plus, d1.minus].sort()).toEqual(['R1', 'R5']);
    expect(d.connections.get('R4')!.has('R3')).toBe(true);
  });

  it('sample model has no validation errors', () => {
    const errs = validateModel(sampleModel()).filter((i) => i.severity === 'error');
    expect(errs).toEqual([]);
  });
});

describe('structured edits', () => {
  it('moving a wall resizes both rooms and keeps them enclosed', () => {
    const m = sampleModel();
    const res = applyEdits(m, [{ op: 'moveWall', wallId: 'W6', distance: 300 }]);
    expect(res.ok).toBe(true);
    const d = derive(res.model);
    expect(d.rooms).toHaveLength(6);
    const bath = d.rooms.find((r) => r.id === 'R2')!;
    // W6 runs south (0,1); walking south your left is +x (east), so +300 grows the bathroom.
    expect(bath.grossArea).toBeCloseTo(2.3 * 4, 1);
    expect(d.rooms.find((r) => r.id === 'R3')!.grossArea).toBeCloseTo(5.2 * 4, 1);
  });

  it('rejects an edit that pushes a door off its wall', () => {
    const res = applyEdits(sampleModel(), [{ op: 'setOpening', openingId: 'D4', patch: { offset: 8900 } }]);
    expect(res.ok).toBe(false);
  });

  it('relocating the bedroom door into the hall links bedroom to hall', () => {
    const res = applyEdits(sampleModel(), [{ op: 'relocateOpening', openingId: 'D1', wallId: 'W5', offset: 4600, swing: -1 }]);
    expect(res.ok).toBe(true);
    const link = derive(res.model).links.get('D1')!;
    expect([link.plus, link.minus].sort()).toEqual(['R1', 'R4']);
  });
});
