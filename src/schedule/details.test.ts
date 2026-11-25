import { describe, expect, it } from 'vitest';
import { draftTaskDetails, withDetails } from './details';
import { sampleProject } from '../model/sample';

describe('task details', () => {
  it('writes details for every brief task and leaves manual tasks empty', () => {
    const p = sampleProject();
    for (const t of p.tasks) {
      const d = draftTaskDetails(t, p);
      if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHOW) console.log(`## ${t.title}\n${d}\n`);
      expect(d.length).toBeGreaterThan(40);
    }
    const manual = { ...p.tasks[0], origin: 'manual' as const, notes: undefined };
    expect(withDetails([manual], p)[0].notes).toBeUndefined();
  });
});
