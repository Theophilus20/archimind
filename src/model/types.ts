/**
 * ArchiMind building model.
 *
 * The building is stored as architectural objects (walls, openings, rooms, furniture).
 * Drawings, the Three.js scene, measurements and review findings are all generated
 * from this single source of truth. All lengths are millimetres in plan coordinates
 * (x → right, y → down, matching the source drawing).
 */

export type Id = string;
export interface Vec2 {
  x: number;
  y: number;
}

/** Where a value came from. Unknown values are never silently invented. */
export type Provenance = 'detected' | 'assumed' | 'confirmed';
export type ProvMap = Partial<Record<string, Provenance>>;

export type RoomType =
  | 'bedroom'
  | 'bathroom'
  | 'living'
  | 'kitchen'
  | 'dining'
  | 'hall'
  | 'study'
  | 'utility'
  | 'garage'
  | 'other';

export const ROOM_TYPES: RoomType[] = [
  'bedroom',
  'bathroom',
  'living',
  'kitchen',
  'dining',
  'hall',
  'study',
  'utility',
  'garage',
  'other',
];

export interface Wall {
  id: Id;
  a: Vec2;
  b: Vec2;
  thickness: number;
  height: number;
  materialId: Id;
  exterior: boolean;
  prov: ProvMap;
  /** A handrail or balustrade (porch, deck), or a free-standing pillar, rather than a solid wall. */
  kind?: 'railing' | 'column';
  /** Pillars only: how it is built (unset means a square column). */
  columnStyle?: ColumnStyle;
}

export type ColumnStyle = 'square' | 'round' | 'classical' | 'brick' | 'timber' | 'steel';

export type OpeningKind = 'door' | 'window' | 'opening';

export type DoorStyle = 'double' | 'sliding' | 'pocket' | 'folding';

export interface Opening {
  id: Id;
  kind: OpeningKind;
  wallId: Id;
  /** Distance from wall start (a) to the opening centre, mm. */
  offset: number;
  width: number;
  height: number;
  /** Height of the bottom of the opening above floor level. Doors are 0. */
  sill: number;
  /** Which end of the opening the door is hinged on, relative to the wall direction. */
  hinge: 'start' | 'end';
  /** Which side of the wall the leaf swings into: +1 = left normal of a→b, -1 = right. */
  swing: 1 | -1;
  prov: ProvMap;
  /**
   * How a door opens, when it isn't one hinged leaf: a pair of leaves, two glass panels that slide
   * past each other, one leaf sliding into the wall, or leaves that fold back.
   */
  style?: DoorStyle;
}

export interface RoomMeta {
  id: Id;
  name: string;
  type: RoomType;
  floorMaterialId: Id;
  /** A point inside the room, used to keep identity when walls move. */
  seed: Vec2;
  prov: ProvMap;
  /** Porches only: under the main roof, its own lean-to roof, or open. Unset means automatic. */
  porchRoof?: 'main' | 'own' | 'none';
  /** Porches only: what kind (covered porch, veranda, deck, patio...): sets its floor and posts. */
  porchKind?: PorchKind;
}

export type PorchKind = 'porch' | 'veranda' | 'wrap' | 'screened' | 'portico' | 'deck' | 'patio';

export type FurnitureKind =
  | 'bed'
  | 'desk'
  | 'sofa'
  | 'table'
  | 'chair'
  | 'wardrobe'
  /** A low cabinet against a wall: sideboard, console, shelves or a TV unit without a TV. */
  | 'sideboard'
  | 'kitchen'
  | 'bath'
  | 'wc'
  | 'basin'
  | 'tv'
  | 'workstation'
  | 'meeting'
  | 'counter'
  | 'machine'
  | 'conveyor'
  | 'rack'
  | 'stair'
  /** An L-shaped stair: two flights at right angles with a quarter landing. */
  | 'stair-l'
  /** A U-shaped (dog-leg) stair: two flights side by side with a half landing. */
  | 'stair-u'
  | 'spiral'
  | 'lift'
  | 'plant';

