/**
 * Projects, membership and invites.
 *
 * Firestore layout
 *   users/{uid}                         profile (name, role, colour, last project)
 *   projects/{pid}                      brief, model, findings, tasks, roles{uid: role}, memberUids[], members[]
 *   projects/{pid}/revisions/{rid}      full model snapshots
 *   projects/{pid}/messages/{mid}       crit-room messages (snapshots live in Cloud Storage)
 *   projects/{pid}/presence/{uid}       who is in the room, camera when presenting
 *   projects/{pid}/aiEvents/{id}        hybrid-inference telemetry (source, latency, request type)
 *   invites/{code}                      role-scoped invite links (7-day expiry)
 *
 * In demo mode the same API works on localStorage so judges can try everything offline.
 */
import { arrayRemove, arrayUnion, collection, deleteDoc, deleteField, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore';
import { create } from 'zustand';
import { getFirebase, track } from './config';
import type { AccessLevel, Member, Project, UserRole } from '../model/types';
import { newWalkKey } from '../collab/walkRoom';

export interface ProjectSummary {
  id: string;
  name: string;
  role: UserRole;
  updatedAt: number;
  cloud: boolean;
  /** False for projects someone else shared with you. */
  owned?: boolean;
  /** Who shared it (owner's display name). */
  sharedBy?: string;
}

interface ProjectsState {
  list: ProjectSummary[];
  set: (l: ProjectSummary[]) => void;
}
export const useProjects = create<ProjectsState>((set) => ({ list: [], set: (list) => set({ list }) }));

const INDEX_KEY = 'archimind.projects.index';
export const localKey = (id: string) => `archimind.project.${id}`;

export function readLocalIndex(): ProjectSummary[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function writeLocalIndex(p: Project, role: UserRole) {
  const list = readLocalIndex().filter((x) => x.id !== p.id);
  list.unshift({ id: p.id, name: p.name, role, updatedAt: p.updatedAt, cloud: false });
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    /* ignore */
  }
  if (!getFirebase()) useProjects.getState().set(list);
}
export function removeLocal(id: string) {
  try {
    localStorage.removeItem(localKey(id));
    localStorage.setItem(INDEX_KEY, JSON.stringify(readLocalIndex().filter((x) => x.id !== id)));
  } catch {
    /* ignore */
  }
}

/** Live list of projects the signed-in user belongs to. */
export function watchMyProjects(uid: string) {
  const fb = getFirebase();
  if (!fb) {
    useProjects.getState().set(readLocalIndex());
    return () => undefined;
  }
  const q = query(collection(fb.db, 'projects'), where('memberUids', 'array-contains', uid));
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs
        .map((d) => {
          const data = d.data() as { name?: string; roles?: Record<string, UserRole>; updatedAt?: number; owner?: string; members?: Member[] };
          const owned = !data.owner || data.owner === uid;
          return { id: d.id, name: data.name ?? 'Untitled', role: data.roles?.[uid] ?? 'student', updatedAt: data.updatedAt ?? 0, cloud: true, owned, sharedBy: owned ? undefined : data.members?.find((m) => m.id === data.owner)?.name };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      useProjects.getState().set(list);
    },
    () => useProjects.getState().set(readLocalIndex()),
  );
}

export async function saveUserProfile(uid: string, me: Member, lastProjectId: string) {
  const fb = getFirebase();
  if (!fb) return;
  await setDoc(doc(fb.db, 'users', uid), { name: me.name, role: me.role, color: me.color, photo: me.photo ?? null, figure: me.figure ?? null, look: me.look ? JSON.parse(JSON.stringify(me.look)) : null, lastProjectId, updatedAt: serverTimestamp() }, { merge: true }).catch(() => undefined);
}

export async function loadUserProfile(uid: string): Promise<{ name?: string; role?: UserRole; color?: string; photo?: string; figure?: Member['figure']; look?: Member['look']; lastProjectId?: string } | null> {
  const fb = getFirebase();
  if (!fb) return null;
  const s = await getDoc(doc(fb.db, 'users', uid)).catch(() => null);
  return s?.exists() ? (s.data() as { name?: string; role?: UserRole; color?: string; photo?: string; figure?: Member['figure']; look?: Member['look']; lastProjectId?: string }) : null;
}

function code(n = 10) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return [...r].map((x) => a[x % a.length]).join('');
}

