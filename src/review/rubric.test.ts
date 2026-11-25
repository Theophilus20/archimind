import { describe, expect, it } from 'vitest';
import { reviewCriterion } from './rubric';
import { reconcile, runRules } from './rules';
import { sampleBrief, sampleModel } from '../model/sample';

describe('rubric evidence', () => {
  it('gives every criterion specific, measured evidence', () => {
    const model = sampleModel();
    const brief = sampleBrief();
    const findings = reconcile([], runRules(model, brief), model.revision);
    for (const c of brief.rubric) {
      const r = reviewCriterion(model, brief, findings, c, { revisions: [] });
      if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHOW) console.log(`${c.name} [${r.score}]\n  + ${r.strengths}\n  - ${r.improvement}\n  = ${r.evidence}\n  # ${r.elementIds.join(' ')}`);
      expect(r.evidence.length).toBeGreaterThan(20);
      expect(r.strengths).not.toMatch(/single-storey arrangement/);
      expect(r.improvement).not.toMatch(/Develop and evidence this criterion/);
      expect(r.score).toBeGreaterThanOrEqual(35);
      expect(r.score).toBeLessThanOrEqual(94);
    }
  });
});
