/**
 * Walkthrough without pointer lock (which embedded browsers and some setups block).
 *
 * - The camera follows your own figure from behind by default; scroll or pinch to zoom
 *   from your own eyes, to just behind you, out to a view from above.
 * - Drag to turn and tilt, W A S D / arrow keys / on-screen pad to move.
 * - Click anywhere on the floor to walk there; the route goes through doorways.
 * - Walls, high windows, furniture and closed doors block you. Walking into a closed
 *   door opens it; click a door or window (or press E beside it) to open or close it.
 * - Walls between the camera and your figure fade so you never lose sight of yourself.
 */
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { BuildingModel, Id, Opening, Vec2, Wall } from '../model/types';
import { wallSolids } from '../model/wallgeom';
import { add, doorLeaves, furnitureFootprint, isDoubleDoor, isRollerDoor, mul, noSwing, openingFrame, pointInPolygon, projectOnSegment, wallDir, wallNormal } from '../model/geometry';
import { derive } from '../model/derive';
import { doorLimits, isOpen, leafAngle, leafAt, toggle } from './doors';

const S = 1 / 1000;
const EYE = 1.6;
const RADIUS = 230; // mm, body radius for collisions
export const MAX_DIST = 18; // m, furthest zoom for a small building; larger buildings zoom out further

/** How far the camera may pull back: enough to see the whole building around you from above. */
export function maxZoomFor(model: BuildingModel) {
  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  if (!xs.length) return MAX_DIST;
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * S;
  return Math.max(MAX_DIST, size * 1.5);
}

export interface WalkInput {
  forward: number;
  back: number;
  left: number;
  right: number;
  turnLeft: number;
  turnRight: number;
}
export const emptyWalkInput = (): WalkInput => ({ forward: 0, back: 0, left: 0, right: 0, turnLeft: 0, turnRight: 0 });

export interface WalkPose {
  x: number; // plan mm
  y: number;
  yaw: number;
  moving: boolean;
  /** Height of the floor you are on, m (multi-storey buildings). */
  elev?: number;
  /** Velocity, mm/s. */
  vx?: number;
  vy?: number;
}

export type WalkView = 'first' | 'follow' | 'above';

/** Shared, per-frame walk state read by the 3D view (your figure, wall fading). */
export const walkView = {
  active: false,
  third: false,
  x: 0,
  y: 0,
  yaw: 0,
  speed: 0,
  elev: 0,
  head: new THREE.Vector3(),
  cam: new THREE.Vector3(),
};

/** Buttons in the walk HUD talk to the controls through this. */
export const walkApi: {
  zoom: (delta: number) => void;
  setView: (v: WalkView) => void;
  useNearest: () => void;
} = { zoom: () => undefined, setView: () => undefined, useNearest: () => undefined };

export interface NearOpening {
  id: Id;
  kind: 'door' | 'window';
  open: boolean;
}

interface Seg {
  a: Vec2;
  b: Vec2;
  h: number;
  /** Furniture outline this edge belongs to: if you are ever inside it, you are pushed out. */
  poly?: Vec2[];
}

function obstacles(model: BuildingModel): Seg[] {
  const segs: Seg[] = [];
  for (const s of wallSolids(model)) {
    const d = wallDir(s.wall);
    for (const [a, e] of s.spans) segs.push({ a: add(s.wall.a, mul(d, a)), b: add(s.wall.a, mul(d, e)), h: s.wall.thickness / 2 });
    for (const o of s.openings) {
      if (o.kind !== 'window' || o.sill < 300) continue;
      const f = openingFrame(o, s.wall);
      segs.push({ a: f.start, b: f.end, h: s.wall.thickness / 2 });
    }
  }
  // Chairs get pushed aside and plants or a TV are small: only bigger furniture stops you.
  for (const f of model.furniture) {
    if (f.kind === 'tv' || f.kind === 'basin' || f.kind === 'chair' || f.kind === 'plant') continue;
    const fp = furnitureFootprint(f);
    for (let i = 0; i < 4; i++) segs.push({ a: fp[i], b: fp[(i + 1) % 4], h: 20, poly: fp });
  }
  return segs;
}