export interface Furniture {
  id: Id;
  kind: FurnitureKind;
  /** Centre, mm. */
  x: number;
  y: number;
  /** Footprint along local x (w) and local y (d), mm. */
  w: number;
  d: number;
  /** Degrees clockwise in plan. */
  rotation: number;
  prov: ProvMap;
}

export interface Material {
  id: Id;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  use: 'wall' | 'floor' | 'glass' | 'frame' | 'fabric' | 'wood' | 'roof';
}

export type RoofKind = 'none' | 'flat' | 'shed' | 'gable' | 'hip';

export interface RoofDesign {
  kind: RoofKind;
  /** Degrees from horizontal (ignored for flat roofs). */
  pitch: number;
  /** Eaves overhang beyond the external wall face, mm. */
  overhang: number;
  /** Ridge runs along plan x or y; 'auto' follows the longer side. */
  ridge: 'auto' | 'x' | 'y';
  materialId: string;
  prov: ProvMap;
}

export interface ModelDefaults {
  wallHeight: number;
  doorHeight: number;
  windowSill: number;
  windowHead: number;
  exteriorThickness: number;
  interiorThickness: number;
}

export interface SourceDrawing {
  /** Data URL of the rasterised drawing (kept small) or a storage URL. */
  url: string;
  widthPx: number;
  heightPx: number;
  /** Millimetres per pixel after scale confirmation. */
  mmPerPx: number;
  /** Plan-space position of the image's top-left pixel. */
  origin: Vec2;
  name: string;
}

/** What kind of building this is; each type gets its own structure, plan and facade. */
export type BuildingType = 'bungalow' | 'duplex' | 'apartments' | 'office' | 'industrial' | 'school' | 'tower' | 'pavilion';
export type FacadeKind = 'render' | 'brick' | 'timber' | 'concrete' | 'glass' | 'fins' | 'metal';
export type RoofFeature = 'pitched' | 'flat' | 'garden' | 'sawtooth' | 'crown';

export interface BuildingSpec {
  type: BuildingType;
  /** Number of floors above ground. */
  storeys: number;
  /** Floor to floor height, mm. */
  storeyHeight: number;
  facade: FacadeKind;
  roof: RoofFeature;
  /** Accent colour for fins, canopies and signage. */
  accent: string;
}

/** One floor of the building. Typical floors in towers repeat. */
export interface LevelPlan {
  id: Id;
  name: string;
  /** How many floors use this plan (typical floors). */
  repeat: number;
  /** Floor to floor height, mm. */
  height: number;
  walls: Wall[];
  openings: Opening[];
  rooms: RoomMeta[];
  furniture: Furniture[];
}

export interface BuildingModel {
  id: Id;
  units: 'mm';
  revision: number;
  walls: Wall[];
  openings: Opening[];
  rooms: RoomMeta[];
  furniture: Furniture[];
  roof: RoofDesign;
  defaults: ModelDefaults;
  prov: ProvMap;
  source?: SourceDrawing;
  /** Multi-storey buildings: every level. The active level's plan lives in walls/openings/rooms/furniture. */
  levels?: LevelPlan[];
  activeLevel?: number;
  spec?: BuildingSpec;
  /** Extra parts of a generated design, e.g. the curved canopy that is a bag's handle (plan mm). */
  features?: { canopy?: Vec2[] };
  /** Dimensions people placed themselves (the automatic dimension strings are not stored). */
  dimensions?: Dimension[];
}

/** A dimension placed by hand: measures from a to b; the line sits `offset` mm to the side. */
export interface Dimension {
  id: Id;
  a: Vec2;
  b: Vec2;
  offset: number;
  /** Floor it was drawn on, in a building with several floors (none means the ground floor). */
  level?: number;
}

// ---------------------------------------------------------------------------
// Structured edits. The AI may only propose these; geometry code applies and
// validates them. No generated code is ever executed.
// ---------------------------------------------------------------------------

