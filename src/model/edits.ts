import { add, dist, mul, pointAlongWall, projectOnSegment, wallLength, wallNormal, wallDir, dot, sub, round } from './geometry';
import { derive, refreshSeeds } from './derive';
import type { BuildingModel, EditOp, Id, RoofDesign, Vec2, Wall } from './types';
import { validateModel, type ValidationIssue } from './validate';

const clone = <T,>(x: T): T => structuredClone(x);

/** Older saved models only stored the roof kind. */
export function normalizeRoof(r: Partial<RoofDesign> | undefined): RoofDesign {
  return { kind: r?.kind ?? 'none', pitch: r?.pitch ?? 35, overhang: r?.overhang ?? 400, ridge: r?.ridge ?? 'auto', materialId: r?.materialId ?? 'roof-tile', prov: r?.prov ?? { kind: 'assumed' } };
}

/** Absolute centre of every opening, used to keep openings fixed in space while host walls change. */
function openingCentres(m: BuildingModel) {
  const walls = new Map(m.walls.map((w) => [w.id, w]));
  const out = new Map<Id, Vec2>();
  for (const o of m.openings) {
    const w = walls.get(o.wallId);
    if (w) out.set(o.id, pointAlongWall(w, o.offset));
  }
  return out;
}

function reanchorOpenings(m: BuildingModel, centres: Map<Id, Vec2>, wallIds: Set<Id>) {
  const walls = new Map(m.walls.map((w) => [w.id, w]));
  for (const o of m.openings) {
    if (!wallIds.has(o.wallId)) continue;
    const w = walls.get(o.wallId);
    const c = centres.get(o.id);
    if (!w || !c) continue;
    const pr = projectOnSegment(c, w.a, w.b);
    o.offset = round(pr.tRaw * wallLength(w), 1);
  }
}

function moveWall(m: BuildingModel, wallId: Id, distance: number) {
  const w = m.walls.find((x) => x.id === wallId);
  if (!w) throw new Error(`Wall ${wallId} not found`);
  const shift = mul(wallNormal(w), distance);
  const centres = openingCentres(m);
  const touched = new Set<Id>([w.id]);
  const tol = (other: Wall) => Math.max(w.thickness, other.thickness) / 2 + 15;
  for (const o of m.walls) {
    if (o.id === w.id) continue;
    for (const end of ['a', 'b'] as const) {
      const pr = projectOnSegment(o[end], w.a, w.b);
      if (pr.distance <= tol(o) && pr.tRaw > -0.01 && pr.tRaw < 1.01) {
        o[end] = add(o[end], shift);
        touched.add(o.id);
      }
    }
  }
  w.a = add(w.a, shift);
  w.b = add(w.b, shift);
  // Openings on the moved wall travel with it; openings on stretched walls stay put in space.
  const movedCentres = new Map(centres);
  for (const o of m.openings) if (o.wallId === w.id) movedCentres.set(o.id, add(centres.get(o.id)!, shift));
  // Furniture fully inside the shifted strip is left alone; geometry checks will flag clashes.
  reanchorOpenings(m, movedCentres, touched);
  for (const id of touched) {
    const ww = m.walls.find((x) => x.id === id)!;
    ww.prov.geometry = 'confirmed';
  }
}

function moveWallEndpoint(m: BuildingModel, wallId: Id, end: 'a' | 'b', to: Vec2) {
  const w = m.walls.find((x) => x.id === wallId);
  if (!w) throw new Error(`Wall ${wallId} not found`);
  const centres = openingCentres(m);
  const from = w[end];
  for (const o of m.walls) {
    if (o.id === w.id) continue;
    for (const e of ['a', 'b'] as const) if (dist(o[e], from) < 5) o[e] = { ...to };
  }
  w[end] = { ...to };
  w.prov.geometry = 'confirmed';
  reanchorOpenings(m, centres, new Set(m.walls.map((x) => x.id)));
}

