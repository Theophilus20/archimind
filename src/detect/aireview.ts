/**
 * Combining the pixel check with the AI's reading of the drawing. Research on AI models reading
 * architectural drawings finds they read text well (labels, dimension figures) but often misread
 * door swings and confuse windows with openings, so:
 *  - the scale comes from the dimension text the AI reads;
 *  - the AI's verdict on an opening is taken where the pixel check was unsure, and for the cases
 *    the pixels find hardest (sliding doors, open passages); anything changed is marked to check;
 *  - the AI never deletes what the pixels found.
 */
import type { DetectedOpening, DetectedWall } from './detector';
import { parseLength, type Unit } from './units';
import type { FoundOpening, PlanParts } from '../ai/requests';

/** A dimension as written (41'0", 12500, 12.5 m) into a unit and a value for the scale step. */
export function scaleFromText(text: string | undefined): { unit: Unit; value: string; mm: number } | null {
  if (!text) return null;
  const t = text.trim().replace(/[″]/g, '"').replace(/[′]/g, "'");
  const unit: Unit = /['"]|ft|feet|in\b/i.test(t) ? 'ft' : /\d\s*m$/i.test(t) && !/mm$/i.test(t) ? 'm' : 'mm';
  const mm = parseLength(t, unit);
  // A building is somewhere between a garden shed and a city block.
  if (!(mm >= 2000 && mm <= 300000)) return null;
  return { unit, value: t, mm };
}

/** The openings the pixel check found, in the pixels of the image sent to the AI. */
export function describeForAI(walls: DetectedWall[], openings: DetectedOpening[], s: number): FoundOpening[] {
  return openings.flatMap((o) => {
    const w = walls.find((x) => x.id === o.wallId);
    if (!w) return [];
    const horiz = Math.abs(w.a.y - w.b.y) < 1;
    const lo = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
    const along = lo + o.offset;
    return [{ id: o.id, x: (horiz ? along : w.a.x) * s, y: (horiz ? w.a.y : along) * s, width: o.width * s, wall: horiz ? 'horizontal' : 'vertical', kind: o.kind === 'door' && o.style === 'sliding' ? 'sliding door' : o.kind }];
  });
}

/**
 * Apply the AI's verdicts. Confirmed items (you set them) are never touched, nor is a sliding door
 * the pixels found (its two offset panels are the clearest reading there is; a whole-plan reading
 * often takes them for an open gap). A verdict is taken when the pixel check was unsure
 * (confidence under 0.7), or when it says sliding door for a hinged door the pixels read without
 * a clear swing. Changed items are marked so the check step shows them.
 */
export function applyVerdicts(openings: DetectedOpening[], verdicts: PlanParts['verdicts']): { openings: DetectedOpening[]; changed: number } {
  let changed = 0;
  const byId = new Map(verdicts.map((v) => [v.id, v.kind]));
  const out = openings.map((o) => {
    const v = byId.get(o.id);
    if (!v || v === 'none' || o.confidence >= 1) return o;
    if (o.kind === 'door' && o.style === 'sliding') return o;
    const now = o.kind === 'door' && o.style === 'sliding' ? 'sliding' : o.kind;
    const want = v === 'double' ? 'door' : v;
    if (want === now) return o;
    const unsure = o.confidence < 0.7;
    const hard = want === 'sliding' && o.kind === 'door' && o.confidence < 0.85;
    const fromOpening = o.kind === 'opening' && (want === 'door' || want === 'sliding');
    if (!unsure && !hard && !fromOpening) return o;
    changed++;
    return { ...o, kind: want === 'sliding' ? ('door' as const) : want, style: want === 'sliding' ? ('sliding' as const) : undefined, confidence: 0.62, ai: true };
  });
  return { openings: out, changed };
}
