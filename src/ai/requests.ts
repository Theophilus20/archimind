/**
 * ArchiMind's bounded AI request types. Each has a JSON schema (used for both
 * Gemini Nano's responseConstraint and the cloud model's responseJsonSchema),
 * a validator, and a deterministic fallback so the studio keeps working
 * without a model.
 */
import { runAI, type JsonSchema } from './hybrid';
import { PLAN_READING_GUIDE } from './planGuide';
import { FURNITURE_SYMBOLS, OPENING_SYMBOLS } from '../detect/symbols';
import { allElementIds, describeElement, modelSummary } from './context';
import { derive } from '../model/derive';
import type { Brief, BuildingModel, EditOp, Finding, FurnitureKind, Id, Message, Proposal, RoomType, RubricCriterion, UserRole } from '../model/types';
import { ROOM_TYPES } from '../model/types';
import { applyEdits } from '../model/edits';
import { parseCommand, placeFurniture, addWindowToRoom } from './commands';
import { growRoomBy } from '../review/rules';
import { reviewCriterion, type CriterionReview, type ReviewContext } from '../review/rubric';

const SYSTEM = `You are ArchiMind, an assistant inside an architectural design studio app.
You work from a structured building model; element ids look like W3 (wall), D1 (door), N2 (window), O1 (opening), R4 (room), F7 (furniture).
Only reference ids that appear in the context. Measurements are calculated by the app, so never invent numbers.
Be concise, specific and kind. Your advice is provisional design feedback, not structural approval or code compliance.
Write in plain, friendly English. Never use em dashes; use commas or full stops instead.
Always answer with JSON that matches the requested schema.`;

const str = (x: unknown): x is string => typeof x === 'string';
const arr = (x: unknown): x is unknown[] => Array.isArray(x);
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clampText = (s: string, n = 600) => (s.length > n ? s.slice(0, n) + '…' : s);

// ---------------------------------------------------------------------------
// 1. Brief summary (on-device)
// ---------------------------------------------------------------------------

export interface BriefSummary {
  summary: string;
  priorities: string[];
  risks: string[];
}

export async function summarizeBrief(brief: Brief) {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Two or three sentences.' },
      priorities: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      risks: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    },
    required: ['summary', 'priorities', 'risks'],
  };
  const prompt = `Summarise this design brief for the project team.
Title: ${brief.title}
Client: ${brief.client}
Occupants: ${brief.occupants}
Site: ${brief.siteWidth} × ${brief.siteDepth} m
Deadline: ${brief.deadline}
Goals: ${brief.goals.join(', ')}
Required spaces: ${brief.requirements.map((q) => `${q.count}× ${q.label} (≥${q.minArea} m²)`).join('; ')}
Notes: ${brief.notes}`;
  return runAI<BriefSummary>({
    type: 'brief.summarize',
    system: SYSTEM,
    prompt,
    schema,
    validate: (x) => (obj(x) && str(x.summary) && arr(x.priorities) && arr(x.risks) ? { summary: clampText(x.summary), priorities: x.priorities.filter(str).slice(0, 5), risks: x.risks.filter(str).slice(0, 4) } : null),
    heuristic: () => ({
      summary: `${brief.title}: ${brief.occupants} The scheme needs ${brief.requirements.reduce((s, q) => s + q.count, 0)} spaces on a ${brief.siteWidth} × ${brief.siteDepth} m site, due ${brief.deadline}.`,
      priorities: brief.goals.map((g) => `Design for ${g.replace('-', ' ')}`),
      risks: brief.requirements.filter((q) => q.minArea >= 15).map((q) => `${q.label} needs ≥ ${q.minArea} m²`),
    }),
  });
}

// ---------------------------------------------------------------------------
// 2. Explain a selected space or element (on-device)
// ---------------------------------------------------------------------------

export interface Explanation {
  headline: string;
  explanation: string;
  considerations: string[];
}

export async function explainElement(model: BuildingModel, brief: Brief, findings: Finding[], id: Id) {
  const d = derive(model);
  const room = d.roomById.get(id);
  const related = findings.filter((f) => f.status === 'open' && f.evidence.elementIds.includes(id));
  const facts: string[] = [];
  if (room) {
    const req = brief.requirements.find((q) => q.type === room.type);
    facts.push(`${room.name} is a ${room.type} of ${room.area.toFixed(1)} m² net (${room.grossArea.toFixed(1)} m² gross)${req ? `; brief target ≥ ${req.minArea} m²` : ''}.`);
    const neighbours = [...(d.connections.get(room.id) ?? [])].map((n) => d.roomById.get(n)?.name).filter(Boolean);
    facts.push(`Connected by doors/openings to: ${neighbours.join(', ') || 'nothing'}.`);
    const wins = model.openings.filter((o) => o.kind === 'window' && [d.links.get(o.id)?.plus, d.links.get(o.id)?.minus].includes(room.id));
    facts.push(`Windows: ${wins.map((w) => `${w.id} ${w.width} mm`).join(', ') || 'none'}.`);
  } else {
    facts.push(`${describeElement(model, id)}.`);
    const o = model.openings.find((x) => x.id === id);
    if (o) facts.push(`Width ${o.width} mm, height ${o.height} mm, sill ${o.sill} mm.`);
    const w = model.walls.find((x) => x.id === id);
    if (w) facts.push(`Thickness ${w.thickness} mm, height ${w.height} mm (${w.prov.height ?? 'detected'}).`);
  }
  if (related.length) facts.push(`Open findings: ${related.map((f) => f.title).join('; ')}.`);
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      explanation: { type: 'string', description: 'Up to 3 sentences in plain language.' },
      considerations: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
    required: ['headline', 'explanation', 'considerations'],
  };
  return runAI<Explanation>({
    type: 'element.explain',
    system: SYSTEM,
    prompt: `Explain this element to a ${brief.mode === 'studio' ? 'design student' : 'project architect'} in the context of the brief.\nFacts (calculated by the app):\n${facts.join('\n')}\nBrief goals: ${brief.goals.join(', ')}.`,
    schema,
    validate: (x) => (obj(x) && str(x.headline) && str(x.explanation) && arr(x.considerations) ? { headline: clampText(x.headline, 120), explanation: clampText(x.explanation), considerations: x.considerations.filter(str).slice(0, 3) } : null),
    heuristic: () => ({
      headline: room ? `${room.name}, ${room.area.toFixed(1)} m²` : describeElement(model, id),
      explanation: facts.join(' '),
      considerations: related.length ? related.map((f) => f.suggestion) : ['No open findings reference this element.'],
    }),
  });
}

