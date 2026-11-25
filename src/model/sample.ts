import type { Brief, BuildingModel, Furniture, Member, Milestone, Opening, Project, RoomMeta, Task, Wall } from './types';
import { refreshSeeds } from './derive';

const today = () => new Date();
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

/** A plan doesn't show the roof: start with an assumed, editable pitched roof that is hidden in the dollhouse view. */
export function defaultRoof(): import('./types').RoofDesign {
  return { kind: 'none', pitch: 35, overhang: 400, ridge: 'auto', materialId: 'roof-tile', prov: { kind: 'assumed' } };
}

export const DEFAULTS = {
  wallHeight: 2700,
  doorHeight: 2100,
  windowSill: 900,
  windowHead: 2100,
  exteriorThickness: 250,
  interiorThickness: 100,
};

const ext = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({
  id,
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  thickness: DEFAULTS.exteriorThickness,
  height: DEFAULTS.wallHeight,
  materialId: 'render',
  exterior: true,
  prov: { geometry: 'confirmed', thickness: 'confirmed', height: 'assumed' },
});
const int = (id: string, ax: number, ay: number, bx: number, by: number): Wall => ({
  ...ext(id, ax, ay, bx, by),
  thickness: DEFAULTS.interiorThickness,
  materialId: 'plaster',
  exterior: false,
});
const door = (id: string, wallId: string, offset: number, width: number, swing: 1 | -1, hinge: 'start' | 'end' = 'start'): Opening => ({
  id,
  kind: 'door',
  wallId,
  offset,
  width,
  height: DEFAULTS.doorHeight,
  sill: 0,
  hinge,
  swing,
  prov: { position: 'confirmed', width: 'confirmed', height: 'assumed' },
});
const win = (id: string, wallId: string, offset: number, width: number, sill = DEFAULTS.windowSill, height = DEFAULTS.windowHead - DEFAULTS.windowSill): Opening => ({
  id,
  kind: 'window',
  wallId,
  offset,
  width,
  height,
  sill,
  hinge: 'start',
  swing: 1,
  prov: { position: 'confirmed', width: 'confirmed', sill: 'assumed', height: 'assumed' },
});
const room = (id: string, name: string, type: RoomMeta['type'], x: number, y: number, floorMaterialId = 'oak'): RoomMeta => ({
  id,
  name,
  type,
  floorMaterialId,
  seed: { x, y },
  prov: { name: 'confirmed', type: 'confirmed' },
});
const furn = (id: string, kind: Furniture['kind'], x: number, y: number, w: number, d: number, rotation = 0): Furniture => ({
  id,
  kind,
  x,
  y,
  w,
  d,
  rotation,
  prov: { position: 'confirmed' },
});

/** The demo family home (matches public/samples/family-home.svg). */
export function sampleModel(): BuildingModel {
  const walls: Wall[] = [
    ext('W1', 0, 0, 12000, 0),
    ext('W2', 12000, 0, 12000, 9000),
    ext('W3', 12000, 9000, 0, 9000),
    ext('W4', 0, 9000, 0, 0),
    int('W5', 4500, 0, 4500, 5200),
    int('W6', 6500, 0, 6500, 4000),
    int('W7', 4500, 4000, 12000, 4000),
    int('W8', 0, 5200, 12000, 5200),
    int('W9', 6000, 5200, 6000, 9000),
  ];
  const openings: Opening[] = [
    door('D1', 'W8', 3600, 850, 1),
    door('D2', 'W7', 1000, 750, 1),
    door('D3', 'W7', 2900, 850, 1),
    door('D4', 'W2', 4600, 1000, -1, 'end'),
    door('D5', 'W8', 5250, 900, -1),
    { ...door('O1', 'W9', 1800, 1800, 1), kind: 'opening', height: 2400 },
    win('N1', 'W4', 6500, 1500),
    win('N2', 'W1', 2250, 1200),
    win('N3', 'W1', 5500, 700, 1500, 600),
    win('N4', 'W1', 9250, 1800),
    win('N5', 'W3', 9000, 2400),
    win('N6', 'W3', 3000, 1800),
    win('N7', 'W2', 7000, 1200),
    win('N8', 'W2', 2000, 1200),
  ];
  const rooms: RoomMeta[] = [
    room('R1', 'Bedroom 1', 'bedroom', 2250, 2600),
    room('R2', 'Bathroom', 'bathroom', 5500, 2000, 'tile'),
    room('R3', 'Bedroom 2', 'bedroom', 9250, 2000),
    room('R4', 'Hall', 'hall', 8250, 4600),
    room('R5', 'Living room', 'living', 3000, 7100),
    room('R6', 'Kitchen & dining', 'kitchen', 9000, 7100, 'terrazzo'),
  ];
  const furniture: Furniture[] = [
    furn('F1', 'bed', 2250, 1125, 1600, 2000),
    furn('F2', 'wardrobe', 4150, 2600, 1800, 600, 90),
    furn('F3', 'bed', 9800, 1125, 1400, 2000),
    furn('F4', 'desk', 7200, 450, 1200, 600, 0),
    furn('F5', 'sofa', 2700, 7900, 2200, 900, 180),
    furn('F6', 'tv', 2700, 5450, 1600, 400),
    furn('F7', 'table', 9000, 7700, 1800, 900),
    furn('F8', 'kitchen', 9500, 5550, 3000, 600),
    furn('F9', 'bath', 5500, 500, 1700, 750),
    furn('F10', 'wc', 4875, 2400, 400, 650, -90),
    furn('F11', 'basin', 6250, 2600, 500, 400, 90),
  ];
  return refreshSeeds({
    id: 'family-home',
    units: 'mm',
    revision: 1,
    walls,
    openings,
    rooms,
    furniture,
    roof: defaultRoof(),
    defaults: { ...DEFAULTS },
    prov: { 'defaults.wallHeight': 'assumed', 'defaults.windowSill': 'assumed' },
  });
}

