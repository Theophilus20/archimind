/**
 * People in the model: procedurally generated human figures (woman / man) with a walk
 * cycle. Used for live participants walking through the model and for scale figures
 * that wander between rooms through doorways.
 */
import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Appearance, BottomStyle, BuildingModel, Figure, HairStyle, Id, Vec2 } from '../model/types';
import { walkView } from './Walk';
import { myLastDoorChange, reachPulse, useDoors } from './doors';
import { useCollab } from '../collab/collab';
import { derive } from '../model/derive';
import { openingFrame, pointInPolygon } from '../model/geometry';
import { RealPerson } from './RealPerson';

const S = 1 / 1000;

export interface FigureLook {
  figure: Figure;
  /** Realistic person id (see PEOPLE). */
  person: string;
  top: string;
  bottom: string;
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  bottomStyle: BottomStyle;
  shoes: string;
}

/**
 * Realistic people from the Microsoft Rocketbox avatar library (MIT licence, © 2020 Microsoft).
 * Files live in public/people/<id>/; see public/people/LICENSE-Rocketbox.txt.
 */
export const PEOPLE: { id: string; figure: Figure; label: string }[] = [
  { id: 'f1', figure: 'woman', label: 'Blazer and trousers' },
  { id: 'f2', figure: 'woman', label: 'Top and trousers' },
  { id: 'f3', figure: 'woman', label: 'Shirt and jeans' },
  { id: 'f4', figure: 'woman', label: 'Dress and boots' },
  { id: 'f5', figure: 'woman', label: 'Hoodie and shorts' },
  { id: 'f6', figure: 'woman', label: 'Blouse and skirt' },
  { id: 'f7', figure: 'woman', label: 'Long dress and headscarf' },
  { id: 'm1', figure: 'man', label: 'Jacket and trousers' },
  { id: 'm2', figure: 'man', label: 'Denim jacket and jeans' },
  { id: 'm3', figure: 'man', label: 'Shirt and jeans' },
  { id: 'm4', figure: 'man', label: 'Polo and shorts' },
  { id: 'm5', figure: 'man', label: 'Hoodie and cap' },
  { id: 'm6', figure: 'man', label: 'Suit' },
  { id: 'm7', figure: 'man', label: 'Thobe and cap' },
];

/** Choices offered in the account menu (the 3D figure and its preview use the same values). */
export const SKIN_TONES = ['#f6d5b8', '#eabd94', '#d29b6c', '#b47a4c', '#8d5524', '#5c3a21'];
export const HAIR_COLOURS = ['#1b1210', '#3b2314', '#6a4128', '#a5703f', '#d9b56c', '#b0b0b0'];
export const CLOTH_COLOURS = ['#1a73e8', '#e37400', '#188038', '#d93025', '#8430ce', '#f9ab00', '#00897b', '#37474f', '#eceff1', '#212121', '#795548', '#ad1457'];
export const SHOE_COLOURS = ['#1f1f1f', '#5d4037', '#f5f5f5', '#1a73e8', '#c62828'];
export const HAIR_STYLES: { id: HairStyle; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'long', label: 'Long' },
  { id: 'bun', label: 'Bun' },
  { id: 'curly', label: 'Curly' },
  { id: 'none', label: 'Bald' },
];

/** A figure's look: anything the person chose, with the rest picked consistently from their id. */
export function lookFor(seed: string, figure: Figure, top: string, custom?: Appearance): FigureLook {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const forFigure = PEOPLE.filter((p) => p.figure === figure);
  const base: FigureLook = {
    figure,
    // Everyone gets a realistic person by default, picked consistently from their id.
    person: forFigure[h % forFigure.length].id,
    top,
    bottom: figure === 'woman' ? ['#37474f', '#4e342e', '#263238'][h % 3] : ['#263238', '#3e4a5b', '#4e4a44'][h % 3],
    skin: SKIN_TONES[h % SKIN_TONES.length],
    hair: HAIR_COLOURS[(h >>> 3) % 4],
    hairStyle: figure === 'woman' ? (['long', 'bun', 'curly'] as HairStyle[])[(h >>> 5) % 3] : (['short', 'curly', 'short'] as HairStyle[])[(h >>> 5) % 3],
    bottomStyle: 'trousers',
    shoes: SHOE_COLOURS[(h >>> 7) % 2],
  };
  const out = { ...base };
  if (custom) for (const [k, v] of Object.entries(custom)) if (v) (out as Record<string, unknown>)[k] = v;
  const chosen = PEOPLE.find((p) => p.id === out.person);
  if (chosen) out.figure = chosen.figure;
  else out.person = base.person; // e.g. an older "Simple" choice: everyone is a realistic person now
  return out;
}