// ---------------------------------------------------------------------------
// 3. Crit minutes: thread → decisions + actions (on-device, conversation stays local)
// ---------------------------------------------------------------------------

export interface Minutes {
  summary: string;
  decisions: string[];
  actions: { title: string; owner: UserRole; effortHours: number; elementIds: Id[] }[];
  openQuestions: string[];
}

export async function critMinutes(model: BuildingModel, messages: Message[]) {
  const ids = allElementIds(model);
  const transcript = messages
    .filter((m) => m.kind === 'text' || m.kind === 'intent')
    .slice(-30)
    .map((m) => `${m.authorName} (${m.role})${m.anchor?.elementIds.length ? ` [on ${m.anchor.elementIds.join(',')}]` : ''}: ${m.text}`)
    .join('\n');
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      decisions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      actions: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            owner: { type: 'string', enum: ['student', 'lecturer', 'architect', 'client'] },
            effortHours: { type: 'number' },
            elementIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'owner', 'effortHours', 'elementIds'],
        },
      },
      openQuestions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    },
    required: ['summary', 'decisions', 'actions', 'openQuestions'],
  };
  return runAI<Minutes>({
    type: 'thread.minutes',
    system: SYSTEM,
    prompt: `Write minutes for this design crit conversation. Extract decisions, action items (owner role, estimated hours 0.5–16, element ids mentioned) and open questions.\n\n${transcript}`,
    schema,
    validate: (x) => {
      if (!obj(x) || !str(x.summary) || !arr(x.decisions) || !arr(x.actions) || !arr(x.openQuestions)) return null;
      const actions = x.actions.filter(obj).map((a) => ({
        title: str(a.title) ? clampText(a.title, 140) : '',
        owner: (['student', 'lecturer', 'architect', 'client'].includes(a.owner as string) ? a.owner : 'student') as UserRole,
        effortHours: typeof a.effortHours === 'number' ? Math.min(16, Math.max(0.5, a.effortHours)) : 2,
        elementIds: arr(a.elementIds) ? a.elementIds.filter((i): i is string => str(i) && ids.has(i)) : [],
      }));
      return { summary: clampText(x.summary), decisions: x.decisions.filter(str).slice(0, 6), actions: actions.filter((a) => a.title), openQuestions: x.openQuestions.filter(str).slice(0, 4) };
    },
    heuristic: () => heuristicMinutes(messages, ids),
  });
}