export function applyEdit(model: BuildingModel, op: EditOp): BuildingModel {
  const m = clone(model);
  switch (op.op) {
    case 'moveWall':
      moveWall(m, op.wallId, op.distance);
      break;
    case 'moveWallEndpoint':
      moveWallEndpoint(m, op.wallId, op.end, op.to);
      break;
    case 'setWall': {
      const w = m.walls.find((x) => x.id === op.wallId);
      if (!w) throw new Error(`Wall ${op.wallId} not found`);
      Object.assign(w, op.patch);
      for (const k of Object.keys(op.patch)) w.prov[k] = 'confirmed';
      break;
    }
    case 'addWall':
      if (m.walls.some((w) => w.id === op.wall.id)) throw new Error(`Wall ${op.wall.id} already exists`);
      m.walls.push(clone(op.wall));
      break;
    case 'removeWall':
      m.walls = m.walls.filter((w) => w.id !== op.wallId);
      m.openings = m.openings.filter((o) => o.wallId !== op.wallId);
      break;
    case 'setOpening': {
      const o = m.openings.find((x) => x.id === op.openingId);
      if (!o) throw new Error(`Opening ${op.openingId} not found`);
      Object.assign(o, op.patch);
      if (op.patch.kind === 'window' && o.sill === 0) o.sill = m.defaults.windowSill;
      if (op.patch.kind && op.patch.kind !== 'window') o.sill = 0;
      for (const k of Object.keys(op.patch)) o.prov[k] = 'confirmed';
      break;
    }
    case 'relocateOpening': {
      const o = m.openings.find((x) => x.id === op.openingId);
      if (!o) throw new Error(`Opening ${op.openingId} not found`);
      if (!m.walls.some((w) => w.id === op.wallId)) throw new Error(`Wall ${op.wallId} not found`);
      o.wallId = op.wallId;
      o.offset = op.offset;
      if (op.swing) o.swing = op.swing;
      o.prov.position = 'confirmed';
      break;
    }
    case 'addOpening':
      if (m.openings.some((o) => o.id === op.opening.id)) throw new Error(`Opening ${op.opening.id} already exists`);
      m.openings.push(clone(op.opening));
      break;
    case 'removeOpening':
      m.openings = m.openings.filter((o) => o.id !== op.openingId);
      break;
    case 'setRoom': {
      let r = m.rooms.find((x) => x.id === op.roomId);
      // A space nobody has named yet ("Unnamed space"): give it a record of its own first.
      if (!r && op.roomId.startsWith('R?')) {
        const found = derive(m).rooms.find((x) => x.id === op.roomId);
        if (found) {
          r = { id: nextId(m, 'R'), name: found.name, type: found.type, floorMaterialId: found.floorMaterialId, seed: found.centroid, prov: { name: 'assumed', type: 'assumed' } };
          m.rooms.push(r);
        }
      }
      if (!r) throw new Error(`Room ${op.roomId} not found`);
      Object.assign(r, op.patch);
      for (const k of Object.keys(op.patch)) r.prov[k] = 'confirmed';
      break;
    }
    case 'moveFurniture': {
      const f = m.furniture.find((x) => x.id === op.furnitureId);
      if (!f) throw new Error(`Furniture ${op.furnitureId} not found`);
      f.x = op.x;
      f.y = op.y;
      if (op.rotation !== undefined) f.rotation = op.rotation;
      f.prov.position = 'confirmed';
      break;
    }
    case 'setFurniture': {
      const f = m.furniture.find((x) => x.id === op.furnitureId);
      if (!f) throw new Error(`Furniture ${op.furnitureId} not found`);
      if ((op.patch.w !== undefined && op.patch.w < 100) || (op.patch.d !== undefined && op.patch.d < 100)) throw new Error('Furniture must be at least 100 mm each way.');
      Object.assign(f, op.patch);
      for (const k of Object.keys(op.patch)) f.prov[k] = 'confirmed';
      break;
    }
    case 'addFurniture':
      m.furniture.push(clone(op.furniture));
      break;
    case 'removeFurniture':
      m.furniture = m.furniture.filter((f) => f.id !== op.furnitureId);
      break;
    case 'addDimension':
      if (Math.hypot(op.dimension.b.x - op.dimension.a.x, op.dimension.b.y - op.dimension.a.y) < 10) throw new Error('A dimension needs two different points.');
      m.dimensions = [...(m.dimensions ?? []), clone(op.dimension)];
      break;
    case 'removeDimension':
      m.dimensions = (m.dimensions ?? []).filter((d) => d.id !== op.dimensionId);
      break;
    case 'setDefaults':
      Object.assign(m.defaults, op.patch);
      for (const k of Object.keys(op.patch)) m.prov[`defaults.${k}`] = 'confirmed';
      if (op.patch.wallHeight) for (const w of m.walls) if (w.prov.height !== 'confirmed') w.height = op.patch.wallHeight;
      break;
    case 'setRoof':
      m.roof = { ...normalizeRoof(m.roof), ...op.patch, prov: { ...(m.roof?.prov ?? {}), ...Object.fromEntries(Object.keys(op.patch).map((k) => [k, 'confirmed'])) } };
      break;
    case 'rescale': {
      const f = op.factor;
      if (!(f > 0.05 && f < 20)) throw new Error('That scale change is too big. Check the length you typed.');
      const P = (p: Vec2): Vec2 => ({ x: Math.round(p.x * f), y: Math.round(p.y * f) });
      const plan = (walls: Wall[], openings: BuildingModel['openings'], furniture: BuildingModel['furniture'], rooms: BuildingModel['rooms']) => {
        for (const w of walls) {
          w.a = P(w.a);
          w.b = P(w.b);
        }
        for (const o of openings) {
          o.offset = Math.round(o.offset * f);
          o.width = Math.round(o.width * f);
        }
        for (const it of furniture) {
          it.x = Math.round(it.x * f);
          it.y = Math.round(it.y * f);
        }
        for (const r of rooms) r.seed = P(r.seed);
      };
      plan(m.walls, m.openings, m.furniture, m.rooms);
      for (const l of m.levels ?? []) plan(l.walls, l.openings, l.furniture, l.rooms);
      for (const d of m.dimensions ?? []) {
        d.a = P(d.a);
        d.b = P(d.b);
        d.offset = Math.round(d.offset * f);
      }
      if (m.source) m.source = { ...m.source, mmPerPx: m.source.mmPerPx * f, origin: P(m.source.origin) };
      break;
    }
    case 'confirm': {
      const el =
        m.walls.find((x) => x.id === op.elementId) ??
        m.openings.find((x) => x.id === op.elementId) ??
        m.rooms.find((x) => x.id === op.elementId) ??
        m.furniture.find((x) => x.id === op.elementId);
      if (!el) throw new Error(`Element ${op.elementId} not found`);
      for (const k of Object.keys(el.prov)) el.prov[k] = 'confirmed';
      el.prov.element = 'confirmed';
      break;
    }
  }
  return m;
}

