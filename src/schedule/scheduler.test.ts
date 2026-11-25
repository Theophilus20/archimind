import { describe, expect, it } from 'vitest';
import { schedule } from './scheduler';
import { briefTasks, sampleBrief } from '../model/sample';

describe('scheduler', () => {
  const brief = { ...sampleBrief(), startDate: '2026-11-16', deadline: '2026-12-07', hoursPerDay: 4, workDays: [1, 2, 3, 4, 5] };
  const { tasks } = briefTasks(brief);

  it('respects dependencies and owner capacity', () => {
    const r = schedule(tasks, brief, '2026-11-16');
    expect(r.cycle).toBeNull();
    const at = (id: string) => r.byId.get(id)!;
    expect(at('T2').startHour).toBeGreaterThanOrEqual(at('T1').endHour);
    expect(at('T8').startHour).toBeGreaterThanOrEqual(Math.max(at('T4').endHour, at('T5').endHour, at('T6').endHour, at('T7').endHour));
    // 49 h of work at 4 h/day = 13 workdays from Mon 16 Nov → Wed 2 Dec.
    expect(r.remainingHours).toBe(49);
    expect(r.projectedFinish).toBe('2026-12-02');
    expect(r.overrunDays).toBe(0);
  });

  it('reports lateness when hours shrink', () => {
    const r = schedule(tasks, { ...brief, hoursPerDay: 2 }, '2026-11-16');
    expect(r.overrunDays).toBeGreaterThan(0);
    expect(r.items.some((i) => i.late)).toBe(true);
  });

  it('detects dependency cycles', () => {
    const cyc = tasks.map((t) => (t.id === 'T1' ? { ...t, deps: ['T9'] } : t));
    expect(schedule(cyc, brief, '2026-11-16').cycle).not.toBeNull();
  });
});