export function emptyModel(): BuildingModel {
  return {
    id: 'model',
    units: 'mm',
    revision: 1,
    walls: [],
    openings: [],
    rooms: [],
    furniture: [],
    roof: defaultRoof(),
    defaults: { ...DEFAULTS },
    prov: {},
  };
}

export function sampleBrief(): Brief {
  const start = isoDate(today());
  return {
    title: 'Family home, Studio 2 project',
    mode: 'studio',
    client: 'Studio brief: a family of four',
    occupants: 'Two adults who work from home part-time and two children (8 and 12).',
    siteWidth: 14,
    siteDepth: 11,
    startDate: start,
    deadline: addDays(start, 21),
    hoursPerDay: 4,
    workDays: [1, 2, 3, 4, 5, 6],
    goals: ['privacy', 'daylight', 'open-plan'],
    requirements: [
      { id: 'q1', type: 'bedroom', label: 'Bedrooms', count: 2, minArea: 12 },
      { id: 'q2', type: 'bathroom', label: 'Family bathroom', count: 1, minArea: 5 },
      { id: 'q3', type: 'living', label: 'Living room', count: 1, minArea: 20 },
      { id: 'q4', type: 'kitchen', label: 'Kitchen & dining', count: 1, minArea: 15 },
      { id: 'q5', type: 'study', label: 'Quiet home study', count: 1, minArea: 7 },
      { id: 'q6', type: 'hall', label: 'Entrance hall', count: 1, minArea: 4 },
    ],
    notes:
      'Bedrooms must feel private from the social spaces. Living areas should receive south light. A quiet study is needed for home working. Single storey on a flat suburban plot.',
    rubric: [
      { id: 'c1', name: 'Response to brief', weight: 25, description: 'All required spaces provided at suitable sizes; client needs addressed.' },
      { id: 'c2', name: 'Circulation & spatial relationships', weight: 20, description: 'Clear, efficient movement; sensible public/private zoning.' },
      { id: 'c3', name: 'Concept development', weight: 20, description: 'A clear idea that drives the plan and is developed through iterations.' },
      { id: 'c4', name: 'Design rationale', weight: 15, description: 'Decisions are explained with evidence.' },
      { id: 'c5', name: 'Drawing completeness', weight: 10, description: 'Plans, sections and 3D views are complete, dimensioned and consistent.' },
      { id: 'c6', name: 'Presentation', weight: 10, description: 'Boards communicate the scheme clearly.' },
    ],
  };
}

export function briefTasks(brief: Brief): { tasks: Task[]; milestones: Milestone[] } {
  const now = Date.now();
  const crit = addDays(brief.startDate, Math.max(3, Math.round((Date.parse(brief.deadline) - Date.parse(brief.startDate)) / 86400000 / 2)));
  const t = (id: string, title: string, effortHours: number, deps: string[], deliverable: string, deadline?: string): Task => ({
    id,
    title,
    owner: brief.mode === 'studio' ? 'Student' : 'Architect',
    effortHours,
    deps,
    status: 'todo',
    origin: 'brief',
    links: { elementIds: [], findingIds: [] },
    deliverable,
    deadline,
    createdAt: now,
  });
  const tasks: Task[] = [
    t('T1', 'Concept development and precedent study', 8, [], 'Concept sheet'),
    t('T2', 'Develop ground floor plan', 10, ['T1'], 'Floor plan', crit),
    t('T3', 'Prepare for interim crit', 3, ['T2'], 'Crit pin-up', crit),
    t('T4', 'Draw sections A–A and B–B', 6, ['T2'], 'Sections'),
    t('T5', '3D model and presentation views', 6, ['T2'], '3D views'),
    t('T6', 'Material board', 4, ['T5'], 'Material board'),
    t('T7', 'Write design rationale', 3, ['T3'], 'Rationale text'),
    t('T8', 'Compose presentation boards', 8, ['T4', 'T5', 'T6', 'T7'], 'Presentation boards', brief.deadline),
    t('T9', 'Export and submit', 1, ['T8'], 'Submission', brief.deadline),
  ];
  return {
    tasks,
    milestones: [
      { id: 'M1', name: 'Interim crit', date: crit, kind: 'review' },
      { id: 'M2', name: 'Final submission', date: brief.deadline, kind: 'submission' },
    ],
  };
}

export const DEFAULT_MEMBERS: Member[] = [
  { id: 'u-student', name: 'Ada Mensah', role: 'student', color: '#1a73e8' },
  { id: 'u-tutor', name: 'Prof. Ruiz', role: 'lecturer', color: '#e37400' },
  { id: 'u-client', name: 'The Okoro family', role: 'client', color: '#188038' },
];

export function sampleProject(): Project {
  const brief = sampleBrief();
  const { tasks, milestones } = briefTasks(brief);
  const model = sampleModel();
  const now = Date.now();
  return {
    id: 'demo-family-home',
    name: 'Family Home',
    createdAt: now,
    updatedAt: now,
    brief,
    model,
    revisions: [
      {
        id: 'rev-1',
        number: 1,
        label: 'Plan confirmed from drawing',
        author: DEFAULT_MEMBERS[0].name,
        role: 'student',
        createdAt: now,
        edits: [],
        findingIds: [],
        snapshot: model,
      },
    ],
    findings: [],
    tasks,
    milestones,
    members: DEFAULT_MEMBERS,
  };
}
