/**
 * Delete your ArchiMind account and everything that belongs to it.
 *
 * Order matters: Firestore rules check membership through the project document, so data inside
 * a project is removed while the project still exists, and the sign-in itself goes last.
 *   1. Confirm it's you (Firebase only deletes accounts that signed in recently).
 *   2. Projects you own: flag them as being deleted, clear their chat, revisions, presence, walk
 *      records, AI log and stored files, then delete the project.
 *   3. Projects others shared with you: delete your messages and AI log entries, then leave.
 *   4. Your invite links and your profile (name, photo, figure).
 *   5. Your sign-in. Your Google account itself is not touched.
 */
import { GoogleAuthProvider, deleteUser, reauthenticateWithPopup } from 'firebase/auth';
import { collection, deleteDoc, doc, getDoc, getDocs, query, updateDoc, where, writeBatch, type DocumentReference, type QueryDocumentSnapshot } from 'firebase/firestore';
import { deleteObject, listAll, ref, type StorageReference } from 'firebase/storage';
import { getFirebase, track } from './config';
import { leaveProject, removeLocal } from './projects';
import type { Member } from '../model/types';

export interface AccountPlan {
  owned: { id: string; name: string; people: number }[];
  shared: { id: string; name: string; members: Member[] }[];
}

/** What deleting the account would remove, so the person can see it before confirming. */
export async function planAccountDeletion(): Promise<AccountPlan> {
  const fb = getFirebase();
  const uid = fb?.auth.currentUser?.uid;
  if (!fb || !uid) return { owned: [], shared: [] };
  const snap = await getDocs(query(collection(fb.db, 'projects'), where('memberUids', 'array-contains', uid)));
  const plan: AccountPlan = { owned: [], shared: [] };
  for (const d of snap.docs) {
    const data = d.data() as { name?: string; owner?: string; memberUids?: string[]; members?: Member[] };
    if (!data.owner || data.owner === uid) plan.owned.push({ id: d.id, name: data.name ?? 'Untitled', people: Math.max(0, (data.memberUids?.length ?? 1) - 1) });
    else plan.shared.push({ id: d.id, name: data.name ?? 'Untitled', members: data.members ?? [] });
  }
  return plan;
}

async function deleteDocs(docs: QueryDocumentSnapshot[]) {
  const fb = getFirebase()!;
  for (let i = 0; i < docs.length; i += 400) {
    const b = writeBatch(fb.db);
    for (const d of docs.slice(i, i + 400)) b.delete(d.ref);
    await b.commit();
  }
}

async function clearFolder(r: StorageReference): Promise<void> {
  const list = await listAll(r);
  await Promise.all(list.items.map((i) => deleteObject(i).catch(() => undefined)));
  for (const p of list.prefixes) await clearFolder(p);
}

const SUBCOLLECTIONS = ['messages', 'revisions', 'presence', 'walk', 'aiEvents'];

/**
 * Delete one project you own, for everyone: its chat, revisions, presence, walk records, AI log,
 * stored files and invite links, then the project itself, and this browser's copy.
 */
export async function deleteProject(pid: string): Promise<void> {
  const fb = getFirebase();
  const uid = fb?.auth.currentUser?.uid;
  if (fb && uid) {
    const pref = doc(fb.db, 'projects', pid);
    const snap = await getDoc(pref).catch(() => null);
    if (snap?.exists()) {
      const owner = (snap.data() as { owner?: string }).owner;
      if (owner && owner !== uid) throw new Error('Only the person who owns this project can delete it.');
      await updateDoc(pref, { deleting: true });
      for (const sub of SUBCOLLECTIONS) await deleteDocs((await getDocs(collection(pref, sub))).docs);
      if (fb.storage) await clearFolder(ref(fb.storage, `projects/${pid}`)).catch(() => undefined);
      await deleteDocs((await getDocs(query(collection(fb.db, 'invites'), where('createdBy', '==', uid), where('projectId', '==', pid)))).docs).catch(() => undefined);
      await deleteDoc(pref);
    }
  }
  removeLocal(pid);
  track('project_deleted', {});
}

export async function deleteAccount(onStep: (text: string) => void): Promise<void> {
  const fb = getFirebase();
  const user = fb?.auth.currentUser;
  if (!fb || !user) throw new Error('You are not signed in.');
  const uid = user.uid;

  if (!user.isAnonymous) {
    onStep('Confirm it’s you in the Google window…');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const r = await reauthenticateWithPopup(user, provider);
      if (r.user.uid !== uid) throw new Error('That was a different Google account. Choose the account you want to delete.');
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'auth/popup-blocked') throw new Error('The browser blocked the Google window. Allow pop-ups for ArchiMind and try again.');
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') throw new Error('Cancelled. Nothing was deleted.');
      if (code === 'auth/user-mismatch') throw new Error('That was a different Google account. Choose the account you want to delete.');
      throw e;
    }
  }

  const plan = await planAccountDeletion();

  for (const p of plan.owned) {
    onStep(`Deleting “${p.name}”…`);
    const pref = doc(fb.db, 'projects', p.id);
    await updateDoc(pref, { deleting: true });
    for (const sub of SUBCOLLECTIONS) await deleteDocs((await getDocs(collection(pref, sub))).docs);
    if (fb.storage) await clearFolder(ref(fb.storage, `projects/${p.id}`)).catch(() => undefined);
    await deleteDoc(pref);
    try {
      localStorage.removeItem(`archimind.project.${p.id}`);
    } catch {
      /* ignore */
    }
  }

  for (const p of plan.shared) {
    onStep(`Removing your messages from “${p.name}” and leaving it…`);
    const pref = doc(fb.db, 'projects', p.id) as DocumentReference;
    await deleteDocs((await getDocs(query(collection(pref, 'messages'), where('authorId', '==', uid)))).docs).catch(() => undefined);
    await deleteDocs((await getDocs(query(collection(pref, 'aiEvents'), where('uid', '==', uid)))).docs).catch(() => undefined);
    for (const sub of ['presence', 'walk']) {
      const mine = (await getDocs(collection(pref, sub)).catch(() => null))?.docs.filter((d) => d.id === uid || d.id.startsWith(`${uid}__`)) ?? [];
      await deleteDocs(mine).catch(() => undefined);
    }
    await leaveProject({ id: p.id, members: p.members }, uid);
  }

  onStep('Deleting your invite links and profile…');
  await deleteDocs((await getDocs(query(collection(fb.db, 'invites'), where('createdBy', '==', uid)))).docs).catch(() => undefined);
  await deleteDoc(doc(fb.db, 'users', uid));

  onStep('Deleting your sign-in…');
  track('account_deleted', { owned: plan.owned.length, shared: plan.shared.length });
  await deleteUser(user);

  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('archimind.')) localStorage.removeItem(k);
    sessionStorage.clear();
  } catch {
    /* ignore */
  }
}
