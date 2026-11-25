import { useMemo } from 'react';
import type { BuildingModel } from '../model/types';
import { wallSolids } from '../model/wallgeom';
import { add, bbox, mul, wallDir, wallNormal } from '../model/geometry';
import { derive } from '../model/derive';

/**
 * A lightweight isometric line drawing of the live building model (pure SVG, no WebGL),
 * used as the Overview banner illustration. It redraws whenever the model changes.
 */
export function IsoPreview({ model, className }: { model: BuildingModel; className?: string }) {
  const svg = useMemo(() => {
    if (!model.walls.length) return null;
    const b = bbox(model.walls.flatMap((w) => [w.a, w.b]));
    const cx = b.minX + b.w / 2;
    const cy = b.minY + b.h / 2;
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    // plan (x, y) + height z → iso screen
    const P = (x: number, y: number, z: number) => {
      const X = x - cx;
      const Y = y - cy;
      return { x: (X - Y) * cos, y: (X + Y) * sin - z };
    };
    const polys: { d: string; depth: number; kind: 'top' | 'side' | 'floor' }[] = [];
    const d = derive(model);
    for (const r of d.rooms) {
      const pts = r.inner.map((p) => P(p.x, p.y, 0));
      polys.push({ d: `M${pts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('L')}Z`, depth: -1e9, kind: 'floor' });
    }
    for (const s of wallSolids(model)) {
      const w = s.wall;
      const dir = wallDir(w);
      const n = mul(wallNormal(w), w.thickness / 2);
      const segs: [number, number, number, number][] = s.spans.map(([a, e]) => [a, e, 0, w.height]);
      for (const o of s.openings) {
        if (o.sill > 0) segs.push([o.offset - o.width / 2, o.offset + o.width / 2, 0, o.sill]);
        segs.push([o.offset - o.width / 2, o.offset + o.width / 2, o.sill + o.height, w.height]);
      }
      for (const [a, e, z0, z1] of segs) {
        if (z1 - z0 < 1) continue;
        const p0 = add(w.a, mul(dir, a));
        const p1 = add(w.a, mul(dir, e));
        const c = [add(p0, n), add(p1, n), add(p1, mul(n, -1)), add(p0, mul(n, -1))];
        const top = c.map((p) => P(p.x, p.y, z1));
        const depth = (p0.x + p1.x) / 2 + (p0.y + p1.y) / 2;
        // two visible side faces (towards the viewer: +x and +y)
        for (let i = 0; i < 4; i++) {
          const q0 = c[i];
          const q1 = c[(i + 1) % 4];
          const nx = q1.y - q0.y;
          const ny = -(q1.x - q0.x);
          const facing = nx * 1 + ny * 1; // viewer looks from (+x,+y)
          if (facing <= 0) continue;
          const f = [P(q0.x, q0.y, z0), P(q1.x, q1.y, z0), P(q1.x, q1.y, z1), P(q0.x, q0.y, z1)];
          polys.push({ d: `M${f.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('L')}Z`, depth: depth + 0.1, kind: 'side' });
        }
        polys.push({ d: `M${top.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('L')}Z`, depth: depth + 0.2, kind: 'top' });
      }
    }
    polys.sort((a, b) => a.depth - b.depth);
    const all = model.walls.flatMap((w) => [P(w.a.x, w.a.y, 0), P(w.b.x, w.b.y, 0), P(w.a.x, w.a.y, w.height), P(w.b.x, w.b.y, w.height)]);
    const minX = Math.min(...all.map((p) => p.x)) - 600;
    const maxX = Math.max(...all.map((p) => p.x)) + 600;
    const minY = Math.min(...all.map((p) => p.y)) - 600;
    const maxY = Math.max(...all.map((p) => p.y)) + 600;
    return { polys, vb: `${minX} ${minY} ${maxX - minX} ${maxY - minY}` };
  }, [model]);

  if (!svg) return null;
  return (
    <svg className={className} viewBox={svg.vb} preserveAspectRatio="xMidYMid meet" aria-hidden>
      <defs>
        <linearGradient id="iso-side" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffca28" stopOpacity="0.32" />
          <stop offset="1" stopColor="#ff7043" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      {svg.polys.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.kind === 'floor' ? 'rgba(138,180,248,0.10)' : p.kind === 'top' ? 'rgba(255,202,40,0.85)' : 'url(#iso-side)'}
          stroke={p.kind === 'floor' ? 'rgba(138,180,248,0.35)' : 'rgba(255,214,102,0.9)'}
          strokeWidth={p.kind === 'top' ? 10 : 14}
          strokeLinejoin="round"
          style={{ animation: `iso-in 0.5s ease-out ${Math.min(0.6, i * 0.004)}s both` }}
        />
      ))}
      <style>{'@keyframes iso-in{from{opacity:0;transform:translateY(120px)}}'}</style>
    </svg>
  );
}
