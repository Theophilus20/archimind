/**
 * Doors and windows that open and close in the 3D model.
 *
 * - Everyone starts from the toolbar's "doors open" setting; clicking a door or window
 *   (or pressing E next to it, or walking into a closed door) overrides it.
 * - Overrides travel with your presence, so people walking through the model together
 *   see the same doors open and close (newest change wins).
 * - Scale figures open doors as they reach them and close them behind themselves.
 * - A door only opens as far as the room allows: if furniture or another wall is in
 *   the way, the leaf stops against it, which is exactly what a clash looks like.
 */
import { create } from 'zustand';
import type { BuildingModel, Id, Opening, Vec2, Wall } from '../model/types';
import { add, furnitureFootprint, isRollerDoor, mul, noSwing, norm, openingFrame, projectOnSegment, sub } from '../model/geometry';
import { wallSolids } from '../model/wallgeom';
import { useCollab, updatePresence } from '../collab/collab';

export type Toggle = { open: boolean; at: number };

interface DoorsState {
  /** The toolbar setting everyone starts from. */
  defaultOpen: boolean;
  /** My own changes. */
  mine: Record<Id, Toggle>;
  /** Doors held open by wandering figures (count of figures). */
  held: Record<Id, number>;
  setDefault: (open: boolean) => void;
  set: (id: Id, open: boolean) => void;
  hold: (id: Id, on: boolean) => void;
}

/** When I last opened or closed a door, by this computer's clock (for the hand-raise animation). */
let localChangeAt = 0;

export const useDoors = create<DoorsState>((set, get) => ({
  defaultOpen: true,
  mine: {},
  held: {},
  setDefault: (open) => {
    if (get().defaultOpen === open) return;
    set({ defaultOpen: open, mine: {} });
    updatePresence({ doors: {} });
  },
  set: (id, open) => {
    // Stamp the change later than any change already seen for this door. Computers' clocks differ,
    // so a plain Date.now() could lose to someone whose clock runs ahead and the door would not
    // respond; this way the latest click always wins, for everyone.
    let seen = get().mine[id]?.at ?? 0;
    for (const p of Object.values(useCollab.getState().presence)) seen = Math.max(seen, p.doors?.[id]?.at ?? 0);
    const mine = { ...get().mine, [id]: { open, at: Math.max(Date.now(), seen + 1) } };
    // A door you open or close yourself is no longer held open by a passing figure.
    localChangeAt = Date.now();
    set((s) => ({ mine, held: { ...s.held, [id]: 0 } }));
    updatePresence({ doors: mine });
  },
  hold: (id, on) => set((s) => ({ held: { ...s.held, [id]: Math.max(0, (s.held[id] ?? 0) + (on ? 1 : -1)) } })),
}));

/** Is this door or window open right now (my changes, other people's, figures, default)? */
export function isOpen(o: Pick<Opening, 'id' | 'kind'>): boolean {
  const { defaultOpen, mine, held } = useDoors.getState();
  if ((held[o.id] ?? 0) > 0) return true;
  let best: Toggle | undefined = mine[o.id];
  for (const p of Object.values(useCollab.getState().presence)) {
    const t = p.doors?.[o.id];
    if (t && (!best || t.at > best.at)) best = t;
  }
  if (best) return best.open;
  return o.kind === 'door' ? defaultOpen : false;
}

/**
 * How far a figure's hand is raised (0 to 1), ms after it opened or closed a door:
 * up over ~0.35 s, a short hold at the handle, back down by ~1.1 s.
 */
export function reachPulse(msSince: number): number {
  if (!(msSince >= 0) || msSince > 1100) return 0;
  const t = msSince / 1100;
  return Math.sin(Math.PI * Math.min(1, t * 1.4) ** 0.8) * (t < 0.55 ? 1 : 1 - (t - 0.55) / 0.45) ** 0.5;
}

/** When I last opened or closed a door myself (ms, Date.now()). */
export function myLastDoorChange(): number {
  return localChangeAt;
}

