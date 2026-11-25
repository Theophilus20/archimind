/**
 * The sheet that teaches the AI plan symbols: a legend of standard symbols, drawn here and named,
 * above numbered tiles cut from the drawing, each with a red box round the part to identify (the
 * legend uses the same red box). Showing labelled examples next to enlarged, numbered candidates
 * ("set-of-mark" prompting) is far more reliable than asking a model to spot small symbols on a
 * whole drawing.
 */
import { FURNITURE_SYMBOLS, OPENING_SYMBOLS } from './symbols';
import type { Rasterized } from './rasterize';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** A tile: the part of the drawing to show, and the box to mark in red (both in drawing px). */
export interface SheetTile {
  crop: Rect;
  mark: Rect;
  /** Turn the tile a quarter turn so a wall running up the page lies flat, as in the legend. */
  turn?: boolean;
}
export type SheetKind = 'openings' | 'furniture';

/** Legend symbols are drawn on a 112 px cell and scaled to the sheet's cell size. */
const UNIT = 112;
/** Openings get bigger tiles: a sliding door's panels are thin lines inside the wall. */
const LAYOUT: Record<SheetKind, { cols: number; cell: number }> = { openings: { cols: 6, cell: 168 }, furniture: { cols: 7, cell: 144 } };
const NAME = 18;
const HEAD = 24;
const RED = '#e8000b';
/** The most tiles one sheet holds. */
export const MAX_TILES: Record<SheetKind, number> = { openings: 48, furniture: 56 };

/** The drawing on a canvas, to cut tiles from. */
export function rasterCanvas(r: Rasterized): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = r.width;
  c.height = r.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(r.rgba), r.width, r.height), 0, 0);
  return c;
}

type Draw = (g: CanvasRenderingContext2D) => void;
const rect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 0) => {
  g.beginPath();
  if (r) g.roundRect(x, y, w, h, r);
  else g.rect(x, y, w, h);
  g.stroke();
};
const line = (g: CanvasRenderingContext2D, ...p: number[]) => {
  g.beginPath();
  g.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
  g.stroke();
};
const circle = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
};

// Openings: a wall (y 65 to 75) with a gap from x 30 to 82, as drawn on a plan.
const wall: Draw = (g) => {
  g.fillStyle = '#000';
  g.fillRect(4, 65, 26, 10);
  g.fillRect(82, 65, 26, 10);
};
const OPENING_LEGEND: Record<(typeof OPENING_SYMBOLS)[number], Draw> = {
  'hinged door': (g) => {
    wall(g);
    g.lineWidth = 2;
    line(g, 30, 65, 30, 13);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(30, 65, 52, -Math.PI / 2, 0);
    g.stroke();
  },
  'double door': (g) => {
    wall(g);
    g.lineWidth = 2;
    line(g, 30, 65, 30, 39);
    line(g, 82, 65, 82, 39);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(30, 65, 26, -Math.PI / 2, 0);
    g.stroke();
    g.beginPath();
    g.arc(82, 65, 26, Math.PI, Math.PI * 1.5);
    g.stroke();
  },
  'sliding door': (g) => {
    wall(g);
    g.lineWidth = 1.2;
    line(g, 30, 65, 30, 75);
    line(g, 82, 65, 82, 75);
    rect(g, 30, 66, 30, 3.5);
    rect(g, 52, 70.5, 30, 3.5);
  },
  window: (g) => {
    wall(g);
    g.lineWidth = 1;
    line(g, 30, 65, 82, 65);
    line(g, 30, 70, 82, 70);
    line(g, 30, 75, 82, 75);
    line(g, 30, 65, 30, 75);
    line(g, 82, 65, 82, 75);
  },
  'open passage': wall,
};

