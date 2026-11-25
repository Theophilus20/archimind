/**
 * Multi-storey rendering: procedural facade textures (glass curtain wall, ribbed
 * cladding, brick, panels), floor slabs, the shell of repeated typical floors,
 * vertical fins, and roofs (flat with parapets, roof garden, sawtooth with
 * skylights, glass crown with spire). Everything is generated from the model.
 */
import { useMemo } from 'react';
import * as THREE from 'three';
import type { BuildingModel, BuildingSpec, Wall } from '../model/types';
import type { DerivedRoom } from '../model/derive';
import { materialById } from '../model/materials';
import { wallNormal } from '../model/geometry';

const S = 1 / 1000;

// ---------------------------------------------------------------------------
// Facade textures (drawn once, shared)
// ---------------------------------------------------------------------------

/** Real-world size of one texture tile, metres [width, height]. */
export const TEX_MODULE: Record<string, [number, number]> = {
  curtain: [1.5, 3.8],
  cladding: [1.2, 3],
  'cladding-dark': [1.2, 3],
  brick: [1.0, 0.5],
  'white-panel': [1.5, 1.5],
  concrete: [2.4, 1.2],
  'timber-clad': [0.9, 3],
};

const cache = new Map<string, THREE.CanvasTexture>();

function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  cache.set(key, t);
  return t;
}

function glass(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tint = ['#b9d6e8', '#4d7895']) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, tint[0]);
  gr.addColorStop(1, tint[1]);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
  // a soft diagonal reflection
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = 'rgba(255,255,255,0.13)';
  g.beginPath();
  g.moveTo(x + w * 0.15, y);
  g.lineTo(x + w * 0.55, y);
  g.lineTo(x + w * 0.1, y + h);
  g.lineTo(x - w * 0.3, y + h);
  g.fill();
  g.restore();
}

export function facadeTexture(id: string, color?: string): THREE.Texture | null {
  switch (id) {
    case 'curtain':
      return canvasTex('curtain', 128, 320, (g) => {
        glass(g, 0, 0, 128, 320);
        g.fillStyle = '#26313b';
        g.fillRect(0, 0, 5, 320);
        g.fillRect(123, 0, 5, 320);
        g.fillRect(0, 222, 128, 4); // transom
        g.fillStyle = '#34404b';
        g.fillRect(0, 296, 128, 24); // slab edge
      });
    case 'cladding':
    case 'cladding-dark':
      return canvasTex(id, 128, 256, (g) => {
        const base = id === 'cladding' ? ['#d5d9dc', '#aab0b5'] : ['#4a535c', '#2f363d'];
        g.fillStyle = base[0];
        g.fillRect(0, 0, 128, 256);
        for (let i = 0; i < 8; i++) {
          const gr = g.createLinearGradient(i * 16, 0, i * 16 + 16, 0);
          gr.addColorStop(0, base[1]);
          gr.addColorStop(0.5, base[0]);
          gr.addColorStop(1, base[1]);
          g.fillStyle = gr;
          g.fillRect(i * 16 + 2, 0, 12, 256);
        }
      });
    case 'brick':
      return canvasTex('brick', 128, 64, (g) => {
        g.fillStyle = '#d9cfc4';
        g.fillRect(0, 0, 128, 64);
        const tones = ['#a65a3c', '#9b5236', '#b0654a', '#94503a'];
        for (let row = 0; row < 4; row++)
          for (let col = -1; col < 3; col++) {
            const x = col * 60 + (row % 2) * 30 + 2;
            g.fillStyle = tones[(row * 3 + col + 8) % 4];
            g.fillRect(x, row * 16 + 2, 56, 12);
          }
      });
    case 'white-panel':
      return canvasTex('white-panel', 128, 128, (g) => {
        g.fillStyle = '#eef0f1';
        g.fillRect(0, 0, 128, 128);
        g.fillStyle = '#c9cdd0';
        g.fillRect(0, 0, 128, 2);
        g.fillRect(0, 0, 2, 128);
      });
    case 'concrete':
      return canvasTex('concrete', 256, 128, (g) => {
        g.fillStyle = '#bcb9b3';
        g.fillRect(0, 0, 256, 128);
        g.fillStyle = 'rgba(0,0,0,0.06)';
        for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 256, 1);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        for (const [x, y] of [[32, 32], [96, 32], [160, 32], [224, 32], [32, 96], [96, 96], [160, 96], [224, 96]]) {
          g.beginPath();
          g.arc(x, y, 2.5, 0, Math.PI * 2);
          g.fill();
        }
      });
    case 'timber-clad':
      return canvasTex('timber-clad', 128, 256, (g) => {
        const tones = ['#3b3330', '#453a35', '#352e2b', '#4a3f39'];
        for (let i = 0; i < 8; i++) {
          g.fillStyle = tones[i % 4];
          g.fillRect(i * 16, 0, 15, 256);
        }
      });
    case 'punched':
      return canvasTex(`punched-${color}`, 128, 320, (g) => {
        g.fillStyle = color ?? '#e6dccb';
        g.fillRect(0, 0, 128, 320);
        glass(g, 22, 70, 84, 170, ['#9fc0d4', '#3f6680']);
        g.strokeStyle = '#37404a';
        g.lineWidth = 4;
        g.strokeRect(22, 70, 84, 170);
        g.fillStyle = 'rgba(0,0,0,0.12)';
        g.fillRect(0, 300, 128, 20);
      });
  }
  return null;
}

