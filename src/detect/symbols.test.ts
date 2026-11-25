import { describe, expect, it } from 'vitest';
import { applyOpeningSymbols, checkedParts, type OpeningAnswer, type SymbolAnswers } from './symbols';
import type { DetectedOpening } from './detector';
import type { PlanParts } from '../ai/requests';

const op = (id: string, kind: DetectedOpening['kind'], confidence: number, extra: Partial<DetectedOpening> = {}): DetectedOpening => ({ id, wallId: 'W1', offset: 100, width: 40, kind, swing: 1, hinge: 'start', confidence, ...extra });

describe('the legend check on the openings the pixels found', () => {
  it('turns what the pixels were unsure about, or read without a clear swing, into a sliding door', () => {
    const answers = new Map<string, OpeningAnswer>([
      ['O1', 'sliding door'],
      ['O2', 'sliding door'],
      ['O3', 'sliding door'],
      ['O4', 'sliding door'],
    ]);
    const { openings, changed } = applyOpeningSymbols([op('O1', 'opening', 0.45), op('O2', 'window', 0.6), op('O3', 'door', 0.9), op('O4', 'window', 0.8)], answers);
    expect(changed).toBe(2);
    expect(openings[0]).toMatchObject({ kind: 'door', style: 'sliding', ai: true });
    expect(openings[1]).toMatchObject({ kind: 'door', style: 'sliding', ai: true });
    // a clear swing arc or clear glass the pixels found stands
    expect(openings[2]).toMatchObject({ kind: 'door' });
    expect(openings[2].style).toBeUndefined();
    expect(openings[3].kind).toBe('window');
  });

  it('never overrules a sliding door the pixels found, what you confirmed, or deletes anything', () => {
    const answers = new Map<string, OpeningAnswer>([
      ['O1', 'open passage'],
      ['O2', 'window'],
      ['O3', 'none'],
    ]);
    const { openings, changed } = applyOpeningSymbols([op('O1', 'door', 0.7, { style: 'sliding' }), op('O2', 'door', 1), op('O3', 'opening', 0.45)], answers);
    expect(changed).toBe(0);
    expect(openings.map((o) => [o.kind, o.style])).toEqual([
      ['door', 'sliding'],
      ['door', undefined],
      ['opening', undefined],
    ]);
  });

  it('settles what the pixels were unsure about', () => {
    const answers = new Map<string, OpeningAnswer>([
      ['O1', 'hinged door'],
      ['O2', 'window'],
      ['O3', 'open passage'],
    ]);
    const { openings } = applyOpeningSymbols([op('O1', 'opening', 0.45), op('O2', 'door', 0.6), op('O3', 'door', 0.62)], answers);
    expect(openings.map((o) => o.kind)).toEqual(['door', 'window', 'opening']);
  });
});

describe('the legend check on what the AI read', () => {
  const parts: PlanParts = {
    overall: {},
    verdicts: [],
    doors: [
      [0, 0, 10, 10],
      [20, 20, 30, 30],
      [40, 40, 50, 50],
    ],
    windows: [[60, 60, 70, 70]],
    outdoor: [],
    furniture: [
      { kind: 'wardrobe', box: [100, 100, 120, 200] },
      { kind: 'table', box: [300, 300, 340, 330] },
      { kind: 'tv', box: [500, 500, 510, 560] },
      { kind: 'chair', box: [600, 600, 620, 620] },
    ],
  };

  it('drops what does not match a symbol on a closer look and renames what was misnamed', () => {
    const answers: SymbolAnswers = {
      openings: new Map(),
      doors: ['hinged door', 'window', 'none'],
      windows: ['sliding door'],
      furniture: [{ symbol: 'sideboard', back: 'top' }, { symbol: 'kitchen worktop' }, { symbol: 'none' }, undefined],
      found: [{ kind: 'bed', box: [10, 10, 200, 150], back: 'top' }],
    };
    const out = checkedParts(parts, answers);
    expect(out.doors).toEqual([
      [0, 0, 10, 10],
      [60, 60, 70, 70],
    ]);
    expect(out.windows).toEqual([[20, 20, 30, 30]]);
    // shapes found on the drawing come first, then the AI's own pieces that still stand
    expect(out.furniture.map((f) => f.kind)).toEqual(['bed', 'sideboard', 'kitchen', 'chair']);
    expect(out.furniture[1].back).toBe('top');
  });

  it('leaves the reading as it is when the check did not run', () => {
    expect(checkedParts(parts, null)).toBe(parts);
  });
});
