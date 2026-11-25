/**
 * Multi-storey buildings. Every editing tool, the AI and the review work on the
 * active level, whose plan lives in the model's walls / openings / rooms / furniture.
 * The other floors wait in `levels`; switching floors swaps them.
 */
import type { BuildingModel, LevelPlan } from './types';
import { derive, type DerivedRoom } from './derive';

export interface LevelView {
  index: number;
  name: string;
  repeat: number;
  height: number;
  /** Height of this level's floor above ground, mm. */
  elevation: number;
  plan: Pick<BuildingModel, 'walls' | 'openings' | 'rooms' | 'furniture'>;
  active: boolean;
}

export const isMultiLevel = (m: BuildingModel) => (m.levels?.length ?? 0) > 1;

/** All levels with their elevations, the active one taken from the live plan. */
export function levelViews(m: BuildingModel): LevelView[] {
  const active = m.activeLevel ?? 0;
  if (!m.levels?.length) return [{ index: 0, name: 'Ground floor', repeat: 1, height: m.defaults.wallHeight, elevation: 0, plan: m, active: true }];
  let elevation = 0;
  return m.levels.map((l, i) => {
    const v: LevelView = { index: i, name: l.name, repeat: Math.max(1, l.repeat), height: l.height, elevation, plan: i === active ? m : l, active: i === active };
    elevation += l.height * Math.max(1, l.repeat);
    return v;
  });
}

export function totalHeight(m: BuildingModel) {
  const v = levelViews(m);
  const last = v[v.length - 1];
  return last.elevation + last.height * last.repeat;
}

/** Store the live plan back into its level and bring another level into the live plan. */
export function switchLevel(m: BuildingModel, to: number): BuildingModel {
  if (!m.levels?.length || to < 0 || to >= m.levels.length) return m;
  const cur = m.activeLevel ?? 0;
  const levels: LevelPlan[] = m.levels.map((l, i) => (i === cur ? { ...l, walls: m.walls, openings: m.openings, rooms: m.rooms, furniture: m.furniture } : l));
  const t = levels[to];
  return { ...m, levels, activeLevel: to, walls: t.walls, openings: t.openings, rooms: t.rooms, furniture: t.furniture };
}

/** Floor label for humans: typical floors show their range. */
export function levelLabel(v: Pick<LevelView, 'name' | 'repeat' | 'index'>, all: LevelView[]) {
  if (v.repeat <= 1) return v.name;
  let first = 0;
  for (const l of all) {
    if (l.index === v.index) break;
    first += l.repeat;
  }
  return `${v.name} (floors ${first}-${first + v.repeat - 1})`;
}

const roomCache = new WeakMap<object, DerivedRoom[]>();
/** Rooms on every floor (the brief counts bedrooms upstairs too). */
export function allRooms(m: BuildingModel): DerivedRoom[] {
  const active = derive(m).rooms;
  if (!m.levels?.length) return active;
  const out = [...active];
  m.levels.forEach((l, i) => {
    if (i === (m.activeLevel ?? 0)) return;
    let rooms = roomCache.get(l);
    if (!rooms) {
      rooms = derive({ ...m, walls: l.walls, openings: l.openings, rooms: l.rooms, furniture: l.furniture, levels: undefined }).rooms;
      roomCache.set(l, rooms);
    }
    out.push(...rooms);
  });
  return out;
}