/** Box with UVs in metres / tile size, so textures keep their real scale on every piece. */
export function scaledBox(len: number, h: number, t: number, id: string, storeyM?: number) {
  const g = new THREE.BoxGeometry(len, h, t);
  const mod = TEX_MODULE[id];
  if (mod) {
    const mh = id === 'curtain' && storeyM ? storeyM : mod[1];
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (len / mod[0]), uv.getY(i) * (h / mh));
    uv.needsUpdate = true;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Slabs, shells, fins
// ---------------------------------------------------------------------------

function shapeOf(poly: { x: number; y: number }[], cx: number, cy: number) {
  return new THREE.Shape(poly.map((p) => new THREE.Vector2((p.x - cx) * S, -(p.y - cy) * S)));
}

/** A slab under a floor (or a roof deck): rooms' outlines extruded. */
export function Slab({ rooms, cx, cy, y, thick = 0.25, color = '#d8d4cc', rough = 0.9 }: { rooms: DerivedRoom[]; cx: number; cy: number; y: number; thick?: number; color?: string; rough?: number }) {
  const geos = useMemo(() => rooms.map((r) => new THREE.ExtrudeGeometry(shapeOf(r.polygon, cx, cy), { depth: thick, bevelEnabled: false })), [rooms, cx, cy, thick]);
  return (
    <>
      {geos.map((g, i) => (
        <mesh key={i} geometry={g} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={color} roughness={rough} />
        </mesh>
      ))}
    </>
  );
}

/** Plan direction pointing outside for each exterior wall (+1 = along the wall normal). */
export function outwardSigns(walls: Wall[], roomAt: (p: { x: number; y: number }) => unknown) {
  const m = new Map<string, number>();
  for (const w of walls) {
    if (!w.exterior) continue;
    const n = wallNormal(w);
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    m.set(w.id, roomAt({ x: mid.x + n.x * 700, y: mid.y + n.y * 700 }) ? -1 : 1);
  }
  return m;
}

/** Vertical fins along exterior walls, as one instanced mesh. */
export function Fins({ walls, outward, cx, cy, y0, height, color }: { walls: Wall[]; outward: Map<string, number>; cx: number; cy: number; y0: number; height: number; color: string }) {
  const mesh = useMemo(() => {
    const mats: THREE.Matrix4[] = [];
    for (const w of walls) {
      if (!w.exterior) continue;
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      const n = wallNormal(w);
      const s = outward.get(w.id) ?? 1;
      const dx = (w.b.x - w.a.x) / L;
      const dy = (w.b.y - w.a.y) / L;
      const off = w.thickness / 2 + 175;
      const ang = -Math.atan2(dy, dx);
      const count = Math.floor(L / 1100);
      for (let i = 1; i < count; i++) {
        const t = (i / count) * L;
        const px = w.a.x + dx * t + n.x * s * off;
        const py = w.a.y + dy * t + n.y * s * off;
        const m = new THREE.Matrix4().compose(new THREE.Vector3((px - cx) * S, y0 + height / 2, (py - cy) * S), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ang, 0)), new THREE.Vector3(1, 1, 1));
        mats.push(m);
      }
    }
    const geo = new THREE.BoxGeometry(0.06, height, 0.35);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 });
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, mats.length));
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.count = mats.length;
    im.castShadow = true;
    return im;
  }, [walls, outward, cx, cy, y0, height, color]);
  return <primitive object={mesh} />;
}

