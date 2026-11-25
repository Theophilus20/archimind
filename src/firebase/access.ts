/**
 * Who can open what in a shared project.
 *
 *   crit    Crit room only: see the model there, chat, follow the view, walk together.
 *   markup  Crit room, plus pin spots, highlight areas and draw on the plan.
 *   full    The whole project: brief, studio, review, schedule. Edits together.
 *
 * The owner is always full. Firestore rules enforce it: only full members can change
 * the project document, create revisions or invite others.
 */
import { doc, updateDoc } from 'firebase/firestore';
import { getFirebase, firebaseConfigured, track } from './config';
import { useAuth } from './auth';
import { useStudio } from '../state/store';
import type { AccessLevel, Project, UserRole } from '../model/types';

export const ACCESS_LABEL: Record<AccessLevel, string> = {
  crit: 'Crit room only',
  markup: 'Crit room and mark-up',
  full: 'Whole project',
};

export const ACCESS_HINT: Record<AccessLevel, string> = {
  crit: 'Sees the model in the crit room, chats, follows your view and walks through it with you. Cannot open your brief, studio, review or schedule.',
  markup: 'Everything in the crit room, plus pinning exact spots, highlighting areas and drawing on your plan to show what to work on.',
  full: 'Opens every page of the project and edits the design with you.',
};

export const defaultAccess = (role: UserRole, studio: boolean): AccessLevel => (role === 'lecturer' ? 'markup' : role === 'client' ? 'crit' : studio && role === 'student' ? 'full' : 'full');

export function accessFor(p: Pick<Project, 'owner' | 'access'>, uid: string | null | undefined): AccessLevel {
  if (!firebaseConfigured || !uid || !p.owner || p.owner === uid) return 'full';
  return p.access?.[uid] ?? 'full';
}

export function useMyAccess(): AccessLevel {
  const uid = useAuth((s) => s.user?.uid);
  const owner = useStudio((s) => s.project.owner);
  const access = useStudio((s) => s.project.access);
  return accessFor({ owner, access }, uid);
}

export const canMarkUp = (a: AccessLevel) => a !== 'crit';

/** True for the person who owns the open project (and for local projects with no owner). */
export function useIsOwner(): boolean {
  const uid = useAuth((s) => s.user?.uid);
  const owner = useStudio((s) => s.project.owner);
  return !firebaseConfigured || !owner || owner === uid;
}

/** Owner only: change what a member can open. */
export async function setMemberAccess(projectId: string, uid: string, level: AccessLevel) {
  const fb = getFirebase();
  if (!fb) return;
  await updateDoc(doc(fb.db, 'projects', projectId), { [`access.${uid}`]: level });
  useStudio.setState((s) => (s.project.id === projectId ? { project: { ...s.project, access: { ...(s.project.access ?? {}), [uid]: level } } } : {}));
  track('access_changed', { level });
}
