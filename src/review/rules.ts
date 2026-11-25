/**
 * Calculated design review. Everything here is deterministic geometry and
 * topology — no AI. Interpretive feedback (concept, character, rationale) is
 * produced separately through Firebase AI Logic and labelled as such.
 */
import { derive, type Derived, type DerivedRoom } from '../model/derive';
import { allRooms } from '../model/levels';
import {
  add,
  convexOverlap,
  doorSwingPolygon,
  isRollerDoor,
  furnitureFootprint,
  mul,
  openingFrame,
  pointAlongWall,
  pointInPolygon,
  wallLength,
  wallNormal,
  bbox,
  noSwing,
} from '../model/geometry';
import { applyEdits, findFreeOffset } from '../model/edits';
import type { Brief, BuildingModel, EditOp, Finding, FindingCategory, FindingSeverity, Id, Overlay, Proposal, RoomType } from '../model/types';

type Draft = Omit<Finding, 'id' | 'status' | 'createdAt' | 'revision' | 'source' | 'kind'> & {
  kind?: Finding['kind'];
};

const PRIVATE: RoomType[] = ['bedroom', 'bathroom'];
const SOCIAL: RoomType[] = ['living', 'kitchen', 'dining'];
const HABITABLE: RoomType[] = ['bedroom', 'living', 'kitchen', 'dining', 'study'];
const CIRCULATION: RoomType[] = ['hall'];

const label = (r?: DerivedRoom) => (r ? `${r.name}` : 'outside');
const m2 = (n: number) => `${n.toFixed(1)} m²`;

function draft(
  ruleId: string,
  keyIds: string[],
  severity: FindingSeverity,
  category: FindingCategory,
  title: string,
  finding: string,
  evidenceText: string,
  elementIds: Id[],
  suggestion: string,
  overlays: Overlay[] = [],
  proposal?: Proposal,
): Draft {
  return {
    ruleId,
    fingerprint: `${ruleId}:${[...keyIds].sort().join(',')}`,
    severity,
    category,
    title,
    finding,
    evidence: { elementIds, text: evidenceText, overlays },
    suggestion,
    proposal,
  };
}

/** Accept a proposal only if geometry validation passes and it actually changes something. */
function validProposal(model: BuildingModel, p: Proposal | undefined): Proposal | undefined {
  if (!p) return undefined;
  const r = applyEdits(model, p.edits);
  return r.ok ? p : undefined;
}

// ---------------------------------------------------------------------------

function briefRules(model: BuildingModel, d: Derived, brief: Brief): Draft[] {
  const out: Draft[] = [];
  const minFor = (t: RoomType) => brief.requirements.find((q) => q.type === t)?.minArea ?? 0;
  const everyFloor = allRooms(model);
  for (const req of brief.requirements) {
    const matches = everyFloor.filter((r) => r.type === req.type || (req.type === 'kitchen' && r.type === 'dining'));
    if (matches.length < req.count) {
      const missing = req.count - matches.length;
      const surplus = d.rooms
        .map((r) => ({ r, s: r.area - minFor(r.type) }))
        .filter((x) => x.s > req.minArea)
        .sort((a, b) => b.s - a.s)[0];
      out.push(
        draft(
          'brief.missing',
          [req.id],
          'warning',
          'brief',
          `${req.label} ${missing === 1 && req.count === 1 ? 'is missing' : `(${missing} missing)`}`,
          `The brief asks for ${req.count} × ${req.label.toLowerCase()} (each at least ${req.minArea} m²). The plan has ${matches.length}.`,
          `Rooms marked as ${req.type}: ${matches.length ? matches.map((r) => r.name).join(', ') : 'none yet'}. If a room is there but named differently, select it and set its type.`,
          matches.map((r) => r.id),
          surplus
            ? `${surplus.r.name} is ${m2(surplus.r.area)}, ${m2(surplus.s)} above its own target, so it could give up space for the ${req.label.toLowerCase()}. Otherwise extend the plan.`
            : `Extend the plan or rebalance room sizes to accommodate the ${req.label.toLowerCase()}.`,
          surplus ? [{ kind: 'polygon', points: surplus.r.polygon }] : [],
        ),
      );
    }
    for (const r of matches.filter((x) => d.roomById.has(x.id))) {
      if (req.minArea > 0 && r.area + 0.05 < req.minArea) {
        const proposal = validProposal(model, growRoomProposal(model, d, r, req.minArea - r.area, minFor));
        out.push(
          draft(
            'brief.area',
            [r.id],
            'warning',
            'brief',
            `${r.name} is below the brief's area`,
            `${r.name} has ${m2(r.area)} of clear floor area; the brief asks for at least ${req.minArea} m².`,
            `Measured inside the walls: ${m2(r.area)} (${m2(r.grossArea)} to the middle of the walls).`,
            [r.id],
            proposal ? proposal.label + '.' : `Enlarge ${r.name} by about ${m2(req.minArea - r.area)}.`,
            [{ kind: 'polygon', points: r.polygon }],
            proposal,
          ),
        );
      }
    }
  }
  return out;
}