export interface EditResult {
  model: BuildingModel;
  ok: boolean;
  errors: string[];
  issues: ValidationIssue[];
}

/**
 * Apply a list of structured edits and validate the result. Edits that introduce
 * new validation errors are rejected (the original model is returned).
 */
export function applyEdits(model: BuildingModel, edits: EditOp[]): EditResult {
  const before = new Set(validateModel(model).filter((i) => i.severity === 'error').map((i) => i.key));
  let m = model;
  const errors: string[] = [];
  for (const op of edits) {
    try {
      m = applyEdit(m, op);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) return { model, ok: false, errors, issues: [] };
  m = refreshSeeds(m);
  const issues = validateModel(m);
  const introduced = issues.filter((i) => i.severity === 'error' && !before.has(i.key));
  if (introduced.length) return { model, ok: false, errors: introduced.map((i) => i.message), issues };
  return { model: m, ok: true, errors: [], issues };
}

export function describeEdit(op: EditOp, model?: BuildingModel): string {
  const nameOf = (id: Id) => {
    const r = model?.rooms.find((x) => x.id === id);
    return r ? `${r.name} (${id})` : id;
  };
  switch (op.op) {
    case 'moveWall':
      return `Move wall ${op.wallId} by ${Math.round(op.distance)} mm`;
    case 'moveWallEndpoint':
      return `Move end ${op.end.toUpperCase()} of wall ${op.wallId}`;
    case 'setWall':
      return `Change wall ${op.wallId}: ${Object.entries(op.patch)
        .map(([k, v]) => `${k} → ${v}`)
        .join(', ')}`;
    case 'addWall':
      return `Add wall ${op.wall.id} (${Math.round(wallLength(op.wall))} mm)`;
    case 'removeWall':
      return `Remove wall ${op.wallId}`;
    case 'setOpening':
      return `Change ${op.openingId}: ${Object.entries(op.patch)
        .map(([k, v]) => `${k} → ${v}`)
        .join(', ')}`;
    case 'relocateOpening':
      return `Move ${op.openingId} to wall ${op.wallId} at ${Math.round(op.offset)} mm`;
    case 'addOpening':
      return `Add ${op.opening.kind} ${op.opening.id} on wall ${op.opening.wallId}`;
    case 'removeOpening':
      return `Remove ${op.openingId}`;
    case 'setRoom':
      return `Update ${nameOf(op.roomId)}: ${Object.entries(op.patch)
        .map(([k, v]) => `${k} → ${v}`)
        .join(', ')}`;
    case 'moveFurniture':
      return `Move ${op.furnitureId} to (${Math.round(op.x)}, ${Math.round(op.y)})${op.rotation !== undefined ? ` rotated ${op.rotation}°` : ''}`;
    case 'setFurniture':
      return `Update ${op.furnitureId}: ${Object.entries(op.patch)
        .map(([k, v]) => `${k} → ${v}`)
        .join(', ')}`;
    case 'addFurniture':
      return `Add ${op.furniture.kind} ${op.furniture.id}`;
    case 'removeFurniture':
      return `Remove ${op.furnitureId}`;
    case 'addDimension':
      return `Add dimension ${op.dimension.id} (${Math.round(Math.hypot(op.dimension.b.x - op.dimension.a.x, op.dimension.b.y - op.dimension.a.y))} mm)`;
    case 'removeDimension':
      return `Remove dimension ${op.dimensionId}`;
    case 'setDefaults':
      return `Set ${Object.entries(op.patch)
        .map(([k, v]) => `${k} = ${v} mm`)
        .join(', ')}`;
    case 'setRoof':
      return `Roof: ${Object.entries(op.patch).map(([k, v]) => `${k} ${v}`).join(', ')}`;
    case 'rescale':
      return `Rescale the plan ×${op.factor.toFixed(3)}`;
    case 'confirm':
      return `Confirm ${op.elementId}`;
  }
}

export function nextId(model: BuildingModel, prefix: string) {
  const all = [...model.walls, ...model.openings, ...model.rooms, ...model.furniture, ...(model.dimensions ?? [])].map((e) => e.id);
  let n = 1;
  for (const id of all) {
    const m = id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${prefix}${n}`;
}

/** Element ids that an edit touches, used to mark AI findings outdated. */
export function touchedIds(op: EditOp): Id[] {
  switch (op.op) {
    case 'moveWall':
    case 'moveWallEndpoint':
    case 'setWall':
    case 'removeWall':
      return [op.wallId];
    case 'addWall':
      return [op.wall.id];
    case 'setOpening':
    case 'removeOpening':
      return [op.openingId];
    case 'relocateOpening':
      return [op.openingId, op.wallId];
    case 'addOpening':
      return [op.opening.id, op.opening.wallId];
    case 'setRoom':
      return [op.roomId];
    case 'moveFurniture':
    case 'setFurniture':
    case 'removeFurniture':
      return [op.furnitureId];
    case 'addFurniture':
      return [op.furniture.id];
    case 'addDimension':
      return [op.dimension.id];
    case 'removeDimension':
      return [op.dimensionId];
    case 'confirm':
      return [op.elementId];
    default:
      return [];
  }
}

/**
 * Find free space on a wall for an opening of a given width (returns centre offset or null).
 * Avoids other openings and the junctions where other walls meet this one; `bounds`
 * optionally limits the opening to a stretch of the wall (e.g. the part facing a hall).
 */
export function findFreeOffset(model: BuildingModel, wallId: Id, width: number, prefer?: number, ignoreId?: Id, bounds?: [number, number]): number | null {
  const w = model.walls.find((x) => x.id === wallId);
  if (!w) return null;
  const L = wallLength(w);
  const margin = Math.max(100, w.thickness);
  const taken: (readonly [number, number])[] = model.openings
    .filter((o) => o.wallId === wallId && o.id !== ignoreId)
    .map((o) => [o.offset - o.width / 2 - 100, o.offset + o.width / 2 + 100] as const);
  for (const o of model.walls) {
    if (o.id === w.id) continue;
    for (const e of [o.a, o.b]) {
      const pr = projectOnSegment(e, w.a, w.b);
      if (pr.distance <= (o.thickness + w.thickness) / 2 + 15 && pr.tRaw > 0.001 && pr.tRaw < 0.999) taken.push([pr.along - o.thickness / 2 - 75, pr.along + o.thickness / 2 + 75]);
    }
  }
  const lo = Math.max(margin, bounds?.[0] ?? -Infinity);
  const hi = Math.min(L - margin, bounds?.[1] ?? Infinity);
  const candidates: number[] = [];
  for (let c = lo + width / 2; c <= hi - width / 2; c += 25) candidates.push(Math.round(c));
  const free = candidates.filter((c) => taken.every(([s, e]) => c + width / 2 < s || c - width / 2 > e));
  if (!free.length) return null;
  const target = prefer ?? L / 2;
  free.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  return free[0];
}

export function wallSideToward(w: Wall, p: Vec2): 1 | -1 {
  return dot(sub(p, pointAlongWall(w, wallLength(w) / 2)), wallNormal(w)) >= 0 ? 1 : -1;
}

export { wallDir };

/** The elements a reviewer should look at for an edit (excludes host walls of moved openings). */
export function primaryIds(op: EditOp): Id[] {
  if (op.op === 'relocateOpening') return [op.openingId];
  if (op.op === 'addOpening') return [op.opening.id];
  return touchedIds(op);
}