/** Catches a person that fails to load, so the next person can be tried instead. */
class PersonBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type FigureProps = { look: FigureLook; phaseRef: React.MutableRefObject<{ phase: number; moving: number; reach?: number }>; label?: string; tagScale?: number };

/** While a person loads: a soft pulsing ring where they stand, with their name tag. Never a stand-in body. */
function LoadingMarker({ label, color, tagScale = 1 }: { label?: string; color: string; tagScale?: number }) {
  const ring = useRef<THREE.Mesh>(null);
  const tag = useMemo(() => (label ? makeTag(label, color) : null), [label, color]);
  useFrame(({ clock }) => {
    const s = 1 + 0.18 * Math.sin(clock.elapsedTime * 4);
    ring.current?.scale.set(s, s, s);
  });
  return (
    <group>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
        <ringGeometry args={[0.2, 0.28, 40]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} />
      </mesh>
      {tag && (
        <sprite position={[0, 1.9 + 0.1 * tagScale, 0]} scale={[tag.w * tagScale, tag.h * tagScale, 1]}>
          <spriteMaterial map={tag.tex} depthTest={false} transparent />
        </sprite>
      )}
    </group>
  );
}

/**
 * A walkthrough person with their name tag (RealPerson.tsx). If that person can't load, the next
 * person of the same body type is tried; only if several fail is the loading marker left.
 */
export function HumanFigure(props: FigureProps) {
  return <PersonAttempt props={props} tries={0} />;
}

function PersonAttempt({ props, tries }: { props: FigureProps; tries: number }) {
  const list = PEOPLE.filter((x) => x.figure === props.look.figure);
  const start = Math.max(0, list.findIndex((x) => x.id === props.look.person));
  const id = list[(start + tries) % list.length].id;
  const marker = <LoadingMarker label={props.label} color={props.look.top} tagScale={props.tagScale} />;
  return (
    <PersonBoundary key={id} fallback={tries < 2 ? <PersonAttempt props={props} tries={tries + 1} /> : marker}>
      <Suspense fallback={marker}>
        <RealPerson {...props} look={{ ...props.look, person: id }} makeTag={makeTag} />
      </Suspense>
    </PersonBoundary>
  );
}