/** Move one shared interior wall so `room` gains `needed` m² without pushing its neighbour below its own target. */
function growRoomProposal(model: BuildingModel, d: Derived, room: DerivedRoom, needed: number, minFor: (t: RoomType) => number): Proposal | undefined {
  let best: { op: EditOp; cost: number; text: string } | undefined;
  for (const wallId of room.wallIds) {
    const w = model.walls.find((x) => x.id === wallId);
    if (!w || w.exterior) continue;
    const n = wallNormal(w);
    const mid = pointAlongWall(w, wallLength(w) / 2);
    const plusPt = add(mid, mul(n, w.thickness / 2 + 150));
    const minusPt = add(mid, mul(n, -(w.thickness / 2 + 150)));
    const sideOfRoom = pointInPolygon(plusPt, room.polygon) ? 1 : pointInPolygon(minusPt, room.polygon) ? -1 : 0;
    if (!sideOfRoom) continue;
    const neighbour = d.roomAt(sideOfRoom === 1 ? minusPt : plusPt);
    if (!neighbour) continue;
    const b = bbox(room.polygon);
    const along = Math.abs(n.x) > 0.5 ? b.h : b.w; // room extent parallel to the wall
    const distance = Math.ceil(((needed + 0.3) * 1e6) / along / 50) * 50;
    const neighbourAfter = neighbour.area - (distance * along) / 1e6;
    if (neighbourAfter < minFor(neighbour.type) + 0.2) continue;
    const op: EditOp = { op: 'moveWall', wallId, distance: -sideOfRoom * distance };
    const cost = distance + (minFor(neighbour.type) ? 0 : 500);
    if (!best || cost < best.cost) best = { op, cost, text: `Move wall ${wallId} ${distance} mm into ${neighbour.name}` };
  }
  return best ? { label: best.text, edits: [best.op], rationale: 'Worked out from the room areas. The neighbouring room stays above its own target.' } : undefined;
}

