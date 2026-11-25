/**
 * Firestore project sync. The project document holds the brief, building model,
 * findings, tasks, membership and a revision index; full revision snapshots live in
 * a subcollection so the main document stays well under Firestore's 1 MiB limit.
 * Large files (drawings, snapshots, exports) are in Cloud Storage with URLs here.
 * The persistent offline cache means edits made offline sync when the network returns.
 */
import { collection, deleteField, doc, getDoc, getDocs, onSnapshot, setDoc, updateDoc } from 'firebase/firestore';
import { getFirebase } from './config';
import { onUser, type AuthUser } from './auth';
import { useStudio, isPlaceholder, placeholderProject } from '../state/store';
import type { AccessLevel, Member, Project, Revision, UserRole } from '../model/types';
import { accessFor } from './access';
import { newWalkKey } from '../collab/walkRoom';

export type SyncStatus = 'off' | 'connecting' | 'synced' | 'saving' | 'offline' | 'error';

let lastWritten = 0;
/** The project whose Firestore document is known to exist (auto-save waits for it). */
let attachedId = '';
let applyingRemote = false;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Top-level fields this client wrote last time, so a field it drops is removed from the cloud too. */
let writtenKeys: string[] = [];

type CloudDoc = Omit<Project, 'revisions'> & {
  owner: string;
  /** Membership: uid → role. (Project.members is the display list.) */
  roles: Record<string, UserRole>;
  memberUids: string[];
  access?: Record<string, AccessLevel>;
  revisionIndex?: Omit<Revision, 'snapshot'>[];
  updatedBy?: string;
};

function strip(p: Project, uid: string) {
  // owner and access are only ever written by the owner's sharing controls, never by sync.
  const { revisions, model, owner: _owner, access: _access, walkKey: _walkKey, ...rest0 } = p;
  // Concept data from older versions is not part of the product any more.
  const { concept: _c, conceptHistory: _h, ...rest } = rest0 as typeof rest0 & { concept?: unknown; conceptHistory?: unknown };
  const source = model.source && model.source.url.startsWith('data:') && model.source.url.length > 400_000 ? { ...model.source, url: '' } : model.source;
  return JSON.parse(
    JSON.stringify({
      ...rest,
      model: { ...model, source },
      revisionIndex: revisions.map(({ snapshot: _snapshot, ...r }) => r),
      updatedBy: uid,
    }),
  );
}

function mergeTeam(members: Member[], team: Member[] = []) {
  const byId = new Map(members.map((m) => [m.id, m]));
  for (const t of team) byId.set(t.id, t);
  return [...byId.values()];
}

/** Load a shared project (and its revision snapshots) from Firestore. */
export async function openCloudProject(id: string): Promise<Project | null> {
  const fb = getFirebase();
  if (!fb) return null;
  const [snap, revs] = await Promise.all([getDoc(doc(fb.db, 'projects', id)), getDocs(collection(fb.db, 'projects', id, 'revisions')).catch(() => null)]);
  if (!snap.exists()) return null;
  const data = snap.data() as CloudDoc;
  const revisions = (revs?.docs.map((d) => d.data() as Revision) ?? []).sort((a, b) => a.number - b.number);
  const { owner, roles: _m, memberUids: _u, revisionIndex: _r, updatedBy: _b, ...rest } = data;
  return {
    ...(rest as unknown as Omit<Project, 'revisions'>),
    owner,
    access: data.access ?? {},
    members: mergeTeam([], (rest as unknown as Project).members),
    // An empty new project has no revisions yet; only a plan saved without any gets a starting one.
    revisions: revisions.length || !data.model.walls?.length ? revisions : [{ id: 'rev-1', number: data.model.revision, label: 'Current model', author: '', role: 'student', createdAt: data.updatedAt, edits: [], findingIds: [], snapshot: data.model }],
  };
}