function makeTag(text: string, color: string) {
  const c = document.createElement('canvas');
  const scale = 2;
  const ctx = c.getContext('2d')!;
  ctx.font = `500 ${22 * scale}px "Google Sans", Roboto, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 28 * scale;
  const h = 36 * scale;
  c.width = w;
  c.height = h;
  ctx.font = `500 ${22 * scale}px "Google Sans", Roboto, sans-serif`;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 14 * scale, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, w: (w / h) * 0.26, h: 0.26 };
}

// ---------------------------------------------------------------------------
// A figure that eases toward a target pose (live participants)
// ---------------------------------------------------------------------------

export function LiveFigure({ look, pose, receivedAt, cx, cy, label, memberId }: { look: FigureLook; pose: { x: number; y: number; yaw: number; moving: boolean; elev?: number; vx?: number; vy?: number }; receivedAt?: number; cx: number; cy: number; label: string; memberId?: string }) {
  const group = useRef<THREE.Group>(null);
  const anim = useRef({ phase: 0, moving: 0, reach: 0 });
  const seenDoor = useRef(0);
  const reachAt = useRef(0);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    // Predict where they are now from their last position and velocity (about 10 updates a second;
    // receivedAt is already shifted back by the update's age), so the figure walks smoothly.
    const ahead = pose.moving && receivedAt ? Math.min(0.6, (Date.now() - receivedAt) / 1000) : 0;
    const tx = (pose.x + (pose.vx ?? 0) * ahead - cx) * S;
    const tz = (pose.y + (pose.vy ?? 0) * ahead - cy) * S;
    // Far away (just appeared, or a jump between floors): snap; otherwise glide.
    if (Math.hypot(tx - g.position.x, tz - g.position.z) > 6) {
      g.position.x = tx;
      g.position.z = tz;
    }
    g.position.x += (tx - g.position.x) * Math.min(1, dt * 14);
    g.position.z += (tz - g.position.z) * Math.min(1, dt * 14);
    g.position.y += ((pose.elev ?? 0) - g.position.y) * Math.min(1, dt * 8);
    let diff = pose.yaw + Math.PI - g.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    g.rotation.y += diff * Math.min(1, dt * 12);
    anim.current.moving += ((pose.moving ? 1 : 0) - anim.current.moving) * Math.min(1, dt * 8);
    anim.current.phase += dt * 7 * anim.current.moving;
    // They opened or closed a door just now: raise a hand to it.
    // (Timed from when their change arrives here, so differences between computers' clocks don't matter.)
    let doorAt = 0;
    const theirs = memberId ? useCollab.getState().presence[memberId]?.doors : undefined;
    if (theirs) for (const t of Object.values(theirs)) doorAt = Math.max(doorAt, t.at);
    if (doorAt > seenDoor.current) {
      if (seenDoor.current) reachAt.current = Date.now();
      seenDoor.current = doorAt;
    }
    anim.current.reach = reachPulse(Date.now() - reachAt.current);
  });
  return (
    <group ref={group} position={[(pose.x - cx) * S, 0, (pose.y - cy) * S]}>
      <HumanFigure look={look} phaseRef={anim} label={label} />
    </group>
  );
}

/** Your own figure during a walkthrough, seen from behind when the camera is zoomed out. */
export function SelfFigure({ look, cx, cy }: { look: FigureLook; cx: number; cy: number }) {
  // When others walk with you, a small tag tells you which figure is yours.
  const together = useCollab((st) => Object.keys(st.walkers).length > 0);
  const group = useRef<THREE.Group>(null);
  const anim = useRef({ phase: 0, moving: 0, reach: 0 });
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    g.visible = walkView.third;
    anim.current.reach = reachPulse(Date.now() - myLastDoorChange());
    g.position.set((walkView.x - cx) * S, walkView.elev, (walkView.y - cy) * S);
    g.rotation.y = walkView.yaw + Math.PI;
    const m = Math.min(1, walkView.speed);
    anim.current.moving += (m - anim.current.moving) * Math.min(1, dt * 8);
    anim.current.phase += dt * 7 * Math.max(0.6, walkView.speed) * (anim.current.moving > 0.05 ? 1 : 0);
  });
  return (
    <group ref={group}>
      <HumanFigure look={look} phaseRef={anim} label={together ? 'You' : undefined} tagScale={0.6} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Wandering scale figures: move room to room through doorways
// ---------------------------------------------------------------------------

interface Agent {
  look: FigureLook;
  path: { p: Vec2; door?: Id }[];
  pos: Vec2;
  wait: number;
  room: string;
  /** Doors this figure is holding open, released a moment after passing through. */
  holding: { id: Id; at: Vec2; release?: number }[];
}

export function Wanderers({ model, cx, cy, count = 2 }: { model: BuildingModel; cx: number; cy: number; count?: number }) {
  const d = derive(model);
  const doors = useMemo(() => {
    // door centre per pair of connected rooms
    const map = new Map<string, { c: Vec2; id: Id }>();
    for (const o of model.openings) {
      if (o.kind === 'window') continue;
      const l = d.links.get(o.id);
      const w = model.walls.find((x) => x.id === o.wallId);
      if (!l?.plus || !l.minus || !w) continue;
      const c = openingFrame(o, w).center;
      map.set(`${l.plus}|${l.minus}`, { c, id: o.id });
      map.set(`${l.minus}|${l.plus}`, { c, id: o.id });
    }
    return map;
  }, [model, d]);

  const agents = useRef<Agent[]>([]);
  // Let go of any doors when the figures are hidden.
  useEffect(() => () => useDoors.setState({ held: {} }), []);
  const groups = useRef<(THREE.Group | null)[]>([]);
  const anims = useRef(Array.from({ length: count }, () => ({ phase: Math.random() * 6, moving: 0, reach: 0, reachAt: -10 })));
  const looks = useMemo(() => Array.from({ length: count }, (_, i) => lookFor(`visitor-${i}`, i % 2 ? 'man' : 'woman', ['#1a73e8', '#e37400', '#188038', '#8430ce'][i % 4])), [count]);

  // (Re)seed agents in random rooms when the model changes.
  useMemo(() => {
    useDoors.setState({ held: {} });
    const rooms = d.rooms.filter((r) => r.area > 3);
    agents.current = looks.map((look, i) => {
      const r = rooms[(i * 2 + 1) % Math.max(1, rooms.length)];
      const p = r ? { ...r.centroid } : { x: cx, y: cy };
      return { look, path: [], pos: p, wait: 1 + i, room: r?.id ?? '', holding: [] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, looks]);

  const plan = (a: Agent) => {
    // choose a neighbouring room (BFS up to 3 steps) and walk via door centres
    const start = a.room;
    const prev = new Map<string, string>();
    const q = [start];
    const seen = new Set([start]);
    while (q.length) {
      const r = q.shift()!;
      for (const n of d.connections.get(r) ?? []) if (!seen.has(n)) seen.add(n), prev.set(n, r), q.push(n);
    }
    const options = [...seen].filter((r) => r !== start);
    if (!options.length) return;
    const goal = options[Math.floor(Math.random() * options.length)];
    const chain: string[] = [goal];
    while (chain[0] !== start && prev.has(chain[0])) chain.unshift(prev.get(chain[0])!);
    const path: Agent['path'] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const door = doors.get(`${chain[i]}|${chain[i + 1]}`);
      if (door) path.push({ p: door.c, door: door.id });
    }
    const room = d.roomById.get(goal);
    if (!room) return;
    // a random spot inside the destination room
    let spot = room.centroid;
    for (let t = 0; t < 12; t++) {
      const cand = { x: room.centroid.x + (Math.random() - 0.5) * 1800, y: room.centroid.y + (Math.random() - 0.5) * 1800 };
      if (pointInPolygon(cand, room.inner)) {
        spot = cand;
        break;
      }
    }
    path.push({ p: spot });
    a.path = path;
    a.room = goal;
  };

  useFrame((state, dt) => {
    const step = Math.min(dt, 0.05);
    const clock = state.clock.elapsedTime;
    agents.current.forEach((a, i) => {
      const anim = anims.current[i];
      const g = groups.current[i];
      anim.reach = reachPulse((clock - anim.reachAt) * 1000);
      // Open a door just before reaching it; close it again once through.
      const next = a.path[0];
      if (next?.door && !a.holding.some((h) => h.id === next.door) && Math.hypot(next.p.x - a.pos.x, next.p.y - a.pos.y) < 1400) {
        useDoors.getState().hold(next.door, true);
        a.holding.push({ id: next.door, at: next.p });
        anim.reachAt = clock; // reach for the handle
      }
      for (const h of a.holding) {
        if (h.release === undefined && h.id !== a.path[0]?.door && Math.hypot(h.at.x - a.pos.x, h.at.y - a.pos.y) > 1300) h.release = clock + 1.2;
      }
      a.holding = a.holding.filter((h) => {
        if (h.release !== undefined && clock > h.release) {
          useDoors.getState().hold(h.id, false);
          anim.reachAt = clock; // and pull it closed behind them
          return false;
        }
        return true;
      });
      if (a.path.length) {
        const t = a.path[0].p;
        const dx = t.x - a.pos.x;
        const dy = t.y - a.pos.y;
        const dist = Math.hypot(dx, dy);
        const v = 1050 * step;
        if (dist <= v) {
          a.pos = { ...t };
          a.path.shift();
          if (!a.path.length) a.wait = 2 + Math.random() * 4;
        } else {
          a.pos = { x: a.pos.x + (dx / dist) * v, y: a.pos.y + (dy / dist) * v };
          if (g) {
            const want = Math.atan2(dx, dy);
            let diff = want - g.rotation.y;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            g.rotation.y += diff * Math.min(1, step * 8);
          }
        }
        anim.moving += (1 - anim.moving) * Math.min(1, step * 6);
      } else {
        anim.moving += (0 - anim.moving) * Math.min(1, step * 6);
        a.wait -= step;
        if (a.wait <= 0) plan(a);
      }
      anim.phase += step * 7 * anim.moving;
      if (g) g.position.set((a.pos.x - cx) * S, 0, (a.pos.y - cy) * S);
    });
  });

  return (
    <>
      {looks.map((look, i) => (
        <group key={i} ref={(el) => (groups.current[i] = el)}>
          <HumanFigure look={look} phaseRef={{ current: anims.current[i] }} />
        </group>
      ))}
    </>
  );
}