function privacyRules(model: BuildingModel, d: Derived, brief: Brief): Draft[] {
  const out: Draft[] = [];
  const wallById = new Map(model.walls.map((w) => [w.id, w]));
  const wantsPrivacy = brief.goals.includes('privacy');
  for (const o of model.openings) {
    if (o.kind === 'window') continue;
    const link = d.links.get(o.id);
    if (!link?.plus || !link.minus) continue;
    const a = d.roomById.get(link.plus)!;
    const b = d.roomById.get(link.minus)!;
    const priv = PRIVATE.includes(a.type) ? a : PRIVATE.includes(b.type) ? b : undefined;
    const soc = SOCIAL.includes(a.type) ? a : SOCIAL.includes(b.type) ? b : undefined;
    if (!priv || !soc || priv === soc) continue;
    // Proposal: re-hang the door on a wall the private room shares with a hall.
    let proposal: Proposal | undefined;
    for (const wallId of priv.wallIds) {
      const w = wallById.get(wallId);
      if (!w || w.exterior || wallId === o.wallId) continue;
      const n = wallNormal(w);
      // Find runs along the wall that are the private room on one side and circulation on the other.
      const L = wallLength(w);
      const runs: { s: number; e: number; other: DerivedRoom; privSide: 1 | -1 }[] = [];
      for (let s = 0; s <= L; s += 50) {
        const c = pointAlongWall(w, s);
        const pPlus = d.roomAt(add(c, mul(n, w.thickness / 2 + 150)));
        const pMinus = d.roomAt(add(c, mul(n, -(w.thickness / 2 + 150))));
        const privSide: 1 | -1 | 0 = pPlus?.id === priv.id ? 1 : pMinus?.id === priv.id ? -1 : 0;
        const other = privSide === 1 ? pMinus : privSide === -1 ? pPlus : undefined;
        const last = runs[runs.length - 1];
        if (!other || !CIRCULATION.includes(other.type) || !privSide) continue;
        if (last && last.other.id === other.id && s - last.e <= 50) last.e = s;
        else runs.push({ s, e: s, other, privSide });
      }
      runs.sort((x, y) => y.e - y.s - (x.e - x.s));
      for (const run of runs) {
        // Junctions and existing openings are avoided by findFreeOffset.
        const offset = findFreeOffset(model, wallId, o.width, (run.s + run.e) / 2, undefined, [run.s, run.e]);
        if (offset === null) continue;
        proposal = validProposal(model, {
          label: `Re-hang door ${o.id} on wall ${wallId} so ${priv.name} opens from the ${run.other.name.toLowerCase()}`,
          rationale: `${priv.name} would be entered from circulation instead of directly from the ${soc.name.toLowerCase()}.`,
          edits: [{ op: 'relocateOpening', openingId: o.id, wallId, offset, swing: run.privSide }],
        });
        if (proposal) break;
      }
      if (proposal) break;
    }
    const host = wallById.get(o.wallId)!;
    const f = openingFrame(o, host);
    out.push(
      draft(
        'privacy.direct-door',
        [o.id],
        wantsPrivacy ? 'warning' : 'advice',
        'privacy',
        `${priv.name} opens directly onto the ${soc.name.toLowerCase()}`,
        `Door ${o.id} connects ${priv.name} straight to the ${soc.name.toLowerCase()}${wantsPrivacy ? ', which conflicts with the brief’s privacy goal' : ''}.`,
        `${o.id} on wall ${o.wallId} links ${label(a)} and ${label(b)} with no intermediate circulation space.`,
        [o.id, priv.id, soc.id],
        proposal ? `${proposal.label}.` : `Consider entering ${priv.name} from a hall or lobby, or screening the doorway.`,
        [
          { kind: 'polyline', points: [f.start, f.end] },
          { kind: 'polygon', points: doorSwingPolygon(o, host) },
        ],
        proposal,
      ),
    );
  }
  return out;
}