function collide(p: Vec2, segs: Seg[]): Vec2 {
  let q = { ...p };
  for (let pass = 0; pass < 3; pass++) {
    // Inside a piece of furniture (it was placed over you, or over the way in): step out of it
    // across its nearest edge instead of being held in by its sides.
    for (const s of segs) {
      if (!s.poly || !pointInPolygon(q, s.poly)) continue;
      let best: { point: Vec2; distance: number } | null = null;
      for (let i = 0; i < s.poly.length; i++) {
        const pr = projectOnSegment(q, s.poly[i], s.poly[(i + 1) % s.poly.length]);
        if (!best || pr.distance < best.distance) best = pr;
      }
      if (best) {
        const c = s.poly.reduce((a, v) => ({ x: a.x + v.x / s.poly!.length, y: a.y + v.y / s.poly!.length }), { x: 0, y: 0 });
        const dx = best.point.x - c.x;
        const dy = best.point.y - c.y;
        const d = Math.hypot(dx, dy) || 1;
        q = { x: best.point.x + (dx / d) * (RADIUS + s.h + 1), y: best.point.y + (dy / d) * (RADIUS + s.h + 1) };
      }
    }
    for (const s of segs) {
      const pr = projectOnSegment(q, s.a, s.b);
      const min = RADIUS + s.h;
      if (pr.distance < min) {
        const dx = q.x - pr.point.x;
        const dy = q.y - pr.point.y;
        const d = Math.hypot(dx, dy) || 1;
        q = { x: pr.point.x + (dx / d) * min, y: pr.point.y + (dy / d) * min };
      }
    }
  }
  return q;
}

/** Where the walkthrough starts: inside the front door, or beside the stairs on upper floors. */
export function walkStart(model: BuildingModel): WalkPose {
  const entrance = model.openings.find((o) => o.kind === 'door' && model.walls.find((w) => w.id === o.wallId)?.exterior);
  const stair = model.furniture.find((f) => f.kind === 'stair' || f.kind === 'stair-l' || f.kind === 'stair-u' || f.kind === 'spiral');
  if (stair && ((model.activeLevel ?? 0) > 0 || !entrance)) {
    const d = derive(model);
    const reach = Math.max(stair.w, stair.d) / 2 + 800;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const p = { x: stair.x + dx * reach, y: stair.y + dy * reach };
      const room = d.roomAt(p);
      if (room) return { x: p.x, y: p.y, yaw: Math.atan2(-(room.centroid.x - p.x), -(room.centroid.y - p.y)), moving: false };
    }
  }
  if (entrance) {
    const w = model.walls.find((x) => x.id === entrance.wallId)!;
    const f = openingFrame(entrance, w);
    // Step inside: the side of the wall that has a room behind it.
    const d = derive(model);
    const inward = d.roomAt(add(f.center, mul(f.normal, 900))) ? f.normal : mul(f.normal, -1);
    const p = add(f.center, mul(inward, 1300));
    return { x: p.x, y: p.y, yaw: Math.atan2(-inward.x, -inward.y), moving: false };
  }
  const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
  const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, yaw: 0, moving: false };
}

/** Waypoints from `from` to `to` that pass through doorways (straight line within a room). */
export function planRoute(model: BuildingModel, from: Vec2, to: Vec2): Vec2[] {
  const d = derive(model);
  const OUT = '__outside__';
  const a = d.roomAt(from)?.id ?? OUT;
  const b = d.roomAt(to)?.id ?? OUT;
  if (a === b) return [to];
  // Graph of rooms (and outside) joined by doors.
  const edges = new Map<string, { to: string; o: Opening; w: Wall }[]>();
  const addEdge = (x: string, y: string, o: Opening, w: Wall) => {
    if (!edges.has(x)) edges.set(x, []);
    edges.get(x)!.push({ to: y, o, w });
  };
  for (const o of model.openings) {
    if (o.kind === 'window') continue;
    const l = d.links.get(o.id);
    const w = model.walls.find((x) => x.id === o.wallId);
    if (!l || !w) continue;
    const p = l.plus ?? OUT;
    const m = l.minus ?? OUT;
    if (p === m) continue;
    addEdge(p, m, o, w);
    addEdge(m, p, o, w);
  }
  const prev = new Map<string, { from: string; o: Opening; w: Wall }>();
  const q = [a];
  const seen = new Set([a]);
  while (q.length) {
    const r = q.shift()!;
    if (r === b) break;
    for (const e of edges.get(r) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, { from: r, o: e.o, w: e.w });
      q.push(e.to);
    }
  }
  if (!prev.has(b)) return [to];
  const hops: { from: string; o: Opening; w: Wall }[] = [];
  for (let r = b; r !== a; r = prev.get(r)!.from) hops.unshift(prev.get(r)!);
  const pts: Vec2[] = [];
  for (const h of hops) {
    const f = openingFrame(h.o, h.w);
    const n = wallNormal(h.w);
    // Approach from the side we are on, leave on the other side.
    const onPlus = (d.links.get(h.o.id)?.plus ?? OUT) === h.from;
    const s = onPlus ? 1 : -1;
    const clear = h.w.thickness / 2 + 520;
    pts.push(add(f.center, mul(n, s * clear)), add(f.center, mul(n, -s * clear)));
  }
  pts.push(to);
  return pts;
}