function heuristicMinutes(messages: Message[], ids: Set<Id>): Minutes {
  const decisions: string[] = [];
  const actions: Minutes['actions'] = [];
  const questions: string[] = [];
  for (const m of messages.filter((x) => x.kind === 'text')) {
    for (const s of m.text.split(/(?<=[.!?])\s+/)) {
      const t = s.trim();
      if (!t) continue;
      const mentioned = (t.match(/\b[WDNORF]\d+\b/g) ?? []).filter((i) => ids.has(i));
      if (/\b(agree|agreed|decided|let'?s go|go with|accepted|approve)\b/i.test(t)) decisions.push(`${t} (${m.authorName})`);
      else if (/\b(need to|should|will|please|can you|could you|todo|must)\b/i.test(t))
        actions.push({ title: t.replace(/^(please|can you|could you)\s+/i, '').replace(/\?$/, ''), owner: m.role === 'lecturer' || m.role === 'client' ? 'student' : m.role, effortHours: 2, elementIds: [...new Set([...(m.anchor?.elementIds ?? []), ...mentioned])] });
      else if (t.endsWith('?')) questions.push(`${t} (${m.authorName})`);
    }
  }
  return {
    summary: `${messages.length} messages from ${[...new Set(messages.map((m) => m.authorName))].join(', ')}. ${decisions.length} decision${decisions.length === 1 ? '' : 's'}, ${actions.length} action${actions.length === 1 ? '' : 's'}.`,
    decisions: decisions.slice(0, 6),
    actions: actions.slice(0, 6),
    openQuestions: questions.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// 4. Plain-language rewrite for the audience (on-device)
// ---------------------------------------------------------------------------

export interface Translation {
  text: string;
  glossary: { term: string; meaning: string }[];
}

const GLOSSARY: Record<string, string> = {
  circulation: 'how people move through the home',
  fenestration: 'the arrangement of windows',
  glazing: 'windows and glass',
  section: 'a drawing cut vertically through the building',
  elevation: 'a flat drawing of one side of the building',
  threshold: 'the doorway between two spaces',
  massing: 'the overall shape and bulk of the building',
  parti: 'the core design idea',
  clerestory: 'high windows near the ceiling',
  datum: 'a reference line or height',
  'door swing': 'the space a door needs to open',
  'net area': 'usable floor area inside the walls',
  'gross area': 'floor area measured to the middle of the walls',
  zoning: 'grouping quiet and busy rooms',
  adjacency: 'which rooms sit next to each other',
};

export async function translateMessage(model: BuildingModel, text: string, audience: UserRole) {
  const ids = [...new Set(text.match(/\b[WDNORF]\d+\b/g) ?? [])].filter((i) => allElementIds(model).has(i));
  const idNotes = ids.map((i) => `${i} = ${describeElement(model, i)}`).join('; ');
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      glossary: { type: 'array', maxItems: 5, items: { type: 'object', properties: { term: { type: 'string' }, meaning: { type: 'string' } }, required: ['term', 'meaning'] } },
    },
    required: ['text', 'glossary'],
  };
  const audienceText = audience === 'client' ? 'a homeowner with no architectural training' : audience === 'student' ? 'a first-year architecture student' : 'an architect (keep technical precision)';
  return runAI<Translation>({
    type: 'message.translate',
    system: SYSTEM,
    prompt: `Rewrite this studio message for ${audienceText}. Keep every fact, replace element ids with plain names, keep it under 90 words.\nElement ids: ${idNotes || 'none'}\nMessage: ${text}`,
    schema,
    validate: (x) => (obj(x) && str(x.text) && arr(x.glossary) ? { text: clampText(x.text), glossary: x.glossary.filter(obj).filter((g) => str(g.term) && str(g.meaning)).map((g) => ({ term: g.term as string, meaning: g.meaning as string })).slice(0, 5) } : null),
    heuristic: () => {
      let out = text;
      const glossary: Translation['glossary'] = [];
      for (const i of ids) out = out.replace(new RegExp(`\\b${i}\\b`, 'g'), `the ${describeElement(model, i)}`);
      for (const [term, meaning] of Object.entries(GLOSSARY)) {
        if (new RegExp(`\\b${term}\\b`, 'i').test(out)) glossary.push({ term, meaning });
      }
      if (audience === 'client') out = out.replace(/\b(\d{3,5})\s?mm\b/g, (_, n) => `${(Number(n) / 1000).toFixed(2).replace(/\.?0+$/, '')} m`);
      return { text: out, glossary: glossary.slice(0, 5) };
    },
  });
}

// ---------------------------------------------------------------------------
// 5. Client / tutor feedback → measurable design intent (on-device)
// ---------------------------------------------------------------------------

export interface DesignIntent {
  statement: string;
  elementIds: Id[];
  measure: string;
  category: 'area' | 'daylight' | 'privacy' | 'circulation' | 'storage' | 'character';
}

export async function feedbackToIntent(model: BuildingModel, brief: Brief, findings: Finding[], text: string) {
  const ids = allElementIds(model);
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      intents: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            statement: { type: 'string', description: 'What the person wants, as a design intent.' },
            elementIds: { type: 'array', items: { type: 'string' } },
            measure: { type: 'string', description: 'How the app could check it, e.g. "Kitchen net area ≥ 18 m²".' },
            category: { type: 'string', enum: ['area', 'daylight', 'privacy', 'circulation', 'storage', 'character'] },
          },
          required: ['statement', 'elementIds', 'measure', 'category'],
        },
      },
    },
    required: ['intents'],
  };
  return runAI<{ intents: DesignIntent[] }>({
    type: 'message.intent',
    system: SYSTEM,
    prompt: `Turn this feedback into design intents tied to model elements, each with a measurable check.\nModel:\n${modelSummary(model, brief, findings, 1800)}\n\nFeedback: "${text}"`,
    schema,
    validate: (x) => {
      if (!obj(x) || !arr(x.intents)) return null;
      const intents = x.intents.filter(obj).map((i) => ({
        statement: str(i.statement) ? clampText(i.statement, 200) : '',
        elementIds: arr(i.elementIds) ? i.elementIds.filter((e): e is string => str(e) && ids.has(e)) : [],
        measure: str(i.measure) ? clampText(i.measure, 160) : '',
        category: (['area', 'daylight', 'privacy', 'circulation', 'storage', 'character'].includes(i.category as string) ? i.category : 'character') as DesignIntent['category'],
      }));
      return { intents: intents.filter((i) => i.statement) };
    },
    heuristic: () => ({ intents: heuristicIntents(model, text) }),
  });
}