function clearanceRules(model: BuildingModel, d: Derived): Draft[] {
  const out: Draft[] = [];
  const wallById = new Map(model.walls.map((w) => [w.id, w]));
  const doors = model.openings.filter((o) => o.kind === 'door' && !noSwing(o) && !isRollerDoor(o, model.spec?.type === 'industrial') && wallById.has(o.wallId));
  const swings = doors.map((o) => ({ o, poly: doorSwingPolygon(o, wallById.get(o.wallId)!) }));
  for (const { o, poly } of swings) {
    for (const f of model.furniture) {
      const fp = furnitureFootprint(f);
      const depth = convexOverlap(poly, fp);
      if (depth < 20) continue;
      const proposal = validProposal(model, relocateFurniture(model, d, f.id, swings.map((s) => s.poly)));
      out.push(
        draft(
          'clearance.door-swing',
          [o.id, f.id],
          'warning',
          'clearance',
          `The ${f.kind} overlaps door ${o.id}'s swing`,
          `${f.id} (${f.kind}) sits inside the arc swept by door ${o.id}, so the door cannot open fully.`,
          `Overlap of ${Math.round(depth)} mm between the ${o.width} mm door arc and the ${f.w} × ${f.d} mm ${f.kind} footprint.`,
          [o.id, f.id],
          proposal ? `${proposal.label}, or reconsider the door hinge.` : `Move the ${f.kind} or reconsider the door arrangement.`,
          [
            { kind: 'polygon', points: poly },
            { kind: 'polygon', points: fp },
          ],
          proposal,
        ),
      );
    }
  }
  for (let i = 0; i < swings.length; i++)
    for (let j = i + 1; j < swings.length; j++) {
      const depth = convexOverlap(swings[i].poly, swings[j].poly);
      if (depth < 30) continue;
      const a = swings[i].o;
      const b = swings[j].o;
      out.push(
        draft(
          'clearance.door-door',
          [a.id, b.id],
          'advice',
          'clearance',
          `Doors ${a.id} and ${b.id} clash`,
          `The swings of ${a.id} and ${b.id} overlap; opening both at once will collide.`,
          `Arc overlap ${Math.round(depth)} mm.`,
          [a.id, b.id],
          `Flip the hinge of one door or use a sliding door.`,
          [
            { kind: 'polygon', points: swings[i].poly },
            { kind: 'polygon', points: swings[j].poly },
          ],
          validProposal(model, { label: `Flip the hinge of ${b.id}`, edits: [{ op: 'setOpening', openingId: b.id, patch: { hinge: b.hinge === 'start' ? 'end' : 'start' } }] }),
        ),
      );
    }
  return out;
}

/** Slide a piece of furniture along its long axis to the nearest clear spot inside its room. */
function relocateFurniture(model: BuildingModel, d: Derived, furnitureId: Id, swingPolys: ReturnType<typeof doorSwingPolygon>[]): Proposal | undefined {
  const f = model.furniture.find((x) => x.id === furnitureId)!;
  const room = d.roomAt({ x: f.x, y: f.y });
  if (!room) return undefined;
  const r = (f.rotation * Math.PI) / 180;
  const axis = { x: Math.cos(r), y: Math.sin(r) };
  const others = model.furniture.filter((x) => x.id !== f.id).map(furnitureFootprint);
  for (let step = 100; step <= 3000; step += 100) {
    for (const sign of [-1, 1]) {
      const c = add({ x: f.x, y: f.y }, mul(axis, sign * step));
      const cand = { ...f, x: Math.round(c.x), y: Math.round(c.y) };
      const fp = furnitureFootprint(cand);
      if (!fp.every((p) => pointInPolygon(p, room.inner))) continue;
      if (swingPolys.some((s) => convexOverlap(s, fp) > 5)) continue;
      if (others.some((o) => convexOverlap(o, fp) > 5)) continue;
      return {
        label: `Slide the ${f.kind} ${f.id} ${step} mm along the wall`,
        rationale: 'The nearest spot in the room that is clear of doors and other furniture.',
        edits: [{ op: 'moveFurniture', furnitureId: f.id, x: cand.x, y: cand.y }],
      };
    }
  }
  return undefined;
}