// Furniture, seen from above, centred in the cell.
const FURNITURE_LEGEND: Record<(typeof FURNITURE_SYMBOLS)[number], Draw> = {
  bed: (g) => {
    rect(g, 36, 12, 40, 62);
    rect(g, 39, 15, 15, 9, 3);
    rect(g, 58, 15, 15, 9, 3);
    line(g, 36, 32, 76, 32);
  },
  sofa: (g) => {
    rect(g, 18, 30, 76, 32);
    rect(g, 18, 30, 76, 9);
    rect(g, 18, 39, 9, 23);
    rect(g, 85, 39, 9, 23);
    line(g, 46, 39, 46, 62);
    line(g, 66, 39, 66, 62);
  },
  armchair: (g) => {
    rect(g, 38, 28, 36, 36, 4);
    rect(g, 38, 28, 36, 9);
    rect(g, 38, 37, 8, 27);
    rect(g, 66, 37, 8, 27);
  },
  'dining table': (g) => {
    rect(g, 30, 34, 52, 26);
    for (const x of [34, 51, 68]) {
      rect(g, x, 21, 10, 10);
      rect(g, x, 63, 10, 10);
    }
  },
  'coffee table': (g) => circle(g, 56, 47, 16),
  desk: (g) => {
    rect(g, 26, 24, 60, 24);
    rect(g, 48, 54, 16, 14, 2);
    line(g, 48, 66, 64, 66);
  },
  wardrobe: (g) => {
    rect(g, 18, 34, 76, 24);
    line(g, 18, 34, 94, 58);
    line(g, 18, 58, 94, 34);
  },
  sideboard: (g) => rect(g, 22, 40, 68, 14),
  'TV unit': (g) => {
    rect(g, 22, 42, 68, 12);
    line(g, 34, 47, 78, 47);
  },
  'kitchen worktop': (g) => {
    rect(g, 10, 30, 92, 30);
    rect(g, 18, 35, 24, 20, 3);
    circle(g, 30, 45, 2);
    for (const [x, y] of [
      [64, 39],
      [80, 39],
      [64, 51],
      [80, 51],
    ])
      circle(g, x, y, 4.5);
  },
  'washing machine': (g) => {
    rect(g, 38, 27, 36, 36);
    circle(g, 56, 45, 13);
  },
  bath: (g) => {
    rect(g, 22, 30, 68, 34);
    rect(g, 27, 35, 58, 24, 10);
    circle(g, 34, 47, 2);
  },
  shower: (g) => {
    rect(g, 38, 28, 36, 36);
    line(g, 38, 28, 74, 64);
    line(g, 38, 64, 74, 28);
    circle(g, 56, 46, 3);
  },
  toilet: (g) => {
    rect(g, 44, 18, 24, 9);
    g.beginPath();
    g.ellipse(56, 44, 10, 15, 0, 0, Math.PI * 2);
    g.stroke();
  },
  basin: (g) => {
    rect(g, 40, 34, 32, 24);
    g.beginPath();
    g.ellipse(56, 47, 11, 8, 0, 0, Math.PI * 2);
    g.stroke();
    circle(g, 56, 37, 1.5);
  },
  plant: (g) => {
    for (let i = 0; i < 7; i++) circle(g, 56 + Math.cos((i * 2 * Math.PI) / 7) * 11, 47 + Math.sin((i * 2 * Math.PI) / 7) * 11, 7);
    circle(g, 56, 47, 4);
  },
  stair: (g) => {
    rect(g, 40, 8, 32, 76);
    for (let y = 16; y < 84; y += 8) line(g, 40, y, 72, y);
    line(g, 56, 78, 56, 16);
    line(g, 50, 24, 56, 16, 62, 24);
  },
};

/**
 * Draw the sheet for one kind of symbol: the legend, then a numbered tile per candidate.
 * Returns a JPEG for the AI and its size.
 */