function heuristicIntents(model: BuildingModel, text: string): DesignIntent[] {
  const d = derive(model);
  const t = text.toLowerCase();
  const rooms = d.rooms.filter((r) => t.includes(r.name.toLowerCase()) || t.includes(r.type) || (r.type === 'bathroom' && /\bbath/.test(t)) || (r.type === 'living' && /lounge|sitting/.test(t)));
  const out: DesignIntent[] = [];
  const pick = rooms.length ? rooms : d.rooms.slice(0, 1);
  const rules: [RegExp, DesignIntent['category'], (n: string, a: number) => [string, string]][] = [
    [/cramped|small|tight|bigger|more space|squeez/, 'area', (n, a) => [`Make the ${n.toLowerCase()} feel more generous`, `${n} net area ≥ ${(a * 1.15).toFixed(1)} m² (now ${a.toFixed(1)} m²)`]],
    [/dark|gloomy|light|bright|sun/, 'daylight', (n) => [`Bring more daylight into the ${n.toLowerCase()}`, `${n} glazing ≥ 10% of floor area`]],
    [/private|privacy|overlook|see into|noise|noisy|quiet/, 'privacy', (n) => [`Separate the ${n.toLowerCase()} from busy spaces`, `${n} not entered directly from living/kitchen`]],
    [/far|walk|route|through|corridor|flow/, 'circulation', (n) => [`Shorten and clarify the route to the ${n.toLowerCase()}`, `${n} reachable from the hall`]],
    [/storage|cupboard|wardrobe|clutter/, 'storage', (n) => [`Add storage to the ${n.toLowerCase()}`, `≥ 1.2 m of storage in ${n}`]],
  ];
  for (const [re, category, make] of rules) {
    if (!re.test(t)) continue;
    for (const r of pick) {
      const [statement, measure] = make(r.name, r.area);
      out.push({ statement, elementIds: [r.id], measure, category });
    }
  }
  if (!out.length) out.push({ statement: text.trim().slice(0, 200), elementIds: pick.map((r) => r.id), measure: 'Discuss at next crit', category: 'character' });
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// 6. Read room labels from the uploaded drawing (cloud preferred, image input)
// ---------------------------------------------------------------------------

export async function readRoomLabels(image: { mimeType: 'image/png' | 'image/jpeg'; data: string }, rooms: { index: number; cx: number; cy: number; areaM2: number }[]) {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      rooms: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, name: { type: 'string' }, type: { type: 'string', enum: ROOM_TYPES } },
          required: ['index', 'name', 'type'],
        },
      },
    },
    required: ['rooms'],
  };
  return runAI<{ rooms: { index: number; name: string; type: RoomType }[] }>({
    type: 'plan.labels',
    system: `${SYSTEM}\n\n${PLAN_READING_GUIDE}`,
    prompt: `This is an architectural floor plan. For each numbered room centre (pixel coordinates in the image), read the room label written on the drawing and classify the room type. If unreadable, guess from size and position and say "Room".\n${rooms.map((r) => `#${r.index} at (${Math.round(r.cx)}, ${Math.round(r.cy)}) px, ${r.areaM2.toFixed(1)} m²`).join('\n')}`,
    image,
    schema,
    validate: (x) =>
      obj(x) && arr(x.rooms)
        ? { rooms: x.rooms.filter(obj).filter((r) => typeof r.index === 'number' && str(r.name)).map((r) => ({ index: r.index as number, name: clampText(r.name as string, 40), type: (ROOM_TYPES.includes(r.type as RoomType) ? r.type : 'other') as RoomType })) }
        : null,
    heuristic: () => ({ rooms: guessRoomTypes(rooms) }),
  });
}

// ---------------------------------------------------------------------------
// 6b. Read the rest of an uploaded plan: doors, windows, outdoor spaces, furniture (cloud, image)
// ---------------------------------------------------------------------------

export const DRAWN_FURNITURE: FurnitureKind[] = ['bed', 'sofa', 'table', 'chair', 'desk', 'wardrobe', 'sideboard', 'kitchen', 'bath', 'wc', 'basin', 'tv', 'plant', 'stair'];
export const OUTDOOR_KINDS = ['porch', 'veranda', 'deck', 'patio', 'terrace'] as const;
type Box4 = [number, number, number, number];

/** Everything is a box [ymin, xmin, ymax, xmax], each 0 to 1000 across the image. */
export interface PlanParts {
  /** The overall dimensions written on the drawing, exactly as written (for example 41'0"). */
  overall: { width?: string; depth?: string };
  /** Verdicts on the openings the drawing check found, by id. */
  verdicts: { id: string; kind: 'door' | 'double' | 'sliding' | 'window' | 'opening' | 'none' }[];
  doors: Box4[];
  windows: Box4[];
  outdoor: { kind: (typeof OUTDOOR_KINDS)[number]; box: Box4 }[];
  /** `back`: the side of the drawing a piece's back faces (bed head, sofa back, cistern), when known. */
  furniture: { kind: FurnitureKind; box: Box4; back?: Side; alt?: FurnitureKind }[];
}

/** An opening the pixel check found, described for the AI to review (pixels of the image sent). */
export interface FoundOpening {
  id: string;
  x: number;
  y: number;
  width: number;
  wall: 'horizontal' | 'vertical';
  kind: string;
}

const VERDICTS = ['door', 'double', 'sliding', 'window', 'opening', 'none'] as const;

/**
 * Read a floor plan drawing. The pixel check places walls and openings precisely; the AI reads
 * what models do well (text: the overall dimensions for the scale) and reviews the check's list
 * of openings against the drawing, with a guide to drafting symbols. It also finds what the check
 * missed, outdoor spaces and furniture.
 */
