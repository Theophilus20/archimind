import { create } from 'zustand';
import { switchLevel } from '../model/levels';
import type { BuildingModel, CameraPose, EditOp, Finding, Id, Member, Project, Proposal, Revision, Task, Brief, UserRole } from '../model/types';
import { applyEdits, describeEdit, primaryIds, touchedIds, type EditResult } from '../model/edits';
import { reconcile, runRules } from '../review/rules';
import { sampleProject, sampleBrief, emptyModel, DEFAULT_MEMBERS } from '../model/sample';
import { localKey, writeLocalIndex } from '../firebase/projects';
import { track } from '../firebase/config';
import { withDetails } from '../schedule/details';

const LEGACY_KEY = 'archimind.project.v1';
const CURRENT_KEY = 'archimind.currentProject';
const ME_KEY = 'archimind.me.v1';

function readLocal(id: string): Project | null {
  try {
    const raw = localStorage.getItem(localKey(id));
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

/** After your last project is deleted: an empty stand-in that is never saved or synced. */
export const isPlaceholder = (id: string) => id.startsWith('none-');
export function placeholderProject(id = `none-${Date.now().toString(36)}`): Project {
  return { ...makeProject('blank', 'No project open'), id };
}

/** The project open last time when this browser has no copy of it: reopened from the cloud after sign-in. */
export const reopenFromCloud: { id: string | null } = { id: null };

function loadProject(): Project {
  try {
    const hash = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const id = hash.get('local') ?? sessionStorage.getItem(CURRENT_KEY) ?? localStorage.getItem(CURRENT_KEY);
    if (id && isPlaceholder(id)) return placeholderProject(id);
    const p = id ? readLocal(id) : null;
    if (p) return withRules(p);
    if (id && !id.startsWith('demo')) reopenFromCloud.id = id;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) return withRules(JSON.parse(legacy) as Project);
  } catch {
    /* ignore */
  }
  // A first visit starts on an empty project of your own: no sample plan, schedule or revisions.
  // (The "demo-" id lets your own work from the cloud replace it after you sign in.)
  return { ...makeProject('blank', 'My first project'), id: `demo-${Math.random().toString(36).slice(2, 10)}` };
}

export function makeProject(kind: 'sample' | 'blank', name: string, mode: Brief['mode'] = 'studio'): Project {
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (kind === 'sample') return withRules({ ...sampleProject(), id, name });
  // Everything starts empty: no rooms asked for, no marking rubric, no schedule, no revisions and
  // nobody else in the team. The schedule is made from the brief when you ask for it.
  const brief: Brief = { ...sampleBrief(), title: name, mode, client: '', occupants: '', notes: '', requirements: [], rubric: [], goals: [] };
  const model = { ...emptyModel(), id: `m-${id}` };
  const now = Date.now();
  return withRules({ id, name, createdAt: now, updatedAt: now, brief, model, revisions: [], findings: [], tasks: [], milestones: [], members: [] });
}

/** Floors are not offered for now: a project saved with several opens on its ground floor alone. */
function groundFloorOnly(p: Project): Project {
  const m = p.model;
  if (!m.levels?.length) return p;
  const g = switchLevel(m, 0);
  return { ...p, model: { ...g, levels: undefined, activeLevel: undefined } };
}

function withRules(p0: Project): Project {
  const p = groundFloorOnly(p0);
  return { ...p, findings: reconcile(p.findings, runRules(p.model, p.brief), p.model.revision) };
}

function loadMe(p: Project): Member {
  // Per-tab identity (sessionStorage) so two tabs can play student and tutor.
  try {
    const tab = sessionStorage.getItem(ME_KEY);
    if (tab) return JSON.parse(tab) as Member;
  } catch {
    /* ignore */
  }
  let base: Member = p.members[0] ?? DEFAULT_MEMBERS[0];
  try {
    const saved = localStorage.getItem(ME_KEY);
    if (saved) base = JSON.parse(saved) as Member;
  } catch {
    /* ignore */
  }
  const me = { ...base, id: `u-${Math.random().toString(36).slice(2, 10)}` };
  try {
    sessionStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    /* ignore */
  }
  return me;
}

export interface PreviewState {
  proposal: Proposal;
  model: BuildingModel;
  findingId?: Id;
  messageId?: Id;
  issues: string[];
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

interface StudioState {
  project: Project;
  me: Member;
  selection: Id[];
  hover: Id | null;
  preview: PreviewState | null;
  past: { model: BuildingModel; label: string }[];
  future: { model: BuildingModel; label: string }[];
  focus: { ids: Id[]; view?: CameraPose; nonce: number } | null;
  toasts: Toast[];
  lastCamera: CameraPose | null;

  select: (ids: Id[], additive?: boolean) => void;
  setHover: (id: Id | null) => void;
  focusOn: (ids: Id[], view?: CameraPose) => void;
  setLastCamera: (c: CameraPose) => void;
  edit: (edits: EditOp[], label?: string) => EditResult;
  undo: () => void;
  redo: () => void;
  startPreview: (proposal: Proposal, ctx?: { findingId?: Id; messageId?: Id }) => boolean;
  cancelPreview: () => void;
  acceptPreview: () => Revision | null;
  replaceModel: (model: BuildingModel, label: string) => void;
  setBrief: (patch: Partial<Brief>) => void;
  addFindings: (f: Finding[]) => void;
  setFindingStatus: (id: Id, status: Finding['status']) => void;
  addTasks: (t: Task[]) => void;
  updateTask: (id: Id, patch: Partial<Task>) => void;
  removeTask: (id: Id) => void;
  setMe: (m: Partial<Member>) => void;
  setProject: (p: Project) => void;
  /** Multi-storey: make another floor the one you edit and walk on. */
  setLevel: (i: number) => void;
  openLocalProject: (id: string) => boolean;
  createProject: (kind: 'sample' | 'blank', name: string, mode?: Brief['mode']) => Project;
  renameProject: (name: string) => void;
  resetDemo: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
let taskSeq = 100;
export const newTaskId = () => `T${Date.now().toString(36).slice(-4)}${taskSeq++}`;

/** Deliverables affected by a set of edits → revision tasks (deterministic). */
export function revisionTasks(edits: EditOp[], model: BuildingModel, revision: number, owner: string, findingId?: Id): Task[] {
  const now = Date.now();
  const out: Task[] = [];
  const add = (title: string, deliverable: string, effortHours: number, elementIds: Id[]) =>
    out.push({ id: newTaskId(), title, owner, effortHours, deps: [], status: 'todo', origin: 'revision', deliverable, links: { elementIds, findingIds: findingId ? [findingId] : [], revision }, createdAt: now });
  const walls = edits.filter((e) => ['moveWall', 'moveWallEndpoint', 'addWall', 'removeWall', 'setWall'].includes(e.op)).flatMap(touchedIds);
  const openings = edits.filter((e) => ['setOpening', 'relocateOpening', 'addOpening', 'removeOpening'].includes(e.op)).flatMap(touchedIds);
  const furniture = edits.filter((e) => ['moveFurniture', 'setFurniture', 'addFurniture', 'removeFurniture'].includes(e.op)).flatMap(touchedIds);
  const exteriorTouched = [...walls, ...openings].some((id) => model.walls.find((w) => w.id === id)?.exterior || model.openings.find((o) => o.id === id && model.walls.find((w) => w.id === o.wallId)?.exterior));
  if (walls.length) {
    add(`Update floor plan dimensions after moving ${[...new Set(walls)].join(', ')}`, 'Floor plan', 1.5, walls);
    add(`Revise sections that cut ${[...new Set(walls)].join(', ')}`, 'Sections', 2, walls);
    add('Update room area schedule', 'Area schedule', 0.5, walls);
  }
  if (openings.length) {
    add(`Update door & window schedule for ${[...new Set(openings)].join(', ')}`, 'Floor plan', 1, openings);
    if (exteriorTouched) add('Revise affected elevations', 'Elevations', 1.5, openings);
  }
  if (furniture.length) add(`Update furnished plan (${[...new Set(furniture)].join(', ')})`, 'Furnished plan', 0.5, furniture);
  if (walls.length || openings.length) add(`Re-export 3D presentation views (rev ${revision})`, '3D views', 1, [...walls, ...openings]);
  return out;
}

export const useStudio = create<StudioState>((set, get) => {
  const project = loadProject();
  return {
    project,
    me: loadMe(project),
    selection: [],
    hover: null,
    preview: null,
    past: [],
    future: [],
    focus: null,
    toasts: [],
    lastCamera: null,

    select: (ids, additive) => set((s) => ({ selection: additive ? [...new Set([...s.selection, ...ids])] : ids })),
    setHover: (hover) => set({ hover }),
    focusOn: (ids, view) => set((s) => ({ focus: { ids, view, nonce: (s.focus?.nonce ?? 0) + 1 }, selection: ids.length ? ids : s.selection })),
    setLastCamera: (lastCamera) => set({ lastCamera }),

    edit: (edits, label) => {
      const s = get();
      const res = applyEdits(s.project.model, edits);
      if (!res.ok) {
        get().toast(`Change rejected: ${res.errors[0]}`, 'error');
        return res;
      }
      const touched = new Set(edits.flatMap(touchedIds));
      const model = { ...res.model, revision: s.project.model.revision };
      set({
        past: [...s.past, { model: s.project.model, label: label ?? edits.map((e) => describeEdit(e, s.project.model)).join('; ') }].slice(-80),
        future: [],
        project: {
          ...s.project,
          model,
          findings: reconcile(s.project.findings, runRules(model, s.project.brief), model.revision, touched),
          updatedAt: Date.now(),
        },
      });
      return res;
    },

    undo: () => {
      const s = get();
      const last = s.past[s.past.length - 1];
      if (!last) return;
      set({
        past: s.past.slice(0, -1),
        future: [{ model: s.project.model, label: last.label }, ...s.future],
        project: { ...s.project, model: last.model, findings: reconcile(s.project.findings, runRules(last.model, s.project.brief), last.model.revision) },
      });
      get().toast(`Undid: ${last.label}`);
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({
        future: s.future.slice(1),
        past: [...s.past, { model: s.project.model, label: next.label }],
        project: { ...s.project, model: next.model, findings: reconcile(s.project.findings, runRules(next.model, s.project.brief), next.model.revision) },
      });
    },

    startPreview: (proposal, ctx) => {
      const s = get();
      const res = applyEdits(s.project.model, proposal.edits);
      if (!res.ok) {
        get().toast(`Proposal failed validation: ${res.errors[0]}`, 'error');
        return false;
      }
      const ids = [...new Set(proposal.edits.flatMap(primaryIds))];
      set({ preview: { proposal, model: res.model, findingId: ctx?.findingId, messageId: ctx?.messageId, issues: res.issues.filter((i) => i.severity === 'warning').map((i) => i.message) }, selection: ids });
      get().focusOn(ids);
      return true;
    },
    cancelPreview: () => set({ preview: null }),
    acceptPreview: () => {
      const s = get();
      const pv = s.preview;
      if (!pv) return null;
      const number = s.project.model.revision + 1;
      const model: BuildingModel = { ...pv.model, revision: number };
      const touched = new Set(pv.proposal.edits.flatMap(touchedIds));
      const findings = reconcile(s.project.findings, runRules(model, s.project.brief), number, touched);
      const resolvedIds = findings.filter((f) => f.resolvedInRevision === number).map((f) => f.id);
      const tasks = withDetails(revisionTasks(pv.proposal.edits, model, number, s.me.role === 'architect' ? 'Architect' : 'Student', pv.findingId), { brief: s.project.brief, model, findings, milestones: s.project.milestones });
      const rev: Revision = {
        id: `rev-${number}`,
        number,
        label: pv.proposal.label,
        author: s.me.name,
        role: s.me.role,
        createdAt: Date.now(),
        edits: pv.proposal.edits,
        findingIds: [...new Set([...(pv.findingId ? [pv.findingId] : []), ...resolvedIds])],
        snapshot: model,
      };
      // Presentation deliverables wait for revision work.
      const existing = s.project.tasks.map((t) => (t.status !== 'done' && /presentation boards/i.test(t.deliverable ?? '') ? { ...t, deps: [...t.deps, ...tasks.map((x) => x.id)] } : t));
      set({
        preview: null,
        past: [...s.past, { model: s.project.model, label: pv.proposal.label }],
        future: [],
        project: {
          ...s.project,
          model,
          findings,
          revisions: [...s.project.revisions, rev],
          tasks: [...existing, ...tasks],
          updatedAt: Date.now(),
        },
      });
      track('revision_accepted', { edits: pv.proposal.edits.length, tasks: tasks.length, resolved: resolvedIds.length, from: pv.findingId ? 'finding' : pv.messageId ? 'crit' : 'manual' });
      get().toast(`Revision ${number} accepted · ${tasks.length} task${tasks.length === 1 ? '' : 's'} added · ${resolvedIds.length} finding${resolvedIds.length === 1 ? '' : 's'} resolved`, 'success');
      return rev;
    },

    replaceModel: (model, label) => {
      const s = get();
      const number = s.project.model.revision + 1;
      const m = { ...model, revision: number };
      set({
        past: [...s.past, { model: s.project.model, label }],
        future: [],
        selection: [],
        project: {
          ...s.project,
          model: m,
          findings: reconcile([], runRules(m, s.project.brief), number),
          revisions: [...s.project.revisions, { id: `rev-${number}`, number, label, author: s.me.name, role: s.me.role, createdAt: Date.now(), edits: [], findingIds: [], snapshot: m }],
          updatedAt: Date.now(),
        },
      });
    },

    setBrief: (patch) =>
      set((s) => {
        const brief = { ...s.project.brief, ...patch };
        return { project: { ...s.project, brief, findings: reconcile(s.project.findings, runRules(s.project.model, brief), s.project.model.revision), updatedAt: Date.now() } };
      }),
    addFindings: (f) => set((s) => ({ project: { ...s.project, findings: [...f, ...s.project.findings.filter((x) => !(x.source !== 'rule' && x.status === 'outdated' && f.some((n) => n.source === x.source)))] } })),
    setFindingStatus: (id, status) => set((s) => ({ project: { ...s.project, findings: s.project.findings.map((f) => (f.id === id ? { ...f, status } : f)) } })),
    // Tasks ArchiMind creates get written details (what to do, done when); manual ones start empty.
    addTasks: (t) => set((s) => ({ project: { ...s.project, tasks: [...s.project.tasks, ...withDetails(t, s.project)], updatedAt: Date.now() } })),
    updateTask: (id, patch) => set((s) => ({ project: { ...s.project, tasks: s.project.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)), updatedAt: Date.now() } })),
    removeTask: (id) => set((s) => ({ project: { ...s.project, tasks: s.project.tasks.filter((t) => t.id !== id).map((t) => ({ ...t, deps: t.deps.filter((d) => d !== id) })) } })),
    setMe: (m) =>
      set((s) => {
        const me = { ...s.me, ...m };
        try {
          sessionStorage.setItem(ME_KEY, JSON.stringify(me));
          localStorage.setItem(ME_KEY, JSON.stringify(me));
        } catch {
          /* ignore */
        }
        return { me };
      }),
    setProject: (p) => set({ project: withRules(p), past: [], future: [], preview: null, selection: [] }),
    setLevel: (i) =>
      set((s) => {
        const m = switchLevel(s.project.model, i);
        if (m === s.project.model) return {};
        return { project: { ...s.project, model: m, updatedAt: Date.now() }, selection: [], preview: null };
      }),
    openLocalProject: (id) => {
      const p = readLocal(id);
      if (!p) return false;
      get().setProject(p);
      return true;
    },
    createProject: (kind, name, mode) => {
      const p = makeProject(kind, name, mode);
      get().setProject(p);
      track('project_created', { kind, mode: mode ?? 'studio' });
      get().toast(`Created “${name}”`, 'success');
      return p;
    },
    renameProject: (name) => set((s) => ({ project: { ...s.project, name, updatedAt: Date.now() } })),
    resetDemo: () => {
      const p = withRules({ ...sampleProject(), id: get().project.id === 'demo-family-home' ? 'demo-family-home' : get().project.id });
      set({ project: p, past: [], future: [], preview: null, selection: [] });
      get().toast('Demo project restored');
    },
    toast: (text, kind = 'info') => {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
      setTimeout(() => get().dismissToast(id), 5200);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});

// Persist locally (debounced). Firestore sync is layered on top in firebase/sync.ts.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStudio.subscribe((s, prev) => {
  if (s.project === prev.project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Remember which project is open first, so a reload reopens it even if the full save below
    // runs out of browser storage.
    try {
      localStorage.setItem(CURRENT_KEY, s.project.id);
      sessionStorage.setItem(CURRENT_KEY, s.project.id);
    } catch {
      /* private mode */
    }
    // The empty stand-in shown after deleting your last project is never stored.
    if (isPlaceholder(s.project.id)) return;
    try {
      localStorage.setItem(localKey(s.project.id), JSON.stringify(s.project));
    } catch {
      /* quota or private mode — drop the source drawing and retry */
      try {
        const lean = { ...s.project, model: { ...s.project.model, source: s.project.model.source ? { ...s.project.model.source, url: s.project.model.source.url.startsWith('data:') ? '' : s.project.model.source.url } : undefined } };
        localStorage.setItem(localKey(s.project.id), JSON.stringify(lean));
      } catch {
        /* give up silently: Firestore (if configured) still has it */
      }
    }
    writeLocalIndex(s.project, s.me.role);
  }, 400);
});

/** The model currently shown: the preview if one is active, otherwise the committed model. */
export const useViewModel = () => useStudio((s) => s.preview?.model ?? s.project.model);

export const roleLabel = (r: UserRole) => ({ student: 'Student', lecturer: 'Lecturer', architect: 'Architect', client: 'Client' })[r];
/** How someone is described to the person looking: a fellow student is a coursemate. */
export const roleLabelFor = (r: UserRole, viewer?: UserRole) => (r === 'student' && viewer === 'student' ? 'Coursemate' : roleLabel(r));
