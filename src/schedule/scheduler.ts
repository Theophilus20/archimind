/**
 * Deterministic scheduling. AI may draft tasks and suggest durations, but dates,
 * dependencies and lateness are always calculated here.
 */
import type { Brief, Id, Milestone, Task } from '../model/types';

export interface ScheduledTask {
  task: Task;
  startHour: number;
  endHour: number;
  start: string; // ISO date
  end: string; // ISO date
  due: string;
  late: boolean;
  slackDays: number;
  critical: boolean;
}

export interface ScheduleResult {
  items: ScheduledTask[];
  byId: Map<Id, ScheduledTask>;
  cycle: Id[] | null;
  projectedFinish: string;
  remainingHours: number;
  availableHours: number;
  overrunDays: number;
  workdays: string[]; // calendar of workdays from start (for drawing)
  origin: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + 'T00:00:00Z');

export function workdayCalendar(origin: string, workDays: number[], count: number): string[] {
  const out: string[] = [];
  const d = parse(origin);
  const days = workDays.length ? workDays : [1, 2, 3, 4, 5];
  let guard = 0;
  while (out.length < count && guard++ < count * 7 + 14) {
    if (days.includes(d.getUTCDay())) out.push(iso(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function schedule(tasks: Task[], brief: Pick<Brief, 'startDate' | 'deadline' | 'hoursPerDay' | 'workDays'>, today = iso(new Date())): ScheduleResult {
  const origin = brief.startDate > today ? brief.startDate : today;
  const hpd = Math.max(0.5, brief.hoursPerDay);
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Kahn topological sort with cycle detection.
  const indeg = new Map<Id, number>();
  for (const t of tasks) indeg.set(t.id, t.deps.filter((d) => byId.has(d)).length);
  const order: Task[] = [];
  const ready = tasks.filter((t) => indeg.get(t.id) === 0);
  const dependents = new Map<Id, Id[]>();
  for (const t of tasks) for (const d of t.deps) if (byId.has(d)) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(t.id);
  while (ready.length) {
    const t = ready.shift()!;
    order.push(t);
    for (const n of dependents.get(t.id) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) ready.push(byId.get(n)!);
    }
  }
  const cycle = order.length < tasks.length ? tasks.filter((t) => !order.includes(t)).map((t) => t.id) : null;
  const schedulable = cycle ? order : tasks;

  // List scheduling: one calendar per owner; among ready tasks the earliest due goes first.
  const due = (t: Task) => t.deadline ?? brief.deadline;
  const finish = new Map<Id, number>();
  const startAt = new Map<Id, number>();
  const ownerFree = new Map<string, number>();
  const pending = new Set(schedulable.map((t) => t.id));
  while (pending.size) {
    const candidates = [...pending].map((id) => byId.get(id)!).filter((t) => t.deps.every((d) => !byId.has(d) || finish.has(d) || !pending.has(d) && !schedulable.some((s) => s.id === d)));
    if (!candidates.length) break;
    candidates.sort((a, b) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : order.indexOf(a) - order.indexOf(b)));
    const t = candidates[0];
    pending.delete(t.id);
    const depsDone = Math.max(0, ...t.deps.map((d) => finish.get(d) ?? 0));
    if (t.status === 'done') {
      startAt.set(t.id, depsDone);
      finish.set(t.id, depsDone);
      continue;
    }
    const free = ownerFree.get(t.owner) ?? 0;
    const s = Math.max(free, depsDone);
    const e = s + Math.max(0.25, t.effortHours);
    startAt.set(t.id, s);
    finish.set(t.id, e);
    ownerFree.set(t.owner, e);
  }

  const maxHour = Math.max(1, ...[...finish.values()]);
  const calendar = workdayCalendar(origin, brief.workDays, Math.ceil(maxHour / hpd) + 60);
  const dateAt = (h: number, isEnd: boolean) => calendar[Math.max(0, Math.min(calendar.length - 1, Math.ceil((isEnd ? h : h + 0.001) / hpd) - 1))] ?? origin;
  const workdaysBetween = (a: string, b: string) => {
    // signed count of workdays from a to b
    const ia = calendar.indexOf(a);
    const ib = calendar.indexOf(b);
    if (ia >= 0 && ib >= 0) return ib - ia;
    return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
  };

  // Latest-finish pass for slack and the critical chain (against each task's due date).
  const latest = new Map<Id, number>();
  const dueHour = (t: Task) => {
    const idx = calendar.findIndex((d) => d > due(t));
    return (idx === -1 ? calendar.length : idx) * hpd;
  };
  for (const t of [...schedulable].reverse()) {
    const succ = (dependents.get(t.id) ?? []).filter((id) => latest.has(id));
    const succLimit = Math.min(...succ.map((id) => latest.get(id)! - Math.max(0.25, byId.get(id)!.effortHours)), Infinity);
    latest.set(t.id, Math.min(dueHour(t), succLimit));
  }

  const items: ScheduledTask[] = schedulable
    .filter((t) => finish.has(t.id))
    .map((t) => {
      const sH = startAt.get(t.id)!;
      const eH = finish.get(t.id)!;
      const end = dateAt(eH, true);
      const slackH = latest.get(t.id)! - eH;
      return {
        task: t,
        startHour: sH,
        endHour: eH,
        start: dateAt(sH, false),
        end,
        due: due(t),
        late: t.status !== 'done' && end > due(t),
        slackDays: Math.floor(slackH / hpd),
        critical: t.status !== 'done' && slackH < hpd,
      };
    })
    .sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);

  const remainingHours = tasks.filter((t) => t.status !== 'done').reduce((s, t) => s + t.effortHours, 0);
  const daysToDeadline = calendar.filter((d) => d <= brief.deadline).length;
  const projectedFinish = items.length ? items.reduce((m, x) => (x.end > m ? x.end : m), origin) : origin;
  return {
    items,
    byId: new Map(items.map((x) => [x.task.id, x])),
    cycle,
    projectedFinish,
    remainingHours,
    availableHours: daysToDeadline * hpd,
    overrunDays: Math.max(0, workdaysBetween(brief.deadline, projectedFinish)),
    workdays: calendar,
    origin,
  };
}

export function milestoneStatus(m: Milestone, result: ScheduleResult) {
  const linked = result.items.filter((i) => i.due === m.date);
  return { onTrack: linked.every((i) => !i.late), count: linked.length };
}