function daylightRules(model: BuildingModel, d: Derived, brief: Brief): Draft[] {
  const out: Draft[] = [];
  const wallById = new Map(model.walls.map((w) => [w.id, w]));
  for (const r of d.rooms) {
    if (!HABITABLE.includes(r.type)) continue;
    const wins = model.openings.filter((o) => {
      if (o.kind !== 'window') return false;
      const l = d.links.get(o.id);
      return l && (l.plus === r.id || l.minus === r.id);
    });
    const glazed = wins.reduce((s, o) => s + (o.width * o.height) / 1e6, 0);
    const ratio = r.area > 0 ? glazed / r.area : 0;
    if (ratio >= 0.1) continue;
    // Proposal: widen the largest window, or add one on an exterior wall of the room.
    let proposal: Proposal | undefined;
    const target = (0.1 * r.area * 1e6) / (model.defaults.windowHead - model.defaults.windowSill);
    if (wins.length) {
      const big = [...wins].sort((a, b) => b.width - a.width)[0];
      const extra = Math.ceil((0.1 * r.area - glazed) * 1e6 / big.height / 50) * 50;
      proposal = validProposal(model, { label: `Widen window ${big.id} to ${big.width + extra} mm`, edits: [{ op: 'setOpening', openingId: big.id, patch: { width: big.width + extra } }] });
    } else {
      for (const wallId of r.wallIds) {
        const w = wallById.get(wallId);
        if (!w?.exterior) continue;
        const width = Math.min(2400, Math.ceil(target / 50) * 50);
        const off = findFreeOffset(model, wallId, width);
        if (off === null) continue;
        proposal = validProposal(model, {
          label: `Add a ${width} mm window to ${r.name} on wall ${wallId}`,
          edits: [
            {
              op: 'addOpening',
              opening: {
                id: `N${model.openings.length + 1}`,
                kind: 'window',
                wallId,
                offset: off,
                width,
                height: model.defaults.windowHead - model.defaults.windowSill,
                sill: model.defaults.windowSill,
                hinge: 'start',
                swing: 1,
                prov: { element: 'assumed' },
              },
            },
          ],
        });
        if (proposal) break;
      }
    }
    out.push(
      draft(
        'daylight.glazing-ratio',
        [r.id],
        wins.length === 0 ? 'warning' : brief.goals.includes('daylight') ? 'warning' : 'advice',
        'daylight',
        wins.length === 0 ? `${r.name} has no window` : `${r.name} may be under-lit`,
        `${r.name} has ${glazed.toFixed(1)} m² of glazing for ${m2(r.area)} of floor (${Math.round(ratio * 100)}%).`,
        `Window area compared with floor area. A common rule of thumb is at least 10%. This is a quick check, not a full daylight study.`,
        [r.id, ...wins.map((o) => o.id)],
        proposal ? `${proposal.label}.` : 'Add or enlarge windows on an exterior wall.',
        [{ kind: 'polygon', points: r.polygon }],
        proposal,
      ),
    );
  }
  return out;
}

function circulationRules(model: BuildingModel, d: Derived): Draft[] {
  const out: Draft[] = [];
  const wallById = new Map(model.walls.map((w) => [w.id, w]));
  const entrances = model.openings.filter((o) => o.kind === 'door' && wallById.get(o.wallId)?.exterior);
  if (!entrances.length && d.rooms.length) {
    out.push(
      draft('circulation.no-entrance', ['plan'], 'critical', 'circulation', 'No entrance door found', 'None of the exterior walls has a door.', 'Doors on exterior walls: 0.', [], 'Add an entrance door to an exterior wall.'),
    );
    return out;
  }
  const start = new Set<Id>();
  for (const e of entrances) {
    const l = d.links.get(e.id);
    if (l?.plus) start.add(l.plus);
    if (l?.minus) start.add(l.minus);
  }
  const seen = new Set(start);
  const queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of d.connections.get(id) ?? []) if (!seen.has(n)) seen.add(n), queue.push(n);
  }
  for (const r of d.rooms) {
    if (seen.has(r.id)) continue;
    out.push(
      draft(
        'circulation.unreachable',
        [r.id],
        'critical',
        'circulation',
        `${r.name} cannot be reached`,
        `There is no door or opening path from the entrance to ${r.name}.`,
        `Checked every route through doors from the front door (${entrances.map((e) => e.id).join(', ')}).`,
        [r.id],
        'Add a door between this room and an adjacent reachable room.',
        [{ kind: 'polygon', points: r.polygon }],
      ),
    );
  }
  // Narrow circulation spaces.
  for (const r of d.rooms.filter((x) => CIRCULATION.includes(x.type))) {
    const b = bbox(r.inner);
    const clear = Math.min(b.w, b.h);
    if (clear < 900)
      out.push(
        draft('circulation.narrow', [r.id], 'warning', 'accessibility', `${r.name} is narrow`, `${r.name} is ${Math.round(clear)} mm wide between wall faces.`, 'Narrowest width between the wall faces.', [r.id], 'Aim for at least 900 mm (1200 mm for wheelchair turning).', [{ kind: 'polygon', points: r.polygon }]),
      );
  }
  return out;
}

