/**
 * How tables are drawn. A dining table comes with its chairs (one per 600 mm along each long
 * side); a small table by a sofa in a living room is a coffee table, low and without chairs.
 */
import { derive } from './derive';
import type { BuildingModel, Id } from './types';

export const chairsPerSide = (w: number) => Math.max(1, Math.min(4, Math.floor(w / 600)));

export function coffeeTableIds(model: BuildingModel): Set<Id> {
  const out = new Set<Id>();
  const tables = model.furniture.filter((f) => f.kind === 'table' && Math.max(f.w, f.d) < 1000);
  if (!tables.length) return out;
  const d = derive(model);
  for (const f of tables) {
    if (d.roomAt(f)?.type !== 'living') continue;
    if (model.furniture.some((s) => s.kind === 'sofa' && Math.hypot(s.x - f.x, s.y - f.y) < 2500)) out.add(f.id);
  }
  return out;
}