/** Create a role-scoped invite link (Firestore) or a same-browser demo link. */
export async function createInvite(projectId: string, role: UserRole, uid: string | null, access: AccessLevel = 'full'): Promise<string> {
  const base = `${location.origin}${location.pathname}`;
  const fb = getFirebase();
  if (!fb || !uid) return `${base}#/join?local=${encodeURIComponent(projectId)}&role=${role}`;
  const c = code();
  await setDoc(doc(fb.db, 'invites', c), { projectId, role, access, createdBy: uid, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400000 });
  track('invite_created', { role, access });
  return `${base}#/join?code=${c}`;
}

/** Accept an invite: adds the user to the project with the invite's role. */
export async function acceptInvite(c: string, uid: string, member: Member): Promise<{ projectId: string; role: UserRole; access: AccessLevel }> {
  const fb = getFirebase();
  if (!fb) throw new Error('Invites need a Firebase project.');
  const inv = await getDoc(doc(fb.db, 'invites', c));
  if (!inv.exists()) throw new Error('This invite link is not valid.');
  const data = inv.data() as { projectId: string; role: UserRole; expiresAt: number; access?: AccessLevel };
  const access: AccessLevel = data.access ?? 'full';
  if (data.expiresAt < Date.now()) throw new Error('This invite link has expired.');
  await updateDoc(doc(fb.db, 'projects', data.projectId), {
    [`roles.${uid}`]: data.role,
    [`access.${uid}`]: access,
    memberUids: arrayUnion(uid),
    // Firestore rejects undefined fields, so send a clean member object.
    members: arrayUnion(JSON.parse(JSON.stringify({ ...member, id: uid, role: data.role }))),
    joinCode: c,
  });
  track('invite_accepted', { role: data.role, access });
  return { ...data, access };
}

export interface InviteInfo {
  code: string;
  role: UserRole;
  access: AccessLevel;
  createdAt: number;
  expiresAt: number;
}

/** Invite links I created for this project that have not expired. */
export async function listInvites(projectId: string, uid: string): Promise<InviteInfo[]> {
  const fb = getFirebase();
  if (!fb) return [];
  const snap = await getDocs(query(collection(fb.db, 'invites'), where('projectId', '==', projectId), where('createdBy', '==', uid)));
  return snap.docs
    .map((d) => ({ code: d.id, ...(d.data() as Omit<InviteInfo, 'code'>) }))
    .map((x) => ({ ...x, access: x.access ?? 'full' }))
    .filter((x) => x.expiresAt > Date.now())
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Close an invite link so nobody else can join with it. */
export async function revokeInvite(code: string) {
  const fb = getFirebase();
  if (!fb) return;
  await deleteDoc(doc(fb.db, 'invites', code));
  track('invite_revoked');
}

const cleanMembers = (members: Member[], without: string) => JSON.parse(JSON.stringify(members.filter((m) => m.id !== without)));

/** Owner: take someone out of the project. */
export async function removeMember(p: Pick<Project, 'id' | 'members'>, uid: string) {
  const fb = getFirebase();
  if (!fb) return;
  await updateDoc(doc(fb.db, 'projects', p.id), { [`roles.${uid}`]: deleteField(), [`access.${uid}`]: deleteField(), memberUids: arrayRemove(uid), members: cleanMembers(p.members, uid), walkKey: newWalkKey() });
  track('member_removed');
}

/** Member: leave a project someone shared with you. */
export async function leaveProject(p: Pick<Project, 'id' | 'members'>, uid: string) {
  const fb = getFirebase();
  if (!fb) return;
  await updateDoc(doc(fb.db, 'projects', p.id), { [`roles.${uid}`]: deleteField(), [`access.${uid}`]: deleteField(), memberUids: arrayRemove(uid), members: cleanMembers(p.members, uid) });
  track('project_left');
}