export async function readPlanParts(image: { mimeType: 'image/png' | 'image/jpeg'; data: string; width: number; height: number }, found: FoundOpening[] = []) {
  const box = { type: 'array', items: { type: 'integer' } };
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      overall: { type: 'object', properties: { width: { type: 'string' }, depth: { type: 'string' } } },
      verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: [...VERDICTS] } }, required: ['id', 'kind'] } },
      doors: { type: 'array', items: { type: 'object', properties: { box }, required: ['box'] } },
      windows: { type: 'array', items: { type: 'object', properties: { box }, required: ['box'] } },
      outdoor: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: [...OUTDOOR_KINDS] }, box }, required: ['kind', 'box'] } },
      furniture: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: DRAWN_FURNITURE }, box }, required: ['kind', 'box'] } },
    },
    required: ['overall', 'verdicts', 'doors', 'windows', 'outdoor', 'furniture'],
  };
  const okBox = (b: unknown): b is number[] => arr(b) && b.length === 4 && b.every((n) => typeof n === 'number' && n >= 0 && n <= 1000) && (b[2] as number) > (b[0] as number) && (b[3] as number) > (b[1] as number);
  const boxes = (xs: unknown) => (arr(xs) ? xs.filter(obj).map((x) => x.box).filter(okBox).map((b) => b.map(Math.round) as Box4) : []);
  const ids = new Set(found.map((f) => f.id));
  const list = found.length
    ? found.map((f) => `${f.id}: centre (${Math.round(f.x)}, ${Math.round(f.y)}) px, about ${Math.round(f.width)} px wide, in a ${f.wall} wall, read as ${f.kind}`).join('\n')
    : '(none)';
  return runAI<PlanParts>({
    type: 'plan.read',
    system: `${SYSTEM}\n\n${PLAN_READING_GUIDE}`,
    prompt:
      `This floor plan image is ${image.width} x ${image.height} px. A pixel check already found these openings in the walls:\n${list}\n\n` +
      'Reply with:\n' +
      '1. overall: the overall width (left to right) and depth (top to bottom) of the building exactly as written on its longest dimension strings, for example 41\'0" or 12500. Leave out any you cannot read.\n' +
      '2. verdicts: for each opening above, what it really is: door (hinged, one leaf), double (two leaves), sliding, window, opening (an open passage with no door), or none (not an opening at all).\n' +
      '3. doors and windows the list above missed, each with its bounding box as [ymin, xmin, ymax, xmax] in whole numbers from 0 to 1000 across the whole image.\n' +
      '4. outdoor: outdoor spaces attached to the building (porch, veranda, deck, patio, terrace; a balcony counts as a deck) with boxes.\n' +
      '5. furniture: beds, sofas and armchairs, tables, chairs (each separately), desks, wardrobes, sideboards and shelves, kitchen worktops (one box per straight run of worktop covering its whole length; the sink, hob and fridge are part of it), washing machines, baths or showers, toilets, basins, TV units, plants and stairs, with boxes. Use chair for an armchair, sideboard for a sideboard, console, shelves or TV unit without a TV, and kitchen for a washing machine.\n' +
      'At most 40 doors, 40 windows, 6 outdoor spaces and 80 furniture items.',
    image: { mimeType: image.mimeType, data: image.data },
    schema,
    validate: (x) => {
      if (!obj(x)) return null;
      const ov = obj(x.overall) ? x.overall : {};
      const overall = { ...(str(ov.width) && ov.width.trim() ? { width: ov.width.trim().slice(0, 20) } : {}), ...(str(ov.depth) && ov.depth.trim() ? { depth: ov.depth.trim().slice(0, 20) } : {}) };
      const verdicts = arr(x.verdicts)
        ? x.verdicts.filter(obj).filter((v) => str(v.id) && ids.has(v.id) && (VERDICTS as readonly string[]).includes(v.kind as string)).map((v) => ({ id: v.id as string, kind: v.kind as PlanParts['verdicts'][number]['kind'] }))
        : [];
      const outdoor = arr(x.outdoor)
        ? x.outdoor.filter(obj).filter((o) => (OUTDOOR_KINDS as readonly string[]).includes(o.kind as string) && okBox(o.box)).map((o) => ({ kind: o.kind as PlanParts['outdoor'][number]['kind'], box: (o.box as number[]).map(Math.round) as Box4 }))
        : [];
      const furniture = arr(x.furniture)
        ? x.furniture.filter(obj).filter((f) => DRAWN_FURNITURE.includes(f.kind as FurnitureKind) && okBox(f.box)).map((f) => ({ kind: f.kind as FurnitureKind, box: (f.box as number[]).map(Math.round) as Box4 }))
        : [];
      return { overall, verdicts, doors: boxes(x.doors).slice(0, 40), windows: boxes(x.windows).slice(0, 40), outdoor: outdoor.slice(0, 6), furniture: furniture.slice(0, 80) };
    },
    heuristic: () => ({ overall: {}, verdicts: [], doors: [], windows: [], outdoor: [], furniture: [] }),
  });
}

/**
 * Read a symbol sheet (see detect/symbolsheet.ts): a legend of standard plan symbols above
 * numbered tiles cut from the drawing. For each tile, which legend symbol is in its red box.
 */
export type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

