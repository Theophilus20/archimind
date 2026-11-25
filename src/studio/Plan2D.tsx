import { chairsPerSide, coffeeTableIds } from '../model/furnish';
import { DOOR_TYPES, doorLabel, doorPatch, type DoorType } from '../model/doortypes';
import { edgeOf, porchOps, type PorchKind } from '../model/porchtool';
import { pillarOp, pillarType, type ColumnStyle } from '../model/pillars';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../state/store';
import { derive } from '../model/derive';
import { applyEdit, nextId } from '../model/edits';
import { spanEnds, wallSolids } from '../model/wallgeom';
import { deleteElements, dimensionsOnLevel, elementsInBox, splitWall } from '../model/edittools';
import { drawBus, useAids, useDrawing } from './aids';
import { PlanDims, UserDimension } from './PlanDims';
import {
  add,
  dist,
  doorSwingPolygon,
  isRollerDoor,
  isDoubleDoor,
  doorLeaves,
  dot,
  furnitureFootprint,
  mul,
  pointInPolygon,
  openingFrame,
  pointAlongWall,
  projectOnSegment,
  sub,
  wallDir,
  wallLength,
  wallPolygon,
  wallNormal,
  bbox,
} from '../model/geometry';
import { elementCenter, elementsBounds, modelBounds } from '../model/elements';
import type { BuildingModel, EditOp, FurnitureKind, Id, Overlay, PlanMark, RoomType, Vec2, Wall } from '../model/types';
import { roofShape } from '../model/roof';

/** Cut walls share one fill and one outline, as on a construction drawing. */
const WALL_FILL = '#454b52';
/** Drawing style: cut walls in solid black, as on a construction drawing. */
const DRAW_WALL = '#141516';
const WALL_OUTLINE = '#15181b';

/**
 * The outline of one solid stretch of wall. Spans come from wallSolids, which already makes clean
 * joins (at a corner one wall runs through and the other stops at its face; at a T the wall stops
 * at its host's face), so nothing overshoots.
 */
function wallSpanPolygon(w: Wall, s0: number, e0: number, solid?: Parameters<typeof spanEnds>[0]): Vec2[] {
  const dir = wallDir(w);
  const n = mul(wallNormal(w), w.thickness / 2);
  // Mitred corners and angled T-junctions: each face has its own start and end.
  const { sL, sR, eL, eR } = solid ? spanEnds(solid, s0, e0) : { sL: s0, sR: s0, eL: e0, eR: e0 };
  return [add(add(w.a, mul(dir, sL)), n), add(add(w.a, mul(dir, eL)), n), sub(add(w.a, mul(dir, eR)), n), sub(add(w.a, mul(dir, sR)), n)];
}

export type PlanTool = 'select' | 'wall' | 'door' | 'window' | 'furniture' | 'porch' | 'pillar' | 'measure' | 'split' | 'erase' | 'dimension';

/** Default footprints (mm) for furniture placed from the library. */
export const FURNITURE_SIZES: Record<FurnitureKind, [number, number]> = {
  bed: [1600, 2000],
  desk: [1200, 600],
  chair: [500, 500],
  sofa: [2200, 900],
  table: [1600, 900],
  wardrobe: [1800, 600],
  sideboard: [1600, 450],
  kitchen: [2400, 600],
  bath: [1700, 750],
  wc: [400, 650],
  basin: [500, 400],
  tv: [1600, 400],
  workstation: [1600, 800],
  meeting: [3000, 1200],
  counter: [3000, 800],
  machine: [3000, 1800],
  conveyor: [6000, 900],
  rack: [5400, 1100],
  stair: [1000, 3600],
  'stair-l': [2400, 3000],
  'stair-u': [2100, 3000],
  spiral: [1600, 1600],
  lift: [2000, 2000],
  plant: [800, 800],
};

export interface Pin {
  id: string;
  elementId: Id;
  label: string;
  kind: 'finding' | 'message';
  tone: 'critical' | 'warning' | 'advice' | 'info' | 'message';
  onClick: () => void;
}

export type MarkTool = 'pin' | 'area' | 'pen' | 'line' | 'arrow' | 'text' | 'wall' | 'door' | 'window' | 'remove' | 'eraser';

/** A crit mark shown on the plan, numbered like the comment it belongs to. */
export interface ShownMark {
  id: string;
  n: number;
  mark: PlanMark;
  label: string;
  active?: boolean;
  resolved?: boolean;
  onClick: () => void;
  /** Set when the eraser may remove this mark. */
  onErase?: () => void;
}

interface Props {
  model: BuildingModel;
  /** Crit mark-up: draw a pin, an area or a freehand line instead of editing. */
  markTool?: MarkTool | null;
  markColor?: string;
  onMark?: (m: PlanMark) => void;
  marks?: ShownMark[];
  draftMark?: PlanMark | null;
  ghost?: BuildingModel | null;
  /** Touch screens: each tap adds to the selection (there is no Shift key). */
  multiSelect?: boolean;
  previewIds?: Set<Id>;
  overlays?: Overlay[];
  pins?: Pin[];
  editable?: boolean;
  showUnderlay?: boolean;
  showFurniture?: boolean;
  tool?: PlanTool;
  onToolUsed?: () => void;
  highlight?: Set<Id>;
  furnitureKind?: FurnitureKind;
  /** The kind of door the door tool places. */
  doorType?: DoorType;
  /** The kind of porch the porch tool adds. */
  porchKind?: PorchKind;
  /** The kind of pillar the pillar tool stands up. */
  pillarStyle?: ColumnStyle;
  showRoof?: boolean;
}

export const ROOM_FILL: Record<RoomType, string> = {
  bedroom: '#e8f0fe',
  bathroom: '#e4f7fb',
  living: '#fef7e0',
  kitchen: '#fde9e3',
  dining: '#fde9e3',
  hall: '#f1f3f4',
  study: '#f3e8fd',
  utility: '#eef1f4',
  garage: '#eceff1',
  other: '#f8f9fa',
};

const TONE: Record<Pin['tone'], string> = { critical: '#d93025', warning: '#e37400', advice: '#1a73e8', info: '#5f6368', message: '#7b1fa2' };

type Drag =
  | { kind: 'pan'; start: { x: number; y: number }; view: View; keep?: boolean }
  | { kind: 'wall'; id: Id; start: Vec2; normal: Vec2; value: number }
  | { kind: 'opening'; id: Id; wall: Wall; startOffset: number; start: Vec2; value: number }
  | { kind: 'furniture'; id: Id; start: Vec2; origin: Vec2; value: Vec2 }
  /** Turning a piece of furniture by its round handle. */
  | { kind: 'turn'; id: Id; centre: Vec2; startAngle: number; origin: number; value: number }
  /** Window (left to right) or crossing (right to left) selection box, as in drafting programs. */
  | { kind: 'box'; start: Vec2; cur: Vec2; additive: boolean; roomId?: Id };

interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

const snap = (n: number, step: number) => Math.round(n / step) * step;

