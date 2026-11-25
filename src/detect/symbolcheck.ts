/**
 * Run the symbol check: cut a tile for every opening the pixel check found, every extra door and
 * window the AI read, and every piece of furniture it read; put them on legend sheets; ask the AI
 * which legend symbol each tile shows; match the answers back.
 */
import { readSymbolSheet, type PlanParts } from '../ai/requests';
import type { DetectedOpening, DetectedWall } from './detector';
import type { Rasterized } from './rasterize';
import { boxTile, buildSheet, openingTile, rasterCanvas, type Rect, type SheetKind, type SheetTile } from './symbolsheet';
import { furnitureCandidates } from './candidates';
import { SYMBOL_KIND, type FurnitureSymbol } from './symbols';
import type { Side } from '../ai/requests';
import type { FurnitureAnswer, OpeningAnswer, SymbolAnswers } from './symbols';

type Ref = { t: 'found'; id: string } | { t: 'doors' | 'windows'; i: number };

export async function checkSymbols(r: Rasterized, walls: DetectedWall[], openings: DetectedOpening[], parts: PlanParts): Promise<SymbolAnswers | null> {
  const src = rasterCanvas(r);
  const oTiles: SheetTile[] = [];
  const oRefs: Ref[] = [];
  for (const o of openings) {
    const w = walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const horiz = Math.abs(w.a.y - w.b.y) < 1;
    // offsets run from a pixel wall's smaller end
    const along = (horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y)) + o.offset;
    oTiles.push(openingTile(horiz ? { x: along, y: w.a.y } : { x: w.a.x, y: along }, horiz, o.width, w.thickness));
    oRefs.push({ t: 'found', id: o.id });
  }
  parts.doors.forEach((b, i) => (oTiles.push(boxTile(b, r.width, r.height)), oRefs.push({ t: 'doors', i })));
  parts.windows.forEach((b, i) => (oTiles.push(boxTile(b, r.width, r.height)), oRefs.push({ t: 'windows', i })));
  // Furniture: the shapes drawn on the plan first (exact place and size), then any piece the AI
  // read where no shape was found.
  const shapes = furnitureCandidates(r.rgba, r.width, r.height, walls, openings);
  const toBox = (c: Rect): [number, number, number, number] => [(c.y0 / r.height) * 1000, (c.x0 / r.width) * 1000, (c.y1 / r.height) * 1000, (c.x1 / r.width) * 1000];
  const covered = (b: [number, number, number, number]) => {
    const cx = (((b[1] + b[3]) / 2) * r.width) / 1000;
    const cy = (((b[0] + b[2]) / 2) * r.height) / 1000;
    return shapes.some((c) => cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1);
  };
  const shapeTile = (c: Rect): SheetTile => {
    const pad = Math.max(c.x1 - c.x0, c.y1 - c.y0) * 0.45 + 10;
    return { crop: { x0: c.x0 - pad, y0: c.y0 - pad, x1: c.x1 + pad, y1: c.y1 + pad }, mark: c };
  };
  const extra = parts.furniture.map((f, i) => ({ f, i })).filter(({ f }) => !covered(f.box));
  const fTiles = [...shapes.map(shapeTile), ...extra.map(({ f }) => boxTile(f.box, r.width, r.height))];

  // An answer of "none" for most tiles is the model failing (every tile was cut round something
  // found), not the drawing: ask once more, and if it happens again, ignore that sheet (what was
  // read before stays as it was).
  // (judged on the tiles cut round something found on the drawing; the AI's own furniture boxes
  // may rightly be "none" when it read them in the wrong place)
  type Answer = { symbol: string; back?: Side };
  const ask = async (kind: SheetKind, tiles: SheetTile[], judged: number): Promise<(Answer | undefined)[] | null> => {
    if (!tiles.length) return [];
    try {
      const sheet = buildSheet(kind, src, tiles);
      for (let i = 0; i < 2; i++) {
        const res = await readSymbolSheet(kind, sheet.image, sheet.count);
        if (res.source === 'heuristic') return null;
        const out: (Answer | undefined)[] = new Array(tiles.length).fill(undefined);
        for (const t of res.data.tiles) out[t.n - 1] = { symbol: t.symbol, back: t.back };
        const answered = out.slice(0, Math.min(judged, sheet.count)).filter(Boolean) as Answer[];
        const none = answered.filter((a) => a.symbol === 'none').length;
        if (answered.length >= Math.min(3, judged, sheet.count) && none <= answered.length * 0.5) return out;
      }
      return null;
    } catch {
      return null;
    }
  };
  const [oa, fa] = await Promise.all([ask('openings', oTiles, oRefs.filter((x) => x.t === 'found').length), ask('furniture', fTiles, shapes.length || fTiles.length)]);
  if (oa === null && fa === null) return null;
  const answers: SymbolAnswers = { openings: new Map(), doors: [], windows: [], furniture: [], found: [] };
  (oa ?? []).forEach((a, k) => {
    if (!a) return;
    const ref = oRefs[k];
    if (ref.t === 'found') answers.openings.set(ref.id, a.symbol as OpeningAnswer);
    else answers[ref.t][ref.i] = a.symbol as OpeningAnswer;
  });
  if (fa) {
    shapes.forEach((c, k) => {
      const a = fa[k];
      // what the AI's first reading called it, for when the closer look names something that
      // cannot be in that room
      const first = parts.furniture.find((f) => {
        const cx = (((f.box[1] + f.box[3]) / 2) * r.width) / 1000;
        const cy = (((f.box[0] + f.box[2]) / 2) * r.height) / 1000;
        return cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1;
      });
      if (!a || a.symbol === 'none' || a.symbol === 'door or window') {
        // a closed shape the first reading also took for furniture: the two readings disagree,
        // and the drawing has something there, so the first reading stands (at the shape's place)
        if (first) answers.found.push({ kind: first.kind, box: toBox(c) });
        return;
      }
      answers.found.push({ kind: SYMBOL_KIND[a.symbol as FurnitureSymbol], box: toBox(c), ...(a.back ? { back: a.back } : {}), ...(first && first.kind !== SYMBOL_KIND[a.symbol as FurnitureSymbol] ? { alt: first.kind } : {}) });
    });
    // the AI's own pieces: those where a shape was found give way to it; the rest take their answer
    parts.furniture.forEach((f, i) => {
      if (covered(f.box)) answers.furniture[i] = { symbol: 'none' };
    });
    extra.forEach(({ i }, k) => {
      const a = fa[shapes.length + k];
      if (a) answers.furniture[i] = { symbol: a.symbol as FurnitureAnswer, back: a.back };
    });
  }
  return answers;
}
