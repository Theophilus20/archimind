import { derive } from './derive';
import { pointAlongWall, wallLength, bbox } from './geometry';
import type { BuildingModel, Id, Vec2 } from './types';

export type ElementKind = 'wall' | 'opening' | 'room' | 'furniture' | 'dimension';

export function elementKind(model: BuildingModel, id: Id): ElementKind | null {
  if (model.walls.some((w) => w.id === id)) return 'wall';
  if (model.openings.some((o) => o.id === id)) return 'opening';
  if (model.furniture.some((f) => f.id === id)) return 'furniture';
  if (model.dimensions?.some((d) => d.id === id)) return 'dimension';
  if (model.rooms.some((r) => r.id === id) || derive(model).roomById.has(id)) return 'room';
  return null;
}

export function elementCenter(model: BuildingModel, id: Id): Vec2 | null {
  const w = model.walls.find((x) => x.id === id);
  if (w) return pointAlongWall(w, wallLength(w) / 2);
  const o = model.openings.find((x) => x.id === id);
  if (o) {
    const host = model.walls.find((x) => x.id === o.wallId);
    return host ? pointAlongWall(host, o.offset) : null;
  }
  const f = model.furniture.find((x) => x.id === id);
  if (f) return { x: f.x, y: f.y };
  const r = derive(model).roomById.get(id);
  if (r) return r.centroid;
  return null;
}

export function elementsBounds(model: BuildingModel, ids: Id[]) {
  const pts: Vec2[] = [];
  for (const id of ids) {
    const r = derive(model).roomById.get(id);
    if (r) pts.push(...r.polygon);
    const w = model.walls.find((x) => x.id === id);
    if (w) pts.push(w.a, w.b);
    const c = elementCenter(model, id);
    if (c) pts.push(c);
  }
  return pts.length ? bbox(pts) : null;
}

export function modelBounds(model: BuildingModel) {
  const pts = model.walls.flatMap((w) => [w.a, w.b]);
  if (model.source) {
    pts.push(model.source.origin, { x: model.source.origin.x + model.source.widthPx * model.source.mmPerPx, y: model.source.origin.y + model.source.heightPx * model.source.mmPerPx });
  }
  if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 10000, y: 8000 });
  return bbox(pts);
}