export function toggle(o: Pick<Opening, 'id' | 'kind'>) {
  useDoors.getState().set(o.id, !isOpen(o));
}

/** Current animated angle of each door leaf / window sash, radians (written by the 3D view). */
export const leafAngle = new Map<Id, number>();

export const DOOR_OPEN = (85 * Math.PI) / 180;
export const WINDOW_OPEN = (50 * Math.PI) / 180;

function segDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  // Distance between segments ab and cd (0 when they cross).
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(projectOnSegment(c, a, b).distance, projectOnSegment(d, a, b).distance, projectOnSegment(a, c, d).distance, projectOnSegment(b, c, d).distance);
}

export interface DoorLimit {
  /** Largest opening angle before the leaf hits something, radians. */
  max: number;
  /** What it hits, e.g. "the desk F4". */
  blocker?: string;
  blockerId?: Id;
}

const NAMES: Record<string, string> = { bed: 'bed', desk: 'desk', sofa: 'sofa', table: 'table', chair: 'chair', wardrobe: 'wardrobe', sideboard: 'sideboard', kitchen: 'kitchen units', bath: 'bath', wc: 'WC', basin: 'basin', tv: 'TV unit' };

/** The leaf of door `o` at angle `a`, from hinge to tip, in plan mm. */
export function leafAt(o: Opening, w: Wall, a: number): [Vec2, Vec2] {
  const f = openingFrame(o, w);
  const u = norm(sub(f.closedTip, f.hingePoint));
  const dir = add(mul(u, Math.cos(a)), mul(f.swingDir, Math.sin(a)));
  return [f.hingePoint, add(f.hingePoint, mul(dir, o.width - 20))];
}

/** How far every door can swing before hitting furniture or another wall. */
export function doorLimits(model: BuildingModel): Map<Id, DoorLimit> {
  const out = new Map<Id, DoorLimit>();
  const solids = wallSolids(model);
  // Desks include the chair pulled up to them (about 350 mm beyond the desk edge).
  const feet = model.furniture.map((f) => ({ f, poly: furnitureFootprint(f.kind === 'desk' ? { ...f, d: f.d + 700 } : f) }));
  for (const o of model.openings) {
    if (o.kind !== 'door' || noSwing(o) || isRollerDoor(o, model.spec?.type === 'industrial')) continue;
    const w = model.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    let max = DOOR_OPEN;
    let blocker: string | undefined;
    let blockerId: Id | undefined;
    const step = (2.5 * Math.PI) / 180;
    outer: for (let a = step; a <= DOOR_OPEN + 1e-6; a += step) {
      const [h, t] = leafAt(o, w, a);
      for (const { f, poly } of feet) {
        for (let i = 0; i < 4; i++) {
          if (segDist(h, t, poly[i], poly[(i + 1) % 4]) < 30) {
            max = a - step;
            blocker = `the ${NAMES[f.kind] ?? f.kind} ${f.id}`;
            blockerId = f.id;
            break outer;
          }
        }
      }
      for (const s of solids) {
        if (s.wall.id === w.id) continue;
        const d = norm(sub(s.wall.b, s.wall.a));
        for (const [sa, se] of s.spans) {
          const p = add(s.wall.a, mul(d, sa));
          const q = add(s.wall.a, mul(d, se));
          // Ignore the wall the hinge sits against (touching at the hinge is normal).
          if (projectOnSegment(h, p, q).distance < s.wall.thickness / 2 + 40) continue;
          if (segDist(h, t, p, q) < s.wall.thickness / 2 + 15) {
            max = a - step;
            blocker = `the wall ${s.wall.id}`;
            blockerId = s.wall.id;
            break outer;
          }
        }
      }
    }
    out.set(o.id, { max: Math.max(0, max), blocker: max < DOOR_OPEN - 1e-6 ? blocker : undefined, blockerId: max < DOOR_OPEN - 1e-6 ? blockerId : undefined });
  }
  return out;
}
