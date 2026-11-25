/**
 * Plan symbols the AI is taught with a legend (see symbolsheet.ts), and how its answers are used.
 *
 * Models read small drafting symbols poorly from a whole drawing, but well when each one is shown
 * large next to labelled examples. So every opening and every piece of furniture found is cut out,
 * numbered and boxed in red on a sheet under a legend of standard symbols, and the AI says which
 * legend symbol each tile shows. Its answer then:
 *  - never overrules a sliding door the pixels found (two offset panels is the clearest reading);
 *  - decides what the pixel check was unsure about;
 *  - filters what the AI itself added (doors, windows, furniture): anything it cannot match to a
 *    symbol on a closer look is dropped, and a misnamed piece gets its right name.
 */
import type { FurnitureKind } from '../model/types';
import type { DetectedOpening } from './detector';
import type { PlanParts, Side } from '../ai/requests';

export const OPENING_SYMBOLS = ['hinged door', 'double door', 'sliding door', 'window', 'open passage'] as const;
export type OpeningSymbol = (typeof OPENING_SYMBOLS)[number];

export const FURNITURE_SYMBOLS = [
  'bed',
  'sofa',
  'armchair',
  'dining table',
  'coffee table',
  'desk',
  'wardrobe',
  'sideboard',
  'TV unit',
  'kitchen worktop',
  'washing machine',
  'bath',
  'shower',
  'toilet',
  'basin',
  'plant',
  'stair',
] as const;
export type FurnitureSymbol = (typeof FURNITURE_SYMBOLS)[number];

/** Each legend symbol as a kind of furniture in the model. */
export const SYMBOL_KIND: Record<FurnitureSymbol, FurnitureKind> = {
  bed: 'bed',
  sofa: 'sofa',
  armchair: 'chair',
  'dining table': 'table',
  'coffee table': 'table',
  desk: 'desk',
  wardrobe: 'wardrobe',
  sideboard: 'sideboard',
  'TV unit': 'tv',
  'kitchen worktop': 'kitchen',
  'washing machine': 'kitchen',
  bath: 'bath',
  shower: 'bath',
  toilet: 'wc',
  basin: 'basin',
  plant: 'plant',
  stair: 'stair',
};

export type OpeningAnswer = OpeningSymbol | 'none';
export type FurnitureAnswer = FurnitureSymbol | 'door or window' | 'none';

/** The AI's answers, tile by tile, matched back to what each tile showed. */
export interface SymbolAnswers {
  /** Openings the pixel check found, by id. */
  openings: Map<string, OpeningAnswer>;
  /** The AI's own extra doors, windows and furniture, by their index in its reading. */
  doors: (OpeningAnswer | undefined)[];
  windows: (OpeningAnswer | undefined)[];
  furniture: ({ symbol: FurnitureAnswer; back?: Side } | undefined)[];
  /** Furniture found as shapes on the drawing and named against the legend (exact place and size). */
  found: { kind: FurnitureKind; box: [number, number, number, number]; back?: Side; alt?: FurnitureKind }[];
}

const isDoor = (a: OpeningAnswer | undefined) => a === 'hinged door' || a === 'double door' || a === 'sliding door';

/**
 * Apply the legend check to the openings the pixel check found. Confirmed items (you set them)
 * and sliding doors the pixels saw are kept; a clear reading by the pixels (a swing arc, glass
 * lines) gives way only to a sliding door; anything the pixels were unsure about takes the answer.
 * Nothing is deleted. Changed items are marked for you to check.
 */
export function applyOpeningSymbols(openings: DetectedOpening[], answers: Map<string, OpeningAnswer>): { openings: DetectedOpening[]; changed: number } {
  let changed = 0;
  const out = openings.map((o) => {
    const a = answers.get(o.id);
    if (!a || a === 'none' || o.confidence >= 1) return o;
    if (o.kind === 'door' && o.style === 'sliding') return o;
    const now = o.kind === 'door' ? 'door' : o.kind;
    const unsure = o.confidence < 0.7;
    let next: DetectedOpening | null = null;
    if (a === 'sliding door') {
      // A sliding door's two panels are easy to take for a plain gap or a door without a clear
      // swing. Glass lines across a wall are a window unless the pixels were unsure, and a clear
      // swing arc still stands.
      if (o.kind === 'window' ? o.confidence < 0.7 : o.confidence < 0.85) next = { ...o, kind: 'door', style: 'sliding' };
    } else if (isDoor(a)) {
      if (now !== 'door' && unsure) next = { ...o, kind: 'door', style: undefined };
    } else if (a === 'window') {
      if (now !== 'window' && unsure) next = { ...o, kind: 'window', style: undefined };
    } else if (a === 'open passage') {
      if (now !== 'opening' && unsure) next = { ...o, kind: 'opening', style: undefined };
    }
    if (!next) return o;
    changed++;
    return { ...next, confidence: 0.66, ai: true };
  });
  return { openings: out, changed };
}

/**
 * The AI's own reading, filtered by the legend check: extra doors and windows it cannot match to
 * a door or window symbol on a closer look are dropped (or moved to the right list), and each
 * piece of furniture takes the name of the symbol it matches, or is dropped.
 */
export function checkedParts(parts: PlanParts, answers: SymbolAnswers | null): PlanParts {
  if (!answers) return parts;
  const doors: PlanParts['doors'] = [];
  const windows: PlanParts['windows'] = [];
  parts.doors.forEach((b, i) => {
    const a = answers.doors[i];
    if (a === undefined || isDoor(a)) doors.push(b);
    else if (a === 'window') windows.push(b);
  });
  parts.windows.forEach((b, i) => {
    const a = answers.windows[i];
    if (a === undefined || a === 'window') windows.push(b);
    else if (isDoor(a)) doors.push(b);
  });
  const furniture = parts.furniture.flatMap((f, i) => {
    const a = answers.furniture[i];
    if (a === undefined) return [f];
    if (a.symbol === 'none' || a.symbol === 'door or window') return [];
    return [{ ...f, kind: SYMBOL_KIND[a.symbol], ...(a.back ? { back: a.back } : {}) }];
  });
  return { ...parts, doors, windows, furniture: [...answers.found, ...furniture] };
}