export async function readSymbolSheet(sheet: 'openings' | 'furniture', image: { mimeType: 'image/jpeg' | 'image/png'; data: string }, count: number, cloudModel?: string) {
  const names: string[] = sheet === 'openings' ? [...OPENING_SYMBOLS, 'none'] : [...FURNITURE_SYMBOLS, 'door or window', 'none'];
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      tiles: {
        type: 'array',
        items: { type: 'object', properties: { n: { type: 'integer' }, symbol: { type: 'string', enum: names }, ...(sheet === 'furniture' ? { back: { type: 'string', enum: SIDES } } : {}) }, required: ['n', 'symbol'] },
      },
    },
    required: ['tiles'],
  };
  const what =
    sheet === 'openings'
      ? 'Each tile shows one opening in a wall. Tell a hinged door (a leaf line and a quarter-circle swing arc), a double door (two leaves, two arcs), a sliding door (two thin panels side by side within the wall, offset from each other and overlapping in the middle, no arc), a window (thin parallel lines running the full width of the gap, all in line), and an open passage (a gap with nothing drawn in it). Answer none if the red box sits on solid wall.'
      : 'Each tile shows one piece of furniture or one fitting. For a bed, sofa, armchair, desk, wardrobe, sideboard, TV unit, kitchen worktop, bath, toilet or basin, also say back: the side of the tile its back faces (the bed head with the pillows, the sofa back, the cistern, the side against the wall). Match its shape to the legend: a long plain box is a wardrobe in a bedroom but a sideboard in a living or dining room, a box with four circles or a sink in it is a kitchen worktop, a square with a circle is a washing machine, a square with a cross is a shower. Answer door or window if the red box holds one, and none if it holds no furniture (empty floor, a wall, text or a dimension).';
  return runAI<{ tiles: { n: number; symbol: string; back?: Side }[] }>({
    type: 'plan.symbols',
    cloudModel,
    system: `${SYSTEM}\n\n${PLAN_READING_GUIDE}`,
    prompt:
      `The top of this image is a LEGEND of standard floor plan symbols, each named under it. Below it are ${count} NUMBERED TILES cut from a real floor plan, each with a red box round the part to identify. ` +
      `${what} Every tile was cut round something found on the drawing, so nearly all of them show one of the legend symbols; answer none only when the red box is plainly empty. ` +
      `Compare each tile with the legend symbols, look only inside its red box, and give one answer per tile, numbers 1 to ${count}.`,
    image,
    schema,
    validate: (x) => {
      if (!obj(x) || !arr(x.tiles)) return null;
      const tiles = x.tiles
        .filter(obj)
        .filter((t) => typeof t.n === 'number' && t.n >= 1 && t.n <= count && names.includes(t.symbol as string))
        .map((t) => ({ n: Math.round(t.n as number), symbol: t.symbol as string, ...(SIDES.includes(t.back as Side) ? { back: t.back as Side } : {}) }));
      return { tiles };
    },
    heuristic: () => ({ tiles: [] }),
  });
}

export function guessRoomTypes(rooms: { index: number; areaM2: number }[]) {
  const sorted = [...rooms].sort((a, b) => b.areaM2 - a.areaM2);
  const names: Record<number, { name: string; type: RoomType }> = {};
  let bedrooms = 0;
  sorted.forEach((r, i) => {
    if (i === 0) names[r.index] = { name: 'Living room', type: 'living' };
    else if (r.areaM2 < 3.5) names[r.index] = { name: 'Store', type: 'utility' };
    else if (r.areaM2 < 8) names[r.index] = { name: 'Bathroom', type: 'bathroom' };
    else if (i === 1) names[r.index] = { name: 'Kitchen & dining', type: 'kitchen' };
    else names[r.index] = { name: `Bedroom ${++bedrooms}`, type: 'bedroom' };
  });
  return rooms.map((r) => ({ index: r.index, ...names[r.index] }));
}

// ---------------------------------------------------------------------------
// 7. Interpretive design review against the rubric (cloud preferred)
// ---------------------------------------------------------------------------

export interface InterpretiveReview {
  overall: string;
  criteria: { criterionId: Id; score: number; strengths: string; improvement: string; evidence: string; elementIds: Id[] }[];
  findings: { title: string; finding: string; suggestion: string; elementIds: Id[]; category: 'concept' | 'circulation' | 'privacy' | 'presentation' | 'daylight' }[];
}

