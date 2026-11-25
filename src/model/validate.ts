import { derive } from './derive';
import { dist, projectOnSegment, wallLength } from './geometry';
import type { BuildingModel, Id } from './types';

export interface ValidationIssue {
  key: string;
  severity: 'error' | 'warning';
  message: string;
  elementIds: Id[];
}

/** Deterministic geometry validation. Runs after every edit and before every AI-proposed change is accepted. */
export function validateModel(m: BuildingModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walls = new Map(m.walls.map((w) => [w.id, w]));

  for (const w of m.walls) {
    const L = wallLength(w);
    if (L < 100) issues.push({ key: `short:${w.id}`, severity: 'error', message: `Wall ${w.id} is shorter than 100 mm.`, elementIds: [w.id] });
    if (w.thickness < 50 || w.thickness > 700)
      issues.push({ key: `thick:${w.id}`, severity: 'error', message: `Wall ${w.id} thickness ${w.thickness} mm is outside 50–700 mm.`, elementIds: [w.id] });
    // a porch's edge may be a low paving edge
    const minH = w.kind === 'railing' ? 100 : 300;
    if (w.height < minH || w.height > 30000)
      issues.push({ key: `height:${w.id}`, severity: 'error', message: `Wall ${w.id} height ${w.height} mm is outside ${minH}–30000 mm.`, elementIds: [w.id] });

    // Free ends: an end that touches no other wall usually means a detection gap (a pillar
    // stands on its own).
    for (const end of w.kind === 'column' ? [] : (['a', 'b'] as const)) {
      const p = w[end];
      const joined = m.walls.some((o) => o.id !== w.id && projectOnSegment(p, o.a, o.b).distance <= (o.thickness + w.thickness) / 2 + 15);
      if (!joined)
        issues.push({ key: `free:${w.id}:${end}`, severity: 'warning', message: `Wall ${w.id} has an unconnected end.`, elementIds: [w.id] });
    }
  }

  const byWall = new Map<Id, typeof m.openings>();
  for (const o of m.openings) {
    const w = walls.get(o.wallId);
    if (!w) {
      issues.push({ key: `host:${o.id}`, severity: 'error', message: `${o.id} references missing wall ${o.wallId}.`, elementIds: [o.id] });
      continue;
    }
    (byWall.get(w.id) ?? byWall.set(w.id, []).get(w.id)!).push(o);
    const L = wallLength(w);
    if (o.offset - o.width / 2 < -1 || o.offset + o.width / 2 > L + 1)
      issues.push({ key: `fit:${o.id}`, severity: 'error', message: `${o.id} (${o.width} mm) does not fit within wall ${w.id}.`, elementIds: [o.id, w.id] });
    // Open passages and ribbon / clerestory windows can be long; doors cannot.
    const maxW = o.kind === 'opening' ? 30000 : o.kind === 'window' ? 14000 : 6000;
    if (o.width < 300 || o.width > maxW)
      issues.push({ key: `w:${o.id}`, severity: 'error', message: `${o.id} width ${Math.round(o.width)} mm is outside 300–${maxW} mm.`, elementIds: [o.id] });
    if (o.sill + o.height > w.height + 1)
      issues.push({ key: `top:${o.id}`, severity: 'error', message: `${o.id} is taller than its wall (${o.sill + o.height} > ${w.height} mm).`, elementIds: [o.id, w.id] });
  }
  for (const [wallId, list] of byWall) {
    const sorted = [...list].sort((a, b) => a.offset - b.offset);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.offset + a.width / 2 > b.offset - b.width / 2 - 50)
        issues.push({ key: `overlap:${a.id}:${b.id}`, severity: 'error', message: `${a.id} and ${b.id} overlap on wall ${wallId}.`, elementIds: [a.id, b.id] });
    }
  }

  const d = derive(m);
  for (const id of d.unenclosed) {
    const r = m.rooms.find((x) => x.id === id);
    issues.push({ key: `open:${id}`, severity: 'warning', message: `${r?.name ?? id} is not enclosed by walls.`, elementIds: [id] });
  }
  // Two room labels inside one enclosed space.
  for (let i = 0; i < m.rooms.length; i++)
    for (let j = i + 1; j < m.rooms.length; j++)
      if (dist(m.rooms[i].seed, m.rooms[j].seed) < 1 && m.rooms[i].id !== m.rooms[j].id)
        issues.push({ key: `dup:${m.rooms[i].id}`, severity: 'warning', message: `${m.rooms[i].id} and ${m.rooms[j].id} share a position.`, elementIds: [m.rooms[i].id, m.rooms[j].id] });
  return issues;
}
