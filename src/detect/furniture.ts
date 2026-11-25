/**
 * Furniture read from a drawing by AI: turn boxes measured across the image (0 to 1000) into
 * furniture in the model, at the drawing's scale, facing the usual way for each kind.
 */
import type { BuildingModel, Furniture, FurnitureKind, RoomType, Vec2 } from '../model/types';
import { bbox, furnitureFootprint, pointInPolygon, projectOnSegment } from '../model/geometry';
import { derive } from '../model/derive';

/** Kinds whose long side runs front to back (depth), unlike a sofa or a counter. */
const LONG_SIDE_IS_DEPTH = new Set<FurnitureKind>(['bed', 'wc']);
/** Kinds always wider (along the back) than they are deep. */
const WIDE = new Set<FurnitureKind>(['wardrobe', 'sideboard', 'tv', 'kitchen', 'sofa', 'desk', 'bath']);

export function furnitureFromBoxes(
  items: { kind: FurnitureKind; box: [number, number, number, number]; back?: 'top' | 'right' | 'bottom' | 'left'; alt?: FurnitureKind }[],
  imageW: number,
  imageH: number,
  toMm: (p: Vec2) => Vec2,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): Furniture[] {
  // `alt` (another reading of what it is) rides along for arrangeFurniture, which removes it
  const out: (Furniture & { alt?: FurnitureKind })[] = [];
  for (const it of items) {
    const [y0, x0, y1, x1] = it.box;
    const a = toMm({ x: (x0 / 1000) * imageW, y: (y0 / 1000) * imageH });
    const b = toMm({ x: (x1 / 1000) * imageW, y: (y1 / 1000) * imageH });
    const bw = Math.abs(b.x - a.x);
    const bh = Math.abs(b.y - a.y);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    // Too small or too big to be furniture at this scale, or outside the building.
    if (bw < 150 || bh < 150 || bw > 8000 || bh > 8000) continue;
    if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY) continue;
    // the side its back faces, read off the tile: the width runs along that side (unless that
    // makes a long piece deeper than it is wide, which means the side was misread)
    const across = it.back === 'top' || it.back === 'bottom';
    if (it.back && !(WIDE.has(it.kind) && (across ? bw : bh) < (across ? bh : bw) * 0.9)) {
      out.push({
        id: `F${out.length + 1}`,
        kind: it.kind,
        x: Math.round(cx),
        y: Math.round(cy),
        w: Math.round(across ? bw : bh),
        d: Math.round(across ? bh : bw),
        rotation: { top: 0, right: 90, bottom: 180, left: 270 }[it.back],
        prov: { position: 'detected', kind: 'detected', rotation: 'detected' },
        ...(it.alt ? { alt: it.alt } : {}),
      });
      continue;
    }
    const turn = bw >= bh === LONG_SIDE_IS_DEPTH.has(it.kind) && Math.abs(bw - bh) > 50;
    out.push({
      id: `F${out.length + 1}`,
      kind: it.kind,
      x: Math.round(cx),
      y: Math.round(cy),
      w: Math.round(turn ? bh : bw),
      d: Math.round(turn ? bw : bh),
      rotation: turn ? 90 : 0,
      prov: { position: 'detected', kind: 'detected' },
      ...(it.alt ? { alt: it.alt } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checking and arranging furniture
// ---------------------------------------------------------------------------

type Room = ReturnType<typeof derive>['rooms'][number];

/** What belongs in each kind of room (AI readings put a TV in a bathroom now and then). */
const ALLOWED: Record<RoomType, FurnitureKind[]> = {
  bedroom: ['bed', 'wardrobe', 'desk', 'chair', 'tv', 'plant', 'sofa', 'table', 'sideboard'],
  bathroom: ['wc', 'bath', 'basin', 'wardrobe'],
  kitchen: ['kitchen', 'table', 'chair', 'plant', 'basin'],
  dining: ['table', 'chair', 'plant', 'sofa', 'tv', 'sideboard', 'kitchen'],
  living: ['sofa', 'table', 'chair', 'tv', 'plant', 'desk', 'sideboard', 'stair', 'stair-l', 'stair-u', 'spiral'],
  study: ['desk', 'chair', 'wardrobe', 'sideboard', 'sofa', 'plant', 'tv', 'table'],
  hall: ['wardrobe', 'sideboard', 'plant', 'table', 'chair', 'stair', 'stair-l', 'stair-u', 'spiral'],
  utility: ['kitchen', 'basin', 'wardrobe'],
  garage: ['wardrobe', 'table'],
  other: [],
};
const HOME_KINDS: FurnitureKind[] = ['bed', 'desk', 'sofa', 'table', 'chair', 'wardrobe', 'sideboard', 'kitchen', 'bath', 'wc', 'basin', 'tv', 'plant', 'stair', 'stair-l', 'stair-u', 'spiral'];

/**
 * The kinds that belong in a room. A room without a name (or a porch) goes by what is in it:
 * a toilet or bath makes it a bathroom, a bed a bedroom, a worktop a kitchen.
 */
function allowedIn(room: Room, contents: Furniture[]): FurnitureKind[] {
  if (room.type !== 'other') return ALLOWED[room.type];
  const area = (ks: FurnitureKind[]) => contents.filter((f) => ks.includes(f.kind)).reduce((a, f) => a + f.w * f.d, 0);
  const wet = area(['wc', 'bath']);
  const bed = area(['bed']);
  if (wet > 0 && wet >= bed) return ALLOWED.bathroom;
  if (bed > 0) return ALLOWED.bedroom;
  if (area(['kitchen']) > 0) return [...ALLOWED.kitchen, ...ALLOWED.dining];
  return HOME_KINDS.filter((k) => k !== 'wc' && k !== 'bath' && k !== 'bed');
}

/** Usual sizes in mm, [width min, width max, depth min, depth max]; width runs along the back. */
const SIZE_RANGE: Partial<Record<FurnitureKind, [number, number, number, number]>> = {
  bed: [900, 2000, 1900, 2200],
  sofa: [1200, 3400, 750, 1000],
  table: [600, 2600, 600, 1200],
  chair: [400, 700, 400, 700],
  desk: [800, 2000, 500, 800],
  wardrobe: [500, 3200, 550, 650],
  sideboard: [500, 3200, 300, 550],
  kitchen: [600, 6000, 600, 1000],
  bath: [800, 1900, 700, 1200],
  wc: [350, 500, 600, 750],
  basin: [400, 1200, 350, 600],
  tv: [800, 2400, 300, 500],
  plant: [300, 800, 300, 800],
};
const clampSize = (f: Furniture): Furniture => {
  const r = SIZE_RANGE[f.kind];
  if (!r) return f;
  const lim = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)));
  return { ...f, w: lim(f.w, r[0], r[1]), d: lim(f.d, r[2], r[3]) };
};

/** Kinds that stand with their back to a wall: bedhead, sofa back, cistern, worktop, wardrobe. */
const AGAINST_WALL = new Set<FurnitureKind>(['bed', 'sofa', 'wardrobe', 'sideboard', 'kitchen', 'wc', 'bath', 'tv', 'desk', 'basin']);
/** When two pieces overlap, the first of these kinds stays. */
const PRIORITY: FurnitureKind[] = ['bed', 'kitchen', 'bath', 'wc', 'stair', 'sofa', 'wardrobe', 'table', 'desk', 'sideboard', 'tv', 'basin', 'chair', 'plant'];

const overlapArea = (a: Furniture, b: Furniture) => {
  const ra = bbox(furnitureFootprint(a));
  const rb = bbox(furnitureFootprint(b));
  const w = Math.min(ra.maxX, rb.maxX) - Math.max(ra.minX, rb.minX);
  const h = Math.min(ra.maxY, rb.maxY) - Math.max(ra.minY, rb.minY);
  return w > 0 && h > 0 ? w * h : 0;
};

const distToPolygon = (p: Vec2, poly: Vec2[]) => {
  if (pointInPolygon(p, poly)) return 0;
  return Math.min(...poly.map((a, i) => projectOnSegment(p, a, poly[(i + 1) % poly.length]).distance));
};

/** Move a piece so it sits wholly inside the room (when it fits), keeping it as close as it was. */
function keepInside(f: Furniture, room: Room): Furniture {
  const rb = bbox(room.inner);
  const fb = bbox(furnitureFootprint(f));
  let dx = 0;
  let dy = 0;
  if (fb.w <= rb.w) dx = fb.minX < rb.minX ? rb.minX - fb.minX + 10 : fb.maxX > rb.maxX ? rb.maxX - fb.maxX - 10 : 0;
  if (fb.h <= rb.h) dy = fb.minY < rb.minY ? rb.minY - fb.minY + 10 : fb.maxY > rb.maxY ? rb.maxY - fb.maxY - 10 : 0;
  if (!dx && !dy) return f;
  const g = { ...f, x: Math.round(f.x + dx), y: Math.round(f.y + dy) };
  return pointInPolygon(g, room.polygon) ? g : f;
}

/**
 * Put a piece back against the nearest wall of its room, its back to the wall and its front to
 * the room. `turn` lets it turn to face a wall on the other axis (the studio's button); without
 * it the piece keeps the way it faces (furniture read from a drawing already faces right).
 * Returns null when no wall of the room is within reach.
 */
export function backToWall(model: BuildingModel, f: Furniture, opts: { reach?: number; turn?: boolean; room?: Room; keepSide?: boolean } = {}): Furniture | null {
  const room = opts.room ?? derive(model).roomAt({ x: f.x, y: f.y });
  if (!room) return null;
  const reach = opts.reach ?? 900;
  const solid = new Map(model.walls.filter((w) => w.kind !== 'railing' && w.kind !== 'column').map((w) => [w.id, w]));
  const r = (f.rotation * Math.PI) / 180;
  const facingY = Math.abs(Math.cos(r)) >= Math.abs(Math.sin(r));
  const axes: ('x' | 'y')[] = opts.turn ? ['x', 'y'] : [facingY ? 'y' : 'x'];
  let best: { gap: number; face: number; side: -1 | 1; axis: 'x' | 'y' } | null = null;
  for (const axis of axes) {
    for (const id of room.wallIds) {
      const w = solid.get(id);
      if (!w) continue;
      const along = axis === 'y' ? Math.abs(w.a.y - w.b.y) < 1 : Math.abs(w.a.x - w.b.x) < 1;
      if (!along) continue;
      const c = axis === 'y' ? w.a.y : w.a.x;
      const lo = axis === 'y' ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
      const hi = axis === 'y' ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
      const at = axis === 'y' ? f.x : f.y;
      if (at < lo || at > hi) continue;
      const centre = axis === 'y' ? f.y : f.x;
      // the wall is on the smaller-coordinate side (-1) or the larger one (+1)
      const side: -1 | 1 = c < centre ? -1 : 1;
      // known back side: only a wall behind it (rotation 0 = back up, 90 right, 180 down, 270 left)
      if (opts.keepSide && side !== (Math.round(f.rotation) % 360 === 0 || Math.round(f.rotation) % 360 === 270 ? -1 : 1)) continue;
      const face = c - side * (w.thickness / 2);
      const gap = side === -1 ? centre - f.d / 2 - face : face - (centre + f.d / 2);
      if (Math.abs(gap) < reach && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { gap, face, side, axis };
    }
  }
  if (!best) return null;
  const centre = Math.round(best.face - best.side * (f.d / 2 + 15));
  // Back to the wall: rotation 0 puts the back up (-y), 90 right, 180 down, 270 left.
  const rotation = best.axis === 'y' ? (best.side === -1 ? 0 : 180) : best.side === -1 ? 270 : 90;
  return keepInside({ ...f, rotation, ...(best.axis === 'y' ? { y: centre } : { x: centre }) }, room);
}

/**
 * Make furniture read from a drawing sit the way furniture does:
 *  1. each piece in a room where it belongs (a TV read inside a toilet goes to the room next door
 *     if it belongs there and is within reach, or is left out), at a usual size;
 *  2. chairs drawn round a table are left to the table (the table comes with its chairs);
 *  3. anything that stands against a wall moved back to the nearest wall, facing the room;
 *  4. worktop pieces along the same wall joined into one run;
 *  5. no two pieces on top of each other.
 */
export function arrangeFurniture(model: BuildingModel, input: (Furniture & { alt?: FurnitureKind })[]): Furniture[] {
  const d = derive(model);
  // The same plain cabinet symbol is a wardrobe in a bedroom but a sideboard, shelves or a TV
  // console in a living or dining room.
  // first readings for what cannot be in the room, then drop the extra field
  const items = input.map(({ alt, ...f }) => {
    const room = d.roomAt({ x: f.x, y: f.y });
    return alt && room && !ALLOWED[room.type].includes(f.kind) && ALLOWED[room.type].includes(alt) ? { ...f, kind: alt } : f;
  });
  const first = items.flatMap((f) => {
    const room = d.roomAt({ x: f.x, y: f.y });
    let g = f;
    // the plain cabinet symbol again: a long one in a bedroom is a wardrobe
    if (f.kind === 'sideboard' && room?.type === 'bedroom' && Math.max(f.w, f.d) >= 1400) g = { ...g, kind: 'wardrobe' };
    if (f.kind === 'wardrobe' && room && (room.type === 'living' || room.type === 'dining')) g = { ...f, kind: 'sideboard' };
    // a sink in a kitchen or laundry is part of the worktop
    if (f.kind === 'basin' && room && (room.type === 'kitchen' || room.type === 'utility')) g = { ...g, kind: 'kitchen' };
    // a dining table drawn with its chairs: the table itself (the model draws the chairs round it)
    if (g.kind === 'table' && Math.min(g.w, g.d) > 1200) g = { ...g, w: Math.max(800, g.w - 700), d: Math.max(700, g.d - 700) };
    // far bigger than any piece of its kind: a misreading (an outline of floor, not furniture)
    const r = SIZE_RANGE[g.kind];
    if (r && (g.w > r[1] * 1.6 || g.d > r[3] * 1.6)) return [];
    return [{ f: clampSize(g), room }];
  });
  const contents = new Map<string, Furniture[]>();
  for (const { f, room } of first) if (room) contents.set(room.id, [...(contents.get(room.id) ?? []), f]);
  const allowed = new Map(d.rooms.map((r) => [r.id, allowedIn(r, contents.get(r.id) ?? [])]));
  const fits = (f: Furniture, room: Room) => {
    if (!allowed.get(room.id)!.includes(f.kind)) return false;
    if (f.kind === 'table' && room.type === 'bedroom' && Math.max(f.w, f.d) > 800) return false;
    // no bigger than the room (a worktop or wardrobe may run wall to wall)
    const rb = bbox(room.inner);
    return Math.max(f.w, f.d) <= Math.max(rb.w, rb.h) + 20 && Math.min(f.w, f.d) <= Math.min(rb.w, rb.h) + 20;
  };
  // 1. in a room where it belongs
  let list: { f: Furniture; room: Room }[] = first.flatMap(({ f, room }) => {
    if (room && fits(f, room)) return [{ f: keepInside(f, room), room }];
    // read just over the line: the nearest room it belongs in, if close
    const near = d.rooms
      .filter((r) => r.id !== room?.id && fits(f, r))
      .map((r) => ({ r, dist: distToPolygon(f, r.inner) }))
      .filter((x) => x.dist < 700)
      .sort((a, b) => a.dist - b.dist)[0];
    if (!near) return [];
    const rb = bbox(near.r.inner);
    const moved = keepInside({ ...f, x: Math.round(Math.min(rb.maxX, Math.max(rb.minX, f.x))), y: Math.round(Math.min(rb.maxY, Math.max(rb.minY, f.y))) }, near.r);
    return pointInPolygon(moved, near.r.polygon) ? [{ f: moved, room: near.r }] : [];
  });
  // 2. chairs drawn round a table are part of the table
  list = list.filter(({ f, room }) => {
    if (f.kind !== 'chair') return true;
    return !list.some((o) => o.f.kind === 'table' && o.room.id === room.id && Math.hypot(o.f.x - f.x, o.f.y - f.y) < Math.max(o.f.w, o.f.d) / 2 + 900);
  });
  // 3. against a wall, back to it
  // (a back side read off the drawing is kept when there is a wall behind it; otherwise the
  // nearest wall on that axis decides)
  const placed = list.map(({ f, room }) => ({
    f: (AGAINST_WALL.has(f.kind) && ((f.prov.rotation === 'detected' && backToWall(model, f, { room, keepSide: true })) || backToWall(model, f, { room }))) || f,
    room,
  }));
  // 4. worktop pieces along the same wall become one run
  let merged: { f: Furniture; room: Room }[] = [];
  for (const it of placed) {
    const alongX = it.f.rotation === 0 || it.f.rotation === 180;
    const run =
      it.f.kind === 'kitchen' &&
      merged.find(
        (m) =>
          m.f.kind === 'kitchen' &&
          m.room.id === it.room.id &&
          m.f.rotation === it.f.rotation &&
          (alongX ? Math.abs(m.f.y - it.f.y) < 150 : Math.abs(m.f.x - it.f.x) < 150) &&
          (alongX ? Math.abs(m.f.x - it.f.x) : Math.abs(m.f.y - it.f.y)) < (m.f.w + it.f.w) / 2 + 400,
      );
    if (!run) {
      merged.push(it);
      continue;
    }
    const lo = (f: Furniture) => (alongX ? f.x : f.y) - f.w / 2;
    const hi = (f: Furniture) => (alongX ? f.x : f.y) + f.w / 2;
    const a0 = Math.min(lo(run.f), lo(it.f));
    const a1 = Math.max(hi(run.f), hi(it.f));
    run.f = { ...run.f, w: Math.round(a1 - a0), ...(alongX ? { x: Math.round((a0 + a1) / 2) } : { y: Math.round((a0 + a1) / 2) }) };
  }
  // Where the drawing's own worktop lines were found (runs K1, K2…), a long worktop the AI read
  // elsewhere in the room is not drawn there: keep only its small pieces (a fridge, a machine).
  const withRuns = new Set(merged.filter((m) => m.f.kind === 'kitchen' && m.f.id.startsWith('K')).map((m) => m.room.id));
  merged = merged.filter((m) => !(m.f.kind === 'kitchen' && !m.f.id.startsWith('K') && withRuns.has(m.room.id) && m.f.w > 1000));
  // 5. no two pieces on top of each other
  const rank = (k: FurnitureKind) => (PRIORITY.indexOf(k) + PRIORITY.length + 1) % (PRIORITY.length + 1);
  const ranked = [...merged].sort((a, b) => rank(a.f.kind) - rank(b.f.kind));
  const kept: Furniture[] = [];
  for (const { f } of ranked) {
    if (kept.some((k) => overlapArea(k, f) > 0.3 * Math.min(f.w * f.d, k.w * k.d))) continue;
    kept.push(f);
  }
  return kept.map((f, i) => ({ ...f, id: `F${i + 1}` }));
}

/**
 * Worktop runs drawn on the plan: in kitchens and utility rooms, the front edge of a worktop is a
 * line parallel to a wall, 450 to 750 mm out from it. Follow that line along each wall (on the
 * drawing itself, through `ink`, which says whether a point in mm is drawn) and return a kitchen
 * run for each one at least 900 mm long. Runs on two walls that meet make an L: the first goes
 * into the corner and the second stops at its front edge. AI tends to box only the sink and hob.
 */
export function worktopRuns(model: BuildingModel, ink: (p: Vec2) => boolean, step = 20): Furniture[] {
  const d = derive(model);
  const solid = new Map(model.walls.filter((w) => w.kind !== 'railing' && w.kind !== 'column').map((w) => [w.id, w]));
  const out: Furniture[] = [];
  for (const room of d.rooms) {
    if (room.type !== 'kitchen' && room.type !== 'utility') continue;
    const rb = bbox(room.inner);
    type Run = { horiz: boolean; side: 1 | -1; face: number; depth: number; a0: number; a1: number; lo: number; hi: number };
    const runs: Run[] = [];
    for (const id of room.wallIds) {
      const w = solid.get(id);
      if (!w) continue;
      const horiz = Math.abs(w.a.y - w.b.y) < 1;
      if (!horiz && Math.abs(w.a.x - w.b.x) >= 1) continue;
      const c = horiz ? w.a.y : w.a.x;
      const side: 1 | -1 = c < (horiz ? (rb.minY + rb.maxY) / 2 : (rb.minX + rb.maxX) / 2) ? 1 : -1; // into the room
      const face = c + (side * w.thickness) / 2;
      const lo = Math.max(horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y), horiz ? rb.minX : rb.minY);
      const hi = Math.min(horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y), horiz ? rb.maxX : rb.maxY);
      const roomDepth = horiz ? rb.h : rb.w;
      if (hi - lo < 900) continue;
      const at = (across: number, along: number) => ink(horiz ? { x: along, y: across } : { x: across, y: along });
      const longest = (across: number) => {
        let best: { a0: number; a1: number } | null = null;
        let start = -1;
        let last = -Infinity;
        for (let a = lo + 40; a <= hi - 40; a += step) {
          if (!at(across, a)) continue;
          if (a - last > 3 * step) start = a;
          last = a;
          if (!best || last - start > best.a1 - best.a0) best = { a0: start, a1: last };
        }
        return best;
      };
      // the depth where the longest line runs (the middle of it, as a drawn line has some width)
      let found: { depth: number; a0: number; a1: number } | null = null;
      let depthEnd = 0;
      for (let depth = 450; depth <= Math.min(750, roomDepth - 700); depth += step) {
        const run = longest(face + side * depth);
        if (!run || run.a1 - run.a0 < 900) continue;
        // the front edge is a thin line, not the edge of a filled band such as another wall
        let filled = 0;
        let n = 0;
        for (let a = run.a0; a <= run.a1; a += step * 2) {
          n++;
          if (at(face + side * (depth + 120), a)) filled++;
        }
        if (filled / Math.max(1, n) > 0.6) continue;
        const len = run.a1 - run.a0;
        if (!found || len > found.a1 - found.a0 + step) {
          found = { depth, ...run };
          depthEnd = depth;
        } else if (Math.abs(len - (found.a1 - found.a0)) <= step && depth - depthEnd <= step) depthEnd = depth;
      }
      if (!found) continue;
      const depth = Math.round((found.depth + depthEnd) / 2 / 10) * 10;
      // a run that ends near a side wall goes up to it (an L's corner, or a worktop wall to wall)
      runs.push({ horiz, side, face, depth, a0: found.a0 - lo < 800 ? lo : found.a0, a1: hi - found.a1 < 800 ? hi : found.a1, lo, hi });
    }
    // two runs meeting in a corner: the later one stops at the earlier one's front edge
    const rectOf = (r: Run) => {
      const b0 = r.face;
      const b1 = r.face + r.side * r.depth;
      const [c0, c1] = [Math.min(b0, b1), Math.max(b0, b1)];
      return r.horiz ? { minX: r.a0, maxX: r.a1, minY: c0, maxY: c1 } : { minX: c0, maxX: c1, minY: r.a0, maxY: r.a1 };
    };
    runs.forEach((r, k) => {
      for (const q of runs.slice(0, k)) {
        if (q.horiz === r.horiz) continue;
        const a = rectOf(q);
        const b = rectOf(r);
        if (a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY) continue;
        const [qa0, qa1] = r.horiz ? [a.minX, a.maxX] : [a.minY, a.maxY];
        if (qa0 - r.a0 < r.a1 - qa1) r.a0 = Math.max(r.a0, qa1);
        else r.a1 = Math.min(r.a1, qa0);
      }
    });
    for (const r of runs) {
      if (r.a1 - r.a0 < 600) continue;
      const across = Math.round(r.face + (r.side * r.depth) / 2);
      const mid = Math.round((r.a0 + r.a1) / 2);
      // Back to the wall: rotation 0 puts the back up (-y), 90 right, 180 down, 270 left.
      const rotation = r.horiz ? (r.side === 1 ? 0 : 180) : r.side === 1 ? 270 : 90;
      out.push({ id: `K${out.length + 1}`, kind: 'kitchen', x: r.horiz ? mid : across, y: r.horiz ? across : mid, w: Math.round(r.a1 - r.a0), d: r.depth, rotation, prov: { position: 'detected', kind: 'detected' } });
    }
  }
  return out;
}