function accessibilityRules(model: BuildingModel): Draft[] {
  const out: Draft[] = [];
  for (const o of model.openings) {
    if (o.kind !== 'door' || o.width >= 800) continue;
    out.push(
      draft(
        'accessibility.door-width',
        [o.id],
        'advice',
        'accessibility',
        `Door ${o.id} is narrow`,
        `${o.id} is ${o.width} mm wide.`,
        'Compared with an 800 mm guide for step-free access. Local building rules may ask for more.',
        [o.id],
        'Use an 850–900 mm door where space allows.',
        [],
        validProposal(model, { label: `Widen ${o.id} to 850 mm`, edits: [{ op: 'setOpening', openingId: o.id, patch: { width: 850 } }] }),
      ),
    );
  }
  return out;
}

export function runRules(model: BuildingModel, brief: Brief): Draft[] {
  const d = derive(model);
  return [
    ...circulationRules(model, d),
    ...privacyRules(model, d, brief),
    ...clearanceRules(model, d),
    ...briefRules(model, d, brief),
    ...daylightRules(model, d, brief),
    ...accessibilityRules(model),
  ];
}

let seq = 0;
export const findingId = () => `FND-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Merge a fresh rule run into the stored findings:
 * - unchanged problems keep their id, status and history;
 * - problems that disappeared are marked resolved in this revision;
 * - interpretive (AI / person) findings that reference edited elements become outdated.
 */
export function reconcile(existing: Finding[], drafts: Draft[], revision: number, touched: Set<Id> = new Set()): Finding[] {
  const now = Date.now();
  const byFp = new Map(existing.filter((f) => f.source === 'rule').map((f) => [f.fingerprint, f]));
  const fresh = new Set(drafts.map((x) => x.fingerprint));
  const out: Finding[] = [];
  for (const f of existing) {
    if (f.source !== 'rule') {
      const stale = f.status === 'open' && f.evidence.elementIds.some((id) => touched.has(id));
      out.push(stale ? { ...f, status: 'outdated' } : f);
      continue;
    }
    if (!fresh.has(f.fingerprint)) {
      out.push(f.status === 'open' ? { ...f, status: 'resolved', resolvedInRevision: revision } : f);
    }
  }
  for (const dft of drafts) {
    const prev = byFp.get(dft.fingerprint);
    const status: Finding['status'] = prev ? (prev.status === 'resolved' || prev.status === 'outdated' ? 'open' : prev.status) : 'open';
    out.push({
      ...dft,
      kind: dft.kind ?? 'calculated',
      id: prev?.id ?? findingId(),
      source: 'rule',
      status,
      revision,
      createdAt: prev?.createdAt ?? now,
      resolvedInRevision: undefined,
    });
  }
  const order: Record<Finding['status'], number> = { open: 0, outdated: 1, resolved: 2, dismissed: 3 };
  const sev: Record<FindingSeverity, number> = { critical: 0, warning: 1, advice: 2, info: 3 };
  return out.sort((a, b) => order[a.status] - order[b.status] || sev[a.severity] - sev[b.severity] || a.createdAt - b.createdAt);
}


/** Grow a room by about `m2` square metres by moving one of its internal walls (validated). */
export function growRoomBy(model: BuildingModel, brief: Brief, roomId: Id, m2: number): Proposal | undefined {
  const d = derive(model);
  const room = d.roomById.get(roomId);
  if (!room) return undefined;
  const minFor = (t: RoomType) => brief.requirements.find((q) => q.type === t)?.minArea ?? 0;
  return validProposal(model, growRoomProposal(model, d, room, m2, minFor));
}
