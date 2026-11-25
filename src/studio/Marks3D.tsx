/**
 * Crit marks shown in the 3D model: pins on surfaces, highlighted areas on the floor,
 * lines and arrows, suggested walls / doors / windows, and notes. Highlighted parts
 * (and suggested removals) glow on the element itself via the viewer's emissive map.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { PlanMark } from '../model/types';

const S = 1 / 1000;

export interface Mark3D {
  id: string;
  n: number;
  mark: PlanMark;
  label: string;
  onClick?: () => void;
}

const labelCache = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();
function label(text: string, color: string) {
  const key = text + color;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const f = '600 40px "Google Sans", Roboto, sans-serif';
  g.font = f;
  const w = Math.ceil(g.measureText(text).width) + 36;
  c.width = w;
  c.height = 60;
  g.font = f;
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(0, 0, w, 60, 30);
  g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, 18, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const out = { tex, w: (w / 60) * 0.32, h: 0.32 };
  labelCache.set(key, out);
  return out;
}

function Tag({ text, color, pos }: { text: string; color: string; pos: [number, number, number] }) {
  const l = label(text, color);
  return (
    <sprite position={pos} scale={[l.w, l.h, 1]} renderOrder={10}>
      <spriteMaterial map={l.tex} depthTest={false} transparent />
    </sprite>
  );
}

export function Marks3D({ marks, cx, cy }: { marks: Mark3D[]; cx: number; cy: number }) {
  const W = (p: { x: number; y: number }, y = 0): [number, number, number] => [(p.x - cx) * S, y, (p.y - cy) * S];
  const items = useMemo(() => marks, [marks]);
  return (
    <group>
      {items.map((m) => {
        const c = m.mark.color;
        const pts = m.mark.points;
        const num = m.n > 0 ? String(m.n) : '+';
        const click = m.onClick
          ? {
              onClick: (e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                m.onClick!();
              },
            }
          : {};
        switch (m.mark.kind) {
          case 'pin':
          case 'part': {
            const y = m.mark.z ?? 0;
            const at = W(pts[0], y);
            return (
              <group key={m.id} {...click}>
                <mesh position={[at[0], y + 0.28, at[2]]} rotation={[Math.PI, 0, 0]}>
                  <coneGeometry args={[0.13, 0.42, 16]} />
                  <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.35} />
                </mesh>
                <mesh position={[at[0], y + 0.6, at[2]]}>
                  <sphereGeometry args={[0.2, 20, 16]} />
                  <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.35} />
                </mesh>
                <Tag text={num} color={c} pos={[at[0], y + 1.0, at[2]]} />
              </group>
            );
          }
          case 'area': {
            if (pts.length < 2) return null;
            const x0 = Math.min(pts[0].x, pts[1].x);
            const x1 = Math.max(pts[0].x, pts[1].x);
            const y0 = Math.min(pts[0].y, pts[1].y);
            const y1 = Math.max(pts[0].y, pts[1].y);
            const mid = W({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 });
            return (
              <group key={m.id} {...click}>
                <mesh position={[mid[0], 0.03, mid[2]]} rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[(x1 - x0) * S, (y1 - y0) * S]} />
                  <meshBasicMaterial color={c} transparent opacity={0.32} depthWrite={false} />
                </mesh>
                <Line points={[W({ x: x0, y: y0 }, 0.04), W({ x: x1, y: y0 }, 0.04), W({ x: x1, y: y1 }, 0.04), W({ x: x0, y: y1 }, 0.04), W({ x: x0, y: y0 }, 0.04)]} color={c} lineWidth={3} />
                <Tag text={num} color={c} pos={[(x0 - cx) * S, 1.2, (y0 - cy) * S]} />
              </group>
            );
          }
          case 'pen':
          case 'line':
          case 'arrow':
          case 'wall': {
            if (pts.length < 2) return null;
            const h = m.mark.kind === 'wall' ? 1.2 : 0.05;
            return (
              <group key={m.id} {...click}>
                <Line points={pts.map((p) => W(p, h))} color={c} lineWidth={m.mark.kind === 'wall' ? 6 : 4} dashed={m.mark.kind === 'wall'} dashSize={0.3} gapSize={0.15} />
                {m.mark.kind === 'wall' && (
                  <mesh position={W({ x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, 1.2)} rotation={[0, -Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), 0]}>
                    <boxGeometry args={[Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) * S, 2.4, 0.12]} />
                    <meshBasicMaterial color={c} transparent opacity={0.25} depthWrite={false} />
                  </mesh>
                )}
                <Tag text={m.mark.kind === 'wall' ? `${num} new wall` : num} color={c} pos={W(pts[0], h + 0.6)} />
              </group>
            );
          }
          case 'door':
          case 'window': {
            if (pts.length < 2) return null;
            const ang = -Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
            const door = m.mark.kind === 'door';
            const y = door ? 1.05 : 1.5;
            return (
              <group key={m.id} {...click}>
                <mesh position={W(pts[0], y)} rotation={[0, ang, 0]}>
                  <boxGeometry args={[door ? 0.9 : 1.2, door ? 2.1 : 1.2, 0.4]} />
                  <meshBasicMaterial color={c} transparent opacity={0.45} depthWrite={false} />
                </mesh>
                <Tag text={`${num} new ${m.mark.kind}`} color={c} pos={W(pts[0], door ? 2.5 : 2.4)} />
              </group>
            );
          }
          case 'remove':
            return <Tag key={m.id} text={`${num} remove ${m.mark.elementId ?? ''}`} color={c} pos={W(pts[0], 2.6)} />;
          case 'text':
            return <Tag key={m.id} text={`${m.n > 0 ? m.n + '. ' : ''}${m.mark.text || 'Note'}`} color={c} pos={W(pts[0], 2.2)} />;
        }
        return null;
      })}
    </group>
  );
}