export type EditOp =
  | { op: 'moveWall'; wallId: Id; distance: number }
  | { op: 'moveWallEndpoint'; wallId: Id; end: 'a' | 'b'; to: Vec2 }
  | { op: 'setWall'; wallId: Id; patch: Partial<Pick<Wall, 'thickness' | 'height' | 'materialId' | 'exterior' | 'kind' | 'columnStyle' | 'a' | 'b'>> }
  | { op: 'addWall'; wall: Wall }
  | { op: 'removeWall'; wallId: Id }
  | { op: 'setOpening'; openingId: Id; patch: Partial<Pick<Opening, 'offset' | 'width' | 'height' | 'sill' | 'hinge' | 'swing' | 'kind' | 'style'>> }
  | { op: 'relocateOpening'; openingId: Id; wallId: Id; offset: number; swing?: 1 | -1 }
  | { op: 'addOpening'; opening: Opening }
  | { op: 'removeOpening'; openingId: Id }
  | { op: 'setRoom'; roomId: Id; patch: Partial<Pick<RoomMeta, 'name' | 'type' | 'floorMaterialId' | 'porchRoof' | 'porchKind'>> }
  | { op: 'moveFurniture'; furnitureId: Id; x: number; y: number; rotation?: number }
  | { op: 'setFurniture'; furnitureId: Id; patch: Partial<Pick<Furniture, 'kind' | 'w' | 'd'>> }
  | { op: 'addFurniture'; furniture: Furniture }
  | { op: 'removeFurniture'; furnitureId: Id }
  | { op: 'addDimension'; dimension: Dimension }
  | { op: 'removeDimension'; dimensionId: Id }
  | { op: 'setDefaults'; patch: Partial<ModelDefaults> }
  | { op: 'setRoof'; patch: Partial<Omit<RoofDesign, 'prov'>> }
  /** Fix the drawing's scale: every plan length times `factor` (heights and furniture sizes stay). */
  | { op: 'rescale'; factor: number }
  | { op: 'confirm'; elementId: Id };

export interface Proposal {
  label: string;
  rationale?: string;
  edits: EditOp[];
}

// ---------------------------------------------------------------------------
// Project, brief, review, schedule, conversation
// ---------------------------------------------------------------------------

export type UserRole = 'student' | 'lecturer' | 'architect' | 'client';

export interface RoomRequirement {
  id: Id;
  type: RoomType;
  label: string;
  count: number;
  minArea: number; // m²
}

export interface RubricCriterion {
  id: Id;
  name: string;
  weight: number;
  description: string;
}

export type DesignGoal = 'privacy' | 'daylight' | 'open-plan' | 'accessibility' | 'storage' | 'flexibility';

export interface Brief {
  title: string;
  mode: 'studio' | 'practice';
  client: string;
  occupants: string;
  siteWidth: number; // m
  siteDepth: number; // m
  startDate: string; // ISO date
  deadline: string; // ISO date
  hoursPerDay: number;
  workDays: number[]; // 0 = Sunday
  goals: DesignGoal[];
  requirements: RoomRequirement[];
  notes: string;
  rubric: RubricCriterion[];
  summary?: string;
}

export type FindingSource = 'rule' | 'ai-on-device' | 'ai-cloud' | 'heuristic' | 'person';
export type FindingSeverity = 'info' | 'advice' | 'warning' | 'critical';
export type FindingCategory =
  | 'brief'
  | 'circulation'
  | 'privacy'
  | 'daylight'
  | 'clearance'
  | 'accessibility'
  | 'geometry'
  | 'concept'
  | 'presentation';

export interface Overlay {
  kind: 'polygon' | 'polyline' | 'point';
  points: Vec2[];
}

export interface Finding {
  id: Id;
  ruleId?: string;
  fingerprint: string;
  source: FindingSource;
  kind: 'calculated' | 'interpretive';
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  finding: string;
  evidence: { elementIds: Id[]; text: string; overlays: Overlay[] };
  suggestion: string;
  proposal?: Proposal;
  revision: number;
  status: 'open' | 'resolved' | 'dismissed' | 'outdated';
  resolvedInRevision?: number;
  createdAt: number;
  rubricCriterionId?: Id;
}

export interface Revision {
  id: Id;
  number: number;
  label: string;
  author: string;
  role: UserRole;
  createdAt: number;
  edits: EditOp[];
  findingIds: Id[];
  snapshot: BuildingModel;
}