export function startProjectSync(onStatus: (s: SyncStatus, detail?: string) => void) {
  const fb = getFirebase();
  if (!fb) {
    onStatus('off');
    return () => undefined;
  }
  onStatus('connecting');
  let unsubDoc: (() => void) | undefined;
  let unsubStore: (() => void) | undefined;
  let user: AuthUser | null = null;
  let currentId = '';

  const online = () => onStatus(navigator.onLine ? 'synced' : 'offline');
  window.addEventListener('online', online);
  window.addEventListener('offline', online);

  const attach = async (pid: string) => {
    unsubDoc?.();
    currentId = pid;
    attachedId = '';
    writtenKeys = [];
    if (isPlaceholder(pid)) return onStatus('synced');
    if (!user) return;
    const ref = doc(fb.db, 'projects', pid);
    try {
      const snap = await getDoc(ref);
      // Switched to another project while we were waiting: never write this one's data elsewhere.
      if (currentId !== pid) return;
      if (!snap.exists()) {
        const p = useStudio.getState().project;
        if (p.id !== pid) return;
        const role = useStudio.getState().me.role;
        const walkKey = newWalkKey();
        await setDoc(ref, { ...strip(p, user.uid), owner: user.uid, roles: { [user.uid]: role }, memberUids: [user.uid], walkKey });
        useStudio.setState((st) => (st.project.id === pid ? { project: { ...st.project, owner: user!.uid, access: {}, walkKey } } : {}));
        for (const r of p.revisions) await setDoc(doc(fb.db, 'projects', pid, 'revisions', r.id), JSON.parse(JSON.stringify(r)));
        lastWritten = p.updatedAt;
      }
      if (currentId !== pid) return;
      if (snap.exists()) lastWritten = 0;
      attachedId = pid;
      // Anything edited while the document was being created gets saved now.
      if (useStudio.getState().project.updatedAt > lastWritten) useStudio.setState((st) => ({ project: { ...st.project } }));
      online();
      if (snap.exists()) {
        const d0 = snap.data() as CloudDoc;
        let walkKey = d0.walkKey;
        // Older projects get a walk key from the first person who can edit the project document.
        const canEdit = d0.owner === user.uid || (d0.access?.[user.uid] ?? 'full') === 'full';
        if (!walkKey && canEdit) {
          // Don't wait for the server: a slow connection must never hold up opening the project.
          const k = (walkKey = newWalkKey());
          void updateDoc(ref, { walkKey: k }).catch(() =>
            useStudio.setState((st) => (st.project.id === pid && st.project.walkKey === k ? { project: { ...st.project, walkKey: undefined } } : {})),
          );
        }
        useStudio.setState((st) => (st.project.id === pid ? { project: { ...st.project, owner: d0.owner, access: d0.access ?? {}, walkKey } } : {}));
      }
      unsubDoc = onSnapshot(
        ref,
        { includeMetadataChanges: true },
        (s) => {
          if (s.metadata.hasPendingWrites) {
            onStatus('saving');
            return;
          }
          const data = s.data() as CloudDoc | undefined;
          if (data && (data.owner !== useStudio.getState().project.owner || data.walkKey !== useStudio.getState().project.walkKey || JSON.stringify(data.access ?? {}) !== JSON.stringify(useStudio.getState().project.access ?? {}))) {
            applyingRemote = true;
            useStudio.setState((st) => (st.project.id === pid ? { project: { ...st.project, owner: data.owner, access: data.access ?? {}, walkKey: data.walkKey } } : {}));
            applyingRemote = false;
          }
          if (!data || data.updatedAt <= lastWritten || (data.updatedBy === user?.uid && data.updatedAt <= lastWritten)) {
            onStatus(s.metadata.fromCache && !navigator.onLine ? 'offline' : 'synced');
            return;
          }
          const cur = useStudio.getState().project;
          if (cur.id !== pid) return;
          applyingRemote = true;
          const { owner, roles: _m, memberUids: _u, revisionIndex, updatedBy: _b, ...rest } = data;
          // Pull any revision snapshots we don't have yet.
          const missing = (revisionIndex ?? []).filter((r) => !cur.revisions.some((x) => x.id === r.id));
          useStudio.setState({
            project: {
              ...cur,
              ...(rest as unknown as Omit<Project, 'revisions'>),
              members: mergeTeam(cur.members, (rest as unknown as Project).members),
              owner,
              access: data.access ?? {},
              walkKey: data.walkKey,
              // Only reuse the local drawing for the same plan; never paste it under a different model.
              model: data.model?.source?.url === '' && cur.model.source && cur.model.id === data.model.id ? { ...data.model, source: cur.model.source } : data.model,
              revisions: cur.revisions,
            },
          });
          applyingRemote = false;
          lastWritten = data.updatedAt;
          if (missing.length)
            Promise.all(missing.map((r) => getDoc(doc(fb.db, 'projects', pid, 'revisions', r.id)))).then((docs) => {
              const extra = docs.filter((d) => d.exists()).map((d) => d.data() as Revision);
              if (!extra.length) return;
              applyingRemote = true;
              useStudio.setState((st) => ({ project: { ...st.project, revisions: [...st.project.revisions, ...extra].sort((a, b) => a.number - b.number) } }));
              applyingRemote = false;
            });
          onStatus('synced');
        },
        (e) => {
          if ((e as { code?: string }).code === 'permission-denied' && useStudio.getState().project.id === pid && useStudio.getState().project.owner) {
            useStudio.getState().toast('You no longer have access to that project. Opening your own work.', 'info');
            openOwnWork(pid);
            return;
          }
          onStatus('error', e.message);
        },
      );
    } catch (e) {
      // Someone else owns a document with this id (e.g. an old shared demo id): keep working on a private copy.
      const cur = useStudio.getState().project;
      if ((e as { code?: string }).code === 'permission-denied' && cur.id === pid && cur.id.startsWith('demo')) {
        useStudio.getState().setProject({ ...cur, id: `demo-${Math.random().toString(36).slice(2, 10)}` });
        useStudio.getState().toast('Saved your own copy of the demo project to Firestore', 'info');
        return;
      }
      onStatus('error', (e as Error).message);
    }
  };

  unsubStore = useStudio.subscribe((st, prev) => {
    if (st.project.id !== prev.project.id) {
      attach(st.project.id);
      return;
    }
    if (applyingRemote || st.project === prev.project || !user) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const p = useStudio.getState().project;
      if (p.id !== currentId || !user) return;
      // Wait until the project's document exists (created with you as owner); attach saves pending edits.
      if (attachedId !== p.id) return;
      // Crit-only and mark-up members never write the project document (rules would refuse it).
      if (accessFor(p, user.uid) !== 'full') return;
      try {
        lastWritten = p.updatedAt;
        onStatus('saving');
        // Replace each field whole. A deep merge would keep anything the model no longer has
        // (a dimension taken away by Undo, a deleted level), so other people would still see it.
        const data = strip(p, user.uid) as Record<string, unknown>;
        const keys = Object.keys(data);
        const gone = writtenKeys.filter((k) => !keys.includes(k));
        for (const k of gone) data[k] = deleteField();
        await setDoc(doc(fb.db, 'projects', p.id), data, { mergeFields: [...keys, ...gone] });
        writtenKeys = keys;
        const newRevs = p.revisions.filter((r) => !prev.project.revisions.some((x) => x.id === r.id));
        for (const r of newRevs) await setDoc(doc(fb.db, 'projects', p.id, 'revisions', r.id), JSON.parse(JSON.stringify(r)));
        online();
      } catch (e) {
        onStatus('error', (e as Error).message);
      }
    }, 900);
  });

  const unsubUser = onUser((u) => {
    user = u;
    if (u) attach(useStudio.getState().project.id);
    else unsubDoc?.();
  });

  return () => {
    unsubUser();
    unsubDoc?.();
    unsubStore?.();
    window.removeEventListener('online', online);
    window.removeEventListener('offline', online);
  };
}

/** Open the most recent project of yours (not `except`), or start a fresh sample if there is none. */
export async function openOwnWork(except?: string) {
  const { useProjects } = await import('./projects');
  const mine = useProjects
    .getState()
    .list.filter((p) => p.id !== except && p.owned !== false)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const p of mine) {
    if (useStudio.getState().openLocalProject(p.id)) return;
    const proj = p.cloud ? await openCloudProject(p.id).catch(() => null) : null;
    if (proj) {
      useStudio.getState().setProject(proj);
      return;
    }
  }
  // Nothing left: show an empty stand-in (never saved) rather than bringing back a sample project.
  useStudio.getState().setProject(placeholderProject());
}