/** The outside of repeated typical floors: one tall textured box per exterior wall. */
export function RepeatShell({ walls, cx, cy, y0, floors, storey, outward, spec }: { walls: Wall[]; cx: number; cy: number; y0: number; floors: number; storey: number; outward: Map<string, number>; spec?: BuildingSpec }) {
  const items = useMemo(() => {
    const H = floors * storey * S;
    return walls
      .filter((w) => w.exterior)
      .map((w) => {
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * S;
        const mat = materialById(w.materialId);
        const id = w.materialId === 'curtain' ? 'curtain' : w.materialId.startsWith('cladding') ? w.materialId : 'punched';
        const tex = facadeTexture(id, mat.color);
        const geo = new THREE.BoxGeometry(L, H, w.thickness * S);
        const uv = geo.attributes.uv as THREE.BufferAttribute;
        const mw = id === 'curtain' || id === 'punched' ? 1.5 : TEX_MODULE[id]?.[0] ?? 1.2;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (L / mw), uv.getY(i) * floors);
        const m = new THREE.MeshStandardMaterial({ map: tex, roughness: id === 'curtain' ? 0.12 : 0.7, metalness: id === 'curtain' ? 0.45 : 0.05, envMapIntensity: id === 'curtain' ? 1.6 : 1 });
        return { w, L, H, geo, m };
      });
  }, [walls, floors, storey]);
  return (
    <>
      {items.map(({ w, H, geo, m }) => (
        <mesh key={w.id} geometry={geo} material={m} position={[((w.a.x + w.b.x) / 2 - cx) * S, y0 + H / 2, ((w.a.y + w.b.y) / 2 - cy) * S]} rotation={[0, -Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x), 0]} castShadow receiveShadow />
      ))}
      {spec?.facade === 'fins' && <Fins walls={walls} outward={outward} cx={cx} cy={cy} y0={y0} height={floors * storey * S} color={spec.accent} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Roofs for generated buildings
// ---------------------------------------------------------------------------

function pseudo(i: number) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function Parapets({ walls, cx, cy, y }: { walls: Wall[]; cx: number; cy: number; y: number }) {
  return (
    <>
      {walls.map((w) => {
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) * S;
        return (
          <mesh key={w.id} position={[((w.a.x + w.b.x) / 2 - cx) * S, y + 0.45, ((w.a.y + w.b.y) / 2 - cy) * S]} rotation={[0, -Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x), 0]} castShadow>
            <boxGeometry args={[L + w.thickness * S, 0.9, w.thickness * S]} />
            <meshStandardMaterial color={w.materialId === 'curtain' ? '#3a4652' : materialById(w.materialId).color} roughness={0.7} />
          </mesh>
        );
      })}
    </>
  );
}

