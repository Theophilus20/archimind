import { describe, expect, it } from 'vitest';
import { runRules, reconcile } from './rules';
import { sampleBrief, sampleModel } from '../model/sample';
import { applyEdits } from '../model/edits';

describe('calculated review of the sample home', () => {
  const model = sampleModel();
  const brief = sampleBrief();
  const drafts = runRules(model, brief);
  const by = (rule: string) => drafts.filter((d) => d.ruleId === rule);

  it('flags the bedroom door opening onto the living room, with a validated fix', () => {
    const f = by('privacy.direct-door');
    expect(f).toHaveLength(1);
    expect(f[0].evidence.elementIds).toContain('D1');
    const e = f[0].proposal!.edits[0] as { op: string; wallId: string; offset: number; swing: number };
    expect(e).toMatchObject({ op: 'relocateOpening', openingId: 'D1', wallId: 'W5', swing: -1 });
    // Door (850 mm) must sit between the W7 junction (y = 4000) and the W8 face (y = 5150).
    expect(e.offset - 425).toBeGreaterThan(4125);
    expect(e.offset + 425).toBeLessThanOrEqual(5100);
  });

  it('the sample house has no furniture inside door swings', () => {
    expect(by('clearance.door-swing')).toEqual([]);
  });

  it('flags a desk pushed into door D3 swing and proposes moving it', () => {
    const clashing = { ...model, furniture: model.furniture.map((x) => (x.id === 'F4' ? { ...x, x: 6850, y: 3300, rotation: -90 } : x)) };
    const f = runRules(clashing, brief).filter((x) => x.ruleId === 'clearance.door-swing');
    expect(f.map((x) => x.fingerprint)).toContain('clearance.door-swing:D3,F4');
    const desk = f.find((x) => x.fingerprint.includes('F4'))!;
    expect(desk.proposal?.edits[0].op).toBe('moveFurniture');
  });

  it('notes the missing study from the brief', () => {
    expect(by('brief.missing').map((x) => x.fingerprint)).toEqual(['brief.missing:q5']);
  });

  it('marks findings resolved after accepting their proposals', () => {
    const first = reconcile([], drafts, 1);
    const privacy = first.find((x) => x.ruleId === 'privacy.direct-door')!;
    const res = applyEdits(model, privacy.proposal!.edits);
    expect(res.ok).toBe(true);
    const second = reconcile(first, runRules(res.model, brief), 2, new Set(['D1']));
    expect(second.find((x) => x.id === privacy.id)!.status).toBe('resolved');
  });
});