export type TaskStatus = 'todo' | 'doing' | 'done';
export interface Task {
  id: Id;
  title: string;
  owner: string;
  effortHours: number;
  deadline?: string;
  deps: Id[];
  status: TaskStatus;
  origin: 'brief' | 'finding' | 'revision' | 'message' | 'manual' | 'ai';
  links: { elementIds: Id[]; findingIds: Id[]; revision?: number; messageId?: Id };
  deliverable?: string;
  /** Free-text details: steps, references, what done looks like. */
  notes?: string;
  createdAt: number;
}

export interface Milestone {
  id: Id;
  name: string;
  date: string;
  kind: 'review' | 'submission' | 'client';
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export type Figure = 'woman' | 'man';

export interface Member {
  id: Id;
  name: string;
  role: UserRole;
  color: string;
  /** The 3D figure that represents this person when they walk through a model. */
  figure?: Figure;
  /** Profile photo: a small data URL (kept in Firestore, no Storage needed) or a Google photo URL. */
  photo?: string;
  /** How their 3D figure looks (skin, hair, clothes, shoes). */
  look?: Appearance;
}

export type HairStyle = 'short' | 'long' | 'bun' | 'curly' | 'none';
export type BottomStyle = 'trousers' | 'skirt';
/** Figure customisation; anything left out is picked consistently from the person's id. */
export interface Appearance {
  /** A realistic person (Microsoft Rocketbox, MIT). The colour fields below are from older versions. */
  person?: string;
  skin?: string;
  hair?: string;
  hairStyle?: HairStyle;
  top?: string;
  bottom?: string;
  bottomStyle?: BottomStyle;
  shoes?: string;
}

export interface Message {
  id: Id;
  threadId: string; // 'studio' or an element / finding id
  authorId: Id;
  authorName: string;
  role: UserRole;
  text: string;
  createdAt: number;
  kind: 'text' | 'system' | 'minutes' | 'translation' | 'intent';
  anchor?: { elementIds: Id[]; view?: CameraPose; revision: number; snapshot?: string; mark?: PlanMark; marks?: PlanMark[] };
  /** The author erased their marks from this message. */
  erased?: boolean;
  /** The message this one replies to (a short quote travels with it). */
  replyTo?: { id: Id; authorName: string; text: string };
  /** People mentioned with @name. */
  mentions?: Id[];
  proposal?: Proposal;
  ai?: { source: AISource; requestType: string };
  resolved?: boolean;
  /** When the author last corrected the text. */
  editedAt?: number;
}

export type AISource = 'on_device' | 'in_cloud' | 'heuristic';

/** What an invited person can open: the crit room only, the crit room plus mark-up, or everything. */
export type AccessLevel = 'crit' | 'markup' | 'full';

/**
 * A mark someone made in the crit room (plan mm). Drawing marks (pin, area, pen, line,
 * arrow, note) explain; suggestion marks (wall, door, window, remove) can be applied
 * to the model by someone who edits the project; part marks highlight a 3D element.
 */
export type PlanMarkKind = 'pin' | 'area' | 'pen' | 'line' | 'arrow' | 'text' | 'wall' | 'door' | 'window' | 'remove' | 'part';
export interface PlanMark {
  kind: PlanMarkKind;
  points: Vec2[];
  color: string;
  /** Note text (text marks). */
  text?: string;
  /** Wall a door/window suggestion sits on, element to remove, or 3D part highlighted. */
  elementId?: Id;
  /** Height above the floor for pins placed on the 3D model, m. */
  z?: number;
  /** Floor the mark belongs to (multi-storey). */
  level?: number;
  /** Local id while drafting. */
  id?: string;
}

export interface Project {
  id: Id;
  name: string;
  createdAt: number;
  updatedAt: number;
  brief: Brief;
  model: BuildingModel;
  revisions: Revision[];
  findings: Finding[];
  tasks: Task[];
  milestones: Milestone[];
  members: Member[];
  /** Firebase uid of the owner (read from Firestore, never written by sync). */
  owner?: string;
  /** Access level per member uid (owner is always full). */
  access?: Record<string, AccessLevel>;
  /** Random key naming this project's live walking channel (read from Firestore, never written by sync). */
  walkKey?: string;
}