export async function interpretiveReview(model: BuildingModel, brief: Brief, findings: Finding[], ctx: ReviewContext = {}) {
  const ids = allElementIds(model);
  const rubric: RubricCriterion[] = brief.rubric.length ? brief.rubric : [{ id: 'c0', name: 'Overall design quality', weight: 100, description: 'Response to the brief.' }];
  // Measured facts per criterion: given to the AI to cite, and used to fill any gaps in its answer.
  const measured = new Map(rubric.map((c) => [c.id, reviewCriterion(model, brief, findings, c, ctx)]));
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      overall: { type: 'string' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            criterionId: { type: 'string', enum: rubric.map((c) => c.id) },
            score: { type: 'integer', minimum: 0, maximum: 100 },
            strengths: { type: 'string' },
            improvement: { type: 'string' },
            evidence: { type: 'string' },
            elementIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['criterionId', 'score', 'strengths', 'improvement', 'evidence', 'elementIds'],
        },
      },
      findings: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            finding: { type: 'string' },
            suggestion: { type: 'string' },
            elementIds: { type: 'array', items: { type: 'string' } },
            category: { type: 'string', enum: ['concept', 'circulation', 'privacy', 'presentation', 'daylight'] },
          },
          required: ['title', 'finding', 'suggestion', 'elementIds', 'category'],
        },
      },
    },
    required: ['overall', 'criteria', 'findings'],
  };
  const prompt = `Give provisional, evidence-based feedback on this ${brief.mode === 'studio' ? 'student project' : 'design'}.
Separate opinion from measurement: measured issues are already listed as calculated findings, so refer to them, don't restate numbers you weren't given.
The lecturer keeps the final grade; scores are provisional.

For each criterion: strengths and improvement must be specific to this design (name rooms, sizes, routes), and evidence must quote the measurements below. Never write generic advice.

Rubric, with the measured evidence for each criterion:
${rubric.map((c) => `${c.id} ${c.name} (${c.weight}%): ${c.description}\n   Measured: ${measured.get(c.id)!.evidence}`).join('\n')}

Model and calculated findings:
${modelSummary(model, brief, findings, 3200)}

Brief notes: ${brief.notes}`;
  return runAI<InterpretiveReview>({
    type: 'review.interpretive',
    system: SYSTEM,
    prompt,
    schema,
    validate: (x) => {
      if (!obj(x) || !str(x.overall) || !arr(x.criteria) || !arr(x.findings)) return null;
      const criteria = x.criteria
        .filter(obj)
        .filter((c) => rubric.some((r) => r.id === c.criterionId))
        .map((c) => {
          const m = measured.get(c.criterionId as string)!;
          const els = arr(c.elementIds) ? c.elementIds.filter((e): e is string => str(e) && ids.has(e)) : [];
          return {
            criterionId: c.criterionId as string,
            score: Math.max(0, Math.min(100, Math.round(Number(c.score) || 0))),
            strengths: str(c.strengths) && c.strengths.trim() ? clampText(c.strengths, 300) : m.strengths,
            improvement: str(c.improvement) && c.improvement.trim() ? clampText(c.improvement, 300) : m.improvement,
            evidence: str(c.evidence) && c.evidence.trim() ? clampText(c.evidence, 360) : m.evidence,
            elementIds: els.length ? els : m.elementIds,
          };
        });
      const fs = x.findings
        .filter(obj)
        .filter((f) => str(f.title) && str(f.finding))
        .map((f) => ({
          title: clampText(f.title as string, 120),
          finding: clampText(f.finding as string, 400),
          suggestion: str(f.suggestion) ? clampText(f.suggestion, 300) : '',
          elementIds: arr(f.elementIds) ? f.elementIds.filter((e): e is string => str(e) && ids.has(e)) : [],
          category: (['concept', 'circulation', 'privacy', 'presentation', 'daylight'].includes(f.category as string) ? f.category : 'concept') as InterpretiveReview['findings'][number]['category'],
        }));
      return criteria.length ? { overall: clampText(x.overall, 600), criteria, findings: fs } : null;
    },
    heuristic: () => heuristicReview(findings, rubric, measured),
  });
}

