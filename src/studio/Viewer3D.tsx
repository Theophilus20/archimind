import { chairsPerSide, coffeeTableIds } from '../model/furnish';
import { edgeOf, porchKindOf } from '../model/porchtool';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Lightformer, OrbitControls, ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStudio } from '../state/store';
import { useCollab, broadcastCamera, broadcastWalk } from '../collab/collab';
import { WalkControls, emptyWalkInput, walkApi, walkClick, blocksView, type NearOpening, type WalkInput } from './Walk';
import { DOOR_OPEN, WINDOW_OPEN, doorLimits, isOpen, leafAngle, toggle, useDoors, type DoorLimit } from './doors';
import { LiveFigure, SelfFigure, Wanderers, lookFor } from './People';
import { Marks3D, type Mark3D } from './Marks3D';
import { roofShape, type P3 } from '../model/roof';
import { levelViews, totalHeight } from '../model/levels';
import { Canopy, Fins, RepeatShell, Slab, SpecRoofs, exteriorOutline, facadeTexture, outwardSigns, scaledBox, type RoofPiece } from './Building3D';
import { roleLabelFor } from '../state/store';
import { derive } from '../model/derive';
import { porchRoof } from '../model/porch';
import { spanEnds, wallSolids } from '../model/wallgeom';
import { bbox, openingFrame, wallAngle, wallLength, wallDir, add, mul, pointInPolygon, projectOnSegment, isRollerDoor, isDoubleDoor, doorLeaves, noSwing, furnitureFootprint } from '../model/geometry';
import { elementCenter, elementsBounds } from '../model/elements';
import { materialById } from '../model/materials';
import type { BuildingModel, CameraPose, Furniture, Id, Opening, PlanMark, Vec2, Wall } from '../model/types';
import type { Pin } from './Plan2D';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useTheme } from '../ui/hooks';
import { Icon } from '../ui/common';

export type ViewMode = 'orbit' | 'walk';

export interface ViewerSettings {
  mode: ViewMode;
  hour: number;
  section: number | null; // metres, null = no cut
  roof: boolean;
  furniture: boolean;
  doorsOpen: boolean;
  people: boolean;
  /** Multi-storey: hide the floors above the active one to see inside it. */
  cutAbove?: boolean;
}

/** Imperative hooks for screenshots and GLB export. */
export const viewerApi: { capture?: () => string; exportGLB?: () => Promise<Blob>; pose?: () => CameraPose; home?: () => void; camera?: THREE.Camera } = {};
if (import.meta.env.DEV) (window as unknown as { __viewer: typeof viewerApi }).__viewer = viewerApi;

const S = 1 / 1000; // mm → m
const HILITE = { select: '#1a73e8', preview: '#1e8e3e', finding: '#e37400', hover: '#5f6368' } as const;

interface Ctx {
  cx: number;
  cy: number;
  sel: Set<Id>;
  hover: Id | null;
  preview: Set<Id>;
  findingIds: Set<Id>;
  onPick: (id: Id, e: ThreeEvent<MouseEvent>) => void;
  onHover: (id: Id | null) => void;
  /** Walking through the model (doors toggle on click, walls fade). */
  walk: boolean;
  limits: Map<Id, DoorLimit>;
  /** Which local side windows open towards (outside). */
  outward: Map<Id, number>;
  /** Parts highlighted (or suggested for removal) in crit marks, by element id. */
  markColors?: Map<Id, string>;
  /** Industrial building: its wide doors are roller shutters. */
  industrial?: boolean;
}

const toWorld = (p: Vec2, c: Ctx): [number, number] => [(p.x - c.cx) * S, (p.y - c.cy) * S];

function emissiveFor(id: Id, c: Ctx): [string, number] {
  const mc = c.markColors?.get(id);
  if (mc) return [mc, 0.65];
  if (c.sel.has(id)) return [HILITE.select, 0.55];
  if (c.preview.has(id)) return [HILITE.preview, 0.5];
  if (c.findingIds.has(id)) return [HILITE.finding, 0.45];
  if (c.hover === id) return [HILITE.hover, 0.25];
  return ['#000000', 0];
}

/**
 * What makes a porch, deck or veranda (a space bounded by handrails) read as one: a timber deck,
 * posts at the outer corners holding a lean-to roof that slopes away from the house, and a step
 * down at the way in.
 */