function Sawtooth({ room, cx, cy, y }: { room: DerivedRoom; cx: number; cy: number; y: number }) {
  const xs = room.polygon.map((p) => p.x);
  const ys = room.polygon.map((p) => p.y);
  const x0 = (Math.min(...xs) - cx) * S;
  const x1 = (Math.max(...xs) - cx) * S;
  const z0 = (Math.min(...ys) - cy) * S;
  const z1 = (Math.max(...ys) - cy) * S;
  const D = z1 - z0;
  const n = Math.max(2, Math.round((x1 - x0) / 7));
  const tw = (x1 - x0) / n;
  const rise = 2.4;
  const slope = Math.hypot(tw, rise);
  const ang = Math.atan2(rise, tw);
  return (
    <group>
      <mesh position={[(x0 + x1) / 2, y + 0.1, (z0 + z1) / 2]} receiveShadow>
        <boxGeometry args={[x1 - x0, 0.2, D]} />
        <meshStandardMaterial color="#8d969e" roughness={0.6} metalness={0.3} />
      </mesh>
      {Array.from({ length: n }, (_, i) => {
        const a = x0 + i * tw;
        return (
          <group key={i}>
            <mesh position={[a + tw / 2, y + 0.2 + rise / 2, (z0 + z1) / 2]} rotation={[0, 0, ang]} castShadow receiveShadow>
              <boxGeometry args={[slope, 0.12, D]} />
              <meshStandardMaterial color="#c3c8cc" roughness={0.45} metalness={0.55} />
            </mesh>
            <mesh position={[a + tw, y + 0.2 + rise / 2, (z0 + z1) / 2]}>
              <boxGeometry args={[0.05, rise, D]} />
              <meshPhysicalMaterial color="#bfe3f2" roughness={0.05} transparent opacity={0.45} envMapIntensity={1.6} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function Garden({ room, cx, cy, y }: { room: DerivedRoom; cx: number; cy: number; y: number }) {
  const shrubs = useMemo(() => {
    const xs = room.inner.map((p) => p.x);
    const ys = room.inner.map((p) => p.y);
    const out: { x: number; z: number; r: number }[] = [];
    const inside = (p: { x: number; y: number }) => {
      let s = false;
      const poly = room.inner;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i].y > p.y !== poly[j].y > p.y && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) s = !s;
      return s;
    };
    for (let i = 0; out.length < Math.min(14, Math.max(3, room.area / 25)) && i < 200; i++) {
      const p = { x: Math.min(...xs) + pseudo(i) * (Math.max(...xs) - Math.min(...xs)), y: Math.min(...ys) + pseudo(i + 99) * (Math.max(...ys) - Math.min(...ys)) };
      if (inside(p)) out.push({ x: (p.x - cx) * S, z: (p.y - cy) * S, r: 0.5 + pseudo(i + 7) * 0.6 });
    }
    return out;
  }, [room, cx, cy]);
  return (
    <>
      {shrubs.map((s, i) => (
        <mesh key={i} position={[s.x, y + s.r * 0.8, s.z]} castShadow>
          <sphereGeometry args={[s.r, 12, 10]} />
          <meshStandardMaterial color={i % 3 ? '#5f8f45' : '#7aa356'} roughness={1} />
        </mesh>
      ))}
    </>
  );
}

function Crown({ outline, cx, cy, y, accent }: { outline: { x: number; y: number }[]; cx: number; cy: number; y: number; accent: string }) {
  const geo = useMemo(() => {
    const mx = outline.reduce((s, p) => s + p.x, 0) / outline.length;
    const my = outline.reduce((s, p) => s + p.y, 0) / outline.length;
    const pts = outline.map((p) => ({ x: mx + (p.x - mx) * 0.9, y: my + (p.y - my) * 0.9 }));
    return { g: new THREE.ExtrudeGeometry(shapeOf(pts, cx, cy), { depth: 7, bevelEnabled: false }), c: [(mx - cx) * S, (my - cy) * S] as [number, number] };
  }, [outline, cx, cy]);
  return (
    <group>
      <mesh geometry={geo.g} rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]}>
        <meshPhysicalMaterial color="#cfe8f6" roughness={0.05} metalness={0.2} transparent opacity={0.55} emissive={accent} emissiveIntensity={0.18} envMapIntensity={1.8} />
      </mesh>
      <mesh position={[geo.c[0], y + 7 + 9, geo.c[1]]} castShadow>
        <cylinderGeometry args={[0.08, 0.35, 18, 12]} />
        <meshStandardMaterial color={accent} metalness={0.7} roughness={0.25} />
      </mesh>
    </group>
  );
}

export interface RoofPiece {
  room: DerivedRoom;
  /** Height of the roof deck above ground, m. */
  y: number;
  walls: Wall[];
  top: boolean;
  /** Walls taller than 6 m (production halls) get the sawtooth. */
  tall: boolean;
}

/** Roofs for a generated building: flat with parapets, garden, sawtooth or crown. */
export function SpecRoofs({ pieces, spec, cx, cy, crownOutline }: { pieces: RoofPiece[]; spec: BuildingSpec; cx: number; cy: number; crownOutline?: { x: number; y: number }[] }) {
  const topY = Math.max(0, ...pieces.filter((p) => p.top).map((p) => p.y));
  return (
    <group>
      {pieces.map((p, i) => {
        const big = p.room.area > 250;
        const ext = p.walls.filter((w) => w.exterior && p.room.wallIds.includes(w.id));
        if (spec.roof === 'sawtooth' && big && p.tall) return <Sawtooth key={i} room={p.room} cx={cx} cy={cy} y={p.y} />;
        const green = spec.roof === 'garden' && p.room.area > 12;
        return (
          <group key={i}>
            <Slab rooms={[p.room]} cx={cx} cy={cy} y={p.y} thick={0.3} color={green ? '#6b8f4e' : '#c9c6bf'} rough={1} />
            <Parapets walls={ext} cx={cx} cy={cy} y={p.y + 0.3} />
            {green && <Garden room={p.room} cx={cx} cy={cy} y={p.y + 0.3} />}
          </group>
        );
      })}
      {spec.roof === 'crown' && crownOutline && crownOutline.length > 2 && <Crown outline={crownOutline} cx={cx} cy={cy} y={topY + 0.3} accent={spec.accent} />}
    </group>
  );
}

/** Ordered exterior outline of a level (generated buildings draw exterior walls in order). */
export function exteriorOutline(m: Pick<BuildingModel, 'walls'>) {
  return m.walls.filter((w) => w.exterior).map((w) => w.a);
}

/** A curved canopy on slim columns (e.g. the handle of a bag-shaped building). */
export function Canopy({ points, cx, cy, color, height = 4.8 }: { points: { x: number; y: number }[]; cx: number; cy: number; color: string; height?: number }) {
  const segs = useMemo(() => {
    const out: { x: number; z: number; len: number; ang: number }[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) * S;
      out.push({ x: ((a.x + b.x) / 2 - cx) * S, z: ((a.y + b.y) / 2 - cy) * S, len, ang: -Math.atan2(b.y - a.y, b.x - a.x) });
    }
    return out;
  }, [points, cx, cy]);
  return (
    <group>
      {segs.map((sg, i) => (
        <mesh key={i} position={[sg.x, height, sg.z]} rotation={[0, sg.ang, 0]} castShadow receiveShadow>
          <boxGeometry args={[sg.len + 0.08, 0.22, 2.6]} />
          <meshStandardMaterial color={color} roughness={0.35} metalness={0.4} />
        </mesh>
      ))}
      {points
        .filter((_, i) => i % 3 === 0)
        .map((p, i) => (
          <mesh key={`c${i}`} position={[(p.x - cx) * S, height / 2, (p.y - cy) * S]} castShadow>
            <cylinderGeometry args={[0.09, 0.11, height, 10]} />
            <meshStandardMaterial color="#5f6368" metalness={0.6} roughness={0.35} />
          </mesh>
        ))}
    </group>
  );
}
