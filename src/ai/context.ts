import { derive } from '../model/derive';
import type { Brief, BuildingModel, Finding, Id } from '../model/types';
import { bbox } from '../model/geometry';

/** A compact, token-bounded description of the model for on-device prompts. */
export function modelSummary(model: BuildingModel, brief?: Brief, findings: Finding[] = [], maxChars = 2600): string {
  const d = derive(model);
  const b = model.walls.length ? bbox(model.walls.flatMap((w) => [w.a, w.b])) : null;
  const lines: string[] = [];
  if (b) lines.push(`Plan ${(b.w / 1000).toFixed(1)} × ${(b.h / 1000).toFixed(1)} m, single storey, wall height ${model.defaults.wallHeight} mm.`);
  for (const r of d.rooms) {
    const doors: string[] = [];
    const wins: string[] = [];
    for (const o of model.openings) {
      const l = d.links.get(o.id);
      if (!l || (l.plus !== r.id && l.minus !== r.id)) continue;
      const other = l.plus === r.id ? l.minus : l.plus;
      const otherName = other ? d.roomById.get(other)?.name ?? other : 'outside';
      if (o.kind === 'window') wins.push(`${o.id} ${(o.width / 1000).toFixed(1)}m`);
      else doors.push(`${o.id}→${otherName}`);
    }
    lines.push(`${r.id} ${r.name} (${r.type}) ${r.area.toFixed(1)} m²; doors ${doors.join(', ') || 'none'}; windows ${wins.join(', ') || 'none'}.`);
  }
  if (model.furniture.length) lines.push(`Furniture: ${model.furniture.map((f) => `${f.id} ${f.kind}`).join(', ')}.`);
  if (brief) {
    lines.push(`Brief: ${brief.occupants} Goals: ${brief.goals.join(', ')}.`);
    lines.push(`Required: ${brief.requirements.map((q) => `${q.count}× ${q.label} ≥${q.minArea} m²`).join('; ')}.`);
  }
  const open = findings.filter((f) => f.status === 'open').slice(0, 8);
  if (open.length) lines.push(`Open findings: ${open.map((f) => `[${f.kind}] ${f.title}`).join('; ')}.`);
  const s = lines.join('\n');
  return s.length > maxChars ? s.slice(0, maxChars) + '…' : s;
}

/** Human description of any element id. */
export function describeElement(model: BuildingModel, id: Id): string {
  const d = derive(model);
  const r = d.roomById.get(id);
  if (r) return `${r.name}`;
  const o = model.openings.find((x) => x.id === id);
  if (o) {
    const l = d.links.get(o.id);
    const names = [l?.plus, l?.minus].map((x) => (x ? d.roomById.get(x)?.name : 'outside'));
    const k = o.kind === 'opening' ? 'opening' : o.kind;
    return `${k} ${o.id} between ${names[0]} and ${names[1]}`;
  }
  const w = model.walls.find((x) => x.id === id);
  if (w) return `${w.exterior ? 'external' : 'internal'} wall ${w.id}`;
  const f = model.furniture.find((x) => x.id === id);
  if (f) {
    const room = d.roomAt({ x: f.x, y: f.y });
    return `${f.kind} ${f.id}${room ? ` in ${room.name}` : ''}`;
  }
  return id;
}

export function allElementIds(model: BuildingModel): Set<Id> {
  return new Set([...model.walls, ...model.openings, ...model.rooms, ...model.furniture].map((e) => e.id));
}
