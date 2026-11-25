// Shows why project saves must replace fields rather than deep-merge them: a key dropped from the
// model (e.g. dimensions taken away by Undo) survives a merge but not a mergeFields write.
// Uses a throwaway anonymous account and a temporary document, both deleted at the end.
// Usage: node scripts/merge-check.mjs
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, deleteUser } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^VITE_FIREBASE_/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const app = initializeApp({ apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID });
const auth = getAuth(app);
const user = (await signInAnonymously(auth)).user;
const db = getFirestore(app);
const ref = doc(db, 'projects', `merge-check-${Date.now().toString(36)}`);
const base = { owner: user.uid, memberUids: [user.uid], roles: { [user.uid]: 'student' }, name: 'merge check', updatedAt: 1 };
try {
  await setDoc(ref, { ...base, model: { walls: [1], dimensions: [{ id: 'DIM1' }] } });
  await setDoc(ref, { name: 'merge check', updatedAt: 2, model: { walls: [1] } }, { merge: true });
  const afterMerge = (await getDoc(ref)).data().model;
  console.log('merge: true      -> dimensions still there:', 'dimensions' in afterMerge);
  await setDoc(ref, { name: 'merge check', updatedAt: 3, model: { walls: [1] } }, { mergeFields: ['name', 'updatedAt', 'model'] });
  const after = (await getDoc(ref)).data();
  console.log('mergeFields      -> dimensions still there:', 'dimensions' in after.model, '| owner kept:', after.owner === user.uid, '| members kept:', after.memberUids?.length === 1);
} finally {
  await deleteDoc(ref).catch((e) => console.log('cleanup failed', e.code));
  await deleteUser(user).catch(() => undefined);
}
process.exit(0);