function PorchExtras({ model, c }: { model: BuildingModel; c: Ctx }) {
  const parts = useMemo(() => {
    const rails = new Set(model.walls.filter((w) => w.kind === 'railing').map((w) => w.id));
    if (!rails.size) return [];
    const solid = model.walls.filter((w) => w.kind !== 'railing' && w.kind !== 'column');
    const houseH = solid.length ? Math.max(...solid.map((w) => w.height)) : 2700;
    const onHouse = (p: { x: number; y: number }) => solid.some((w) => projectOnSegment(p, w.a, w.b).distance < w.thickness / 2 + 40);
    const out: { posts: [number, number, number][]; columns: boolean; floor: 'timber' | 'paving' | 'slab'; roof: THREE.BufferGeometry | null; deck: { x: number; z: number; w: number; d: number }; steps: { x: number; z: number; w: number; angle: number }[] }[] = [];
    for (const r of derive(model).rooms) {
      if (!r.wallIds.some((id) => rails.has(id))) continue;
      const style = porchRoof(model, r);
      const kind = r.porchKind ? porchKindOf(r.porchKind) : null;
      const floor = kind?.floor ?? 'timber';
      const xs = r.polygon.map((p) => p.x);
      const ys = r.polygon.map((p) => p.y);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const mid = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const sides = { top: { x: mid.x, y: minY }, bottom: { x: mid.x, y: maxY }, left: { x: minX, y: mid.y }, right: { x: maxX, y: mid.y } };
      const house = (Object.keys(sides) as (keyof typeof sides)[]).find((k) => onHouse(sides[k])) ?? 'top';
      const hi = Math.min(houseH - 150, 2900);
      const lo = hi - 400;
      const o = 250;
      // Roof corners: the edge against the house is high, the far edge low, with an overhang.
      const corners: [number, number, number][] =
        house === 'top'
          ? [[minX - o, minY, hi], [maxX + o, minY, hi], [maxX + o, maxY + o, lo], [minX - o, maxY + o, lo]]
          : house === 'bottom'
            ? [[minX - o, maxY, hi], [maxX + o, maxY, hi], [maxX + o, minY - o, lo], [minX - o, minY - o, lo]]
            : house === 'left'
              ? [[minX, minY - o, hi], [minX, maxY + o, hi], [maxX + o, maxY + o, lo], [maxX + o, minY - o, lo]]
              : [[maxX, minY - o, hi], [maxX, maxY + o, hi], [minX - o, maxY + o, lo], [minX - o, minY - o, lo]];
      // Only a projecting porch gets a lean-to roof of its own; a recessed one is under the main roof.
      let g: THREE.BufferGeometry | null = null;
      if (style === 'own') {
        const v = corners.map(([x, y, h]) => [(x - c.cx) * S, h * S, (y - c.cy) * S]);
        g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([...v[0], ...v[1], ...v[2], ...v[0], ...v[2], ...v[3]], 3));
        g.computeVertexNormals();
      }
      // Posts at the corners away from the house: up to the main roof's eave, or the lean-to's low
      // edge. An open deck has only its handrail.
      const postTop = style === 'main' ? houseH : lo;
      const posts = [
        [minX, minY],
        [maxX, minY],
        [maxX, maxY],
        [minX, maxY],
      ]
        .filter(([x, y]) => style !== 'none' && !onHouse({ x, y }))
        .map(([x, y]) => [(x - c.cx) * S, (y - c.cy) * S, postTop * S] as [number, number, number]);
      // A step down outside each way in through the handrail (paving is at ground level).
      const steps = model.openings
        .filter((op) => floor !== 'paving' && op.kind === 'opening' && rails.has(op.wallId) && r.wallIds.includes(op.wallId))
        .map((op) => {
          const w = model.walls.find((x) => x.id === op.wallId)!;
          const f = openingFrame(op, w);
          const outN = pointInPolygon(add(f.center, mul(f.normal, 300)), r.polygon) ? mul(f.normal, -1) : f.normal;
          const p = add(f.center, mul(outN, 220));
          return { x: (p.x - c.cx) * S, z: (p.y - c.cy) * S, w: op.width * S, angle: -wallAngle(w) };
        });
      out.push({ posts, columns: r.porchKind === 'portico', floor, roof: g, deck: { x: (mid.x - c.cx) * S, z: (mid.y - c.cy) * S, w: (maxX - minX) * S, d: (maxY - minY) * S }, steps });
    }
    return out;
  }, [model, c.cx, c.cy]);
  useEffect(() => () => parts.forEach((p) => p.roof?.dispose()), [parts]);
  return (
    <group name="porches">
      {parts.map((p, i) => (
        <group key={i}>
          {/* a concrete slab under the decking */}
          {p.floor === 'slab' && (
            <mesh position={[p.deck.x, -0.1, p.deck.z]} castShadow receiveShadow>
              <boxGeometry args={[p.deck.w, 0.2, p.deck.d]} />
              <meshStandardMaterial color="#c9c5bd" roughness={0.85} />
            </mesh>
          )}
          {p.floor === 'paving'
            ? // stone paving slabs, 600 mm square
              Array.from({ length: Math.max(1, Math.round(p.deck.w / 0.6)) * Math.max(1, Math.round(p.deck.d / 0.6)) }, (_, k) => {
                const nx = Math.max(1, Math.round(p.deck.w / 0.6));
                const nz = Math.max(1, Math.round(p.deck.d / 0.6));
                const i = k % nx;
                const j = Math.floor(k / nx);
                const sw = p.deck.w / nx;
                const sd = p.deck.d / nz;
                return (
                  <mesh key={`pv${k}`} position={[p.deck.x - p.deck.w / 2 + sw * (i + 0.5), 0.012, p.deck.z - p.deck.d / 2 + sd * (j + 0.5)]} receiveShadow>
                    <boxGeometry args={[sw - 0.012, 0.024, sd - 0.012]} />
                    <meshStandardMaterial color={(i + j) % 3 === 0 ? '#cbc5ba' : (i + j) % 3 === 1 ? '#d6d0c5' : '#c2bcb0'} roughness={0.9} />
                  </mesh>
                );
              })
            : // timber deck boards
              Array.from({ length: Math.max(1, Math.floor(p.deck.d / 0.14)) }, (_, k) => (
                <mesh key={`b${k}`} position={[p.deck.x, 0.012, p.deck.z - p.deck.d / 2 + 0.07 + k * 0.14]} receiveShadow>
                  <boxGeometry args={[p.deck.w, 0.02, 0.125]} />
                  <meshStandardMaterial color={k % 2 ? '#9a7352' : '#a67c58'} roughness={0.8} />
                </mesh>
              ))}
          {p.posts.map(([x, z, h], k) =>
            p.columns ? (
              // a portico's round columns with a base and a cap
              <group key={`p${k}`} position={[x, 0, z]}>
                <mesh position={[0, h / 2, 0]} castShadow>
                  <cylinderGeometry args={[0.11, 0.13, h, 20]} />
                  <meshStandardMaterial color="#f3efe7" roughness={0.55} />
                </mesh>
                <mesh position={[0, 0.06, 0]}>
                  <boxGeometry args={[0.36, 0.12, 0.36]} />
                  <meshStandardMaterial color="#e6e1d8" roughness={0.7} />
                </mesh>
                <mesh position={[0, h - 0.06, 0]}>
                  <boxGeometry args={[0.34, 0.12, 0.34]} />
                  <meshStandardMaterial color="#e6e1d8" roughness={0.7} />
                </mesh>
              </group>
            ) : (
              <mesh key={`p${k}`} position={[x, h / 2, z]} castShadow>
                <boxGeometry args={[0.14, h, 0.14]} />
                <meshStandardMaterial color="#efe9df" roughness={0.6} />
              </mesh>
            ),
          )}
          {p.roof && (
            <mesh geometry={p.roof} castShadow receiveShadow>
              <meshStandardMaterial color="#6f7a85" roughness={0.45} metalness={0.5} side={THREE.DoubleSide} />
            </mesh>
          )}
          {p.steps.map((st, k) => (
            <mesh key={`s${k}`} position={[st.x, 0.06, st.z]} rotation={[0, st.angle, 0]} castShadow receiveShadow>
              <boxGeometry args={[st.w, 0.12, 0.32]} />
              <meshStandardMaterial color="#b9b6b0" roughness={0.85} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

/** A free-standing pillar, built the way its style says. */
function ColumnMesh({ w, c }: { w: Wall; c: Ctx }) {
  const [em, ei] = emissiveFor(w.id, c);
  const mid = toWorld({ x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }, c);
  const angle = -wallAngle(w);
  const H = w.height * S;
  const z = Math.max(w.thickness, wallLength(w)) * S;
  const mat = (color: string, rough = 0.7, metal = 0) => <meshStandardMaterial color={color} roughness={rough} metalness={metal} emissive={em} emissiveIntensity={ei} />;
  const box = (y: number, sx: number, sy: number, sz: number, color: string, rough?: number, metal?: number, x = 0, zz = 0) => (
    <mesh position={[x, y, zz]} castShadow receiveShadow>
      <boxGeometry args={[sx, sy, sz]} />
      {mat(color, rough, metal)}
    </mesh>
  );
  const cyl = (y: number, rt: number, rb: number, h: number, color: string, rough?: number) => (
    <mesh position={[0, y, 0]} castShadow receiveShadow>
      <cylinderGeometry args={[rt, rb, h, 28]} />
      {mat(color, rough)}
    </mesh>
  );
  let body: React.ReactNode;
  switch (w.columnStyle ?? 'square') {
    case 'round':
      body = cyl(H / 2, z / 2, z / 2, H, '#cfcbc4', 0.8);
      break;
    case 'classical':
      // plinth, base moulding, a slightly tapering shaft, then the capital and its square abacus
      body = (
        <>
          {box(0.07, z * 1.3, 0.14, z * 1.3, '#e9e4da', 0.6)}
          {cyl(0.18, z * 0.56, z * 0.6, 0.08, '#efeae1', 0.55)}
          {cyl(H / 2, z * 0.42, z * 0.5, H - 0.5, '#f3efe7', 0.5)}
          {cyl(H - 0.22, z * 0.6, z * 0.44, 0.12, '#efeae1', 0.55)}
          {box(H - 0.08, z * 1.25, 0.16, z * 1.25, '#e9e4da', 0.6)}
        </>
      );
      break;
    case 'brick':
      body = (
        <>
          {box((H - 0.08) / 2, z, H - 0.08, z, '#a65a3c', 0.9)}
          {box(H - 0.04, z + 0.06, 0.08, z + 0.06, '#d9d4ca', 0.8)}
        </>
      );
      break;
    case 'timber':
      body = (
        <>
          {box(H / 2 + 0.05, z, H - 0.1, z, '#b08560', 0.75)}
          {box(0.05, z + 0.04, 0.1, z + 0.04, '#5f6368', 0.4, 0.7)}
        </>
      );
      break;
    case 'steel':
      // an H section: two flanges and a web, on a base plate
      body = (
        <>
          {box(H / 2, z, H, 0.018, '#4a5058', 0.4, 0.75, 0, z / 2 - 0.009)}
          {box(H / 2, z, H, 0.018, '#4a5058', 0.4, 0.75, 0, -z / 2 + 0.009)}
          {box(H / 2, 0.012, H, z - 0.036, '#4a5058', 0.4, 0.75)}
          {box(0.01, z + 0.12, 0.02, z + 0.12, '#3c4043', 0.5, 0.6)}
        </>
      );
      break;
    default:
      body = box(H / 2, z, H, z, '#bdb9b2', 0.85);
  }
  return (
    <group position={[mid[0], 0, mid[1]]} rotation={[0, angle, 0]} onClick={(e) => c.onPick(w.id, e)} onPointerOver={(e) => (e.stopPropagation(), c.onHover(w.id))} onPointerOut={() => c.onHover(null)}>
      {body}
    </group>
  );
}

/** A handrail: posts, a top rail, a bottom rail and thin balusters, along each part of the wall. */
function RailingMesh({ solid, c }: { solid: ReturnType<typeof wallSolids>[number]; c: Ctx }) {
  const w = solid.wall;
  const dir = wallDir(w);
  const angle = -wallAngle(w);
  const [em, ei] = emissiveFor(w.id, c);
  const H = w.height * S;
  const parts: { x: number; z: number; y: number; sx: number; sy: number; sz: number }[] = [];
  const edge = edgeOf(w);
  const screens: { x: number; z: number; len: number }[] = [];
  for (const [s, e] of solid.spans) {
    const len = (e - s) * S;
    if (len < 0.05) continue;
    const mid = toWorld(add(w.a, mul(dir, (s + e) / 2)), c);
    if (edge === 'kerb') {
      // a low stone edge to the paving
      parts.push({ x: mid[0], z: mid[1], y: H / 2, sx: len, sy: H, sz: 0.16 });
      continue;
    }
    if (edge === 'screen') {
      // insect screens between posts, with a rail at waist height
      parts.push({ x: mid[0], z: mid[1], y: H - 0.04, sx: len, sy: 0.08, sz: 0.09 });
      parts.push({ x: mid[0], z: mid[1], y: 0.05, sx: len, sy: 0.1, sz: 0.09 });
      parts.push({ x: mid[0], z: mid[1], y: 0.9, sx: len, sy: 0.06, sz: 0.07 });
      const posts = Math.max(1, Math.ceil(len / 1.5));
      for (let i = 0; i <= posts; i++) {
        const p = toWorld(add(w.a, mul(dir, s + ((e - s) * i) / posts)), c);
        parts.push({ x: p[0], z: p[1], y: H / 2, sx: 0.09, sy: H, sz: 0.09 });
      }
      screens.push({ x: mid[0], z: mid[1], len });
      continue;
    }
    parts.push({ x: mid[0], z: mid[1], y: H - 0.03, sx: len, sy: 0.05, sz: 0.07 });
    parts.push({ x: mid[0], z: mid[1], y: 0.1, sx: len, sy: 0.04, sz: 0.04 });
    const posts = Math.max(1, Math.ceil(len / 1.2));
    for (let i = 0; i <= posts; i++) {
      const p = toWorld(add(w.a, mul(dir, s + ((e - s) * i) / posts)), c);
      parts.push({ x: p[0], z: p[1], y: H / 2, sx: 0.08, sy: H, sz: 0.08 });
    }
    const bars = Math.floor(len / 0.13);
    for (let i = 1; i < bars; i++) {
      const p = toWorld(add(w.a, mul(dir, s + ((e - s) * i) / bars)), c);
      parts.push({ x: p[0], z: p[1], y: (H - 0.06 + 0.12) / 2, sx: 0.02, sy: H - 0.18, sz: 0.02 });
    }
  }
  return (
    <group onClick={(e) => c.onPick(w.id, e)} onPointerOver={(e) => (e.stopPropagation(), c.onHover(w.id))} onPointerOut={() => c.onHover(null)}>
      {parts.map((p, i) => (
        <mesh key={i} position={[p.x, p.y, p.z]} rotation={[0, angle, 0]} castShadow>
          <boxGeometry args={[p.sx, p.sy, p.sz]} />
          <meshStandardMaterial color={edge === 'kerb' ? '#b9b3a8' : edge === 'screen' ? '#efe9df' : '#5b4636'} roughness={edge === 'kerb' ? 0.9 : 0.6} emissive={em} emissiveIntensity={ei} />
        </mesh>
      ))}
      {screens.map((p, i) => (
        <mesh key={`scr${i}`} position={[p.x, H / 2, p.z]} rotation={[0, angle, 0]}>
          <boxGeometry args={[p.len, H - 0.12, 0.01]} />
          <meshStandardMaterial color="#2b3033" transparent opacity={0.32} roughness={0.9} depthWrite={false} emissive={em} emissiveIntensity={ei} />
        </mesh>
      ))}
      {/* invisible panel so the railing is easy to click */}
      {solid.spans.map(([s, e], i) => {
        const mid = toWorld(add(w.a, mul(dir, (s + e) / 2)), c);
        return (
          <mesh key={`hit${i}`} position={[mid[0], H / 2, mid[1]]} rotation={[0, angle, 0]}>
            <boxGeometry args={[(e - s) * S, H, 0.12]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function WallMesh({ solid, c }: { solid: ReturnType<typeof wallSolids>[number]; c: Ctx }) {
  const w = solid.wall;
  const mat = materialById(w.materialId);
  const dir = wallDir(w);
  const angle = -wallAngle(w);
  const [em, ei] = emissiveFor(w.id, c);
  const H = w.height * S;
  const T = w.thickness * S;
  const boxes: { along: number; len: number; y0: number; y1: number; ends?: { sL: number; sR: number; eL: number; eR: number } }[] = [];
  solid.spans.forEach(([s, e]) => {
    const ends = spanEnds(solid, s, e);
    const mitred = Math.abs(ends.sL - s) > 1 || Math.abs(ends.sR - s) > 1 || Math.abs(ends.eL - e) > 1 || Math.abs(ends.eR - e) > 1;
    boxes.push({ along: (s + e) / 2, len: e - s, y0: 0, y1: H, ends: mitred ? ends : undefined });
  });
  for (const o of solid.openings) {
    const top = (o.sill + o.height) * S;
    if (o.sill > 0) boxes.push({ along: o.offset, len: o.width, y0: 0, y1: o.sill * S });
    if (top < H - 0.001) boxes.push({ along: o.offset, len: o.width, y0: top, y1: H });
  }
  // One material per wall so it can fade when it hides your figure during a walk.
  const curtain = w.materialId === 'curtain';
  const base = curtain ? 0.62 : 1;
  const material = useMemo(() => {
    const tex = facadeTexture(w.materialId);
    return new THREE.MeshStandardMaterial({
      color: tex ? '#ffffff' : mat.color,
      map: tex,
      roughness: curtain ? 0.1 : mat.roughness,
      metalness: curtain ? 0.4 : mat.metalness,
      envMapIntensity: curtain ? 1.7 : 1,
      transparent: curtain,
      opacity: base,
      depthWrite: !curtain,
    });
  }, [mat, w.materialId, curtain, base]);
  const geos = useMemo(
    () =>
      boxes.map((b) => {
        const g = scaledBox(b.len * S, b.y1 - b.y0, T, w.materialId, H + 0.25);
        if (b.ends) {
          // Mitred end: move each end vertex to where its face really ends. In the wall's local
          // frame, -z is the wallNormal (L) face and +z the R face.
          const pos = g.attributes.position as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            const start = pos.getX(i) < 0;
            const left = pos.getZ(i) < 0;
            const along = start ? (left ? b.ends.sL : b.ends.sR) : left ? b.ends.eL : b.ends.eR;
            pos.setX(i, (along - b.along) * S);
          }
          pos.needsUpdate = true;
          g.computeVertexNormals();
        }
        return g;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(boxes), T, w.materialId, H],
  );
  useEffect(() => {
    material.emissive.set(em);
    material.emissiveIntensity = ei;
  }, [material, em, ei]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame((_, dt) => {
    const hide = c.walk && blocksView(w.a, w.b, c.cx, c.cy, H);
    const want = hide ? 0.14 : base;
    if (Math.abs(material.opacity - want) < 0.01) return;
    material.opacity += (want - material.opacity) * Math.min(1, dt * 10);
    const transparent = curtain || material.opacity < 0.98;
    if (transparent !== material.transparent) {
      material.transparent = transparent;
      material.depthWrite = !transparent;
      material.needsUpdate = true;
    }
  });
  return (
    <group
      onClick={(e) => c.onPick(w.id, e)}
      onPointerOver={(e) => {
        e.stopPropagation();
        c.onHover(w.id);
      }}
      onPointerOut={() => c.onHover(null)}
    >
      {boxes.map((b, i) => {
        const p = add(w.a, mul(dir, b.along));
        const [x, z] = toWorld(p, c);
        const h = b.y1 - b.y0;
        return (
          <group key={i} position={[x, b.y0 + h / 2, z]} rotation={[0, angle, 0]}>
            <mesh castShadow={!curtain} receiveShadow material={material} geometry={geos[i]} />
            {/* poché: back faces read as solid when a section plane cuts the wall */}
            {!c.walk && (
              <mesh geometry={geos[i]}>
                <meshBasicMaterial color="#2d3135" side={THREE.BackSide} />
              </mesh>
            )}
          </group>
        );
      })}
      {solid.openings.flatMap((o) =>
        // A pair of doors: two half-width leaves sharing the door's open or closed state.
        isDoubleDoor(o, c.industrial) ? doorLeaves(o).map((leaf, i) => <OpeningMesh key={`${o.id}-${i}`} o={leaf} w={w} c={c} />) : [<OpeningMesh key={o.id} o={o} w={w} c={c} />],
      )}
    </group>
  );
}

function OpeningMesh({ o, w, c }: { o: Opening; w: Wall; c: Ctx }) {
  const f = openingFrame(o, w);
  const angle = -wallAngle(w);
  const [em, ei] = emissiveFor(o.id, c);
  const T = w.thickness * S;
  const moving = useRef<THREE.Group>(null);
  const roller = isRollerDoor(o, c.industrial);
  const sliding = o.kind === 'door' && o.style === 'sliding';
  const pocket = o.kind === 'door' && o.style === 'pocket';
  const folding = o.kind === 'door' && o.style === 'folding';
  const foldRefs = useRef<(THREE.Group | null)[]>([]);
  const limit = o.kind === 'door' ? (roller || noSwing(o) ? DOOR_OPEN : (c.limits.get(o.id)?.max ?? DOOR_OPEN)) : WINDOW_OPEN;
  // folding: leaves per side, and which way (local z) they fold out
  const foldN = o.width > 1100 ? 2 : 1;
  const foldLw = (o.width * S) / (foldN * 2);
  const foldZ = -o.swing;
  const outward = c.outward.get(o.id) ?? 1;
  const closedDir = Math.atan2(-(f.closedTip.y - f.hingePoint.y), f.closedTip.x - f.hingePoint.x);
  const swingSign = (f.closedTip.x - f.hingePoint.x) * f.swingDir.y - (f.closedTip.y - f.hingePoint.y) * f.swingDir.x > 0 ? -1 : 1;

  // Ease each leaf / sash toward open or closed; the walk reads the angle for collisions.
  useFrame((_, dt) => {
    if (o.kind === 'opening') return;
    const target = isOpen(o) ? limit : 0;
    const cur = leafAngle.get(o.id);
    // Respond at once: a quick swing (about 0.3 s) in step with the hand reaching for it.
    const step = Math.max(Math.abs(target - cur!) * Math.min(1, dt * 12), dt * 2.2);
    const next = cur === undefined ? target : Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
    leafAngle.set(o.id, next);
    if (folding) {
      // each side's leaves fold back in a zigzag towards their jamb
      const th = (next / limit) * ((80 * Math.PI) / 180);
      const W = o.width * S;
      foldRefs.current.forEach((leaf, i) => {
        if (!leaf) return;
        const right = i >= foldN;
        const k = right ? i - foldN : i;
        const x = right ? W / 2 - k * foldLw * Math.cos(th) : -W / 2 + k * foldLw * Math.cos(th);
        leaf.position.set(x, 0, k % 2 ? foldZ * foldLw * Math.sin(th) : 0);
        leaf.rotation.y = right ? Math.PI + (k % 2 ? -1 : 1) * foldZ * th : (k % 2 ? 1 : -1) * foldZ * th;
      });
      return;
    }
    const g = moving.current;
    if (!g) return;
    if (roller) g.position.y = (next / limit) * o.height * S * 0.88;
    else if (sliding) g.position.x = -(next / limit) * o.width * S * 0.46;
    else if (pocket) g.position.x = (o.hinge === 'start' ? -1 : 1) * (next / limit) * o.width * S * 0.96;
    else if (o.kind === 'door') g.rotation.y = closedDir + swingSign * next;
    else g.rotation.y = -outward * next;
  });

  const pick = {
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (c.walk && walkClick.current) {
        walkClick.current(o);
        return;
      }
      // In the overview a click opens or closes it, and selects it for editing.
      toggle(o);
      c.onPick(o.id, e);
    },
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      c.onHover(o.id);
    },
    onPointerOut: () => c.onHover(null),
  };
  if (o.kind === 'window') {
    const [x, z] = toWorld(f.center, c);
    const W = o.width * S;
    const Hh = o.height * S;
    const y = (o.sill + o.height / 2) * S;
    const fr = 0.05;
    const frameMat = <meshStandardMaterial color="#37404a" roughness={0.45} metalness={0.5} emissive={em} emissiveIntensity={ei} />;
    return (
      <group position={[x, y, z]} rotation={[0, angle, 0]} {...pick}>
        {/* fixed outer frame */}
        {[
          [0, Hh / 2 - fr / 2, W, fr],
          [0, -Hh / 2 + fr / 2, W, fr],
          [W / 2 - fr / 2, 0, fr, Hh],
          [-W / 2 + fr / 2, 0, fr, Hh],
        ].map(([px, py, sx, sy], i) => (
          <mesh key={i} position={[px, py, 0]} castShadow>
            <boxGeometry args={[sx, sy, Math.min(0.07, T)]} />
            {frameMat}
          </mesh>
        ))}
        {/* opening sash, hinged on its left edge */}
        <group ref={moving} position={[-W / 2 + fr, 0, 0]}>
          <mesh position={[(W - 2 * fr) / 2, 0, 0]}>
            <boxGeometry args={[W - 2 * fr, Hh - 2 * fr, 0.012]} />
            <meshPhysicalMaterial color="#bfe3f2" roughness={0.04} metalness={0} transparent opacity={0.28} envMapIntensity={1.6} emissive={em} emissiveIntensity={ei} />
          </mesh>
          {[
            [(W - 2 * fr) / 2, (Hh - 2 * fr) / 2, W - 2 * fr, 0.03],
            [(W - 2 * fr) / 2, -(Hh - 2 * fr) / 2, W - 2 * fr, 0.03],
            [W - 2 * fr, 0, 0.03, Hh - 2 * fr],
            [0, 0, 0.03, Hh - 2 * fr],
          ].map(([px, py, sx, sy], i) => (
            <mesh key={i} position={[px, py, 0]}>
              <boxGeometry args={[sx, sy, 0.04]} />
              {frameMat}
            </mesh>
          ))}
        </group>
        <mesh position={[0, -Hh / 2 - 0.015, T / 2 - 0.02]} castShadow>
          <boxGeometry args={[W + 0.04, 0.03, Math.max(0.06, T * 0.5)]} />
          <meshStandardMaterial color="#e8e4dc" roughness={0.6} />
        </mesh>
      </group>
    );
  }
  if (o.kind === 'opening') return null;
  if (sliding) {
    // A sliding patio door: an aluminium outer frame (head track, sill track and jambs) set in
    // the wall, two framed glass panels on separate tracks, the right one sliding behind the
    // other, with a pull handle on its outer stile.
    const [mx, mz] = toWorld(f.center, c);
    const Wd = o.width * S;
    const Hd = (o.height - 10) * S;
    const pw = Wd * 0.53;
    const D = Math.max(0.1, Math.min(T * 0.85, 0.16)); // frame depth across the wall
    const prof = 0.07; // panel stile and rail width
    const alu = <meshStandardMaterial color="#2f3439" roughness={0.38} metalness={0.65} emissive={em} emissiveIntensity={ei} />;
    const panel = (key: string, x: number, z: number, handle: number) => (
      <group key={key} position={[x, 0, z]}>
        <mesh position={[0, Hd / 2, 0]}>
          <boxGeometry args={[pw - 2 * prof, Hd - 2 * prof - 0.04, 0.014]} />
          <meshPhysicalMaterial color="#8fc3d6" roughness={0.05} metalness={0.1} transparent opacity={0.48} envMapIntensity={1.8} emissive={em} emissiveIntensity={ei} />
        </mesh>
        {[
          [0, Hd - 0.02 - prof / 2, pw, prof],
          [0, 0.02 + prof / 2 + 0.02, pw, prof + 0.04],
          [-pw / 2 + prof / 2, Hd / 2, prof, Hd - 0.04],
          [pw / 2 - prof / 2, Hd / 2, prof, Hd - 0.04],
        ].map(([px, py, sx, sy], i) => (
          <mesh key={i} position={[px, py, 0]} castShadow>
            <boxGeometry args={[sx, sy, 0.05]} />
            {alu}
          </mesh>
        ))}
        {handle !== 0 &&
          [1, -1].map((side) => (
            <mesh key={side} position={[handle * (pw / 2 - prof / 2), 1.0, side * 0.04]} castShadow>
              <boxGeometry args={[0.025, 0.32, 0.03]} />
              <meshStandardMaterial color="#c9ced3" roughness={0.25} metalness={0.9} />
            </mesh>
          ))}
      </group>
    );
    return (
      <group {...pick} position={[mx, 0, mz]} rotation={[0, angle, 0]}>
        {/* outer frame: head track, sill track (with its two rails) and the side jambs */}
        <mesh position={[0, Hd + 0.03, 0]} castShadow>
          <boxGeometry args={[Wd + 0.04, 0.06, D]} />
          {alu}
        </mesh>
        <mesh position={[0, 0.012, 0]} receiveShadow>
          <boxGeometry args={[Wd + 0.04, 0.024, D]} />
          {alu}
        </mesh>
        {[-0.035, 0.035].map((z) => (
          <mesh key={z} position={[0, 0.03, z]}>
            <boxGeometry args={[Wd, 0.012, 0.008]} />
            <meshStandardMaterial color="#9aa0a6" roughness={0.3} metalness={0.8} />
          </mesh>
        ))}
        {[-1, 1].map((sd) => (
          <mesh key={sd} position={[sd * (Wd / 2 + 0.005), Hd / 2, 0]} castShadow>
            <boxGeometry args={[0.05, Hd + 0.06, D]} />
            {alu}
          </mesh>
        ))}
        {panel('fixed', -Wd / 2 + pw / 2, -0.035, 0)}
        <group ref={moving}>{panel('slide', Wd / 2 - pw / 2, 0.035, 1)}</group>
        {/* invisible face so the opening is easy to click */}
        <mesh position={[0, Hd / 2, 0]}>
          <planeGeometry args={[Wd, Hd]} />
          <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }
  if (pocket || folding) {
    const [mx, mz] = toWorld(f.center, c);
    const Wd = o.width * S;
    const Hd = (o.height - 10) * S;
    const leafMat = <meshStandardMaterial color="#d8c3a5" roughness={0.65} emissive={em} emissiveIntensity={ei} />;
    return (
      <group {...pick} position={[mx, 0, mz]} rotation={[0, angle, 0]}>
        {pocket ? (
          // one leaf that slides into the wall (the wall hides it when open)
          <group ref={moving}>
            <mesh position={[0, Hd / 2, 0]} castShadow receiveShadow>
              <boxGeometry args={[Wd - 0.01, Hd, 0.04]} />
              {leafMat}
            </mesh>
            {[0.03, -0.03].map((z) => (
              <mesh key={z} position={[(o.hinge === 'start' ? 1 : -1) * (Wd / 2 - 0.06), 1.0, z]}>
                <boxGeometry args={[0.03, 0.12, 0.012]} />
                <meshStandardMaterial color="#9aa0a6" metalness={0.8} roughness={0.3} />
              </mesh>
            ))}
          </group>
        ) : (
          // leaves hinged to each other, folding back to each side
          Array.from({ length: foldN * 2 }, (_, i) => {
            const right = i >= foldN;
            const k = right ? i - foldN : i;
            return (
              <group key={i} ref={(g) => {
                  foldRefs.current[i] = g;
                }} position={[right ? Wd / 2 - k * foldLw : -Wd / 2 + k * foldLw, 0, 0]} rotation={[0, right ? Math.PI : 0, 0]}>
                <mesh position={[foldLw / 2, Hd / 2, 0]} castShadow receiveShadow>
                  <boxGeometry args={[foldLw - 0.012, Hd, 0.03]} />
                  {leafMat}
                </mesh>
              </group>
            );
          })
        )}
        {/* invisible face so the opening is easy to click */}
        <mesh position={[0, Hd / 2, 0]}>
          <planeGeometry args={[Wd, Hd]} />
          <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }
  if (roller) {
    // Ribbed shutter that rolls up into a box above the opening.
    const [mx, mz] = toWorld(f.center, c);
    const Wd = o.width * S;
    const Hd = o.height * S;
    return (
      <group {...pick} position={[mx, 0, mz]} rotation={[0, angle, 0]}>
        <group ref={moving}>
          {Array.from({ length: Math.max(6, Math.round(Hd / 0.25)) }, (_, i) => (
            <mesh key={i} position={[0, 0.125 + i * 0.25, 0]} castShadow>
              <boxGeometry args={[Wd - 0.04, 0.23, 0.05]} />
              <meshStandardMaterial color={i % 2 ? '#aeb4ba' : '#bfc5ca'} metalness={0.55} roughness={0.4} emissive={em} emissiveIntensity={ei} />
            </mesh>
          ))}
        </group>
        <mesh position={[0, Hd + 0.2, 0]} castShadow>
          <boxGeometry args={[Wd + 0.1, 0.4, Math.max(0.3, T)]} />
          <meshStandardMaterial color="#5f6368" metalness={0.5} roughness={0.4} />
        </mesh>
        <mesh position={[0, Hd / 2, 0]}>
          <planeGeometry args={[Wd, Hd]} />
          <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
        </mesh>
      </group>
    );
  }
  // Door leaf hinged on the face it swings towards.
  const [hx, hz] = toWorld(f.hingePoint, c);
  const leafW = (o.width - 20) * S;
  const leafH = (o.height - 10) * S;
  return (
    <group {...pick}>
      <group ref={moving} position={[hx, 0, hz]} rotation={[0, closedDir, 0]}>
        <mesh position={[leafW / 2, leafH / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[leafW, leafH, 0.04]} />
          <meshStandardMaterial color="#d8c3a5" roughness={0.65} emissive={em} emissiveIntensity={ei} />
        </mesh>
        {[0.04, -0.04].map((side) => (
          <mesh key={side} position={[leafW - 0.08, 1.0, side]}>
            <boxGeometry args={[0.12, 0.02, 0.02]} />
            <meshStandardMaterial color="#9aa0a6" metalness={0.8} roughness={0.3} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Floors({ model, c, holes = [] }: { model: BuildingModel; c: Ctx; holes?: Vec2[][] }) {
  const d = derive(model);
  return (
    <>
      {d.rooms.map((r) => {
        const shape = new THREE.Shape(r.inner.map((p) => new THREE.Vector2((p.x - c.cx) * S, -(p.y - c.cy) * S)));
        // the opening a stair comes up through
        for (const h of holes) {
          const mid = { x: h.reduce((a, p) => a + p.x, 0) / h.length, y: h.reduce((a, p) => a + p.y, 0) / h.length };
          if (!pointInPolygon(mid, r.inner)) continue;
          shape.holes.push(new THREE.Path([...h].reverse().map((p) => new THREE.Vector2((p.x - c.cx) * S, -(p.y - c.cy) * S))));
        }
        const mat = materialById(r.floorMaterialId);
        const [em, ei] = emissiveFor(r.id, c);
        return (
          <mesh
            key={r.id}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.004, 0]}
            receiveShadow
            onClick={(e) => c.onPick(r.id, e)}
            onPointerOver={(e) => {
              e.stopPropagation();
              c.onHover(r.id);
            }}
            onPointerOut={() => c.onHover(null)}
          >
            <shapeGeometry args={[shape]} />
            <meshStandardMaterial color={mat.color} roughness={mat.roughness} emissive={em} emissiveIntensity={ei * 0.6} />
          </mesh>
        );
      })}
    </>
  );
}

/** The furniture of one level (coffee tables told apart from dining tables by where they stand). */
function FurnitureSet({ model, c }: { model: BuildingModel; c: Ctx }) {
  const coffee = useMemo(() => coffeeTableIds(model), [model]);
  return (
    <>
      {model.furniture.map((f) => (
        <FurnitureMesh key={f.id} f={f} c={c} low={coffee.has(f.id)} />
      ))}
    </>
  );
}

function FurnitureMesh({ f, c, low = false }: { f: Furniture; c: Ctx; low?: boolean }) {
  const [x, z] = toWorld({ x: f.x, y: f.y }, c);
  const [em, ei] = emissiveFor(f.id, c);
  const W = f.w * S;
  const D = f.d * S;
  const m = (color: string, rough = 0.8, metal = 0) => <meshStandardMaterial color={color} roughness={rough} metalness={metal} emissive={em} emissiveIntensity={ei} />;
  const box = (px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: string, rough?: number, metal?: number, key?: string) => (
    <mesh key={key ?? `${px}${py}${pz}${sx}`} position={[px, py, pz]} castShadow receiveShadow>
      <boxGeometry args={[sx, sy, sz]} />
      {m(color, rough, metal)}
    </mesh>
  );
  let body: React.ReactNode = null;
  switch (f.kind) {
    case 'bed':
      body = (
        <>
          {box(0, 0.15, 0, W, 0.3, D, '#8d7b68')}
          {box(0, 0.38, 0.05, W - 0.04, 0.16, D - 0.1, '#f5f2ec', 1)}
          {box(0, 0.48, D * 0.18, W - 0.06, 0.06, D * 0.62, '#9fb3c8', 1)}
          {box(-W / 4, 0.52, -D / 2 + 0.28, W / 2 - 0.12, 0.12, 0.36, '#ffffff', 1)}
          {box(W / 4, 0.52, -D / 2 + 0.28, W / 2 - 0.12, 0.12, 0.36, '#ffffff', 1)}
          {box(0, 0.55, -D / 2 + 0.03, W, 1.1, 0.06, '#6f5b4a')}
        </>
      );
      break;
    case 'desk':
      body = (
        <>
          {box(0, 0.74, 0, W, 0.03, D, '#d8c3a5', 0.6)}
          {[-1, 1].map((sx) => [-1, 1].map((sz) => box((sx * (W - 0.06)) / 2, 0.37, (sz * (D - 0.06)) / 2, 0.035, 0.74, 0.035, '#37404a', 0.4, 0.6, `l${sx}${sz}`)))}
          {/* chair tucked in under the desk edge */}
          {box(0, 0.45, D / 2 + 0.1, 0.45, 0.06, 0.45, '#5f6368')}
          {box(0, 0.75, D / 2 + 0.31, 0.45, 0.55, 0.05, '#5f6368')}
        </>
      );
      break;
    case 'sofa':
      body = (
        <>
          {box(0, 0.22, 0.05, W, 0.36, D - 0.1, '#7d8a96', 1)}
          {box(0, 0.42, 0.08, W - 0.3, 0.12, D - 0.35, '#8a97a3', 1)}
          {box(0, 0.55, -D / 2 + 0.11, W, 0.7, 0.22, '#6f7c88', 1)}
          {box(-W / 2 + 0.1, 0.38, 0.05, 0.2, 0.42, D - 0.1, '#6f7c88', 1)}
          {box(W / 2 - 0.1, 0.38, 0.05, 0.2, 0.42, D - 0.1, '#6f7c88', 1)}
        </>
      );
      break;
    case 'table': {
      if (low) {
        // coffee table: low, no chairs
        body = (
          <>
            {box(0, 0.4, 0, W, 0.04, D, '#c49a6c', 0.45)}
            {[-1, 1].map((sx) => [-1, 1].map((sz) => box((sx * (W - 0.1)) / 2, 0.19, (sz * (D - 0.1)) / 2, 0.04, 0.38, 0.04, '#6f4e3a', 0.6, 0, `t${sx}${sz}`)))}
          </>
        );
        break;
      }
      // dining table with a chair per 600 mm along each long side
      const n = chairsPerSide(f.w);
      const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * (W / n));
      body = (
        <>
          {box(0, 0.74, 0, W, 0.04, D, '#c49a6c', 0.5)}
          {[-1, 1].map((sx) => [-1, 1].map((sz) => box((sx * (W - 0.12)) / 2, 0.37, (sz * (D - 0.12)) / 2, 0.05, 0.72, 0.05, '#6f4e3a', 0.6, 0, `t${sx}${sz}`)))}
          {[-1, 1].map((sz) => xs.map((cx, i) => box(cx, 0.45, sz * (D / 2 + 0.28), 0.42, 0.04, 0.42, '#37404a', 0.6, 0, `c${i}${sz}`)))}
          {[-1, 1].map((sz) => xs.map((cx, i) => box(cx, 0.7, sz * (D / 2 + 0.48), 0.42, 0.5, 0.03, '#37404a', 0.6, 0, `cb${i}${sz}`)))}
        </>
      );
      break;
    }
    case 'wardrobe':
      body = (
        <>
          {box(0, 1.05, 0, W, 2.1, D, '#e7dfd3', 0.7)}
          {box(0, 1.05, D / 2 + 0.001, 0.01, 2.0, 0.005, '#9aa0a6')}
        </>
      );
      break;
    case 'sideboard':
      // low cabinet (about 80 cm), a darker top and door joints on the front
      body = (
        <>
          {box(0, 0.38, 0, W, 0.76, D, '#d9cbb5', 0.65)}
          {box(0, 0.78, 0, W + 0.02, 0.03, D + 0.02, '#8a6a4f', 0.5)}
          {Array.from({ length: Math.max(1, Math.round(W / 0.5)) - 1 }, (_, i) => box(-W / 2 + ((i + 1) * W) / Math.max(1, Math.round(W / 0.5)), 0.4, D / 2 + 0.002, 0.008, 0.66, 0.004, '#9aa0a6', 0.6, 0, `j${i}`))}
        </>
      );
      break;
    case 'kitchen':
      body = (
        <>
          {box(0, 0.44, 0, W, 0.88, D, '#f1eee8', 0.5)}
          {box(0, 0.9, 0, W + 0.02, 0.04, D + 0.02, '#3c4043', 0.35)}
          {box(0, 1.85, -D / 2 + 0.18, W, 0.7, 0.35, '#f1eee8', 0.5)}
          {box(-W / 2 + 0.6, 0.93, 0, 0.6, 0.02, 0.5, '#202124', 0.2, 0.4)}
        </>
      );
      break;
    case 'bath':
      body = (
        <>
          {box(0, 0.28, 0, W, 0.56, D, '#ffffff', 0.15)}
          {box(0, 0.5, 0, W - 0.14, 0.1, D - 0.14, '#cfe8f3', 0.05)}
        </>
      );
      break;
    case 'wc':
      body = (
        <>
          {box(0, 0.2, 0.05, W * 0.8, 0.4, D * 0.7, '#ffffff', 0.15)}
          {box(0, 0.55, -D / 2 + 0.09, W, 0.5, 0.18, '#ffffff', 0.15)}
        </>
      );
      break;
    case 'basin':
      body = (
        <>
          {box(0, 0.42, 0, W, 0.84, D, '#d8c3a5', 0.6)}
          {box(0, 0.86, 0, W - 0.06, 0.04, D - 0.06, '#ffffff', 0.15)}
          {box(0, 1.5, -D / 2 + 0.01, W * 0.9, 0.7, 0.02, '#dfe8ee', 0.05, 0.9)}
        </>
      );
      break;
    case 'tv':
      body = (
        <>
          {box(0, 0.22, 0, W, 0.44, D, '#3c4043', 0.6)}
          {box(0, 1.0, -D / 4, W * 0.75, 0.62, 0.04, '#111111', 0.2, 0.3)}
        </>
      );
      break;
    case 'chair':
      body = (
        <>
          {box(0, 0.45, 0, W * 0.9, 0.05, D * 0.9, '#5f6368', 0.6)}
          {box(0, 0.72, -D * 0.42, W * 0.9, 0.5, 0.04, '#5f6368', 0.6)}
          {[-1, 1].map((sx) => [-1, 1].map((sz) => box((sx * W * 0.4), 0.22, (sz * D * 0.4), 0.035, 0.44, 0.035, '#37404a', 0.4, 0.6, `ch${sx}${sz}`)))}
        </>
      );
      break;
    case 'workstation':
      body = (
        <>
          {box(0, 0.73, 0, W, 0.03, D, '#f1eee8', 0.6)}
          {box(-W / 2 + 0.03, 0.36, 0, 0.04, 0.72, D - 0.06, '#5f6368', 0.4, 0.5, 'l1')}
          {box(W / 2 - 0.03, 0.36, 0, 0.04, 0.72, D - 0.06, '#5f6368', 0.4, 0.5, 'l2')}
          {box(0, 0.95, -D / 2 + 0.03, W, 0.4, 0.03, '#7d8a96', 1)}
          {box(-W / 4, 0.95, -D / 4, 0.5, 0.3, 0.02, '#202124', 0.3, 0.2, 'm1')}
          {box(W / 4, 0.95, -D / 4, 0.5, 0.3, 0.02, '#202124', 0.3, 0.2, 'm2')}
        </>
      );
      break;
    case 'meeting':
      body = (
        <>
          {box(0, 0.74, 0, W, 0.04, D, '#c39a6b', 0.5)}
          {box(0, 0.37, 0, Math.max(0.2, W - 0.8), 0.7, 0.12, '#37404a', 0.4, 0.5)}
          {Array.from({ length: Math.max(2, Math.floor(W / 0.8)) }, (_, i) => {
            const x = -W / 2 + 0.4 + i * ((W - 0.8) / Math.max(1, Math.floor(W / 0.8) - 1));
            return (
              <group key={i}>
                {box(x, 0.45, D / 2 + 0.3, 0.45, 0.08, 0.45, '#5f6368', 0.8, 0, `a${i}`)}
                {box(x, 0.45, -D / 2 - 0.3, 0.45, 0.08, 0.45, '#5f6368', 0.8, 0, `b${i}`)}
              </group>
            );
          })}
        </>
      );
      break;
    case 'counter':
      body = (
        <>
          {box(0, 0.55, 0, W, 1.1, D, '#e8e4dc', 0.6)}
          {box(0, 1.12, 0, W + 0.04, 0.04, D + 0.04, '#37404a', 0.3, 0.3)}
        </>
      );
      break;
    case 'machine':
      body = (
        <>
          {box(0, 0.9, 0, W, 1.8, D, '#e0a526', 0.5, 0.3)}
          {box(0, 1.85, 0, W * 0.6, 0.2, D * 0.6, '#37404a', 0.4, 0.6)}
          {box(W / 2 + 0.01, 1.2, 0, 0.02, 0.5, D * 0.5, '#202124', 0.3, 0.2)}
        </>
      );
      break;
    case 'conveyor':
      body = (
        <>
          {box(0, 0.85, 0, W, 0.08, D, '#3c4043', 0.6, 0.4)}
          {box(0, 0.9, 0, W - 0.1, 0.02, D - 0.2, '#202124', 0.9)}
          {Array.from({ length: Math.max(2, Math.floor(W / 1.5)) }, (_, i) => box(-W / 2 + 0.2 + i * 1.5, 0.42, 0, 0.08, 0.84, D - 0.1, '#9aa0a6', 0.4, 0.6, `c${i}`))}
        </>
      );
      break;
    case 'rack':
      body = (
        <>
          {[0.1, 1.2, 2.3, 3.4].map((h) => box(0, h, 0, W, 0.06, D, '#e37400', 0.5, 0.3, `s${h}`))}
          {Array.from({ length: Math.max(2, Math.floor(W / 2.7) + 1) }, (_, i) => box(-W / 2 + i * (W / Math.max(1, Math.floor(W / 2.7))), 1.8, 0, 0.08, 3.6, D, '#1a73e8', 0.4, 0.5, `u${i}`))}
          {Array.from({ length: Math.max(1, Math.floor(W / 1.4)) }, (_, i) => box(-W / 2 + 0.7 + i * 1.4, 0.65, 0, 1.1, 0.9, D * 0.85, '#c8a979', 0.9, 0, `p${i}`))}
        </>
      );
      break;
    case 'stair': {
      // a straight flight from the front up to the back, as its plan arrow shows
      const steps = Math.max(8, Math.round(D / 0.27));
      const h = 2.8 / steps;
      body = (
        <>
          {Array.from({ length: steps }, (_, i) => box(0, ((i + 1) * h) / 2, D / 2 - ((i + 0.5) * D) / steps, W, h * (i + 1), D / steps, '#d8d3ca', 0.7, 0, `st${i}`))}
          {box(W / 2 - 0.02, 1.9, 0, 0.04, 0.9, D, '#9aa0a6', 0.3, 0.7, 'rail')}
        </>
      );
      break;
    }
    case 'stair-l': {
      // up the left side to a quarter landing at the back, then along the back to the right
      const fw = Math.min(1.1, Math.max(0.8, Math.min(W, D) * 0.42));
      const n1 = Math.max(3, Math.round((D - fw) / 0.27));
      const n2 = Math.max(3, Math.round((W - fw) / 0.27));
      const h = 2.8 / (n1 + n2 + 1);
      const g1 = (D - fw) / n1;
      const g2 = (W - fw) / n2;
      body = (
        <>
          {Array.from({ length: n1 }, (_, i) => box(-W / 2 + fw / 2, ((i + 1) * h) / 2, D / 2 - (i + 0.5) * g1, fw, (i + 1) * h, g1, '#d8d3ca', 0.7, 0, `a${i}`))}
          {box(-W / 2 + fw / 2, ((n1 + 1) * h) / 2, -D / 2 + fw / 2, fw, (n1 + 1) * h, fw, '#cfc9bf', 0.7, 0, 'landing')}
          {Array.from({ length: n2 }, (_, j) => box(-W / 2 + fw + (j + 0.5) * g2, ((n1 + 2 + j) * h) / 2, -D / 2 + fw / 2, g2, (n1 + 2 + j) * h, fw, '#d8d3ca', 0.7, 0, `b${j}`))}
        </>
      );
      break;
    }
    case 'stair-u': {
      // up the left flight, a half landing across the back, up the right flight towards the front
      const gap = 0.1;
      const fw = (W - gap) / 2;
      const ld = Math.min(fw, D * 0.35);
      const n = Math.max(3, Math.round((D - ld) / 0.27));
      const h = 2.8 / (2 * n + 1);
      const g = (D - ld) / n;
      body = (
        <>
          {Array.from({ length: n }, (_, i) => box(-W / 2 + fw / 2, ((i + 1) * h) / 2, D / 2 - (i + 0.5) * g, fw, (i + 1) * h, g, '#d8d3ca', 0.7, 0, `a${i}`))}
          {box(0, ((n + 1) * h) / 2, -D / 2 + ld / 2, W, (n + 1) * h, ld, '#cfc9bf', 0.7, 0, 'landing')}
          {Array.from({ length: n }, (_, j) => box(W / 2 - fw / 2, ((n + 2 + j) * h) / 2, -D / 2 + ld + (j + 0.5) * g, fw, (n + 2 + j) * h, g, '#d8d3ca', 0.7, 0, `b${j}`))}
        </>
      );
      break;
    }
    case 'spiral': {
      // treads round a central pole, climbing as they turn
      const R = Math.min(W, D) / 2;
      const n = 13;
      const sweep = (330 * Math.PI) / 180;
      body = (
        <>
          <mesh position={[0, 1.45, 0]} castShadow>
            <cylinderGeometry args={[0.06, 0.06, 2.9, 12]} />
            {m('#5f6368', 0.35, 0.7)}
          </mesh>
          {Array.from({ length: n }, (_, i) => (
            <group key={`t${i}`} rotation={[0, -Math.PI / 2 + (i * sweep) / n, 0]}>
              <mesh position={[R / 2, ((i + 1) * 2.8) / n, 0]} castShadow receiveShadow>
                <boxGeometry args={[R - 0.06, 0.05, Math.max(0.18, (R * sweep) / n)]} />
                {m('#cfc9bf', 0.7)}
              </mesh>
            </group>
          ))}
        </>
      );
      break;
    }
    case 'lift':
      body = (
        <>
          {box(0, 1.2, 0, W, 2.4, D, '#9aa0a6', 0.25, 0.8)}
          {box(0, 1.05, D / 2 + 0.005, W * 0.5, 2.1, 0.01, '#d0d4d8', 0.15, 0.9)}
        </>
      );
      break;
    case 'plant':
      body = (
        <>
          {box(0, 0.25, 0, W * 0.6, 0.5, D * 0.6, '#efebe4', 0.8)}
          <mesh position={[0, 1.0, 0]} castShadow>
            <sphereGeometry args={[Math.min(W, D) * 0.55, 12, 10]} />
            {m('#5f8f45', 1)}
          </mesh>
        </>
      );
      break;
    default:
      body = box(0, 0.4, 0, W, 0.8, D, '#bdc1c6');
  }
  return (
    <group
      position={[x, 0, z]}
      rotation={[0, (-f.rotation * Math.PI) / 180, 0]}
      onClick={(e) => c.onPick(f.id, e)}
      onPointerOver={(e) => {
        e.stopPropagation();
        c.onHover(f.id);
      }}
      onPointerOut={() => c.onHover(null)}
    >
      {body}
    </group>
  );
}

function Sun({ hour, extent }: { hour: number; extent: number }) {
  const ref = useRef<THREE.DirectionalLight>(null);
  const az = ((90 + (hour - 6) * 15) * Math.PI) / 180;
  const el = Math.max(0.05, Math.sin((Math.PI * (hour - 6)) / 12)) * ((62 * Math.PI) / 180);
  const r = 30;
  const pos: [number, number, number] = [Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r];
  const warm = new THREE.Color('#ffffff').lerp(new THREE.Color('#ffb36b'), 1 - Math.min(1, el / 0.6));
  return (
    <directionalLight
      ref={ref}
      position={pos}
      intensity={1.1 + 1.6 * Math.min(1, el / 0.5)}
      color={warm}
      castShadow
      shadow-mapSize={[2048, 2048]}
      shadow-bias={-0.0004}
      shadow-normalBias={0.02}
      shadow-camera-left={-extent}
      shadow-camera-right={extent}
      shadow-camera-top={extent}
      shadow-camera-bottom={-extent}
      shadow-camera-near={1}
      shadow-camera-far={80}
    />
  );
}

function CameraRig({ c, model, mode, home, homeTarget, elev }: { c: Ctx; model: BuildingModel; mode: ViewMode; home: [number, number, number]; homeTarget: [number, number, number]; elev: number }) {
  const { camera, gl, scene, controls, size } = useThree();
  // Frame the building when it first appears or a different building loads.
  // Portrait screens (phones) need the camera further back to see all of it.
  useEffect(() => {
    if (mode !== 'orbit') return;
    const k = size.width / Math.max(1, size.height) < 0.9 ? 1.55 : 1;
    const t = new THREE.Vector3(...homeTarget);
    camera.position.copy(new THREE.Vector3(...home).sub(t).multiplyScalar(k).add(t));
    const ctl = controls as unknown as OrbitControlsImpl | null;
    if (ctl?.target) {
      ctl.target.copy(t);
      ctl.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.id, controls]);
  const focus = useStudio((s) => s.focus);
  const setLastCamera = useStudio((s) => s.setLastCamera);
  const following = useCollab((s) => s.following);
  const remote = useCollab((s) => s.remoteCamera);
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useEffect(() => {
    viewerApi.capture = () => {
      gl.render(scene, camera);
      return gl.domElement.toDataURL('image/jpeg', 0.85);
    };
    viewerApi.camera = camera;
    viewerApi.pose = () => {
      const t = (controls as unknown as OrbitControlsImpl | null)?.target ?? new THREE.Vector3();
      return { position: camera.position.toArray() as [number, number, number], target: t.toArray() as [number, number, number] };
    };
    viewerApi.exportGLB = () =>
      new Promise((resolve, reject) => {
        const root = scene.getObjectByName('building');
        if (!root) return reject(new Error('Nothing to export'));
        new GLTFExporter().parse(root, (res) => resolve(new Blob([res as ArrayBuffer], { type: 'model/gltf-binary' })), reject, { binary: true });
      });
  }, [gl, scene, camera, controls]);

  useEffect(() => {
    viewerApi.home = () => {
      goal.current = { pos: new THREE.Vector3(...home), target: new THREE.Vector3(...homeTarget) };
    };
  }, [home]);

  // Back from a walkthrough: return to the overview camera.
  const prevMode = useRef(mode);
  useEffect(() => {
    if (prevMode.current === 'walk' && mode === 'orbit') {
      camera.rotation.order = 'XYZ';
      goal.current = { pos: new THREE.Vector3(...home), target: new THREE.Vector3(...homeTarget) };
    }
    prevMode.current = mode;
  }, [mode, camera, home]);

  // Fly to focused elements.
  useEffect(() => {
    if (!focus || mode === 'walk') return;
    if (focus.view) {
      goal.current = { pos: new THREE.Vector3(...focus.view.position), target: new THREE.Vector3(...focus.view.target) };
      return;
    }
    if (!focus.ids.length) return;
    const b = elementsBounds(model, focus.ids);
    if (!b) return;
    const [tx, tz] = toWorld({ x: b.minX + b.w / 2, y: b.minY + b.h / 2 }, c);
    const span = Math.max(b.w, b.h, 6000) * S;
    goal.current = { pos: new THREE.Vector3(tx + span * 0.9, elev + span * 1.25 + 2, tz + span * 1.1), target: new THREE.Vector3(tx, elev + 0.9, tz) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Follow a presenter's camera in the crit room.
  useEffect(() => {
    if (mode === 'orbit' && following && remote && remote.from === following) goal.current = { pos: new THREE.Vector3(...remote.pose.position), target: new THREE.Vector3(...remote.pose.target) };
  }, [remote, following, mode]);

  const lastReport = useRef(0);
  useFrame((state, dt) => {
    const ctl = controls as unknown as OrbitControlsImpl | null;
    if (mode === 'orbit' && goal.current && ctl?.target) {
      camera.position.lerp(goal.current.pos, Math.min(1, dt * 4));
      ctl.target.lerp(goal.current.target, Math.min(1, dt * 4));
      ctl.update();
      if (camera.position.distanceTo(goal.current.pos) < 0.02) goal.current = null;
    }
    const now = state.clock.elapsedTime;
    if (mode === 'orbit' && now - lastReport.current > 0.25) {
      lastReport.current = now;
      const t = ctl?.target ?? new THREE.Vector3();
      const pose: CameraPose = { position: camera.position.toArray() as [number, number, number], target: t.toArray() as [number, number, number] };
      setLastCamera(pose);
      broadcastCamera(pose);
    }
  });
  return null;
}

interface MarkerPoint {
  pin: Pin;
  pos: [number, number, number];
}

/** Projects pin positions to screen space every frame and moves plain DOM buttons (no React re-render). */
function MarkerProjector({ points, els }: { points: MarkerPoint[]; els: React.MutableRefObject<Map<string, HTMLElement>> }) {
  const { camera, size } = useThree();
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (const p of points) {
      const el = els.current.get(p.pin.id);
      if (!el) continue;
      v.set(...p.pos).project(camera);
      const visible = v.z > -1 && v.z < 1;
      el.style.display = visible ? 'flex' : 'none';
      if (visible) el.style.transform = `translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

const markerTone = (p: Pin) => (p.tone === 'message' ? '#7b1fa2' : p.tone === 'critical' ? '#d93025' : p.tone === 'warning' ? '#e37400' : '#1a73e8');

function SectionPlane({ height }: { height: number | null }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.localClippingEnabled = true;
    gl.clippingPlanes = height === null ? [] : [new THREE.Plane(new THREE.Vector3(0, -1, 0), height)];
  }, [gl, height]);
  return null;
}

/** The designed roof (flat, mono-pitch, gable or hip) built from the roof engine's triangles. */
function RoofMesh({ model, c }: { model: BuildingModel; c: Ctx }) {
  const shape = useMemo(() => roofShape(model), [model]);
  const geoms = useMemo(() => {
    if (!shape) return null;
    const toGeom = (tris: [P3, P3, P3][]) => {
      const pos: number[] = [];
      for (const t of tris) for (const [x, y, h] of t) pos.push((x - c.cx) * S, h * S, (y - c.cy) * S);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    };
    return { roof: toGeom(shape.triangles), ends: toGeom(shape.endWalls) };
  }, [shape, c.cx, c.cy]);
  if (!shape || !geoms) return null;
  const mat = materialById(shape.design.materialId);
  const wallMat = materialById(model.walls.find((w) => w.exterior)?.materialId ?? 'render');
  return (
    <group name="roof">
      <mesh geometry={geoms.roof} castShadow receiveShadow>
        <meshStandardMaterial color={mat.color} roughness={mat.roughness} metalness={mat.metalness} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geoms.ends} castShadow receiveShadow>
        <meshStandardMaterial color={wallMat.color} roughness={wallMat.roughness} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Live participants walking through the model, shown as their chosen figure. */
function LiveFigures({ c }: { c: Ctx }) {
  const walkers = useCollab((s) => s.walkers);
  const viewer = useStudio((s) => s.me.role);
  return (
    <>
      {Object.values(walkers).map((w) => (
        <LiveFigure
          key={w.member.id}
          look={lookFor(w.member.id, w.member.figure ?? 'woman', w.member.look?.top ?? w.member.color, w.member.look)}
          pose={w.walk}
          receivedAt={w.receivedAt}
          memberId={w.member.id}
          cx={c.cx}
          cy={c.cy}
          label={`${w.member.name.split(' ')[0]} · ${roleLabelFor(w.member.role, viewer)}`}
        />
      ))}
    </>
  );
}

export function Viewer3D({
  model,
  settings,
  pins = [],
  findingIds = new Set(),
  previewIds = new Set(),
  onExitWalk,
  markTool3d = null,
  markColor = '#d93025',
  onMark3d,
  marks3d = [],
}: {
  model: BuildingModel;
  settings: ViewerSettings;
  pins?: Pin[];
  findingIds?: Set<Id>;
  previewIds?: Set<Id>;
  onExitWalk?: () => void;
  /** Crit mark-up in 3D: pin a spot on a surface, or highlight a whole part. */
  markTool3d?: 'pin' | 'part' | null;
  markColor?: string;
  onMark3d?: (m: PlanMark) => void;
  marks3d?: Mark3D[];
}) {
  const selection = useStudio((s) => s.selection);
  const hover = useStudio((s) => s.hover);
  const select = useStudio((s) => s.select);
  const setHover = useStudio((s) => s.setHover);
  const dark = useTheme((t) => t.resolved === 'dark');
  const bg = dark ? '#1f232b' : '#e9edf2';
  const walkInput = useRef<WalkInput>(emptyWalkInput());
  const me = useStudio((s) => s.me);
  const toast = useStudio((s) => s.toast);
  const [near, setNear] = useState<NearOpening | null>(null);
  const limits = useMemo(() => doorLimits(model), [model]);
  const outward = useMemo(() => {
    const d = derive(model);
    const m = new Map<Id, number>();
    for (const o of model.openings) {
      if (o.kind !== 'window') continue;
      const w = model.walls.find((x) => x.id === o.wallId);
      if (!w) continue;
      const f = openingFrame(o, w);
      // Local +z of a window is the wall's -normal side; open towards the side without a room.
      m.set(o.id, d.roomAt(add(f.center, mul(f.normal, 700))) ? 1 : -1);
    }
    return m;
  }, [model]);
  const setDefaultDoors = useDoors((s) => s.setDefault);
  // The walk tips show for a few seconds, then get out of the way.
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (settings.mode !== 'walk') return;
    setHint(true);
    const t = setTimeout(() => setHint(false), 9000);
    return () => clearTimeout(t);
  }, [settings.mode]);
  useEffect(() => setDefaultDoors(settings.doorsOpen), [settings.doorsOpen, setDefaultDoors]);

  // Every floor of the building, each with its own derived rooms and wall solids.
  const levelData = useMemo(
    () =>
      levelViews(model).map((L) => {
        const m = L.active ? model : ({ ...model, ...L.plan, levels: undefined, activeLevel: undefined } as BuildingModel);
        const dd = derive(m);
        return { ...L, model: m, rooms: dd.rooms, solids: wallSolids(m), outward: outwardSigns(m.walls, dd.roomAt), wallTop: Math.max(0, ...m.walls.map((w) => w.height)) * S };
      }),
    [model],
  );
  const activeIdx = Math.min(levelData.length - 1, model.activeLevel ?? 0);
  const activeElev = levelData[activeIdx].elevation * S;
  const allWalls = useMemo(() => levelData.flatMap((L) => L.model.walls), [levelData]);
  const b = useMemo(() => (allWalls.length ? bbox(allWalls.flatMap((w) => [w.a, w.b])) : { minX: 0, minY: 0, w: 10000, h: 8000, maxX: 10000, maxY: 8000 }), [allWalls]);
  const cx = b.minX + b.w / 2;
  const cy = b.minY + b.h / 2;
  const planExtent = (Math.max(b.w, b.h) * S) / 2 + 4;
  const tallM = levelData.length > 1 ? totalHeight(model) * S : 0;
  const extent = Math.max(planExtent, tallM * 0.6);
  const tall = tallM > planExtent * 1.3;

  const c: Ctx = {
    industrial: model.spec?.type === 'industrial',
    cx,
    cy,
    sel: new Set(selection),
    hover,
    preview: previewIds,
    findingIds,
    onPick: (id, e) => {
      e.stopPropagation();
      if (markTool3d && onMark3d && settings.mode === 'orbit') {
        const p = e.point;
        const at = { x: Math.round(p.x / S + cx), y: Math.round(p.z / S + cy) };
        onMark3d({ kind: markTool3d, points: [at], z: Math.max(0, p.y - activeElev), elementId: id, color: markColor, level: activeIdx });
        return;
      }
      if (settings.mode === 'walk') return;
      select([id], e.nativeEvent.shiftKey);
    },
    onHover: (id) => setHover(id),
    walk: settings.mode === 'walk',
    limits,
    outward,
    markColors: new Map(marks3d.filter((m) => (m.mark.kind === 'part' || m.mark.kind === 'remove') && m.mark.elementId).map((m) => [m.mark.elementId!, m.mark.color])),
  };

  // Stop sharing my position when I leave the walkthrough.
  useEffect(() => {
    if (settings.mode !== 'walk') broadcastWalk(null);
    return () => broadcastWalk(null);
  }, [settings.mode]);

  const homeTarget = useMemo<[number, number, number]>(() => [0, tall ? tallM * 0.45 : levelData.length > 1 ? Math.min(tallM * 0.4, 3) : 0.6, 0], [tall, tallM, levelData.length]);
  const initial = useMemo<[number, number, number]>(() => {
    if (!tall) return [extent * 1.05, extent * 1.75, extent * 1.85];
    const dist = tallM * 1.45 + planExtent * 1.2;
    const dir = new THREE.Vector3(0.5, 0.32, 0.8).normalize();
    return [dir.x * dist, homeTarget[1] + dir.y * dist, dir.z * dist];
  }, [extent, tall, tallM, planExtent, homeTarget]);
  // Which floors to draw: in a walk, only up to yours; otherwise all, unless cut away.
  const cutting = settings.mode === 'walk' || !!settings.cutAbove;
  const ghost: Ctx = { ...c, sel: new Set(), hover: null, preview: new Set(), findingIds: new Set(), onPick: (_id, e) => e.stopPropagation(), onHover: () => undefined, walk: false };
  const roofPieces = useMemo<RoofPiece[]>(() => {
    const out: RoofPiece[] = [];
    levelData.forEach((L, i) => {
      const above = levelData[i + 1]?.rooms ?? [];
      for (const r of L.rooms) {
        if (above.some((q) => pointInPolygon(r.centroid, q.polygon))) continue;
        const top = Math.max(0, ...L.model.walls.filter((w) => r.wallIds.includes(w.id)).map((w) => w.height));
        out.push({ room: r, y: (L.elevation + (L.repeat - 1) * L.height + top) * S, walls: L.model.walls, top: i === levelData.length - 1, tall: top > 6000 });
      }
    });
    return out;
  }, [levelData]);
  const topLevel = levelData[levelData.length - 1];
  const crown = useMemo(() => exteriorOutline(topLevel.model), [topLevel]);
  const showRoof = settings.mode === 'orbit' && settings.roof && (!cutting || activeIdx === levelData.length - 1);
  const markerEls = useRef(new Map<string, HTMLElement>());
  const markerPoints = useMemo<MarkerPoint[]>(
    () =>
      pins.flatMap((pin, i) => {
        const at = elementCenter(model, pin.elementId);
        if (!at) return [];
        const [x, z] = toWorld(at, c);
        return [{ pin, pos: [x + (i % 3) * 0.12, 3.1, z] as [number, number, number] }];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pins, model],
  );

  /** Left-drag in the overview: turn the model (default) or move it (hand). Right-drag or Shift+drag always moves. */
  const [dragMode, setDragMode] = useState<'rotate' | 'move'>('rotate');

  const pad = (key: keyof WalkInput) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      walkInput.current[key] = 1;
    },
    onPointerUp: () => (walkInput.current[key] = 0),
    onPointerLeave: () => (walkInput.current[key] = 0),
    onPointerCancel: () => (walkInput.current[key] = 0),
  });

  return (
    <div className="viewer3d" style={{ position: 'absolute', inset: 0 }}>
      {settings.mode !== 'walk' && (
        <div className="drag-mode seg" role="radiogroup" aria-label="Drag to">
          <button role="radio" aria-checked={dragMode === 'rotate'} className={dragMode === 'rotate' ? 'on' : ''} onClick={() => setDragMode('rotate')} title="Drag to turn the model (right-drag or Shift+drag moves it)">
            <Icon name="3d_rotation" /> Rotate
          </button>
          <button role="radio" aria-checked={dragMode === 'move'} className={dragMode === 'move' ? 'on' : ''} onClick={() => setDragMode('move')} title="Drag to move the model around (right-drag turns it)">
            <Icon name="pan_tool" /> Move
          </button>
        </div>
      )}
      <ErrorBoundary label="the 3D view" compact>
        <Canvas
          shadows="percentage"
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.0 }}
          camera={{ fov: settings.mode === 'walk' ? 70 : 42, near: 0.05, far: Math.max(400, extent * 12), position: initial }}
          onPointerMissed={() => settings.mode === 'orbit' && select([])}
          style={{ cursor: settings.mode === 'walk' ? 'grab' : markTool3d ? 'crosshair' : undefined, touchAction: 'none' }}
        >
          <color attach="background" args={[bg]} />
          <fog attach="fog" args={[bg, Math.max(40, extent * 3), Math.max(120, extent * 10)]} />
          <hemisphereLight args={['#ffffff', '#cfc8bb', 0.55]} />
          <Sun hour={settings.hour} extent={extent} />
          <Environment resolution={256} frames={1}>
            <Lightformer form="rect" intensity={1.6} position={[0, 6, -12]} scale={[18, 6, 1]} />
            <Lightformer form="rect" intensity={0.8} position={[-12, 4, 0]} rotation={[0, Math.PI / 2, 0]} scale={[16, 4, 1]} />
            <Lightformer form="rect" intensity={0.8} position={[12, 4, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[16, 4, 1]} />
            <Lightformer form="circle" intensity={2.2} position={[0, 12, 0]} rotation={[Math.PI / 2, 0, 0]} scale={8} />
          </Environment>
          <SectionPlane height={settings.section} />

          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]} receiveShadow>
            <planeGeometry args={[Math.max(200, extent * 10), Math.max(200, extent * 10)]} />
            <meshStandardMaterial color={dark ? '#2a2f2a' : '#dfe3d9'} roughness={1} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
            <planeGeometry args={[b.w * S + 1.2, b.h * S + 1.2]} />
            <meshStandardMaterial color="#cfc9be" roughness={0.95} />
          </mesh>
          <ContactShadows position={[0, 0.001, 0]} scale={extent * 2.4} opacity={0.35} blur={2.4} far={3} resolution={512} frames={1} />

          <group name="building">
            {levelData.map((L) => {
              if (cutting && L.index > activeIdx) return null;
              const lc = L.active ? c : ghost;
              return (
                <group key={L.index} position={[0, L.elevation * S, 0]}>
                  {L.index > 0 && <Slab rooms={L.rooms} cx={cx} cy={cy} y={-0.25} />}
                  <Floors model={L.model} c={lc} holes={L.index > 0 ? levelData[L.index - 1].model.furniture.filter((f) => f.kind === 'stair' || f.kind === 'stair-l' || f.kind === 'stair-u' || f.kind === 'spiral').map((f) => furnitureFootprint(f)) : []} />
                  {L.solids.map((sd) => (
                    sd.wall.kind === 'railing' ? <RailingMesh key={sd.wall.id} solid={sd} c={lc} /> : sd.wall.kind === 'column' ? <ColumnMesh key={sd.wall.id} w={sd.wall} c={lc} /> : <WallMesh key={sd.wall.id} solid={sd} c={lc} />
                  ))}
                  <PorchExtras model={L.model} c={lc} />
                  {settings.furniture && <FurnitureSet model={L.model} c={lc} />}
                  {model.spec?.facade === 'fins' && <Fins walls={L.model.walls} outward={L.outward} cx={cx} cy={cy} y0={0} height={L.wallTop} color={model.spec.accent} />}
                  {L.repeat > 1 && !(cutting && L.index === activeIdx) && <RepeatShell walls={L.model.walls} cx={cx} cy={cy} y0={L.height * S} floors={L.repeat - 1} storey={L.height} outward={L.outward} spec={model.spec} />}
                </group>
              );
            })}
            {model.features?.canopy && model.features.canopy.length > 1 && <Canopy points={model.features.canopy} cx={cx} cy={cy} color={model.spec?.accent ?? '#1a73e8'} />}
            {showRoof && model.spec && model.spec.roof !== 'pitched' && <SpecRoofs pieces={roofPieces} spec={model.spec} cx={cx} cy={cy} crownOutline={crown} />}
            {showRoof && (!model.spec || model.spec.roof === 'pitched') && (
              <group position={[0, topLevel.elevation * S, 0]}>
                <RoofMesh model={topLevel.model} c={c} />
              </group>
            )}
          </group>

          {marks3d.length > 0 && settings.mode === 'orbit' && (
            <group position={[0, activeElev, 0]}>
              <Marks3D marks={marks3d} cx={cx} cy={cy} />
            </group>
          )}
          <LiveFigures c={c} />
          {settings.mode === 'walk' && <SelfFigure look={lookFor(me.id, me.figure ?? 'woman', me.look?.top ?? me.color, me.look)} cx={cx} cy={cy} />}
          {settings.people && <Wanderers model={model} cx={cx} cy={cy} count={3} />}

          {settings.mode === 'orbit' && <MarkerProjector points={markerPoints} els={markerEls} />}
          {settings.mode === 'orbit' ? (
            <OrbitControls
              makeDefault
              enableDamping
              dampingFactor={0.08}
              screenSpacePanning
              maxPolarAngle={Math.PI * 0.495}
              minDistance={2}
              maxDistance={Math.max(80, extent * 4)}
              target={homeTarget}
              mouseButtons={dragMode === 'move' ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
              touches={dragMode === 'move' ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
            />
          ) : (
            <WalkControls
              model={model}
              cx={cx}
              cy={cy}
              elev={activeElev}
              input={walkInput}
              onPose={(p) => broadcastWalk(p)}
              onNear={setNear}
              onBlocked={(id, what) => toast(`Door ${id} only opens part way because it hits ${what}. Check Review for a fix.`, 'info')}
            />
          )}
          <CameraRig c={c} model={model} mode={settings.mode} home={initial} homeTarget={homeTarget} elev={activeElev} />
        </Canvas>
      </ErrorBoundary>
      {settings.mode === 'orbit' && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          {markerPoints.map(({ pin }) => (
            <button
              key={pin.id}
              ref={(el) => {
                if (el) markerEls.current.set(pin.id, el);
                else markerEls.current.delete(pin.id);
              }}
              onClick={pin.onClick}
              title={pin.label}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                display: 'none',
                pointerEvents: 'auto',
                border: '2px solid #fff',
                background: markerTone(pin),
                color: '#fff',
                borderRadius: '50% 50% 50% 4px',
                width: 26,
                height: 26,
                cursor: 'pointer',
                boxShadow: '0 1px 4px rgba(0,0,0,.35)',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
              }}
            >
              <span className="ms" style={{ fontSize: 15 }}>
                {pin.kind === 'message' ? 'chat' : 'priority_high'}
              </span>
            </button>
          ))}
        </div>
      )}
      {settings.mode === 'walk' && (
        <>
          {hint && <div className="walk-hint">Scroll or pinch to zoom out · Drag to turn · W A S D to move · Click the floor to walk there · Click a door to open or close it</div>}
          <div className="walk-views" role="group" aria-label="Camera">
            <button onClick={() => walkApi.setView('first')} title="See through your own eyes">
              <span className="ms">visibility</span> <span className="lbl">Your eyes</span>
            </button>
            <button onClick={() => walkApi.setView('follow')} title="Camera just behind you">
              <span className="ms">person</span> <span className="lbl">Behind you</span>
            </button>
            <button onClick={() => walkApi.setView('above')} title="Zoom right out">
              <span className="ms">zoom_out_map</span> <span className="lbl">From above</span>
            </button>
          </div>
          <div className="walk-zoom" role="group" aria-label="Zoom">
            <button onClick={() => walkApi.zoom(-1.5)} aria-label="Zoom in">
              <span className="ms">add</span>
            </button>
            <button onClick={() => walkApi.zoom(1.5)} aria-label="Zoom out">
              <span className="ms">remove</span>
            </button>
          </div>
          {near && (
            <button className="btn btn-primary walk-door" onClick={() => walkApi.useNearest()}>
              <span className="ms">{near.kind === 'door' ? (near.open ? 'door_front' : 'door_open') : near.open ? 'window' : 'sensor_window'}</span>
              {near.open ? 'Close' : 'Open'} {near.kind === 'door' ? 'door' : 'window'} {near.id}
              <kbd>E</kbd>
            </button>
          )}
          <div className="walk-pad" aria-label="Walk controls">
            <span />
            <button {...pad('forward')} aria-label="Walk forward">
              <span className="ms">arrow_upward</span>
            </button>
            <span />
            <button {...pad('turnLeft')} aria-label="Turn left">
              <span className="ms">rotate_left</span>
            </button>
            <button {...pad('back')} aria-label="Walk backward">
              <span className="ms">arrow_downward</span>
            </button>
            <button {...pad('turnRight')} aria-label="Turn right">
              <span className="ms">rotate_right</span>
            </button>
          </div>
          {onExitWalk && (
            <button className="btn btn-primary walk-exit" onClick={onExitWalk}>
              <span className="ms">close</span> Exit walkthrough
            </button>
          )}
        </>
      )}
    </div>
  );
}


export function wallLengthM(w: Wall) {
  return wallLength(w) / 1000;
}