export function Plan2D({ model, ghost, multiSelect = false, previewIds, overlays = [], pins = [], editable = true, showUnderlay = true, showFurniture = true, tool = 'select', onToolUsed, highlight, furnitureKind = 'bed', doorType = 'hinged', porchKind = 'porch', pillarStyle = 'square', showRoof = false, markTool = null, markColor = '#d93025', onMark, marks = [], draftMark = null }: Props) {
  const marking = useRef<{ kind: Exclude<MarkTool, 'eraser'>; points: Vec2[] } | null>(null);
  const [liveMark, setLiveMark] = useState<PlanMark | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const selection = useStudio((s) => s.selection);
  const hoverRaw = useStudio((s) => s.hover);
  const hover = markTool ? null : hoverRaw;
  const focus = useStudio((s) => s.focus);
  const select = useStudio((s) => s.select);
  const setHover = useStudio((s) => s.setHover);
  const edit = useStudio((s) => s.edit);

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [wallStart, setWallStart] = useState<Vec2 | null>(null);
  const aids = useAids();
  const [measure, setMeasure] = useState<{ a: Vec2; b: Vec2 | null } | null>(null);
  /** Dimension being placed: first point, then second point, then the offset of its line. */
  const [dimDraft, setDimDraft] = useState<{ a: Vec2; b: Vec2 | null } | null>(null);
  useEffect(() => {
    if (tool !== 'measure') setMeasure(null);
    if (tool !== 'dimension') setDimDraft(null);
    if (tool !== 'wall') {
      setWallStart(null);
      chainStart.current = null;
      chainPts.current = [];
      setChain(null);
    }
    // Placing a dimension while they are hidden would make it vanish: show them.
    if (tool === 'dimension' && !useAids.getState().dims) useAids.getState().toggle('dims');
  }, [tool]);
  // Hiding dimensions drops them from the selection, so Delete never removes something you can't see.
  useEffect(() => {
    if (aids.dims) return;
    const sel = useStudio.getState().selection;
    const keep = sel.filter((id) => !(model.dimensions ?? []).some((d) => d.id === id));
    if (keep.length !== sel.length) select(keep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aids.dims]);
  const moved = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; view: View; mid: Vec2 } | null>(null);

  // Resize observer
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(
    (b: { minX: number; minY: number; w: number; h: number }, pad = 0.12) => {
      // A hidden plan measures 0 × 0; assume a usual shape until it is shown.
      const aspect = size.w > 0 && size.h > 0 ? size.w / size.h : 4 / 3;
      let w = b.w * (1 + pad * 2);
      let h = b.h * (1 + pad * 2);
      if (w / h > aspect) h = w / aspect;
      else w = h * aspect;
      setView({ x: b.minX + b.w / 2 - w / 2, y: b.minY + b.h / 2 - h / 2, w, h });
    },
    [size.w, size.h],
  );

  // Fit on first layout and when the model changes identity drastically.
  const modelKey = model.id + (model.source?.url.length ?? 0);
  useEffect(() => {
    // Leave room above and to the left for the dimension strings of the drawing style.
    const b = modelBounds(model);
    const room = useAids.getState().planStyle !== 'colour' ? Math.max(b.w, b.h) * 0.2 + 1200 : 0;
    fit({ minX: b.minX - room, minY: b.minY - room, w: b.w + room, h: b.h + room });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, size.w > 0 && size.h > 0 ? Math.round(size.w / 50) : 0]);

  // Focus requests from findings, messages and the 3D view.
  useEffect(() => {
    if (!focus || !focus.ids.length) return;
    const b = elementsBounds(model, focus.ids);
    if (!b) return;
    const minSpan = 4000;
    const w = Math.max(b.w, minSpan);
    const h = Math.max(b.h, minSpan);
    fit({ minX: b.minX - (w - b.w) / 2, minY: b.minY - (h - b.h) / 2, w, h }, 0.25);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const k = view ? view.w / Math.max(1, size.w) : 10; // mm per screen px
  const coffee = useMemo(() => coffeeTableIds(model), [model]);

  // Live model while dragging (applies the edit without committing it).
  const liveOp: EditOp | null = useMemo(() => {
    if (!drag) return null;
    if (drag.kind === 'wall' && Math.abs(drag.value) >= 1) return { op: 'moveWall', wallId: drag.id, distance: drag.value };
    if (drag.kind === 'opening' && Math.abs(drag.value - drag.startOffset) >= 1) return { op: 'setOpening', openingId: drag.id, patch: { offset: drag.value } };
    if (drag.kind === 'furniture' && dist(drag.value, drag.origin) >= 1) return { op: 'moveFurniture', furnitureId: drag.id, x: drag.value.x, y: drag.value.y };
    if (drag.kind === 'turn' && drag.value !== drag.origin) {
      const f = model.furniture.find((x) => x.id === drag.id);
      if (f) return { op: 'moveFurniture', furnitureId: drag.id, x: f.x, y: f.y, rotation: drag.value };
    }
    return null;
  }, [drag, model]);
  const shown = useMemo(() => {
    if (!liveOp) return model;
    try {
      return applyEdit(model, liveOp);
    } catch {
      return model;
    }
  }, [model, liveOp]);

  const d = derive(shown);
  const solids = wallSolids(shown);
  const sel = new Set(selection);

  const toPlan = (e: { clientX: number; clientY: number }): Vec2 => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };

  const nearestWall = (p: Vec2, maxDist: number) => {
    let best: { w: Wall; along: number; d: number } | null = null;
    for (const w of shown.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.distance < maxDist && (!best || pr.distance < best.d)) best = { w, along: pr.along, d: pr.distance };
    }
    return best;
  };

  /**
   * Object snapping: wall endpoints, then midpoints, then the nearest point on a wall line
   * (OSNAP, F3), otherwise a 50 mm grid (SNAP, F9). Returns the point and what it snapped to.
   */
  const snapInfo = (p: Vec2): { p: Vec2; kind: 'end' | 'mid' | 'near' | 'grid' | 'free' } => {
    const aids = useAids.getState();
    if (aids.osnap) {
      let end: { q: Vec2; d: number } | null = null;
      for (const w of shown.walls)
        for (const e of [w.a, w.b]) {
          const d = dist(e, p);
          if (d < 16 * k && (!end || d < end.d)) end = { q: { ...e }, d };
        }
      if (end) return { p: end.q, kind: 'end' };
      for (const w of shown.walls) {
        const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
        if (dist(m, p) < 11 * k) return { p: { x: Math.round(m.x), y: Math.round(m.y) }, kind: 'mid' };
      }
      let near: { w: Wall; along: number; d: number } | null = null;
      for (const w of shown.walls) {
        const pr = projectOnSegment(p, w.a, w.b);
        const band = Math.max(w.thickness / 2 + 4 * k, 10 * k);
        if (pr.distance < band && (!near || pr.distance < near.d)) near = { w, along: pr.along, d: pr.distance };
      }
      if (near) {
        const along = aids.snap ? Math.round(near.along / 50) * 50 : Math.round(near.along);
        const q = pointAlongWall(near.w, Math.min(Math.max(along, 0), wallLength(near.w)));
        return { p: { x: Math.round(q.x), y: Math.round(q.y) }, kind: 'near' };
      }
    }
    return aids.snap ? { p: { x: snap(p.x, 50), y: snap(p.y, 50) }, kind: 'grid' } : { p: { x: Math.round(p.x), y: Math.round(p.y) }, kind: 'free' };
  };
  const snapPoint = (p: Vec2): Vec2 => snapInfo(p).p;
  /** ORTHO (F8): keep a wall straight across or up and down from its start; Shift flips it for one point. */
  const shiftRef = useRef(false);
  const orthoFrom = (from: Vec2, q: Vec2): Vec2 => {
    const on = useAids.getState().ortho !== shiftRef.current;
    if (!on) return q;
    return Math.abs(q.x - from.x) >= Math.abs(q.y - from.y) ? { x: q.x, y: from.y } : { x: from.x, y: q.y };
  };
  /** Where a wall being drawn would end for the pointer at p. */
  const wallEnd = (from: Vec2, p: Vec2) => {
    const sn = snapInfo(p);
    const q = orthoFrom(from, sn.p);
    return { p: q, kind: q.x === sn.p.x && q.y === sn.p.y ? sn.kind : ('free' as const) };
  };
  const chainStart = useRef<Vec2 | null>(null);
  /** Points placed in the chain being drawn, starting with its first point. */
  const chainPts = useRef<Vec2[]>([]);
  const setChain = useDrawing((s) => s.setChain);
  /** The selection box, kept in a ref too so fast drags never read a stale state. */
  const boxRef = useRef<{ start: Vec2; cur: Vec2; additive: boolean; roomId?: Id } | null>(null);
  const startBox = (b: { start: Vec2; cur: Vec2; additive: boolean; roomId?: Id }) => {
    boxRef.current = b;
    setDrag({ kind: 'box', ...b });
  };
  const spaceHeld = useRef(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target as HTMLElement)?.closest?.('input,textarea')) spaceHeld.current = true;
      if (e.key === 'Shift') shiftRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false;
      if (e.key === 'Shift') shiftRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // --- Pointer handlers -----------------------------------------------------

  const onWheel = (e: React.WheelEvent) => {
    if (!view) return;
    const p = toPlan(e);
    const f = Math.exp(e.deltaY * 0.0012);
    const w = Math.min(Math.max(view.w * f, 1500), 200000);
    const h = (w / view.w) * view.h;
    setView({ x: p.x - ((p.x - view.x) / view.w) * w, y: p.y - ((p.y - view.y) / view.h) * h, w, h });
  };

  const startElementDrag = (e: React.PointerEvent, id: Id, kind: 'wall' | 'opening' | 'furniture' | 'room' | 'dimension') => {
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceHeld.current)) return; // pan instead
    if (tool === 'erase') {
      // ERASE: click things to delete them (rooms are made by walls, so drag a box over walls instead).
      if (kind === 'room' || !editable) return;
      e.stopPropagation();
      const ops = deleteElements(model, [id]);
      if (typeof ops !== 'string') edit(ops, `Erase ${id}`);
      return;
    }
    if (kind === 'dimension') {
      if (tool !== 'select') return;
      e.stopPropagation();
      const adding = e.shiftKey || multiSelect;
      if (adding && sel.has(id)) select([...sel].filter((x) => x !== id));
      else select([id], adding);
      return;
    }
    if (tool !== 'select') return;
    e.stopPropagation();
    moved.current = false;
    const adding = e.shiftKey || multiSelect;
    if (adding && sel.has(id)) select([...sel].filter((x) => x !== id));
    else if (!sel.has(id) || adding) select([id], adding);
    if (kind === 'room' && e.pointerType === 'mouse' && view && e.shiftKey) {
      // Shift+drag across rooms draws a selection box (a click still selects the room).
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const p0 = toPlan(e);
      startBox({ start: p0, cur: p0, additive: e.ctrlKey || e.metaKey, roomId: id });
      return;
    }
    if (!editable || kind === 'room') {
      // Rooms fill most of the plan: dragging on them moves the view (a click still selects).
      if (!view) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, view, keep: true });
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toPlan(e);
    if (kind === 'wall') {
      const w = model.walls.find((x) => x.id === id)!;
      setDrag({ kind: 'wall', id, start: p, normal: wallNormal(w), value: 0 });
    } else if (kind === 'opening') {
      const o = model.openings.find((x) => x.id === id)!;
      const w = model.walls.find((x) => x.id === o.wallId)!;
      setDrag({ kind: 'opening', id, wall: w, startOffset: o.offset, start: p, value: o.offset });
    } else {
      const f = model.furniture.find((x) => x.id === id)!;
      setDrag({ kind: 'furniture', id, start: p, origin: { x: f.x, y: f.y }, value: { x: f.x, y: f.y } });
    }
  };

  /** Add a wall from the current start to `end`; drawing continues from its end (Esc or right-click stops). */
  const placeWall = (end: Vec2) => {
    if (!wallStart) return;
    if (dist(end, wallStart) <= 200) return;
    const id = nextId(model, 'W');
    // Wall type, as in BIM tools: carry on the type of a wall this one continues end to end; a
    // wall starting from the middle of another is a partition; the first outline on an empty
    // plan is the outside of the building.
    const endJoin = (q: Vec2) => model.walls.find((x) => dist(x.a, q) < 20 || dist(x.b, q) < 20);
    const onBody = (q: Vec2) => model.walls.some((x) => dist(projectOnSegment(q, x.a, x.b).point, q) < x.thickness / 2 + 10);
    const ref = endJoin(wallStart) ?? endJoin(end);
    const outside = ref ? ref.exterior : !onBody(wallStart) && !onBody(end) && !model.walls.some((x) => x.exterior);
    const tallest = model.walls.reduce((h, x) => Math.max(h, x.height), model.defaults.wallHeight);
    const r = edit(
      [{ op: 'addWall', wall: { id, a: wallStart, b: end, thickness: ref?.thickness ?? (outside ? model.defaults.exteriorThickness : model.defaults.interiorThickness), height: ref?.height ?? tallest, materialId: ref?.materialId ?? (outside ? 'render' : 'plaster'), exterior: outside, prov: { geometry: 'confirmed', height: ref ? 'confirmed' : 'assumed' } } }],
      `Add wall ${id}`,
    );
    if (!r.ok) return;
    select([id]);
    chainPts.current.push(end);
    // Back at the first point: the outline is closed, so the chain ends.
    if (chainStart.current && dist(end, chainStart.current) < 5) endChain();
    else {
      setWallStart(end);
      setChain(chainPts.current.length - 1);
    }
  };
  /** Signed distance of p from the line a→b, on the same side convention as UserDimension. */
  const dimOffset = (a: Vec2, b: Vec2, p: Vec2) => {
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return Math.round(((p.x - a.x) * -(b.y - a.y) + (p.y - a.y) * (b.x - a.x)) / L);
  };
  const endChain = () => {
    setWallStart(null);
    chainStart.current = null;
    chainPts.current = [];
    setChain(null);
  };
  /** Take back the last wall of the chain and carry on drawing from where it started. */
  const undoSegment = () => {
    if (chainPts.current.length <= 1) return endChain();
    useStudio.getState().undo();
    chainPts.current.pop();
    setWallStart(chainPts.current[chainPts.current.length - 1]);
    setChain(chainPts.current.length - 1);
  };
  // Typed lengths and "finish" from the command line.
  const placeRef = useRef<(m: { type: string; value?: number }) => void>(() => {});
  placeRef.current = (m) => {
    if (m.type === 'finish') {
      setDimDraft(null);
      return endChain();
    }
    if (m.type === 'undoSegment') return undoSegment();
    if (m.type === 'close') {
      if (chainStart.current && chainPts.current.length >= 3) placeWall(chainStart.current);
      return;
    }
    if (m.type === 'cancel') {
      // Remove every wall of this chain, as if it was never started.
      for (let i = 1; i < chainPts.current.length; i++) useStudio.getState().undo();
      return endChain();
    }
    if (m.type !== 'length' || tool !== 'wall' || !wallStart || !m.value) return;
    const towards = cursor ? orthoFrom(wallStart, snapPoint(cursor)) : { x: wallStart.x + 1, y: wallStart.y };
    const d = sub(towards, wallStart);
    const L = Math.hypot(d.x, d.y) || 1;
    placeWall({ x: Math.round(wallStart.x + (d.x / L) * m.value), y: Math.round(wallStart.y + (d.y / L) * m.value) });
  };
  useEffect(() => drawBus.listen((m) => placeRef.current(m)), []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return;
    const p = toPlan(e);
    shiftRef.current = e.shiftKey;
    // Middle or right button, or Space held: pan (as in drafting programs). Right-click also finishes a chain of walls.
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceHeld.current)) {
      if (e.button === 2 && tool === 'wall' && wallStart) return endChain();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      moved.current = false;
      setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, view, keep: true });
      return;
    }
    if (tool === 'wall') {
      if (!wallStart) {
        const s0 = snapPoint(p);
        setWallStart(s0);
        chainStart.current = s0;
        chainPts.current = [s0];
        setChain(0);
      } else placeWall(wallEnd(wallStart, p).p);
      return;
    }
    if (tool === 'split') {
      const near = nearestWall(p, 30 * k);
      if (near) {
        const ops = splitWall(model, near.w.id, Math.round(near.along / 50) * 50);
        if (typeof ops === 'string') useStudio.getState().toast(ops, 'error');
        else if (edit(ops, `Split wall ${near.w.id}`).ok) select([]);
      }
      onToolUsed?.();
      return;
    }
    if (tool === 'dimension') {
      if (!dimDraft) setDimDraft({ a: snapPoint(p), b: null });
      else if (!dimDraft.b) {
        const q = wallEnd(dimDraft.a, p).p;
        if (dist(q, dimDraft.a) > 20) setDimDraft({ a: dimDraft.a, b: q });
      } else {
        const id = nextId(model, 'DIM');
        // a third click right on the measured line still gets a readable gap
        const offset = dimOffset(dimDraft.a, dimDraft.b, p) || 600;
        const level = model.levels?.length ? { level: model.activeLevel ?? 0 } : {};
        if (edit([{ op: 'addDimension', dimension: { id, a: dimDraft.a, b: dimDraft.b, offset, ...level } }], `Add dimension ${id}`).ok) select([id]);
        setDimDraft(null);
      }
      return;
    }
    if (tool === 'pillar') {
      const op = pillarOp(model, { x: snap(p.x, 50), y: snap(p.y, 50) }, pillarStyle);
      const res = edit([op], `Add ${pillarType(pillarStyle).label.toLowerCase()}`);
      if (res.ok && op.op === 'addWall') select([op.wall.id]);
      onToolUsed?.();
      return;
    }
    if (tool === 'porch') {
      // a porch of the chosen kind against the outside wall nearest the click
      const r = porchOps(model, p, porchKind);
      if (typeof r === 'string') {
        useStudio.getState().toast(r, 'info');
        return;
      }
      const res = edit(r.ops, `Add ${r.label.toLowerCase()}`);
      if (res.ok) {
        const room = derive(res.model).rooms.find((x) => x.porchKind && pointInPolygon(p, x.polygon)) ?? derive(res.model).rooms.find((x) => x.porchKind === porchKind);
        if (room) select([room.id]);
      }
      onToolUsed?.();
      return;
    }
    if (tool === 'measure') {
      const q = snapPoint(p);
      setMeasure((m) => (!m || m.b ? { a: q, b: null } : { ...m, b: q }));
      return;
    }
    if (tool === 'furniture') {
      const [w, dpt] = FURNITURE_SIZES[furnitureKind];
      const id = nextId(model, 'F');
      const r = edit([{ op: 'addFurniture', furniture: { id, kind: furnitureKind, x: snap(p.x, 50), y: snap(p.y, 50), w, d: dpt, rotation: 0, prov: { element: 'confirmed' } } }], `Add ${furnitureKind} ${id}`);
      if (r.ok) select([id]);
      onToolUsed?.();
      return;
    }
    if (tool === 'door' || tool === 'window') {
      const near = nearestWall(p, 30 * k);
      if (near) {
        // the door tool places the chosen kind of door (or an open passage)
        const type = tool === 'window' ? 'window' : doorType;
        const { kind, style } = doorPatch(type);
        const L = wallLength(near.w);
        const width = Math.min(tool === 'window' ? 1200 : DOOR_TYPES.find((t) => t.type === doorType)!.width, L - 200);
        const offset = Math.min(Math.max(snap(near.along, 50), width / 2 + 50), L - width / 2 - 50);
        const id = nextId(model, kind === 'door' ? 'D' : kind === 'window' ? 'N' : 'O');
        const side = dot(sub(p, pointAlongWall(near.w, offset)), wallNormal(near.w)) >= 0 ? 1 : -1;
        const r = edit(
          [
            {
              op: 'addOpening',
              opening: {
                id,
                kind,
                ...(style ? { style } : {}),
                wallId: near.w.id,
                offset,
                width,
                height: kind === 'window' ? model.defaults.windowHead - model.defaults.windowSill : kind === 'opening' ? Math.min(near.w.height - 100, model.defaults.doorHeight + 300) : model.defaults.doorHeight,
                sill: kind === 'window' ? model.defaults.windowSill : 0,
                hinge: 'start',
                swing: side as 1 | -1,
                prov: { element: 'confirmed', height: 'assumed' },
              },
            },
          ],
          `Add ${doorLabel(type).toLowerCase()} ${id}`,
        );
        if (r.ok) select([id]);
        onToolUsed?.();
      }
      return;
    }
    // Background: hold and drag to move the plan. Shift+drag draws a selection box (window to the
    // right, crossing to the left); with the Erase tool a drag box erases what it covers.
    (e.target as Element).setPointerCapture?.(e.pointerId);
    moved.current = false;
    if (e.pointerType === 'mouse' && (tool === 'erase' || (tool === 'select' && e.shiftKey))) {
      startBox({ start: p, cur: p, additive: e.ctrlKey || e.metaKey });
      return;
    }
    setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, view });
  };

  // Two-finger pinch zoom (touch), tracked in the capture phase so it works over elements too.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (markTool === 'eraser') {
      if (!view || e.button !== 0) return;
      // Erase the nearest of your marks under the pointer (independent of drawing order).
      const p = toPlan(e);
      let best: { m: ShownMark; d: number } | null = null;
      for (const m of marks) {
        if (!m.onErase) continue;
        const d = markDistance(m.mark, p, k);
        if (d < 16 * k && (!best || d < best.d)) best = { m, d };
      }
      if (best) {
        e.stopPropagation();
        best.m.onErase!();
      }
      return;
    }
    if (markTool && view && e.button === 0) {
      e.stopPropagation();
      const p = toPlan(e);
      if (markTool === 'text') {
        onMark?.({ kind: 'text', points: [p], color: markColor, text: '' });
        return;
      }
      if (markTool === 'door' || markTool === 'window') {
        const near = nearestWall(p, 40 * k);
        if (!near) return;
        const on = projectOnSegment(p, near.w.a, near.w.b).point;
        const dir = wallDir(near.w);
        onMark?.({ kind: markTool, points: [on, add(on, mul(dir, markTool === 'door' ? 450 : 600))], color: markColor, elementId: near.w.id });
        return;
      }
      if (markTool === 'remove') {
        const furn = shown.furniture.find((f) => pointInPolygon(p, furnitureFootprint(f)));
        const opening = shown.openings.find((o) => {
          const w = shown.walls.find((x) => x.id === o.wallId);
          return w ? projectOnSegment(p, openingFrame(o, w).start, openingFrame(o, w).end).distance < 18 * k : false;
        });
        const target = furn?.id ?? opening?.id ?? nearestWall(p, 20 * k)?.w.id;
        if (!target) return;
        onMark?.({ kind: 'remove', points: [p], color: markColor, elementId: target });
        return;
      }
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const start = markTool === 'wall' ? snapPoint(p) : p;
      marking.current = { kind: markTool, points: [start] };
      setLiveMark({ kind: markTool, points: [start], color: markColor });
      return;
    }
    if (e.pointerType !== 'touch' || !view) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), view, mid: toPlan({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }) };
      setDrag(null);
    }
  };
  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (marking.current) {
      const p = toPlan(e);
      const m = marking.current;
      if (m.kind === 'area') m.points = [m.points[0], p];
      else if (m.kind === 'line' || m.kind === 'arrow' || m.kind === 'wall') {
        const a = m.points[0];
        let q = m.kind === 'wall' ? snapPoint(p) : p;
        const dx = q.x - a.x;
        const dy = q.y - a.y;
        if (Math.abs(dx) < Math.abs(dy) * 0.2) q = { x: a.x, y: q.y };
        else if (Math.abs(dy) < Math.abs(dx) * 0.2) q = { x: q.x, y: a.y };
        m.points = [a, q];
      }
      else if (m.kind === 'pen') {
        const last = m.points[m.points.length - 1];
        if (dist(last, p) > 5 * k) m.points.push(p);
      }
      setLiveMark({ kind: m.kind, points: [...m.points], color: markColor });
      return;
    }
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const f = pinch.current.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const v0 = pinch.current.view;
      const w = Math.min(Math.max(v0.w * f, 1500), 200000);
      const h = (w / v0.w) * v0.h;
      const m = pinch.current.mid;
      setView({ x: m.x - ((m.x - v0.x) / v0.w) * w, y: m.y - ((m.y - v0.y) / v0.h) * h, w, h });
      return;
    }
    const p = toPlan(e);
    shiftRef.current = e.shiftKey;
    setCursor(p);
    if (boxRef.current) {
      boxRef.current = { ...boxRef.current, cur: p };
      setDrag({ kind: 'box', ...boxRef.current });
      return;
    }
    if (!drag) return;
    moved.current = true;
    if (drag.kind === 'pan') {
      const dx = (e.clientX - drag.start.x) * (drag.view.w / size.w);
      const dy = (e.clientY - drag.start.y) * (drag.view.h / size.h);
      setView({ ...drag.view, x: drag.view.x - dx, y: drag.view.y - dy });
    } else if (drag.kind === 'wall') {
      const raw = dot(sub(p, drag.start), drag.normal);
      setDrag({ ...drag, value: snap(raw, e.altKey ? 10 : 50) });
    } else if (drag.kind === 'opening') {
      const dir = wallDir(drag.wall);
      const raw = drag.startOffset + dot(sub(p, drag.start), dir);
      setDrag({ ...drag, value: snap(raw, e.altKey ? 10 : 50) });
    } else if (drag.kind === 'furniture') {
      const delta = sub(p, drag.start);
      const step = e.altKey ? 10 : 50;
      setDrag({ ...drag, value: { x: snap(drag.origin.x + delta.x, step), y: snap(drag.origin.y + delta.y, step) } });
    } else if (drag.kind === 'turn') {
      // 15 degree steps (Alt for any angle), the way the handle is pulled round the centre
      const a = (Math.atan2(p.y - drag.centre.y, p.x - drag.centre.x) * 180) / Math.PI;
      const raw = drag.origin + a - drag.startAngle;
      setDrag({ ...drag, value: ((snap(raw, e.altKey ? 1 : 15) % 360) + 360) % 360 });
    }
  };

  const onPointerUp = (e?: React.PointerEvent) => {
    if (marking.current) {
      const m = marking.current;
      marking.current = null;
      setLiveMark(null);
      // A tiny drag becomes a pin; so does a very short scribble.
      const span = m.points.length > 1 ? dist(m.points[0], m.points[m.points.length - 1]) : 0;
      if ((m.kind === 'line' || m.kind === 'arrow' || m.kind === 'wall') && span > 12 * k) onMark?.({ kind: m.kind, points: m.points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })), color: markColor });
      else if (m.kind === 'line' || m.kind === 'arrow' || m.kind === 'wall') return;
      else if (m.kind === 'area' && span > 12 * k) onMark?.({ kind: 'area', points: m.points, color: markColor });
      else if (m.kind === 'pen' && m.points.length > 2) onMark?.({ kind: 'pen', points: simplifyPath(m.points, 3 * k), color: markColor });
      else onMark?.({ kind: 'pin', points: [m.points[0]], color: markColor });
      return;
    }
    if (e) endPointer(e);
    const box = boxRef.current;
    boxRef.current = null;
    if (box) {
      const span = Math.hypot(box.cur.x - box.start.x, box.cur.y - box.start.y);
      if (span > 6 * k) {
        const ids = elementsInBox(shown, box.start, box.cur, box.cur.x < box.start.x, aids.dims);
        if (tool === 'erase') {
          const ops = deleteElements(model, ids);
          if (typeof ops !== 'string') edit(ops, `Erase ${ids.length} items`);
        } else select(ids, box.additive);
      } else if (!box.roomId && !box.additive && tool === 'select') select([]);
      setDrag(null);
      return;
    }
    if (drag?.kind === 'pan' && !drag.keep && !moved.current && tool === 'select') select([]);
    if (liveOp) edit([liveOp]);
    setDrag(null);
  };

  if (!view) return <svg ref={svgRef} className="plan-svg" />;

  const fs = 12 * k;
  const gridOn = aids.grid;
  /** Construction-drawing look: black cut walls (poché), white rooms, thin symbols, dimensions. */
  const drafting = aids.planStyle !== 'colour';
  const wallFill = drafting ? DRAW_WALL : WALL_FILL;
  const isSel = (id: Id) => sel.has(id);
  const isHi = (id: Id) => highlight?.has(id) || previewIds?.has(id);
  const stroke = (px: number) => px * k;

  return (
    <svg
      ref={svgRef}
      className="plan-svg"
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onContextMenu={(e) => e.preventDefault()}
      onDoubleClick={() => tool === 'wall' && endChain()}
      style={{ cursor: markTool ? 'crosshair' : drag?.kind === 'pan' ? 'grabbing' : tool === 'erase' ? 'not-allowed' : tool !== 'select' ? (tool === 'furniture' ? 'copy' : 'crosshair') : 'grab' }}
      aria-label="Floor plan editor"
    >
      <defs>
        <pattern id="grid" width={1000} height={1000} patternUnits="userSpaceOnUse">
          <path d="M 1000 0 L 0 0 0 1000" fill="none" stroke={drafting ? '#eef0f2' : '#e3e6ea'} strokeWidth={stroke(1)} />
        </pattern>
        <pattern id="hatch" width={120} height={120} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="120" stroke="#f9ab00" strokeWidth={30} strokeOpacity={0.35} />
        </pattern>
      </defs>
      <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill={gridOn ? 'url(#grid)' : '#fbfbfa'} />

      {showUnderlay && shown.source?.url && (
        <image
          href={shown.source.url}
          x={shown.source.origin.x}
          y={shown.source.origin.y}
          width={shown.source.widthPx * shown.source.mmPerPx}
          height={shown.source.heightPx * shown.source.mmPerPx}
          opacity={0.28}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* The floor below, faint, as a guide for walls and the stair */}
      {!!model.levels?.length && (model.activeLevel ?? 0) > 0 && (
        <g style={{ pointerEvents: 'none' }} opacity={0.5}>
          {model.levels[(model.activeLevel ?? 0) - 1].walls.map((w) => (
            <polygon key={`lb${w.id}`} points={wallPolygon(w).map((p) => `${p.x},${p.y}`).join(' ')} fill={w.kind === 'railing' ? 'none' : '#c5cdd8'} stroke="#9aa6b5" strokeWidth={stroke(0.6)} strokeDasharray={w.kind === 'railing' ? `${stroke(3)} ${stroke(2)}` : undefined} />
          ))}
          {model.levels[(model.activeLevel ?? 0) - 1].furniture
            .filter((f) => f.kind === 'stair' || f.kind === 'stair-l' || f.kind === 'stair-u' || f.kind === 'spiral')
            .map((f) => (
              <g key={`ls${f.id}`}>
                <polygon points={furnitureFootprint(f).map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#5f6f85" strokeWidth={stroke(1)} strokeDasharray={`${stroke(5)} ${stroke(3)}`} />
                <FurnitureGlyph f={f} k={k} />
              </g>
            ))}
        </g>
      )}

      {/* Rooms */}
      {d.rooms.map((r) => (
        <g key={r.id} onPointerDown={(e) => startElementDrag(e, r.id, 'room')} onPointerEnter={() => setHover(r.id)} onPointerLeave={() => setHover(null)} style={{ cursor: 'pointer' }}>
          <polygon points={r.inner.map((p) => `${p.x},${p.y}`).join(' ')} fill={drafting ? '#ffffff' : ROOM_FILL[r.type]} stroke={isSel(r.id) ? '#1a73e8' : isHi(r.id) ? '#188038' : 'none'} strokeWidth={stroke(2.5)} />
          {hover === r.id && !isSel(r.id) && <polygon points={r.inner.map((p) => `${p.x},${p.y}`).join(' ')} fill="#1a73e8" fillOpacity={0.05} />}
        </g>
      ))}

      {/* Furniture */}
      {showFurniture &&
        shown.furniture.map((f) => {
          const fp = furnitureFootprint(f);
          return (
            <g key={f.id} onPointerDown={(e) => startElementDrag(e, f.id, 'furniture')} onPointerEnter={() => setHover(f.id)} onPointerLeave={() => setHover(null)} style={{ cursor: editable ? 'move' : 'pointer' }}>
              <polygon
                points={fp.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={isSel(f.id) ? '#d2e3fc' : isHi(f.id) ? '#ceead6' : hover === f.id ? '#f1f3f4' : '#ffffff'}
                stroke={isSel(f.id) ? '#1a73e8' : '#9aa0a6'}
                strokeWidth={stroke(isSel(f.id) ? 2 : 1)}
              />
              <FurnitureGlyph f={f} k={k} low={coffee.has(f.id)} />
            </g>
          );
        })}
      {showFurniture &&
        editable &&
        tool === 'select' &&
        sel.size === 1 &&
        shown.furniture
          .filter((f) => isSel(f.id))
          .map((f) => {
            // In front of the piece (its back is at rotation 0 = up), clear of it on screen.
            const r = (f.rotation * Math.PI) / 180;
            const front = { x: -Math.sin(r), y: Math.cos(r) };
            const reach = f.d / 2 + 30 * k;
            const h = { x: f.x + front.x * reach, y: f.y + front.y * reach };
            return (
              <g key={`turn-${f.id}`}>
                <line x1={f.x + front.x * (f.d / 2)} y1={f.y + front.y * (f.d / 2)} x2={h.x} y2={h.y} stroke="#1a73e8" strokeWidth={stroke(1.5)} style={{ pointerEvents: 'none' }} />
                <g
                  style={{ cursor: 'grab', touchAction: 'none' }}
                  onPointerDown={(e) => {
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    e.stopPropagation();
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    moved.current = false;
                    const p = toPlan(e);
                    const f0 = model.furniture.find((x) => x.id === f.id) ?? f;
                    setDrag({ kind: 'turn', id: f.id, centre: { x: f0.x, y: f0.y }, startAngle: (Math.atan2(p.y - f0.y, p.x - f0.x) * 180) / Math.PI, origin: f0.rotation, value: f0.rotation });
                  }}
                >
                  <title>Drag to turn it (15° steps; hold Alt for any angle)</title>
                  {/* a finger-sized target round the visible handle */}
                  <circle cx={h.x} cy={h.y} r={20 * k} fill="transparent" />
                  <circle cx={h.x} cy={h.y} r={11 * k} fill="#ffffff" stroke="#1a73e8" strokeWidth={stroke(2)} />
                </g>
                <path d={`M ${h.x - 4.5 * k} ${h.y - 1 * k} A ${4.5 * k} ${4.5 * k} 0 1 1 ${h.x + 1 * k} ${h.y + 4.4 * k}`} fill="none" stroke="#1a73e8" strokeWidth={stroke(1.5)} style={{ pointerEvents: 'none' }} />
              </g>
            );
          })}

      {/* Ghost of the committed model while previewing a proposal */}
      {ghost &&
        previewIds &&
        [...previewIds].map((id) => {
          const w = ghost.walls.find((x) => x.id === id);
          if (w) return <line key={`g${id}`} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="#d93025" strokeWidth={w.thickness} strokeOpacity={0.18} strokeDasharray={`${150} ${100}`} />;
          const o = ghost.openings.find((x) => x.id === id);
          const host = o && ghost.walls.find((x) => x.id === o.wallId);
          if (o && host) {
            const f = openingFrame(o, host);
            return <line key={`g${id}`} x1={f.start.x} y1={f.start.y} x2={f.end.x} y2={f.end.y} stroke="#d93025" strokeWidth={host.thickness * 1.4} strokeOpacity={0.35} />;
          }
          const fu = ghost.furniture.find((x) => x.id === id);
          if (fu) return <polygon key={`g${id}`} points={furnitureFootprint(fu).map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#d93025" strokeDasharray={`${60} ${40}`} strokeWidth={stroke(1.5)} />;
          return null;
        })}

      {/* Walls, drawn as on a construction drawing: one merged outline, one cut fill, clean corners.
          The outlines go first and every fill on top, so seams where walls meet disappear. */}
      <g style={{ pointerEvents: 'none' }}>
        {solids.map(({ wall: w, spans }) =>
          w.materialId === 'curtain' || w.kind === 'railing' || w.kind === 'column'
            ? null
            : spans.map(([s0, e0], i) => <polygon key={`${w.id}o${i}`} points={wallSpanPolygon(w, s0, e0, solids.find((x) => x.wall.id === w.id)).map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={WALL_OUTLINE} strokeWidth={stroke(2.6)} strokeLinejoin="miter" />),
        )}
      </g>
      {solids.map(({ wall: w, spans }) => {
        const dir = wallDir(w);
        const n = mul(wallNormal(w), w.thickness / 2);
        // Walls read from a drawing look like any other wall; where they came from shows in the inspector.
        const fill = isSel(w.id) ? '#1a73e8' : isHi(w.id) ? '#188038' : hover === w.id ? (tool === 'erase' ? '#d93025' : '#5f6368') : wallFill;
        return (
          <g key={w.id} onPointerDown={(e) => startElementDrag(e, w.id, 'wall')} onPointerEnter={() => setHover(w.id)} onPointerLeave={() => setHover(null)} style={{ cursor: editable ? (Math.abs(dir.x) > Math.abs(dir.y) ? 'ns-resize' : 'ew-resize') : 'pointer' }}>
            {spans.map(([s0, e0], i) => {
              if (w.kind === 'railing') {
                // Handrail: a light outline with its rail line, not a cut wall.
                const p0 = add(w.a, mul(dir, s0));
                const p1 = add(w.a, mul(dir, e0));
                const pts = [add(p0, n), add(p1, n), sub(p1, n), sub(p0, n)];
                const edge = edgeOf(w);
                return (
                  <g key={i}>
                    <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(w.id) ? '#d2e3fc' : '#ffffff'} stroke={fill === wallFill ? (edge === 'kerb' ? '#9aa0a6' : '#3c4043') : fill} strokeWidth={stroke(1)} />
                    {edge !== 'kerb' && (
                      <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={fill === wallFill ? '#3c4043' : fill} strokeWidth={stroke(0.8)} strokeDasharray={edge === 'screen' ? `${stroke(3)} ${stroke(2)}` : undefined} />
                    )}
                  </g>
                );
              }
              if (w.kind === 'column') {
                // A pillar, drawn as on construction plans: filled square or circle, a classical
                // column's round shaft on its square base, a brick pier hatched, a timber post with
                // a cross, a steel column as its H section.
                const cx = (w.a.x + w.b.x) / 2;
                const cy = (w.a.y + w.b.y) / 2;
                const z = Math.max(w.thickness, wallLength(w));
                const h = z / 2;
                const ink = fill === wallFill ? (drafting ? DRAW_WALL : '#5f6368') : fill;
                const ang = (Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180) / Math.PI;
                const line = { stroke: ink, strokeWidth: stroke(1.2), fill: 'none' };
                let g: React.ReactNode;
                switch (w.columnStyle ?? 'square') {
                  case 'round':
                    g = <circle cx={0} cy={0} r={h} fill={ink} />;
                    break;
                  case 'classical':
                    g = (
                      <>
                        <rect x={-h * 1.3} y={-h * 1.3} width={z * 1.3} height={z * 1.3} {...line} />
                        <circle cx={0} cy={0} r={h} fill={ink} />
                      </>
                    );
                    break;
                  case 'brick':
                    g = (
                      <>
                        <rect x={-h} y={-h} width={z} height={z} fill="#ffffff" stroke={ink} strokeWidth={stroke(1.6)} />
                        {[-0.5, 0, 0.5].map((f) => (
                          <line key={f} x1={-h + Math.max(0, f) * z} y1={h - Math.max(0, -f) * z} x2={h - Math.max(0, -f) * z} y2={-h + Math.max(0, f) * z} stroke={ink} strokeWidth={stroke(0.8)} />
                        ))}
                      </>
                    );
                    break;
                  case 'timber':
                    g = (
                      <>
                        <rect x={-h} y={-h} width={z} height={z} fill="#f3e9dc" stroke={ink} strokeWidth={stroke(1.4)} />
                        <line x1={-h} y1={-h} x2={h} y2={h} stroke={ink} strokeWidth={stroke(0.8)} />
                        <line x1={-h} y1={h} x2={h} y2={-h} stroke={ink} strokeWidth={stroke(0.8)} />
                      </>
                    );
                    break;
                  case 'steel':
                    g = <path d={`M ${-h} ${-h} H ${h} V ${-h + z * 0.12} H ${z * 0.05} V ${h - z * 0.12} H ${h} V ${h} H ${-h} V ${h - z * 0.12} H ${-z * 0.05} V ${-h + z * 0.12} H ${-h} Z`} fill={ink} />;
                    break;
                  default:
                    g = <rect x={-h} y={-h} width={z} height={z} fill={ink} />;
                }
                return (
                  <g key={i} transform={`translate(${cx} ${cy}) rotate(${ang})`}>
                    {/* a pillar is small on the plan: a generous area to click */}
                    <circle cx={0} cy={0} r={Math.max(z * 0.8, 10 * k)} fill="transparent" />
                    {g}
                  </g>
                );
              }
              if (w.materialId === 'curtain') {
                // Glass curtain wall: drawn as glazing (thin frame, glass line, mullions), not solid wall.
                const p0 = add(w.a, mul(dir, s0));
                const p1 = add(w.a, mul(dir, e0));
                const pts = [add(p0, n), add(p1, n), sub(p1, n), sub(p0, n)];
                const len = e0 - s0;
                const mull = Math.max(1, Math.round(len / 1500));
                return (
                  <g key={i}>
                    <polygon points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(w.id) ? '#d2e3fc' : '#e3f2fb'} stroke={fill === wallFill ? WALL_OUTLINE : fill} strokeWidth={stroke(1.2)} />
                    <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="#4f8fb8" strokeWidth={stroke(1.4)} />
                    {Array.from({ length: mull - 1 }, (_, m) => {
                      const q = add(w.a, mul(dir, s0 + ((m + 1) * len) / mull));
                      return <line key={m} x1={add(q, n).x} y1={add(q, n).y} x2={sub(q, n).x} y2={sub(q, n).y} stroke={fill === wallFill ? WALL_OUTLINE : fill} strokeWidth={stroke(1)} />;
                    })}
                  </g>
                );
              }
              const pts = wallSpanPolygon(w, s0, e0, solids.find((x) => x.wall.id === w.id));
              return <polygon key={i} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill={fill} stroke="none" />;
            })}
            {/* generous invisible hit area */}
            <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke="transparent" strokeWidth={Math.max(w.thickness, 14 * k)} />
          </g>
        );
      })}

      {/* Openings */}
      {shown.openings.map((o) => {
        const w = shown.walls.find((x) => x.id === o.wallId);
        if (!w) return null;
        const f = openingFrame(o, w);
        const n = mul(f.normal, w.thickness / 2);
        const colour = isSel(o.id) ? '#1a73e8' : isHi(o.id) ? '#188038' : '#3c4043';
        const common = { onPointerDown: (e: React.PointerEvent) => startElementDrag(e, o.id, 'opening'), onPointerEnter: () => setHover(o.id), onPointerLeave: () => setHover(null), style: { cursor: editable ? 'grab' : 'pointer' } };
        if (o.kind === 'window') {
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : '#ffffff'} stroke={colour} strokeWidth={stroke(drafting ? 0.9 : 1.2)} />
              {drafting ? (
                <>
                  <line x1={add(f.start, mul(n, 0.18)).x} y1={add(f.start, mul(n, 0.18)).y} x2={add(f.end, mul(n, 0.18)).x} y2={add(f.end, mul(n, 0.18)).y} stroke={colour} strokeWidth={stroke(0.8)} />
                  <line x1={sub(f.start, mul(n, 0.18)).x} y1={sub(f.start, mul(n, 0.18)).y} x2={sub(f.end, mul(n, 0.18)).x} y2={sub(f.end, mul(n, 0.18)).y} stroke={colour} strokeWidth={stroke(0.8)} />
                </>
              ) : (
                <line x1={f.start.x} y1={f.start.y} x2={f.end.x} y2={f.end.y} stroke={colour} strokeWidth={stroke(1.2)} />
              )}
            </g>
          );
        }
        if (o.kind === 'opening') {
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : 'transparent'} />
              <line x1={f.start.x} y1={f.start.y} x2={f.end.x} y2={f.end.y} stroke={colour} strokeWidth={stroke(1)} strokeDasharray={`${stroke(5)} ${stroke(4)}`} />
            </g>
          );
        }
        if (o.style === 'pocket') {
          // Pocket door: one leaf across the opening, and the pocket in the wall it slides into
          // (dashed), on the hinge side.
          const dirv = wallDir(w);
          const N = wallNormal(w);
          const pt = Math.max(w.thickness * 0.22, 25);
          const into = o.hinge === 'start' ? -1 : 1;
          const from = o.hinge === 'start' ? f.start : f.end;
          const leaf = [add(f.start, mul(N, -pt / 2)), add(f.end, mul(N, -pt / 2)), add(f.end, mul(N, pt / 2)), add(f.start, mul(N, pt / 2))];
          const pocketEnd = add(from, mul(dirv, into * o.width));
          const pocket = [add(from, mul(N, -pt / 2)), add(pocketEnd, mul(N, -pt / 2)), add(pocketEnd, mul(N, pt / 2)), add(from, mul(N, pt / 2))];
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : drafting ? '#ffffff' : '#fbfbfa'} />
              {[f.start, f.end].map((p, i) => (
                <line key={`j${i}`} x1={add(p, n).x} y1={add(p, n).y} x2={sub(p, n).x} y2={sub(p, n).y} stroke={colour} strokeWidth={stroke(0.9)} />
              ))}
              <polygon points={leaf.map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : '#ffffff'} stroke={colour} strokeWidth={stroke(1.4)} />
              <polygon points={pocket.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={drafting ? '#ffffff' : colour} strokeWidth={stroke(1)} strokeDasharray={`${stroke(4)} ${stroke(3)}`} />
            </g>
          );
        }
        if (o.style === 'folding') {
          // Folding door: the leaves as a zigzag across the opening, folding out to the side they open to.
          const dirv = wallDir(w);
          const out = mul(wallNormal(w), o.swing);
          const m = o.width > 1100 ? 4 : 2;
          const lw = o.width / m;
          const zig = Array.from({ length: m + 1 }, (_, i) => add(add(f.start, mul(dirv, i * lw)), mul(out, i % 2 ? lw * 0.45 + w.thickness / 2 : w.thickness / 2)));
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : drafting ? '#ffffff' : '#fbfbfa'} />
              {[f.start, f.end].map((p, i) => (
                <line key={`j${i}`} x1={add(p, n).x} y1={add(p, n).y} x2={sub(p, n).x} y2={sub(p, n).y} stroke={colour} strokeWidth={stroke(0.9)} />
              ))}
              <polyline points={zig.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={colour} strokeWidth={stroke(drafting ? 1.4 : 2)} strokeLinejoin="miter" />
            </g>
          );
        }
        if (o.style === 'sliding') {
          // Sliding door as drawn on construction plans: two panels on parallel tracks inside the
          // wall, each a little over half the width so they overlap in the middle, jamb lines at
          // both ends, and an arrow showing which way the moving panel slides.
          const dirv = wallDir(w);
          const N = wallNormal(w);
          const half = o.width * 0.54;
          const pt = Math.max(w.thickness * 0.2, 25);
          const off = w.thickness * 0.17;
          const rect = (a: Vec2, b: Vec2, o2: number) => [add(a, mul(N, o2 - pt / 2)), add(b, mul(N, o2 - pt / 2)), add(b, mul(N, o2 + pt / 2)), add(a, mul(N, o2 + pt / 2))];
          const fixed = rect(f.start, add(f.start, mul(dirv, half)), off);
          const slide = rect(sub(f.end, mul(dirv, half)), f.end, -off);
          // arrow just outside the wall face, along the moving panel, pointing the way it opens
          const side = -(w.thickness / 2 + Math.max(90, 10 * k));
          const tail = add(sub(f.end, mul(dirv, o.width * 0.12)), mul(N, side));
          const head = add(sub(f.end, mul(dirv, o.width * 0.42)), mul(N, side));
          const barb = Math.min(110, o.width * 0.08);
          const wing = (sgn: number) => add(add(head, mul(dirv, barb)), mul(N, sgn * barb * 0.6));
          const panelFill = isSel(o.id) ? '#d2e3fc' : drafting ? '#ffffff' : '#e8f4fa';
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : drafting ? '#ffffff' : '#fbfbfa'} />
              {[f.start, f.end].map((p, i) => (
                <line key={`j${i}`} x1={add(p, n).x} y1={add(p, n).y} x2={sub(p, n).x} y2={sub(p, n).y} stroke={colour} strokeWidth={stroke(0.9)} />
              ))}
              {[fixed, slide].map((poly, i) => (
                <polygon key={`p${i}`} points={poly.map((p) => `${p.x},${p.y}`).join(' ')} fill={panelFill} stroke={colour} strokeWidth={stroke(1.4)} />
              ))}
              <g stroke={colour} strokeWidth={stroke(1)} fill="none" style={{ pointerEvents: 'none' }}>
                <line x1={tail.x} y1={tail.y} x2={head.x} y2={head.y} />
                <polyline points={[wing(1), head, wing(-1)].map((p) => `${p.x},${p.y}`).join(' ')} />
              </g>
            </g>
          );
        }
        if (isRollerDoor(o, shown.spec?.type === 'industrial')) {
          // Roller shutter: a thick line across the opening, no swing.
          return (
            <g key={o.id} {...common}>
              <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : '#fbfbfa'} />
              <line x1={f.start.x} y1={f.start.y} x2={f.end.x} y2={f.end.y} stroke={colour} strokeWidth={stroke(3)} />
              <line x1={add(f.start, n).x} y1={add(f.start, n).y} x2={add(f.end, n).x} y2={add(f.end, n).y} stroke={colour} strokeWidth={stroke(1)} strokeDasharray={`${stroke(2)} ${stroke(2)}`} />
            </g>
          );
        }
        // A wide door in a home is a pair of doors: two leaves, each with its own swing.
        const leaves = isDoubleDoor(o, shown.spec?.type === 'industrial') ? doorLeaves(o) : [o];
        return (
          <g key={o.id} {...common}>
            <polygon points={[add(f.start, n), add(f.end, n), sub(f.end, n), sub(f.start, n)].map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#d2e3fc' : drafting ? '#ffffff' : '#fbfbfa'} />
            {leaves.map((leaf, li) => {
              const swing = doorSwingPolygon(leaf, w, 16);
              const openTip = swing[swing.length - 1];
              const lf = openingFrame(leaf, w);
              return (
                <g key={li}>
                  <polygon points={swing.map((p) => `${p.x},${p.y}`).join(' ')} fill={isSel(o.id) ? '#1a73e8' : 'transparent'} fillOpacity={0.08} />
                  <polyline points={swing.slice(1).map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={colour} strokeWidth={stroke(drafting ? 0.8 : 1)} strokeDasharray={drafting ? undefined : `${stroke(4)} ${stroke(3)}`} />
                  <line x1={lf.hingePoint.x} y1={lf.hingePoint.y} x2={openTip.x} y2={openTip.y} stroke={colour} strokeWidth={stroke(drafting ? 1.4 : 2.4)} strokeLinecap="round" />
                </g>
              );
            })}
          </g>
        );
      })}

      {aids.dims && !markTool && <PlanDims model={shown} k={k} fs={fs} />}

      {/* Dimensions placed by hand on this floor (select or erase them like walls; DIMS hides them with the rest) */}
      {aids.dims &&
        !markTool &&
        dimensionsOnLevel(shown).map((dm) => (
          <UserDimension
            key={dm.id}
            d={dm}
            k={k}
            fs={fs}
            colour={isSel(dm.id) ? '#1a73e8' : hover === dm.id ? (tool === 'erase' ? '#d93025' : '#5f6368') : '#202124'}
            onPointerDown={(e) => startElementDrag(e, dm.id, 'dimension')}
            onPointerEnter={() => setHover(dm.id)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      {tool === 'dimension' && dimDraft && cursor && (() => {
        const b = dimDraft.b ?? wallEnd(dimDraft.a, cursor).p;
        const offset = dimDraft.b ? dimOffset(dimDraft.a, dimDraft.b, cursor) : 0;
        return <UserDimension d={{ a: dimDraft.a, b, offset }} k={k} fs={fs} colour="#1a73e8" preview />;
      })()}

      {/* Canopy that belongs to the design (e.g. a bag's handle) */}
      {shown.features?.canopy && shown.features.canopy.length > 1 && (
        <g style={{ pointerEvents: 'none' }}>
          <polyline points={shown.features.canopy.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={shown.spec?.accent ?? '#1a73e8'} strokeOpacity={0.22} strokeWidth={2600} strokeLinejoin="round" />
          <polyline points={shown.features.canopy.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={shown.spec?.accent ?? '#1a73e8'} strokeWidth={stroke(1.5)} strokeDasharray={`${stroke(6)} ${stroke(4)}`} />
          <text x={shown.features.canopy[Math.floor(shown.features.canopy.length / 2)].x} y={shown.features.canopy[Math.floor(shown.features.canopy.length / 2)].y - 1700} fontSize={12 * k} textAnchor="middle" fill={shown.spec?.accent ?? '#1a73e8'} fontWeight={600}>
            canopy
          </text>
        </g>
      )}

      {/* Crit marks: highlighted areas, freehand notes and pinned spots */}
      {[
        ...marks.map((m) => ({ ...m, live: false })),
        ...(draftMark ? [{ id: 'draft', n: 0, mark: draftMark, label: 'Your new mark', onClick: () => undefined, live: true, active: true, resolved: false }] : []),
        ...(liveMark ? [{ id: 'live', n: 0, mark: liveMark, label: '', onClick: () => undefined, live: true, active: true, resolved: false }] : []),
      ].map((m) => (
        <MarkShape key={m.id} m={m} k={k} erasing={markTool === 'eraser'} model={shown} />
      ))}

      {/* Finding evidence overlays */}
      {overlays.map((ov, i) =>
        ov.kind === 'polygon' ? (
          <polygon key={i} points={ov.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="url(#hatch)" stroke="#e37400" strokeWidth={stroke(2)} style={{ pointerEvents: 'none' }} />
        ) : ov.kind === 'polyline' ? (
          <polyline key={i} points={ov.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#e37400" strokeWidth={stroke(5)} strokeLinecap="round" style={{ pointerEvents: 'none' }} />
        ) : (
          <circle key={i} cx={ov.points[0].x} cy={ov.points[0].y} r={stroke(8)} fill="#e37400" />
        ),
      )}

      {/* Room labels — sized to fit their room so small views never overlap */}
      {d.rooms.map((r) => {
        const b = bbox(r.inner);
        const avail = b.w * 0.84;
        const fit = (text: string, max: number) => Math.min(max, avail / Math.max(1, text.length * 0.56));
        let name = r.name;
        let nameSize = fit(name, fs * 1.05);
        if (nameSize < 7 * k) {
          // Too small to read: fall back to the first word, then to the room id.
          name = r.name.split(/[s/&]+/)[0];
          nameSize = fit(name, fs * 1.05);
          if (nameSize < 6 * k) {
            name = r.id;
            nameSize = fit(name, fs);
          }
        }
        const areaSize = Math.min(fs * 0.92, nameSize * 0.92);
        const showArea = b.h > (nameSize + areaSize) * 2.2 && areaSize >= 6 * k;
        const cy = r.centroid.y + (showArea ? -areaSize * 0.35 : nameSize * 0.35);
        return (
          <g key={`l${r.id}`} style={{ pointerEvents: 'none' }}>
            <text x={r.centroid.x} y={cy} textAnchor="middle" fontSize={drafting ? nameSize * 0.86 : nameSize} fontWeight={drafting ? 600 : 500} letterSpacing={drafting ? nameSize * 0.06 : 0} fill={drafting ? '#141516' : '#202124'}>
              {drafting ? name.toUpperCase() : name}
            </text>
            {showArea && (
              <text x={r.centroid.x} y={cy + areaSize * 1.25} textAnchor="middle" fontSize={areaSize} fill="#5f6368">
                {r.area.toFixed(1)} m²
              </text>
            )}
          </g>
        );
      })}

      {/* Dimension of selected wall */}
      {selection.map((id) => {
        const w = shown.walls.find((x) => x.id === id);
        if (!w) return null;
        const n = wallNormal(w);
        const off = w.thickness / 2 + 22 * k;
        const a = add(w.a, mul(n, off));
        const b = add(w.b, mul(n, off));
        const m = add(pointAlongWall(w, wallLength(w) / 2), mul(n, off + 10 * k));
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const upright = ang > 90 || ang < -90 ? ang + 180 : ang;
        return (
          <g key={`dim${id}`} style={{ pointerEvents: 'none' }}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#1a73e8" strokeWidth={stroke(1)} />
            <circle cx={a.x} cy={a.y} r={stroke(2.5)} fill="#1a73e8" />
            <circle cx={b.x} cy={b.y} r={stroke(2.5)} fill="#1a73e8" />
            <text x={m.x} y={m.y} fontSize={fs} fill="#1a73e8" textAnchor="middle" transform={`rotate(${upright} ${m.x} ${m.y})`} fontWeight={500}>
              {w.id} · {Math.round(wallLength(w)).toLocaleString('en-GB')} mm
            </text>
          </g>
        );
      })}

      {/* Drag readout */}
      {drag && drag.kind !== 'pan' && drag.kind !== 'box' && cursor && (
        <g style={{ pointerEvents: 'none' }}>
          <rect x={cursor.x + 12 * k} y={cursor.y - 28 * k} width={fs * 9} height={fs * 1.9} rx={4 * k} fill="#202124" />
          <text x={cursor.x + 18 * k} y={cursor.y - 13 * k} fontSize={fs} fill="#fff">
            {drag.kind === 'wall' ? `${drag.value > 0 ? '+' : ''}${drag.value} mm` : drag.kind === 'opening' ? `offset ${drag.value} mm` : drag.kind === 'turn' ? `turned to ${drag.value}°` : `${Math.round(drag.value.x)}, ${Math.round(drag.value.y)}`}
          </text>
        </g>
      )}

      {/* Roof outline (dashed eaves, ridge and hips) */}
      {showRoof &&
        (() => {
          const rs = roofShape(shown);
          if (!rs) return null;
          return (
            <g style={{ pointerEvents: 'none' }}>
              {rs.outlines.map((ol, oi) => (
                <polygon key={`ro${oi}`} points={ol.map((q) => `${q.x},${q.y}`).join(' ')} fill="#ff7043" fillOpacity={0.05} stroke="#e8710a" strokeWidth={stroke(1.6)} strokeDasharray={`${stroke(8)} ${stroke(5)}`} />
              ))}
              {[...rs.ridges, ...rs.hips].map(([a, b], i) => (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#e8710a" strokeWidth={stroke(i < rs.ridges.length ? 2.2 : 1.4)} strokeDasharray={i < rs.ridges.length ? undefined : `${stroke(6)} ${stroke(4)}`} />
              ))}
            </g>
          );
        })()}

      {/* Measuring tape */}
      {tool === 'measure' && measure && (() => {
        const b = measure.b ?? (cursor ? snapPoint(cursor) : measure.a);
        const len = dist(measure.a, b);
        const mid = { x: (measure.a.x + b.x) / 2, y: (measure.a.y + b.y) / 2 };
        return (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={measure.a.x} y1={measure.a.y} x2={b.x} y2={b.y} stroke="#d93025" strokeWidth={stroke(2)} />
            <circle cx={measure.a.x} cy={measure.a.y} r={stroke(4)} fill="#d93025" />
            <circle cx={b.x} cy={b.y} r={stroke(4)} fill="#d93025" />
            <rect x={mid.x - fs * 3.4} y={mid.y - fs * 2.2} width={fs * 6.8} height={fs * 1.7} rx={4 * k} fill="#d93025" />
            <text x={mid.x} y={mid.y - fs * 0.95} fontSize={fs} fill="#fff" textAnchor="middle" fontWeight={500}>
              {(len / 1000).toFixed(2)} m
            </text>
          </g>
        );
      })()}
      {tool === 'furniture' && cursor && (() => {
        const [w, dpt] = FURNITURE_SIZES[furnitureKind];
        return <rect x={snap(cursor.x, 50) - w / 2} y={snap(cursor.y, 50) - dpt / 2} width={w} height={dpt} fill="#1a73e8" fillOpacity={0.12} stroke="#1a73e8" strokeWidth={stroke(1.5)} strokeDasharray={`${stroke(5)} ${stroke(3)}`} style={{ pointerEvents: 'none' }} />;
      })()}

      {/* Wall tool rubber band */}
      {tool === 'split' && cursor && (() => {
        const near = nearestWall(cursor, 30 * k);
        if (!near) return null;
        const q = pointAlongWall(near.w, Math.round(near.along / 50) * 50);
        const nn = mul(wallNormal(near.w), near.w.thickness);
        return <line x1={q.x - nn.x} y1={q.y - nn.y} x2={q.x + nn.x} y2={q.y + nn.y} stroke="#d93025" strokeWidth={stroke(3)} strokeLinecap="round" />;
      })()}
      {tool === 'wall' && wallStart && cursor && (() => {
        const e = wallEnd(wallStart, cursor).p;
        const L = Math.round(dist(wallStart, e));
        return (
          <g style={{ pointerEvents: 'none' }}>
            <line x1={wallStart.x} y1={wallStart.y} x2={e.x} y2={e.y} stroke="#1a73e8" strokeWidth={model.defaults.interiorThickness} strokeOpacity={0.35} />
            <line x1={wallStart.x} y1={wallStart.y} x2={e.x} y2={e.y} stroke="#1a73e8" strokeWidth={stroke(1)} strokeDasharray={`${stroke(6)} ${stroke(4)}`} />
            <g transform={`translate(${e.x + 14 * k} ${e.y + 26 * k})`}>
              <rect x={0} y={-13 * k} width={L >= 10000 ? 78 * k : 66 * k} height={18 * k} rx={4 * k} fill="#ffffff" stroke="#1a73e8" strokeWidth={stroke(1)} />
              <text x={6 * k} y={0} fontSize={11 * k} fill="#1a73e8" fontFamily="var(--mono)">{L} mm</text>
            </g>
          </g>
        );
      })()}
      {(tool === 'wall' || tool === 'measure' || (tool === 'dimension' && !dimDraft?.b)) && cursor && !drag && (() => {
        const sn = tool === 'wall' && wallStart ? wallEnd(wallStart, cursor) : tool === 'dimension' && dimDraft ? wallEnd(dimDraft.a, cursor) : snapInfo(cursor);
        if (sn.kind === 'grid' || sn.kind === 'free') return null;
        const r = 7 * k;
        const q = sn.p;
        const label = sn.kind === 'end' ? 'Endpoint' : sn.kind === 'mid' ? 'Midpoint' : 'Nearest';
        return (
          <g style={{ pointerEvents: 'none' }}>
            {sn.kind === 'end' && <rect x={q.x - r} y={q.y - r} width={2 * r} height={2 * r} fill="none" stroke="#1a73e8" strokeWidth={stroke(2)} />}
            {sn.kind === 'mid' && <polygon points={`${q.x},${q.y - r} ${q.x + r},${q.y + r * 0.8} ${q.x - r},${q.y + r * 0.8}`} fill="none" stroke="#1a73e8" strokeWidth={stroke(2)} />}
            {sn.kind === 'near' && <path d={`M${q.x - r} ${q.y - r} L${q.x + r} ${q.y - r} L${q.x - r} ${q.y + r} L${q.x + r} ${q.y + r} Z`} fill="none" stroke="#1a73e8" strokeWidth={stroke(2)} />}
            <g transform={`translate(${q.x + 12 * k} ${q.y - 12 * k})`}>
              <rect x={0} y={-12 * k} width={label.length * 6.6 * k + 10 * k} height={16 * k} rx={3 * k} fill="#1a73e8" />
              <text x={5 * k} y={0} fontSize={10.5 * k} fill="#ffffff">{label}</text>
            </g>
          </g>
        );
      })()}
      {drag?.kind === 'box' && Math.hypot(drag.cur.x - drag.start.x, drag.cur.y - drag.start.y) > 6 * k && (() => {
        const crossing = drag.cur.x < drag.start.x;
        const colour = tool === 'erase' ? '#d93025' : crossing ? '#188038' : '#1a73e8';
        return (
          <rect
            x={Math.min(drag.start.x, drag.cur.x)}
            y={Math.min(drag.start.y, drag.cur.y)}
            width={Math.abs(drag.cur.x - drag.start.x)}
            height={Math.abs(drag.cur.y - drag.start.y)}
            fill={colour}
            fillOpacity={0.08}
            stroke={colour}
            strokeWidth={stroke(1.4)}
            strokeDasharray={crossing ? `${stroke(6)} ${stroke(4)}` : undefined}
            style={{ pointerEvents: 'none' }}
          />
        );
      })()}
      {(tool === 'door' || tool === 'window') &&
        cursor &&
        (() => {
          const near = nearestWall(cursor, 30 * k);
          if (!near) return null;
          const p = projectOnSegment(cursor, near.w.a, near.w.b).point;
          return <circle cx={p.x} cy={p.y} r={(tool === 'door' ? 425 : 600)} fill="#1a73e8" fillOpacity={0.15} stroke="#1a73e8" strokeWidth={stroke(1.5)} />;
        })()}

      {/* Pins (findings and crit comments) */}
      {pins.map((pin, i) => {
        const c = elementCenter(shown, pin.elementId);
        if (!c) return null;
        const r = 11 * k;
        const off = { x: (i % 3) * 6 * k, y: -r * 2.2 };
        const at = add(c, off);
        return (
          <g key={pin.id} onPointerDown={(e) => { e.stopPropagation(); pin.onClick(); }} style={{ cursor: 'pointer' }}>
            <title>{pin.label}</title>
            <path d={`M ${at.x} ${at.y + r * 1.9} L ${at.x - r * 0.55} ${at.y + r * 0.7} A ${r} ${r} 0 1 1 ${at.x + r * 0.55} ${at.y + r * 0.7} Z`} fill={TONE[pin.tone]} stroke="#fff" strokeWidth={stroke(1.5)} />
            <text x={at.x} y={at.y + r * 0.38} fontSize={r * 1.05} fill="#fff" textAnchor="middle" fontWeight={700}>
              {pin.kind === 'message' ? '✎' : '!'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function FurnitureGlyph({ f, k, low = false }: { f: BuildingModel['furniture'][number]; k: number; low?: boolean }) {
  const t = `translate(${f.x} ${f.y}) rotate(${f.rotation})`;
  const s = { stroke: '#9aa0a6', strokeWidth: k, fill: 'none', style: { pointerEvents: 'none' as const } };
  const hw = f.w / 2;
  const hd = f.d / 2;
  switch (f.kind) {
    case 'bed':
      return (
        <g transform={t}>
          <rect x={-hw + 80} y={-hd + 80} width={f.w / 2 - 120} height={360} rx={60} {...s} />
          <rect x={40} y={-hd + 80} width={f.w / 2 - 120} height={360} rx={60} {...s} />
          <line x1={-hw} y1={-hd + 520} x2={hw} y2={-hd + 520} {...s} />
        </g>
      );
    case 'sofa':
      return (
        <g transform={t}>
          <rect x={-hw + 60} y={-hd + 60} width={f.w - 120} height={f.d * 0.35} rx={40} {...s} />
        </g>
      );
    case 'table': {
      if (low) return null;
      const n = chairsPerSide(f.w);
      return (
        <g transform={t}>
          {[-1, 1].map((sy) => Array.from({ length: n }, (_, i) => <circle key={`${i}${sy}`} cx={(i - (n - 1) / 2) * (f.w / n)} cy={sy * (hd + 180)} r={180} {...s} />))}
        </g>
      );
    }
    case 'bath':
      return (
        <g transform={t}>
          <rect x={-hw + 70} y={-hd + 70} width={f.w - 140} height={f.d - 140} rx={180} {...s} />
        </g>
      );
    case 'wc':
      return (
        <g transform={t}>
          <ellipse cx={0} cy={hd * 0.25} rx={hw * 0.75} ry={hd * 0.55} {...s} />
        </g>
      );
    case 'basin':
      return (
        <g transform={t}>
          <ellipse cx={0} cy={0} rx={hw * 0.7} ry={hd * 0.6} {...s} />
        </g>
      );
    case 'kitchen':
      return (
        <g transform={t}>
          <circle cx={-hw + 450} cy={0} r={130} {...s} />
          <circle cx={-hw + 750} cy={0} r={130} {...s} />
          <rect x={hw - 900} y={-hd + 100} width={600} height={f.d - 200} rx={40} {...s} />
        </g>
      );
    case 'desk':
      return (
        <g transform={t}>
          <circle cx={0} cy={hd + 260} r={220} {...s} />
        </g>
      );
    case 'wardrobe':
      return (
        <g transform={t}>
          <line x1={-hw} y1={-hd} x2={hw} y2={hd} {...s} />
          <line x1={-hw} y1={hd} x2={hw} y2={-hd} {...s} />
        </g>
      );
    case 'sideboard':
      // a low cabinet: its doors shown as a line along the front
      return (
        <g transform={t}>
          <line x1={-hw + 40} y1={hd - 60} x2={hw - 40} y2={hd - 60} {...s} />
          <line x1={0} y1={-hd} x2={0} y2={hd - 60} {...s} />
        </g>
      );
    case 'stair-l': {
      // two flights at right angles: up the left side, a quarter landing, then along the back
      const fw = Math.min(1100, Math.max(800, Math.min(f.w, f.d) * 0.42));
      const n1 = Math.max(3, Math.round((f.d - fw) / 270));
      const n2 = Math.max(3, Math.round((f.w - fw) / 270));
      const g1 = (f.d - fw) / n1;
      const g2 = (f.w - fw) / n2;
      return (
        <g transform={t}>
          <polyline points={`${-hw},${hd} ${-hw},${-hd} ${hw},${-hd} ${hw},${-hd + fw} ${-hw + fw},${-hd + fw} ${-hw + fw},${hd}`} {...s} />
          {Array.from({ length: n1 }, (_, i) => (
            <line key={`a${i}`} x1={-hw} y1={hd - i * g1} x2={-hw + fw} y2={hd - i * g1} {...s} />
          ))}
          {Array.from({ length: n2 }, (_, i) => (
            <line key={`b${i}`} x1={-hw + fw + (i + 1) * g2} y1={-hd} x2={-hw + fw + (i + 1) * g2} y2={-hd + fw} {...s} />
          ))}
          <polyline points={`${-hw + fw / 2},${hd - 200} ${-hw + fw / 2},${-hd + fw / 2} ${hw - 250},${-hd + fw / 2}`} {...s} />
          <path d={`M ${hw - 470} ${-hd + fw / 2 - 160} L ${hw - 250} ${-hd + fw / 2} L ${hw - 470} ${-hd + fw / 2 + 160}`} {...s} />
        </g>
      );
    }
    case 'stair-u': {
      // up the left flight, across a half landing at the back, and up the right flight towards the front
      const gap = 100;
      const fw = (f.w - gap) / 2;
      const ld = Math.min(fw, f.d * 0.35);
      const n = Math.max(3, Math.round((f.d - ld) / 270));
      const g = (f.d - ld) / n;
      return (
        <g transform={t}>
          <line x1={-hw} y1={-hd + ld} x2={-hw + fw} y2={-hd + ld} {...s} />
          <line x1={hw - fw} y1={-hd + ld} x2={hw} y2={-hd + ld} {...s} />
          <rect x={-gap / 2} y={-hd + ld} width={gap} height={f.d - ld} {...s} />
          {Array.from({ length: n - 1 }, (_, i) => (
            <g key={i}>
              <line x1={-hw} y1={hd - (i + 1) * g} x2={-hw + fw} y2={hd - (i + 1) * g} {...s} />
              <line x1={hw - fw} y1={hd - (i + 1) * g} x2={hw} y2={hd - (i + 1) * g} {...s} />
            </g>
          ))}
          <polyline points={`${-hw + fw / 2},${hd - 200} ${-hw + fw / 2},${-hd + ld / 2} ${hw - fw / 2},${-hd + ld / 2} ${hw - fw / 2},${hd - 250}`} {...s} />
          <path d={`M ${hw - fw / 2 - 160} ${hd - 470} L ${hw - fw / 2} ${hd - 250} L ${hw - fw / 2 + 160} ${hd - 470}`} {...s} />
        </g>
      );
    }
    case 'spiral': {
      const r = Math.min(hw, hd);
      const n = 12;
      const sweep = (330 * Math.PI) / 180;
      return (
        <g transform={t}>
          <circle cx={0} cy={0} r={r} {...s} />
          <circle cx={0} cy={0} r={80} {...s} />
          {Array.from({ length: n + 1 }, (_, i) => {
            const a = Math.PI / 2 + (i * sweep) / n;
            return <line key={i} x1={Math.cos(a) * 80} y1={Math.sin(a) * 80} x2={Math.cos(a) * r} y2={Math.sin(a) * r} {...s} />;
          })}
          <path d={`M ${0} ${r * 0.65} A ${r * 0.65} ${r * 0.65} 0 1 1 ${Math.cos(Math.PI / 2 + sweep) * r * 0.65} ${Math.sin(Math.PI / 2 + sweep) * r * 0.65}`} {...s} />
        </g>
      );
    }
    case 'stair':
      return (
        <g transform={t}>
          {Array.from({ length: 11 }, (_, i) => (
            <line key={i} x1={-hw} y1={-hd + ((i + 1) * f.d) / 12} x2={hw} y2={-hd + ((i + 1) * f.d) / 12} {...s} />
          ))}
          <line x1={0} y1={hd - 200} x2={0} y2={-hd + 300} {...s} />
          <path d={`M ${-160} ${-hd + 520} L 0 ${-hd + 280} L 160 ${-hd + 520}`} {...s} />
        </g>
      );
    case 'lift':
      return (
        <g transform={t}>
          <line x1={-hw} y1={-hd} x2={hw} y2={hd} {...s} />
          <line x1={-hw} y1={hd} x2={hw} y2={-hd} {...s} />
        </g>
      );
    case 'workstation':
      return (
        <g transform={t}>
          <circle cx={0} cy={hd + 280} r={220} {...s} />
          <line x1={-hw + 150} y1={-hd + 120} x2={hw - 150} y2={-hd + 120} {...s} />
        </g>
      );
    case 'meeting':
      return (
        <g transform={t}>
          {Array.from({ length: Math.max(2, Math.floor(f.w / 800)) }, (_, i) => {
            const x = -hw + 400 + i * ((f.w - 800) / Math.max(1, Math.floor(f.w / 800) - 1));
            return (
              <g key={i}>
                <circle cx={x} cy={hd + 300} r={200} {...s} />
                <circle cx={x} cy={-hd - 300} r={200} {...s} />
              </g>
            );
          })}
        </g>
      );
    case 'machine':
      return (
        <g transform={t}>
          <rect x={-hw * 0.6} y={-hd * 0.6} width={f.w * 0.6} height={f.d * 0.6} {...s} />
        </g>
      );
    case 'conveyor':
      return (
        <g transform={t}>
          {Array.from({ length: Math.max(2, Math.floor(f.w / 600)) }, (_, i) => (
            <line key={i} x1={-hw + 300 + i * 600} y1={-hd + 80} x2={-hw + 300 + i * 600} y2={hd - 80} {...s} />
          ))}
        </g>
      );
    case 'rack':
      return (
        <g transform={t}>
          <line x1={-hw} y1={0} x2={hw} y2={0} {...s} />
          {Array.from({ length: Math.max(1, Math.floor(f.w / 2700)) }, (_, i) => (
            <line key={i} x1={-hw + (i + 1) * 2700} y1={-hd} x2={-hw + (i + 1) * 2700} y2={hd} {...s} />
          ))}
        </g>
      );
    case 'plant':
      return (
        <g transform={t}>
          <circle cx={0} cy={0} r={Math.min(hw, hd) * 0.8} {...s} />
          <circle cx={0} cy={0} r={Math.min(hw, hd) * 0.35} {...s} />
        </g>
      );
    default:
      return null;
  }
}

/** Drop points that add almost nothing to a freehand line (keeps messages small). */
function simplifyPath(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (dist(out[out.length - 1], pts[i]) > tol) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out.slice(0, 160).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

function MarkShape({ m, k, erasing, model }: { m: ShownMark & { live: boolean }; k: number; erasing?: boolean; model: BuildingModel }) {
  const c = m.mark.color;
  const pts = m.mark.points;
  const op = m.resolved ? 0.35 : 1;
  const badge = (at: Vec2) =>
    m.n > 0 && (
      <g transform={'translate(' + at.x + ' ' + at.y + ')'}>
        <circle r={11 * k} fill={c} stroke="#fff" strokeWidth={2 * k} />
        <text y={4 * k} fontSize={12 * k} fill="#fff" textAnchor="middle" fontWeight={700}>
          {m.n}
        </text>
      </g>
    );
  const canErase = erasing && !!m.onErase;
  const click = {
    onPointerDown: (e: React.PointerEvent) => {
      if (canErase) {
        e.stopPropagation();
        m.onErase!();
        return;
      }
      if (m.live || erasing) return;
      e.stopPropagation();
      m.onClick();
    },
    style: { cursor: canErase ? 'not-allowed' : m.live ? undefined : 'pointer', opacity: erasing && !canErase ? op * 0.4 : op } as React.CSSProperties,
  };
  const pinAt = (at: Vec2) => (
    <>
      <path transform={'translate(' + at.x + ' ' + at.y + ')'} d={'M0 0 L' + -9 * k + ' ' + -17 * k + ' A' + 11 * k + ' ' + 11 * k + ' 0 1 1 ' + 9 * k + ' ' + -17 * k + ' Z'} fill={c} stroke="#fff" strokeWidth={2 * k} />
      <text x={at.x} y={at.y - 22 * k} fontSize={11 * k} fill="#fff" textAnchor="middle" fontWeight={700}>
        {m.n > 0 ? m.n : '+'}
      </text>
    </>
  );
  if ((m.mark.kind === 'line' || m.mark.kind === 'arrow' || m.mark.kind === 'wall') && pts.length >= 2) {
    const [a, b] = pts;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const hs = 14 * k;
    return (
      <g {...click}>
        <title>{m.label}</title>
        {m.mark.kind === 'wall' ? (
          <>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeOpacity={0.35} strokeWidth={Math.max(150, 8 * k)} strokeLinecap="butt" />
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={2 * k} strokeDasharray={6 * k + ' ' + 4 * k} />
            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 12 * k} fontSize={11 * k} fill={c} textAnchor="middle" fontWeight={600}>
              new wall
            </text>
          </>
        ) : (
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={c} strokeWidth={(m.active ? 4 : 3) * k} strokeLinecap="round" />
        )}
        {m.mark.kind === 'arrow' && <path d={'M' + b.x + ' ' + b.y + ' L' + (b.x - ux * hs - uy * hs * 0.6) + ' ' + (b.y - uy * hs + ux * hs * 0.6) + ' L' + (b.x - ux * hs + uy * hs * 0.6) + ' ' + (b.y - uy * hs - ux * hs * 0.6) + ' Z'} fill={c} />}
        {badge(a)}
      </g>
    );
  }
  if ((m.mark.kind === 'door' || m.mark.kind === 'window') && pts.length >= 2) {
    const [a, b] = pts;
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const half = m.mark.kind === 'door' ? 450 : 600;
    const s0 = { x: a.x - ux * half, y: a.y - uy * half };
    const s1 = { x: a.x + ux * half, y: a.y + uy * half };
    const nx = -uy;
    const ny = ux;
    return (
      <g {...click}>
        <title>{m.label}</title>
        <line x1={s0.x} y1={s0.y} x2={s1.x} y2={s1.y} stroke="#fff" strokeWidth={Math.max(220, 10 * k)} />
        {m.mark.kind === 'door' ? (
          <>
            <line x1={s0.x} y1={s0.y} x2={s0.x + nx * 900} y2={s0.y + ny * 900} stroke={c} strokeWidth={2.5 * k} />
            <path d={'M' + (s0.x + nx * 900) + ' ' + (s0.y + ny * 900) + ' A900 900 0 0 1 ' + s1.x + ' ' + s1.y} fill="none" stroke={c} strokeWidth={1.5 * k} strokeDasharray={4 * k + ' ' + 3 * k} />
          </>
        ) : (
          [-60, 0, 60].map((o) => <line key={o} x1={s0.x + nx * o} y1={s0.y + ny * o} x2={s1.x + nx * o} y2={s1.y + ny * o} stroke={c} strokeWidth={1.6 * k} />)
        )}
        <text x={a.x + nx * 1300} y={a.y + ny * 1300} fontSize={10 * k} fill={c} textAnchor="middle" fontWeight={600}>
          {m.mark.kind === 'door' ? 'new door' : 'new window'}
        </text>
        {badge({ x: a.x + nx * 700, y: a.y + ny * 700 })}
      </g>
    );
  }
  if (m.mark.kind === 'remove') {
    const p = pts[0];
    const el = m.mark.elementId;
    const w = el ? model.walls.find((x) => x.id === el) : undefined;
    return (
      <g {...click}>
        <title>{m.label}</title>
        {w && <line x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={c} strokeOpacity={0.45} strokeWidth={w.thickness + 120} />}
        <g transform={'translate(' + p.x + ' ' + p.y + ')'}>
          <circle r={12 * k} fill={c} stroke="#fff" strokeWidth={2 * k} />
          <path d={'M' + -5 * k + ' ' + -5 * k + ' L' + 5 * k + ' ' + 5 * k + ' M' + 5 * k + ' ' + -5 * k + ' L' + -5 * k + ' ' + 5 * k} stroke="#fff" strokeWidth={2.2 * k} />
        </g>
        <text x={p.x} y={p.y - 18 * k} fontSize={10 * k} fill={c} textAnchor="middle" fontWeight={600}>
          remove {el}
        </text>
      </g>
    );
  }
  if (m.mark.kind === 'text') {
    const p = pts[0];
    const txt = m.mark.text || 'Note';
    const w = Math.max(40, txt.length * 6.4 + 18) * k;
    return (
      <g {...click}>
        <title>{m.label}</title>
        <rect x={p.x} y={p.y - 22 * k} width={w} height={22 * k} rx={6 * k} fill={c} />
        <text x={p.x + 9 * k} y={p.y - 7 * k} fontSize={11.5 * k} fill="#fff" fontWeight={500}>
          {m.n > 0 ? m.n + '. ' : ''}
          {txt}
        </text>
      </g>
    );
  }
  if (m.mark.kind === 'part') {
    const p = pts[0];
    return (
      <g {...click}>
        <title>{m.label}</title>
        <rect x={p.x - 9 * k} y={p.y - 9 * k} width={18 * k} height={18 * k} transform={'rotate(45 ' + p.x + ' ' + p.y + ')'} fill={c} stroke="#fff" strokeWidth={2 * k} />
        {badge({ x: p.x + 16 * k, y: p.y - 16 * k })}
      </g>
    );
  }
  if (m.mark.kind === 'area' && pts.length >= 2) {
    const x = Math.min(pts[0].x, pts[1].x);
    const y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x);
    const h = Math.abs(pts[1].y - pts[0].y);
    return (
      <g {...click}>
        <title>{m.label}</title>
        <rect x={x} y={y} width={w} height={h} rx={8 * k} fill={c} fillOpacity={m.active ? 0.22 : 0.14} stroke={c} strokeWidth={(m.active ? 3 : 2) * k} strokeDasharray={m.live ? 8 * k + ' ' + 5 * k : undefined} className={m.active && !m.live ? 'mark-pulse' : undefined} />
        {badge({ x, y })}
      </g>
    );
  }
  if (m.mark.kind === 'pen' && pts.length >= 2) {
    return (
      <g {...click}>
        <title>{m.label}</title>
        <polyline points={pts.map((p) => p.x + ',' + p.y).join(' ')} fill="none" stroke={c} strokeWidth={(m.active ? 5 : 4) * k} strokeLinecap="round" strokeLinejoin="round" />
        {badge(pts[0])}
      </g>
    );
  }
  const p = pts[0];
  return (
    <g {...click}>
      <title>{m.label}</title>
      {m.active && !m.live && <circle cx={p.x} cy={p.y} r={20 * k} fill={c} fillOpacity={0.18} className="mark-pulse" />}
      {pinAt(p)}
    </g>
  );
}

/** Distance from a plan point to a mark's drawing, for the eraser. */
function markDistance(m: PlanMark, p: Vec2, k: number): number {
  const pts = m.points;
  const seg = (a: Vec2, b: Vec2) => projectOnSegment(p, a, b).distance;
  switch (m.kind) {
    case 'area': {
      if (pts.length < 2) return Infinity;
      const [x0, x1] = [Math.min(pts[0].x, pts[1].x), Math.max(pts[0].x, pts[1].x)];
      const [y0, y1] = [Math.min(pts[0].y, pts[1].y), Math.max(pts[0].y, pts[1].y)];
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return 0;
      return Math.min(seg({ x: x0, y: y0 }, { x: x1, y: y0 }), seg({ x: x1, y: y0 }, { x: x1, y: y1 }), seg({ x: x1, y: y1 }, { x: x0, y: y1 }), seg({ x: x0, y: y1 }, { x: x0, y: y0 }));
    }
    case 'pen':
    case 'line':
    case 'arrow':
    case 'wall': {
      let d = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, seg(pts[i], pts[i + 1]));
      return d;
    }
    case 'text': {
      const w = Math.max(40, (m.text || 'Note').length * 6.4 + 18) * k;
      const a = pts[0];
      if (p.x >= a.x && p.x <= a.x + w && p.y >= a.y - 22 * k && p.y <= a.y) return 0;
      return Math.hypot(p.x - a.x, p.y - a.y);
    }
    case 'pin':
      // The pin's head sits above its point.
      return Math.min(Math.hypot(p.x - pts[0].x, p.y - pts[0].y), Math.hypot(p.x - pts[0].x, p.y - (pts[0].y - 22 * k)));
    default:
      return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  }
}