function heuristicReview(findings: Finding[], rubric: RubricCriterion[], measured: Map<Id, CriterionReview>): InterpretiveReview {
  const open = findings.filter((f) => f.status === 'open');
  const criteria = rubric.map((c) => measured.get(c.id)!);
  const best = [...criteria].sort((x, y) => y.score - x.score)[0];
  const worst = [...criteria].sort((x, y) => x.score - y.score)[0];
  const name = (id: Id) => rubric.find((r) => r.id === id)?.name ?? id;
  return {
    overall: `Provisional review from ArchiMind's measurements: strongest on ${name(best.criterionId).toLowerCase()} (${best.score}), weakest on ${name(worst.criterionId).toLowerCase()} (${worst.score}), with ${open.length} open calculated finding${open.length === 1 ? '' : 's'}. Your lecturer keeps the final grade.`,
    criteria,
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// 8. Free-form instruction → structured edit proposal (on-device)
// ---------------------------------------------------------------------------

export async function proposeEdit(model: BuildingModel, brief: Brief, findings: Finding[], instruction: string, fallback?: Proposal) {
  const ids = allElementIds(model);
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      label: { type: 'string' },
      rationale: { type: 'string' },
      edits: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['addFurniture', 'addWindow', 'growRoom', 'moveWall', 'relocateOpening', 'setOpening', 'moveFurniture', 'removeFurniture', 'setRoom'] },
            target: { type: 'string', description: 'Element id the edit applies to. For addFurniture, addWindow and growRoom this is the room id (R…).' },
            kind: { type: 'string', enum: ['bed', 'desk', 'chair', 'sofa', 'table', 'wardrobe', 'sideboard', 'kitchen', 'bath', 'wc', 'basin', 'tv'], description: 'Furniture kind for addFurniture.' },
            area: { type: 'number', description: 'Square metres to add for growRoom.' },
            wallId: { type: 'string' },
            distance: { type: 'number', description: 'mm, positive = towards wall left normal' },
            offset: { type: 'number' },
            width: { type: 'number' },
            x: { type: 'number' },
            y: { type: 'number' },
            name: { type: 'string' },
          },
          required: ['op', 'target'],
        },
      },
    },
    required: ['label', 'rationale', 'edits'],
  };
  const res = await runAI<Proposal | null>({
    type: 'edit.propose',
    system: SYSTEM,
    prompt: `Propose up to 4 structured edits that carry out the instruction. Use only ids from the model. The app will validate geometry and may reject the proposal.\nModel:\n${modelSummary(model, brief, findings, 1800)}\n\nInstruction: ${instruction}`,
    schema,
    validate: (x) => {
      if (!obj(x) || !str(x.label) || !arr(x.edits)) return null;
      const edits: EditOp[] = [];
      for (const e of x.edits.filter(obj)) {
        const target = e.target as string;
        if (!ids.has(target)) return null;
        const roomOk = model.rooms.some((r) => r.id === target);
        if (e.op === 'addFurniture' && roomOk && str(e.kind)) {
          const op = placeFurniture(model, target, e.kind as Parameters<typeof placeFurniture>[2]);
          if (!op) return null;
          edits.push(op);
        } else if (e.op === 'addWindow' && roomOk) {
          const op = addWindowToRoom(model, target, typeof e.width === 'number' ? Math.round(e.width) : 1200);
          if (!op) return null;
          edits.push(op);
        } else if (e.op === 'growRoom' && roomOk) {
          const p = growRoomBy(model, brief, target, typeof e.area === 'number' ? e.area : 2);
          if (!p) return null;
          edits.push(...p.edits);
        } else if (e.op === 'removeFurniture' && target.startsWith('F')) edits.push({ op: 'removeFurniture', furnitureId: target });
        else if (e.op === 'moveWall' && typeof e.distance === 'number') edits.push({ op: 'moveWall', wallId: target, distance: Math.round(e.distance) });
        else if (e.op === 'relocateOpening' && str(e.wallId) && ids.has(e.wallId) && typeof e.offset === 'number') edits.push({ op: 'relocateOpening', openingId: target, wallId: e.wallId, offset: Math.round(e.offset) });
        else if (e.op === 'setOpening' && (typeof e.width === 'number' || typeof e.offset === 'number'))
          edits.push({ op: 'setOpening', openingId: target, patch: { ...(typeof e.width === 'number' ? { width: Math.round(e.width) } : {}), ...(typeof e.offset === 'number' ? { offset: Math.round(e.offset) } : {}) } });
        else if (e.op === 'moveFurniture' && typeof e.x === 'number' && typeof e.y === 'number') edits.push({ op: 'moveFurniture', furnitureId: target, x: Math.round(e.x), y: Math.round(e.y) });
        else if (e.op === 'setRoom' && str(e.name)) edits.push({ op: 'setRoom', roomId: target, patch: { name: e.name } });
        else return null;
      }
      if (!edits.length) return null;
      const check = applyEdits(model, edits);
      return check.ok ? { label: clampText(x.label, 140), rationale: str(x.rationale) ? clampText(x.rationale, 300) : '', edits } : null;
    },
    heuristic: () => fallback ?? parseCommand(model, brief, instruction),
  });
  return res;
}

// ---------------------------------------------------------------------------
// 9. Design rationale, streamed token by token (on-device preferred)
// ---------------------------------------------------------------------------

export async function draftRationale(model: BuildingModel, brief: Brief, findings: Finding[], revisions: { number: number; label: string }[], onText: (t: string) => void) {
  const { runAIStream } = await import('./hybrid');
  const d = derive(model);
  const resolved = findings.filter((f) => f.status === 'resolved');
  const prompt = `Write a design rationale (3 short paragraphs, first person, plain English, no headings) for this ${brief.mode === 'studio' ? 'student project' : 'scheme'}.
Explain how the plan answers the brief, which decisions changed through review and why, and what remains open. Use only the facts below.

${modelSummary(model, brief, findings, 1800)}
Revisions: ${revisions.map((r) => `rev ${r.number}: ${r.label}`).join('; ')}
Resolved findings: ${resolved.map((f) => f.title).join('; ') || 'none yet'}`;
  return runAIStream(
    {
      type: 'rationale.draft',
      system: SYSTEM.replace('Always answer with JSON that matches the requested schema.', 'Answer in plain prose.'),
      prompt,
      heuristic: () => {
        const social = d.rooms.filter((r) => ['living', 'kitchen', 'dining'].includes(r.type));
        const priv = d.rooms.filter((r) => ['bedroom', 'bathroom', 'study'].includes(r.type));
        const missing = brief.requirements.filter((q) => !d.rooms.some((r) => r.type === q.type));
        return [
          `The plan organises ${d.rooms.length} spaces (${d.rooms.reduce((s, r) => s + r.area, 0).toFixed(0)} m² net) for ${brief.occupants.toLowerCase() || 'the client'} The social rooms, ${social.map((r) => r.name).join(', ') || 'none yet'}, sit together, while ${priv.map((r) => r.name).join(', ') || 'the private rooms'} are grouped away from them to answer the brief's goals of ${brief.goals.join(', ') || 'clarity'}.`,
          revisions.length > 1
            ? `The scheme developed through ${revisions.length - 1} revision${revisions.length > 2 ? 's' : ''}: ${revisions.slice(1).map((r) => r.label.toLowerCase()).join('; ')}. ${resolved.length ? `These changes resolved ${resolved.length} review finding${resolved.length > 1 ? 's' : ''}, including “${resolved[0].title.toLowerCase()}”.` : ''}`
            : 'The plan is at its first confirmed revision; review findings are guiding the next iteration.',
          missing.length ? `Still open: ${missing.map((q) => q.label.toLowerCase()).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not yet provided, and will shape the next round of decisions.` : 'Every space required by the brief is now provided; the next step is refining materials, light and presentation.',
        ].join('\n\n');
      },
    },
    onText,
  );
}
