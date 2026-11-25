/**
 * Dimension strings outside the building, as on a construction drawing: the string nearest the
 * plan locates openings, the next locates partitions, the outer one gives the overall size. Each
 * string is a continuous line with tick marks and the figure above it (drafting convention).
 */
import { openingFrame } from '../model/geometry';
import type { BuildingModel, Vec2, Wall } from '../model/types';

const TOL = 60;

function uniqueSorted(xs: number[]) {
  const out: number[] = [];
  for (const x of xs.sort((a, b) => a - b)) if (!out.length || x - out[out.length - 1] > 30) out.push(Math.round(x));
  return out;
}

export function PlanDims({ model, k, fs }: { model: BuildingModel; k: number; fs: number }) {
  const ext = model.walls.filter((w) => w.exterior);
  if (ext.length < 3) return null;
  const xs = ext.flatMap((w) => [w.a.x, w.b.x]);
  const ys = ext.flatMap((w) => [w.a.y, w.b.y]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const t = Math.max(...ext.map((w) => w.thickness)) / 2;
  const left = minX - t, right = maxX + t, top = minY - t, bottom = maxY + t;

  const onTop = (w: Wall) => Math.abs(w.a.y - minY) < TOL && Math.abs(w.b.y - minY) < TOL;
  const onLeft = (w: Wall) => Math.abs(w.a.x - minX) < TOL && Math.abs(w.b.x - minX) < TOL;
  const opsOn = (side: (w: Wall) => boolean, axis: 'x' | 'y') =>
    model.openings.flatMap((o) => {
      const w = model.walls.find((x) => x.id === o.wallId);
      if (!w || !side(w)) return [];
      const f = openingFrame(o, w);
      return [f.start[axis], f.end[axis]];
    });
  // partitions meeting the side: interior walls with an end on it
  const partitions = (axis: 'x' | 'y', at: number) =>
    model.walls.filter((w) => !w.exterior).flatMap((w) => [w.a, w.b].filter((p) => Math.abs((axis === 'x' ? p.y : p.x) - at) < t + TOL).map((p) => (axis === 'x' ? p.x : p.y)));

  const gap = Math.max(700, 34 * k);
  const step = Math.max(550, 26 * k);
  const tick = Math.max(110, 5 * k);
  const textSize = Math.max(fs * 0.78, 150);
  const line = { stroke: '#3c4043', strokeWidth: 0.9 * k, fill: 'none' as const };

  /** One horizontal (top) or vertical (left) chain of dimensions. */
  const chain = (marks: number[], level: number, horizontal: boolean, key: string) => {
    const pts = uniqueSorted(marks);
    if (pts.length < 2) return null;
    const P = (v: number): Vec2 => (horizontal ? { x: v, y: level } : { x: level, y: v });
    const from = horizontal ? top - gap * 0.35 : left - gap * 0.35; // extension lines start just off the building
    return (
      <g key={key}>
        <line x1={P(pts[0]).x} y1={P(pts[0]).y} x2={P(pts[pts.length - 1]).x} y2={P(pts[pts.length - 1]).y} {...line} />
        {pts.map((v, i) => {
          const p = P(v);
          return (
            <g key={i}>
              {horizontal ? <line x1={p.x} y1={from} x2={p.x} y2={p.y - tick} {...line} strokeWidth={0.6 * k} /> : <line x1={from} y1={p.y} x2={p.x - tick} y2={p.y} {...line} strokeWidth={0.6 * k} />}
              <line x1={p.x - tick} y1={p.y + tick} x2={p.x + tick} y2={p.y - tick} stroke="#202124" strokeWidth={1.6 * k} />
            </g>
          );
        })}
        {pts.slice(1).map((v, i) => {
          const len = v - pts[i];
          const label = String(Math.round(len));
          if (len < label.length * textSize * 0.62) return null; // too tight to letter
          const mid = (v + pts[i]) / 2;
          return horizontal ? (
            <text key={`t${i}`} x={mid} y={level - textSize * 0.35} fontSize={textSize} textAnchor="middle" fill="#202124">
              {label}
            </text>
          ) : (
            <text key={`t${i}`} x={level - textSize * 0.35} y={mid} fontSize={textSize} textAnchor="middle" fill="#202124" transform={`rotate(-90 ${level - textSize * 0.35} ${mid})`}>
              {label}
            </text>
          );
        })}
      </g>
    );
  };

  const topOpenings = opsOn(onTop, 'x');
  const leftOpenings = opsOn(onLeft, 'y');
  const topParts = partitions('x', minY);
  const leftParts = partitions('y', minX);
  const rows: React.ReactNode[] = [];
  let lvl = top - gap;
  if (topOpenings.length) {
    rows.push(chain([left, right, ...topOpenings], lvl, true, 'to'));
    lvl -= step;
  }
  if (uniqueSorted([left, right, ...topParts]).length > 2) {
    rows.push(chain([left, right, ...topParts], lvl, true, 'tp'));
    lvl -= step;
  }
  rows.push(chain([left, right], lvl, true, 'tt'));
  let lv = left - gap;
  if (leftOpenings.length) {
    rows.push(chain([top, bottom, ...leftOpenings], lv, false, 'lo'));
    lv -= step;
  }
  if (uniqueSorted([top, bottom, ...leftParts]).length > 2) {
    rows.push(chain([top, bottom, ...leftParts], lv, false, 'lp'));
    lv -= step;
  }
  rows.push(chain([top, bottom], lv, false, 'lt'));
  return <g style={{ pointerEvents: 'none' }}>{rows}</g>;
}

/**
 * A dimension placed by hand: extension lines from the two measured points, the dimension line
 * offset to one side with architectural ticks, and the length written above the line.
 */
export function UserDimension({
  d,
  k,
  fs,
  colour = '#202124',
  preview = false,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
}: {
  d: { a: Vec2; b: Vec2; offset: number };
  k: number;
  fs: number;
  colour?: string;
  preview?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const dx = d.b.x - d.a.x;
  const dy = d.b.y - d.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  const u = { x: dx / len, y: dy / len };
  const n = { x: -u.y, y: u.x };
  const A = { x: d.a.x + n.x * d.offset, y: d.a.y + n.y * d.offset };
  const B = { x: d.b.x + n.x * d.offset, y: d.b.y + n.y * d.offset };
  const side = d.offset >= 0 ? 1 : -1;
  const gap = Math.min(Math.abs(d.offset) * 0.3, 120);
  const over = Math.max(110, 5 * k);
  const tick = Math.max(100, 4.5 * k);
  const textSize = Math.max(fs * 0.82, 150);
  // keep the text upright
  let angle = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;
  const mid = { x: (A.x + B.x) / 2 + n.x * side * textSize * 0.45, y: (A.y + B.y) / 2 + n.y * side * textSize * 0.45 };
  const ext = (p: Vec2, q: Vec2) => ({ x1: p.x + n.x * side * gap, y1: p.y + n.y * side * gap, x2: q.x + n.x * side * over, y2: q.y + n.y * side * over });
  const s = { stroke: colour, strokeWidth: 0.9 * k, strokeDasharray: preview ? `${4 * k} ${3 * k}` : undefined };
  return (
    <g onPointerDown={onPointerDown} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} style={{ cursor: onPointerDown ? 'pointer' : undefined, pointerEvents: preview ? 'none' : undefined }}>
      <line {...ext(d.a, A)} {...s} strokeWidth={0.6 * k} />
      <line {...ext(d.b, B)} {...s} strokeWidth={0.6 * k} />
      <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} {...s} />
      {[A, B].map((p, i) => (
        <line key={i} x1={p.x - (u.x + n.x) * tick} y1={p.y - (u.y + n.y) * tick} x2={p.x + (u.x + n.x) * tick} y2={p.y + (u.y + n.y) * tick} stroke={colour} strokeWidth={1.6 * k} />
      ))}
      <text x={mid.x} y={mid.y} fontSize={textSize} textAnchor="middle" dominantBaseline="middle" fill={colour} transform={`rotate(${angle} ${mid.x} ${mid.y})`}>
        {Math.round(len)}
      </text>
      {/* generous invisible hit area for selecting or erasing */}
      {onPointerDown && <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke="transparent" strokeWidth={Math.max(textSize * 1.6, 14 * k)} />}
    </g>
  );
}