export function buildSheet(kind: SheetKind, src: HTMLCanvasElement, tiles: SheetTile[]) {
  const legend: [string, Draw][] = kind === 'openings' ? OPENING_SYMBOLS.map((n) => [n, OPENING_LEGEND[n]]) : FURNITURE_SYMBOLS.map((n) => [n, FURNITURE_LEGEND[n]]);
  const shown = tiles.slice(0, MAX_TILES[kind]);
  const { cols: COLS, cell: CELL } = LAYOUT[kind];
  const legendRows = Math.ceil(legend.length / COLS);
  const tileRows = Math.max(1, Math.ceil(shown.length / COLS));
  const W = COLS * CELL;
  const H = HEAD + legendRows * (CELL + NAME) + HEAD + tileRows * CELL;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';
  const head = (y: number, text: string) => {
    g.fillStyle = '#202124';
    g.fillRect(0, y, W, HEAD);
    g.fillStyle = '#fff';
    g.font = 'bold 13px sans-serif';
    g.fillText(text, 8, y + HEAD / 2);
  };
  head(0, kind === 'openings' ? 'LEGEND: openings in walls as drawn on floor plans (red box = the opening)' : 'LEGEND: furniture and fittings as drawn on floor plans, seen from above');
  legend.forEach(([name, draw], i) => {
    const x = (i % COLS) * CELL;
    const y = HEAD + Math.floor(i / COLS) * (CELL + NAME);
    g.save();
    g.translate(x, y);
    g.strokeStyle = '#dadce0';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, CELL - 1, CELL + NAME - 1);
    g.save();
    g.scale(CELL / UNIT, CELL / UNIT);
    g.strokeStyle = '#000';
    g.fillStyle = '#000';
    g.lineWidth = 1.3;
    draw(g);
    if (kind === 'openings') {
      g.strokeStyle = RED;
      g.lineWidth = 1.5;
      g.strokeRect(27, 61, 58, 18);
    }
    g.restore();
    g.fillStyle = '#202124';
    g.font = '12px sans-serif';
    g.textAlign = 'center';
    g.fillText(name, CELL / 2, CELL + NAME / 2 - 2);
    g.textAlign = 'left';
    g.restore();
  });
  const top = HEAD + legendRows * (CELL + NAME);
  head(top, 'NUMBERED TILES cut from the drawing: which legend symbol is inside each red box?');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  shown.forEach((t, i) => {
    const x = (i % COLS) * CELL;
    const y = top + HEAD + Math.floor(i / COLS) * CELL;
    const cx0 = Math.max(0, Math.floor(t.crop.x0));
    const cy0 = Math.max(0, Math.floor(t.crop.y0));
    const cx1 = Math.min(src.width, Math.ceil(t.crop.x1));
    const cy1 = Math.min(src.height, Math.ceil(t.crop.y1));
    const cw0 = Math.max(1, cx1 - cx0);
    const ch0 = Math.max(1, cy1 - cy0);
    // the crop (turned a quarter turn anticlockwise if asked) and the red box in its pixels
    let piece: CanvasImageSource = src;
    let [px0, py0, cw, ch] = [cx0, cy0, cw0, ch0];
    let mark = { x0: t.mark.x0 - cx0, y0: t.mark.y0 - cy0, x1: t.mark.x1 - cx0, y1: t.mark.y1 - cy0 };
    if (t.turn) {
      const tmp = document.createElement('canvas');
      tmp.width = ch0;
      tmp.height = cw0;
      const tg = tmp.getContext('2d')!;
      tg.translate(0, cw0);
      tg.rotate(-Math.PI / 2);
      tg.drawImage(src, cx0, cy0, cw0, ch0, 0, 0, cw0, ch0);
      piece = tmp;
      [px0, py0, cw, ch] = [0, 0, ch0, cw0];
      // (u, v) in the crop lands at (v, width - u)
      mark = { x0: mark.y0, y0: cw0 - mark.x1, x1: mark.y1, y1: cw0 - mark.x0 };
    }
    const s = Math.min((CELL - 8) / cw, (CELL - 8) / ch, 6);
    const dx = x + (CELL - cw * s) / 2;
    const dy = y + (CELL - ch * s) / 2;
    g.drawImage(piece, px0, py0, cw, ch, dx, dy, cw * s, ch * s);
    // the red box stands clear of the symbol's own lines (a box drawn on a cabinet's outline
    // would leave it looking empty)
    const pad = kind === 'furniture' ? 6 : 1.5;
    g.strokeStyle = RED;
    g.lineWidth = 1.5;
    g.strokeRect(dx + mark.x0 * s - pad, dy + mark.y0 * s - pad, (mark.x1 - mark.x0) * s + 2 * pad, (mark.y1 - mark.y0) * s + 2 * pad);
    g.strokeStyle = '#dadce0';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
    g.fillStyle = '#fff';
    g.fillRect(x + 2, y + 2, 26, 17);
    g.strokeStyle = '#202124';
    g.strokeRect(x + 2.5, y + 2.5, 25, 16);
    g.fillStyle = '#202124';
    g.font = 'bold 12px sans-serif';
    g.fillText(String(i + 1), x + 6, y + 11);
  });
  return { image: { mimeType: 'image/jpeg' as const, data: c.toDataURL('image/jpeg', 0.9).split(',')[1] }, width: W, height: H, count: shown.length };
}

/** A tile round an opening in a wall: wide enough to show a door's swing. */
export function openingTile(centre: { x: number; y: number }, horizontal: boolean, width: number, thickness: number): SheetTile {
  // a door's swing reaches its own width out from the wall; the panels of a sliding door or the
  // glass of a window sit inside the wall, so keep the crop tight enough to show them large
  const half = Math.max(width * 0.85, thickness * 3, 20);
  const along = width / 2;
  const across = thickness / 2 + 2;
  return {
    turn: !horizontal,
    crop: { x0: centre.x - half, y0: centre.y - half, x1: centre.x + half, y1: centre.y + half },
    mark: horizontal ? { x0: centre.x - along, y0: centre.y - across, x1: centre.x + along, y1: centre.y + across } : { x0: centre.x - across, y0: centre.y - along, x1: centre.x + across, y1: centre.y + along },
  };
}

/** A tile round a box the AI drew ([ymin, xmin, ymax, xmax], 0 to 1000 across the drawing). */
export function boxTile(box: [number, number, number, number], w: number, h: number): SheetTile {
  const mark = { x0: (box[1] / 1000) * w, y0: (box[0] / 1000) * h, x1: (box[3] / 1000) * w, y1: (box[2] / 1000) * h };
  const pad = Math.max(mark.x1 - mark.x0, mark.y1 - mark.y0) * 0.45 + 10;
  return { crop: { x0: mark.x0 - pad, y0: mark.y0 - pad, x1: mark.x1 + pad, y1: mark.y1 + pad }, mark };
}
