/**
 * Plain-English plan commands understood without a model ("make the kitchen bigger",
 * "move wall W6 300 mm", "add a desk to bedroom 2"). Used as the fallback for the
 * AI edit bar, so every result is still a validated, previewable structured edit.
 */
import { derive, type DerivedRoom } from '../model/derive';
import { applyEdits, findFreeOffset, nextId } from '../model/edits';
import { growRoomBy } from '../review/rules';
import { FURNITURE_SIZES } from '../studio/Plan2D';
import { pointInPolygon, bbox, doorSwingPolygon, convexOverlap, furnitureFootprint } from '../model/geometry';
import type { Brief, BuildingModel, EditOp, FurnitureKind, Proposal } from '../model/types';

const toMm = (n: number, unit?: string) => (unit === 'm' ? n * 1000 : unit === 'cm' ? n * 10 : n);

function findRoom(model: BuildingModel, text: string): DerivedRoom | undefined {
  const d = derive(model);
  const t = text.toLowerCase();
  const byId = t.match(/\br(\d+)\b/);
  if (byId) return d.roomById.get(`R${byId[1]}`);
  // longest room name mentioned wins ("bedroom 2" beats "bedroom")
  const named = d.rooms.filter((r) => t.includes(r.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
  if (named) return named;
  const aliases: [RegExp, string][] = [
    [/kitchen|dining/, 'kitchen'],
    [/living|lounge|sitting/, 'living'],
    [/bed ?room|bedroom/, 'bedroom'],
    [/bath|toilet|wc|shower/, 'bathroom'],
    [/hall|corridor|entry/, 'hall'],
    [/study|office/, 'study'],
  ];
  for (const [re, type] of aliases) if (re.test(t)) return d.rooms.find((r) => r.type === type || (type === 'kitchen' && r.type === 'dining'));
  return undefined;
}

export function parseCommand(model: BuildingModel, brief: Brief, text: string): Proposal | null {
  const t = text.trim();
  const valid = (p: Proposal | null | undefined) => (p && applyEdits(model, p.edits).ok ? p : null);
  let m: RegExpMatchArray | null;

  if ((m = t.match(/move\s+(?:the\s+)?(?:wall\s+)?(W\d+)\s+(?:by\s+)?(-?\d+(?:\.\d+)?)\s*(mm|cm|m)?/i))) {
    const dist = toMm(Number(m[2]), m[3]?.toLowerCase());
    return valid({ label: `Move wall ${m[1].toUpperCase()} by ${Math.round(dist)} mm`, edits: [{ op: 'moveWall', wallId: m[1].toUpperCase(), distance: Math.round(dist) }] });
  }
  if ((m = t.match(/(?:widen|make|set)\s+(?:the\s+)?(?:door\s+|window\s+)?([DNO]\d+)\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(mm|cm|m)?/i))) {
    const w = Math.round(toMm(Number(m[2]), m[3]?.toLowerCase()));
    return valid({ label: `Make ${m[1].toUpperCase()} ${w} mm wide`, edits: [{ op: 'setOpening', openingId: m[1].toUpperCase(), patch: { width: w } }] });
  }
  if ((m = t.match(/flip\s+(?:the\s+)?(?:door\s+)?(D\d+)/i))) {
    const o = model.openings.find((x) => x.id === m![1].toUpperCase());
    if (o) return valid({ label: `Flip the swing of ${o.id}`, edits: [{ op: 'setOpening', openingId: o.id, patch: { swing: (o.swing * -1) as 1 | -1 } }] });
  }
  if ((m = t.match(/rename\s+(.+?)\s+(?:to|as)\s+(.+)$/i))) {
    const r = findRoom(model, m[1]);
    if (r) return valid({ label: `Rename ${r.name} to ${m[2].trim()}`, edits: [{ op: 'setRoom', roomId: r.id, patch: { name: m[2].trim().replace(/["']/g, '') } }] });
  }
  if ((m = t.match(/(?:remove|delete)\s+(?:the\s+)?([FDNOW]\d+)/i))) {
    const id = m[1].toUpperCase();
    const op: EditOp | null = id.startsWith('F') ? { op: 'removeFurniture', furnitureId: id } : id.startsWith('W') ? { op: 'removeWall', wallId: id } : { op: 'removeOpening', openingId: id };
    return valid({ label: `Remove ${id}`, edits: [op] });
  }
  if (/\b(bigger|larger|enlarge|more space|extend|grow)\b/i.test(t)) {
    const r = findRoom(model, t);
    const amount = t.match(/(\d+(?:\.\d+)?)\s*(?:m2|m²|sq ?m|square metres?)/i);
    if (r) return valid(growRoomBy(model, brief, r.id, amount ? Number(amount[1]) : Math.max(1.5, r.area * 0.15)) ?? null);
  }
  if (/\badd\b.*\bwindow\b/i.test(t)) {
    const r = findRoom(model, t);
    if (r) {
      for (const wallId of r.wallIds) {
        const w = model.walls.find((x) => x.id === wallId);
        if (!w?.exterior) continue;
        const off = findFreeOffset(model, wallId, 1200);
        if (off === null) continue;
        return valid({
          label: `Add a 1.2 m window to ${r.name}`,
          edits: [{ op: 'addOpening', opening: { id: nextId(model, 'N'), kind: 'window', wallId, offset: off, width: 1200, height: model.defaults.windowHead - model.defaults.windowSill, sill: model.defaults.windowSill, hinge: 'start', swing: 1, prov: { element: 'confirmed' } } }],
        });
      }
    }
  }
  if ((m = t.match(/\badd\s+(?:a\s+|an\s+)?(bed|desk|chair|sofa|table|wardrobe|tv|bath|wc|toilet|basin|sink|kitchen)\b/i))) {
    const kind = ({ toilet: 'wc', sink: 'basin' } as Record<string, FurnitureKind>)[m[1].toLowerCase()] ?? (m[1].toLowerCase() as FurnitureKind);
    const r = findRoom(model, t.replace(m[0], ''));
    if (r) {
      const [w, dpt] = FURNITURE_SIZES[kind];
      const b = bbox(r.inner);
      // try a few spots inside the room, clear of the walls
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]]) {
        const c = { x: Math.round(b.minX + b.w * fx), y: Math.round(b.minY + b.h * fy) };
        const corners = [
          { x: c.x - w / 2, y: c.y - dpt / 2 },
          { x: c.x + w / 2, y: c.y + dpt / 2 },
        ];
        if (!corners.every((p) => pointInPolygon(p, r.inner))) continue;
        return valid({ label: `Add a ${kind} to ${r.name}`, edits: [{ op: 'addFurniture', furniture: { id: nextId(model, 'F'), kind, x: c.x, y: c.y, w, d: dpt, rotation: 0, prov: { element: 'confirmed' } } }] });
      }
    }
  }
  return null;
}

/** Find a clear spot for a piece of furniture inside a room: against a wall first, facing into the room. */
export function placeFurniture(model: BuildingModel, roomId: string, kind: FurnitureKind): EditOp | null {
  const r = derive(model).roomById.get(roomId);
  if (!r) return null;
  const [w, dpt] = FURNITURE_SIZES[kind];
  const b = bbox(r.inner);
  const gap = 40;
  const cands: { x: number; y: number; rot: number }[] = [];
  for (const t of [0.5, 0.3, 0.7, 0.2, 0.8]) {
    cands.push({ x: b.minX + b.w * t, y: b.minY + dpt / 2 + gap, rot: 0 }); // against the top wall
    cands.push({ x: b.minX + dpt / 2 + gap, y: b.minY + b.h * t, rot: -90 }); // left wall
    cands.push({ x: b.maxX - dpt / 2 - gap, y: b.minY + b.h * t, rot: 90 }); // right wall
    cands.push({ x: b.minX + b.w * t, y: b.maxY - dpt / 2 - gap, rot: 180 }); // bottom wall
  }
  cands.push({ x: b.minX + b.w / 2, y: b.minY + b.h / 2, rot: 0 });
  for (const c0 of cands) {
    const c = { x: Math.round(c0.x), y: Math.round(c0.y) };
    const [fw, fd] = Math.abs(c0.rot) === 90 ? [dpt, w] : [w, dpt];
    const corners = [
      { x: c.x - fw / 2, y: c.y - fd / 2 },
      { x: c.x + fw / 2, y: c.y - fd / 2 },
      { x: c.x + fw / 2, y: c.y + fd / 2 },
      { x: c.x - fw / 2, y: c.y + fd / 2 },
    ];
    if (!corners.every((q) => pointInPolygon(q, r.inner))) continue;
    const clash = model.furniture.some((f) => {
      const [ow, od] = Math.abs(f.rotation % 180) === 90 ? [f.d, f.w] : [f.w, f.d];
      return Math.abs(f.x - c.x) < (ow + fw) / 2 + 60 && Math.abs(f.y - c.y) < (od + fd) / 2 + 60;
    });
    if (clash) continue;
    const op: EditOp = { op: 'addFurniture', furniture: { id: nextId(model, 'F'), kind, x: c.x, y: c.y, w, d: dpt, rotation: c0.rot, prov: { element: 'confirmed' } } };
    // keep doorways clear: reject spots that the clearance rule would flag
    const after = applyEdits(model, [op]);
    if (!after.ok) continue;
    const blocksDoor = model.openings.some((o) => {
      if (o.kind !== 'door') return false;
      const wall = model.walls.find((x) => x.id === o.wallId);
      if (!wall) return false;
      const sw = doorSwingPolygon(o, wall);
      return convexOverlap(sw, furnitureFootprint({ x: c.x, y: c.y, w, d: dpt, rotation: c0.rot })) > 10;
    });
    if (blocksDoor) continue;
    return op;
  }
  return null;
}

/** Add a window of a given width on one of the room's outside walls, if there is room for it. */
export function addWindowToRoom(model: BuildingModel, roomId: string, width = 1200): EditOp | null {
  const r = derive(model).roomById.get(roomId);
  if (!r) return null;
  for (const wallId of r.wallIds) {
    const w = model.walls.find((x) => x.id === wallId);
    if (!w?.exterior) continue;
    const off = findFreeOffset(model, wallId, width);
    if (off === null) continue;
    return { op: 'addOpening', opening: { id: nextId(model, 'N'), kind: 'window', wallId, offset: off, width, height: model.defaults.windowHead - model.defaults.windowSill, sill: model.defaults.windowSill, hinge: 'start', swing: 1, prov: { element: 'confirmed' } } };
  }
  return null;
}