export function WalkControls({
  model,
  cx,
  cy,
  input,
  onPose,
  onNear,
  onBlocked,
  elev = 0,
}: {
  model: BuildingModel;
  cx: number;
  cy: number;
  elev?: number;
  input: MutableRefObject<WalkInput>;
  onPose?: (p: WalkPose) => void;
  onNear?: (n: NearOpening | null) => void;
  onBlocked?: (doorId: Id, blocker: string) => void;
}) {
  const { camera, gl } = useThree();
  const segs = useMemo(() => obstacles(model), [model]);
  const limits = useMemo(() => doorLimits(model), [model]);
  const doors = useMemo(
    () =>
      model.openings
        .filter((o) => o.kind !== 'opening')
        .map((o) => ({ o, w: model.walls.find((w) => w.id === o.wallId)! }))
        .filter((x) => x.w)
        .map((x) => ({ ...x, f: openingFrame(x.o, x.w) })),
    [model],
  );
  const start = useMemo(() => walkStart(model), [model]);
  const maxDist = useMemo(() => maxZoomFor(model), [model]);
  const pos = useRef<Vec2>({ x: start.x, y: start.y });
  const vel = useRef<Vec2>({ x: 0, y: 0 });
  const yaw = useRef(start.yaw);
  const pitch = useRef(-0.05);
  const route = useRef<Vec2[]>([]);
  const keys = useRef<Record<string, boolean>>({});
  const lastReport = useRef(0);
  const dist = useRef({ now: 3.6, want: 3.6 });
  const near = useRef<string>('');
  const camSmooth = useRef(new THREE.Vector3());
  const warned = useRef(new Set<Id>());
  const clickedOpening = useRef(false);

  // Reset when the walkthrough starts or the model changes substantially.
  useEffect(() => {
    pos.current = collide({ x: start.x, y: start.y }, segs);
    yaw.current = start.yaw;
    pitch.current = -0.05;
    route.current = [];
    camera.rotation.order = 'YXZ';
    camSmooth.current.set(Number.NaN, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.x, start.y]);

  useEffect(() => {
    walkView.active = true;
    return () => {
      walkView.active = false;
      walkView.third = false;
    };
  }, []);

  // HUD buttons.
  useEffect(() => {
    walkApi.zoom = (delta) => {
      // Steps grow with distance, so zooming a long way out of a big building stays quick.
      const z = dist.current.want;
      dist.current.want = Math.max(0, Math.min(maxDist, z + delta * (1 + z * 0.12)));
    };
    walkApi.setView = (v) => {
      dist.current.want = v === 'first' ? 0 : v === 'follow' ? 3.6 : maxDist;
      if (v === 'first') pitch.current = -0.05;
    };
    walkApi.useNearest = () => {
      const n = nearest();
      if (n) openOrClose(n.o);
    };
  });

  const openOrClose = (o: Opening) => {
    const willOpen = !isOpen(o);
    toggle(o);
    const lim = limits.get(o.id);
    if (willOpen && o.kind === 'door' && lim?.blocker && !warned.current.has(o.id)) {
      warned.current.add(o.id);
      onBlocked?.(o.id, lim.blocker);
    }
  };

  const nearest = () => {
    let best: (typeof doors)[number] | null = null;
    let bestD = 1700;
    for (const d of doors) {
      const dd = projectOnSegment(pos.current, d.f.start, d.f.end).distance;
      if (dd < bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  };

  // Drag to look; a click without dragging walks to that spot. Wheel / pinch zoom.
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number; moved: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const ray = new THREE.Raycaster();
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -elev);
    const onDown = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        pinch = Math.hypot(p.x - q.x, p.y - q.y);
        down = null;
        return;
      }
      down = { x: e.clientX, y: e.clientY, moved: 0 };
      el.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (pinch > 0) walkApi.zoom((pinch - d) * 0.03);
        pinch = d;
        return;
      }
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      down.moved += Math.abs(dx) + Math.abs(dy);
      down.x = e.clientX;
      down.y = e.clientY;
      yaw.current -= dx * 0.005;
      pitch.current = Math.max(-1.1, Math.min(0.9, pitch.current - dy * 0.0035));
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (down && down.moved < 6) {
        const r = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        // Clicking a door or window toggles it instead of walking.
        const hit = new THREE.Vector3();
        if (!clickedOpening.current && ray.ray.intersectPlane(floor, hit)) route.current = planRoute(model, pos.current, { x: hit.x / S + cx, y: hit.z / S + cy });
      }
      clickedOpening.current = false;
      down = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      walkApi.zoom(e.deltaY * k * 0.0035);
    };
    const kd = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.code === 'KeyE' || e.code === 'KeyF') {
        walkApi.useNearest();
        return;
      }
      if (e.code === 'Equal' || e.code === 'NumpadAdd') return walkApi.zoom(-1.2);
      if (e.code === 'Minus' || e.code === 'NumpadSubtract') return walkApi.zoom(1.2);
      keys.current[e.code] = true;
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      route.current = [];
    };
    const ku = (e: KeyboardEvent) => (keys.current[e.code] = false);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [gl, camera, cx, cy, model, elev]);

  useFrame((state, dt) => {
    const k = keys.current;
    const inp = input.current;
    const step = Math.min(dt, 0.05);
    const run = k.ShiftLeft || k.ShiftRight;
    const turn = 1.9 * step;
    if (k.KeyQ || k.ArrowLeft || inp.turnLeft) yaw.current += turn;
    if (k.KeyE || k.ArrowRight || inp.turnRight) yaw.current -= turn;
    const fwd = { x: -Math.sin(yaw.current), y: -Math.cos(yaw.current) };
    const right = { x: -fwd.y, y: fwd.x };
    let mx = 0;
    let my = 0;
    const f = (k.KeyW || k.ArrowUp || inp.forward ? 1 : 0) - (k.KeyS || k.ArrowDown || inp.back ? 1 : 0);
    const s = (k.KeyD || inp.right ? 1 : 0) - (k.KeyA || inp.left ? 1 : 0);
    if (f || s) {
      route.current = [];
      mx = fwd.x * f + right.x * s;
      my = fwd.y * f + right.y * s;
    } else if (route.current.length) {
      const t = route.current[0];
      const dx = t.x - pos.current.x;
      const dy = t.y - pos.current.y;
      const d = Math.hypot(dx, dy);
      if (d < (route.current.length > 1 ? 260 : 140)) route.current.shift();
      else {
        mx = dx / d;
        my = dy / d;
        // Turn smoothly toward where we are going.
        const want = Math.atan2(-mx, -my);
        let diff = want - yaw.current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        yaw.current += diff * Math.min(1, step * 6);
      }
    }
    const len = Math.hypot(mx, my);
    const speed = run ? 2800 : 1400; // mm/s
    const want = len ? { x: (mx / len) * speed, y: (my / len) * speed } : { x: 0, y: 0 };
    const a = 1 - Math.exp(-step * 10);
    vel.current = { x: vel.current.x + (want.x - vel.current.x) * a, y: vel.current.y + (want.y - vel.current.y) * a };
    const v = Math.hypot(vel.current.x, vel.current.y);
    const moving = v > 120;

    // Doors: leaves at their current angle are obstacles; walking into a closed one opens it.
    const dyn: Seg[] = [];
    for (const d of doors) {
      if (d.o.kind !== 'door') continue;
      const ang = leafAngle.get(d.o.id) ?? 0;
      if (isRollerDoor(d.o, model.spec?.type === 'industrial') || noSwing(d.o)) {
        if (ang < 0.6) dyn.push({ a: d.f.start, b: d.f.end, h: 40 });
      } else {
        for (const leaf of isDoubleDoor(d.o, model.spec?.type === 'industrial') ? doorLeaves(d.o) : [d.o]) {
          const [h, tip] = leafAt(leaf, d.w, ang);
          dyn.push({ a: h, b: tip, h: 25 });
        }
      }
      if (len && ang < 0.35 && !isOpen(d.o)) {
        const pr = projectOnSegment(pos.current, d.f.start, d.f.end);
        if (pr.distance < RADIUS + 360) {
          const tx = d.f.center.x - pos.current.x;
          const ty = d.f.center.y - pos.current.y;
          const tl = Math.hypot(tx, ty) || 1;
          if ((mx * tx + my * ty) / (len * tl) > 0.3) openOrClose(d.o);
        }
      }
    }

    if (v > 1) {
      const next = { x: pos.current.x + vel.current.x * step, y: pos.current.y + vel.current.y * step };
      const resolved = collide(next, dyn.length ? segs.concat(dyn) : segs);
      if (route.current.length && Math.hypot(resolved.x - next.x, resolved.y - next.y) > v * step * 0.85 && v > 600) {
        // Stuck against something: give up on this route.
        route.current = [];
      }
      pos.current = resolved;
    }

    // The door or window you are standing next to (for the HUD button).
    const n = nearest();
    const key = n ? `${n.o.id}:${isOpen(n.o)}` : '';
    if (key !== near.current) {
      near.current = key;
      onNear?.(n ? { id: n.o.id, kind: n.o.kind as 'door' | 'window', open: isOpen(n.o) } : null);
    }

    // Camera: your eyes when zoomed right in, otherwise behind and above your figure.
    const z = dist.current;
    z.now += (z.want - z.now) * (1 - Math.exp(-step * 7));
    const px = (pos.current.x - cx) * S;
    const pz = (pos.current.y - cy) * S;
    const third = z.now > 0.45;
    const cam = camera as THREE.PerspectiveCamera;
    const fov = third ? 55 : 70;
    if (Math.abs(cam.fov - fov) > 0.5) {
      cam.fov += (fov - cam.fov) * 0.2;
      cam.updateProjectionMatrix();
    }
    walkView.third = third;
    walkView.x = pos.current.x;
    walkView.y = pos.current.y;
    walkView.yaw = yaw.current;
    walkView.speed = Math.min(1.6, v / 1400);
    walkView.elev = elev;
    walkView.head.set(px, elev + 1.4, pz);
    if (!third) {
      const bob = moving ? Math.sin(state.clock.elapsedTime * 9) * 0.018 : 0;
      cam.position.set(px, elev + EYE + bob, pz);
      cam.rotation.set(pitch.current, yaw.current, 0, 'YXZ');
      camSmooth.current.copy(cam.position);
    } else {
      const tilt = Math.max(0.1, Math.min(1.45, 0.28 + z.now * 0.062 - pitch.current * 0.8));
      const back = { x: Math.sin(yaw.current), z: Math.cos(yaw.current) };
      const want3 = new THREE.Vector3(px + back.x * z.now * Math.cos(tilt), elev + 1.4 + z.now * Math.sin(tilt), pz + back.z * z.now * Math.cos(tilt));
      if (Number.isNaN(camSmooth.current.x)) camSmooth.current.copy(want3);
      camSmooth.current.lerp(want3, 1 - Math.exp(-step * 12));
      cam.position.copy(camSmooth.current);
      // Look a little ahead of the figure so you see where you are going.
      cam.lookAt(px - back.x * 0.6, elev + 1.1, pz - back.z * 0.6);
    }
    walkView.cam.copy(cam.position);

    const now = state.clock.elapsedTime;
    if (onPose && now - lastReport.current > 0.12) {
      lastReport.current = now;
      onPose({ x: pos.current.x, y: pos.current.y, yaw: yaw.current, moving, elev, vx: vel.current.x, vy: vel.current.y });
    }
  });

  // Door / window meshes call this when clicked during a walk.
  useEffect(() => {
    walkClick.current = (o: Opening) => {
      clickedOpening.current = true;
      route.current = [];
      openOrClose(o);
    };
    return () => {
      walkClick.current = null;
    };
  });
  return null;
}

/** Set while walking: what a click on a door or window does. */
export const walkClick: { current: ((o: Opening) => void) | null } = { current: null };

/** Are walls between the camera and your figure? (used to fade them) */
export function blocksView(a: Vec2, b: Vec2, cx: number, cy: number, heightM: number) {
  if (!walkView.active || !walkView.third) return false;
  const ax = (a.x - cx) * S;
  const az = (a.y - cy) * S;
  const bx = (b.x - cx) * S;
  const bz = (b.y - cy) * S;
  const h = walkView.head;
  const c = walkView.cam;
  // Segment intersection in plan between the wall and the sight line head -> camera.
  const rX = c.x - h.x;
  const rZ = c.z - h.z;
  const sX = bx - ax;
  const sZ = bz - az;
  const den = rX * sZ - rZ * sX;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((ax - h.x) * sZ - (az - h.z) * sX) / den;
  const u = ((ax - h.x) * rZ - (az - h.z) * rX) / den;
  if (t < -0.05 || t > 1.05 || u < -0.08 || u > 1.08) return false;
  const y = h.y + (c.y - h.y) * Math.max(0, Math.min(1, t)) - walkView.elev;
  return y < heightM + 0.15;
}

