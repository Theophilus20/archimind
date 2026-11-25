/**
 * Roof suggestions through Firebase AI Logic: a JSON schema, validation against the
 * allowed roof types and materials, and an offline fallback.
 */
import { runAI, type JsonSchema } from './hybrid';
import { derive } from '../model/derive';
import { roofMaterials } from '../model/materials';
import type { Brief, BuildingModel, RoofDesign } from '../model/types';

const SYSTEM = `You are ArchiMind, a design assistant inside an architectural studio app.
Only reference element ids that appear in the context. Never invent measurements.
Write in plain, friendly English. Never use em dashes; use commas or full stops instead.
Always answer with JSON that matches the requested schema.`;

const str = (x: unknown): x is string => typeof x === 'string';
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s*—\s*/g, ', ');

export interface RoofSuggestion {
  kind: RoofDesign['kind'];
  pitch: number;
  overhang: number;
  materialId: string;
  reason: string;
}

export async function suggestRoof(model: BuildingModel, brief: Brief) {
  const kinds = ['flat', 'shed', 'gable', 'hip'];
  const mats = roofMaterials.map((m) => m.id);
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: kinds },
      pitch: { type: 'number', description: 'Degrees, 3 to 55' },
      overhang: { type: 'number', description: 'mm, 0 to 900' },
      materialId: { type: 'string', enum: mats },
      reason: { type: 'string', description: 'One or two sentences.' },
    },
    required: ['kind', 'pitch', 'overhang', 'materialId', 'reason'],
  };
  const d = derive(model);
  return runAI<RoofSuggestion>({
    type: 'roof.suggest',
    system: SYSTEM,
    prompt: `Suggest a roof for this single-storey house. Consider the brief goals, daylight, rain run-off and character.
Footprint about ${d.rooms.reduce((s, r) => s + r.grossArea, 0).toFixed(0)} m2 with ${d.rooms.length} rooms. Goals: ${brief.goals.join(', ') || 'none given'}. Notes: ${brief.notes.slice(0, 400)}
Materials available: ${roofMaterials.map((m) => `${m.id} (${m.name})`).join(', ')}.`,
    schema,
    validate: (x) =>
      obj(x) && kinds.includes(x.kind as string) && typeof x.pitch === 'number' && typeof x.overhang === 'number' && mats.includes(x.materialId as string) && str(x.reason)
        ? {
            kind: x.kind as RoofDesign['kind'],
            pitch: Math.min(55, Math.max(3, Math.round(x.pitch))),
            overhang: Math.min(900, Math.max(0, Math.round(x.overhang / 50) * 50)),
            materialId: x.materialId as string,
            reason: clip(x.reason, 240),
          }
        : null,
    heuristic: () =>
      brief.goals.includes('daylight')
        ? { kind: 'shed', pitch: 15, overhang: 500, materialId: 'roof-metal', reason: 'A mono-pitch roof rising towards the light opens room for tall windows while shedding rain to the back.' }
        : { kind: 'gable', pitch: 35, overhang: 400, materialId: 'roof-tile', reason: 'A simple 35 degree gable in clay tiles suits a family home, drains well and gives a familiar, welcoming profile.' },
  });
}

