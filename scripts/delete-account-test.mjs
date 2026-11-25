// End-to-end check of account deletion against the live security rules, using two throwaway
// anonymous accounts (never real users). Mirrors the steps in src/firebase/account.ts.
// Usage: node scripts/delete-account-test.mjs
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, deleteUser } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, query, where, writeBatch, arrayUnion, arrayRemove, deleteField } from 'firebase/firestore';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^VITE_FIREBASE_/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const config = { apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN, projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID };
const results = [];
const check = async (name, fn, expectOk = true) => {
  try {
    await fn();
    results.push(`${expectOk ? 'PASS' : 'FAIL'} ${name}${expectOk ? '' : ' (was allowed, should be denied)'}`);
  } catch (e) {
    results.push(`${expectOk ? 'FAIL' : 'PASS'} ${name}${expectOk ? `: ${e.code ?? e.message}` : ' (denied as expected)'}`);
  }
};
async function client(name) {
  const app = initializeApp(config, name);
  const auth = getAuth(app);
  const user = (await signInAnonymously(auth)).user;
  return { uid: user.uid, user, db: getFirestore(app) };
}
const del = async (db, docs) => {
  for (let i = 0; i < docs.length; i += 400) {
    const b = writeBatch(db);
    docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
};

const A = await client('owner');
const B = await client('member');
const pid = `deltest-${Date.now().toString(36)}`;
const code = `deltest${Date.now().toString(36)}`;
const pA = doc(A.db, 'projects', pid);
const pB = doc(B.db, 'projects', pid);

// Setup: A owns a project with content; B joins through an invite and posts.
await setDoc(pA, { name: 'Deletion test', owner: A.uid, memberUids: [A.uid], roles: { [A.uid]: 'student' }, members: [], updatedAt: Date.now() });
await setDoc(doc(A.db, 'projects', pid, 'messages', 'mA'), { authorId: A.uid, text: 'owner message', threadId: 'studio', createdAt: Date.now() });
await setDoc(doc(A.db, 'projects', pid, 'revisions', 'r1'), { number: 1, label: 'test' });
await setDoc(doc(A.db, 'projects', pid, 'presence', `${A.uid}__abc`), { lastSeen: Date.now() });
await setDoc(doc(A.db, 'invites', code), { projectId: pid, createdBy: A.uid, role: 'student', access: 'full', expiresAt: Date.now() + 3600_000 });
await setDoc(doc(A.db, 'users', A.uid), { name: 'Test owner' });
await updateDoc(pB, { [`roles.${B.uid}`]: 'student', memberUids: arrayUnion(B.uid), joinCode: code, [`access.${B.uid}`]: 'full' });
await setDoc(doc(B.db, 'projects', pid, 'messages', 'mB'), { authorId: B.uid, text: 'member message', threadId: 'studio', createdAt: Date.now() });
await setDoc(doc(B.db, 'projects', pid, 'presence', `${B.uid}__xyz`), { lastSeen: Date.now() });
await setDoc(doc(B.db, 'users', B.uid), { name: 'Test member' });

// Resolving feedback is the owner's job.
await check('a member cannot resolve feedback', () => updateDoc(doc(B.db, 'projects', pid, 'messages', 'mA'), { resolved: true }), false);
await check('the owner resolves feedback', () => updateDoc(doc(A.db, 'projects', pid, 'messages', 'mB'), { resolved: true }));

// Day to day: nobody deletes someone else's message.
await check('owner cannot delete a member’s message normally', () => deleteDoc(doc(A.db, 'projects', pid, 'messages', 'mB')), false);
await check('member cannot delete the owner’s message', () => deleteDoc(doc(B.db, 'projects', pid, 'messages', 'mA')), false);
await check('a full-access member can set the flag (they may edit project content)...', () => updateDoc(pB, { deleting: true }));
await check('...but the flag does not let a member delete others’ messages', () => deleteDoc(doc(B.db, 'projects', pid, 'messages', 'mA')), false);
await updateDoc(pA, { deleting: deleteField() });

// B deletes their account: their messages and presence, then leave, then profile and sign-in.
await check('member deletes own messages', async () => del(B.db, (await getDocs(query(collection(pB, 'messages'), where('authorId', '==', B.uid)))).docs));
await check('member deletes own presence', async () => del(B.db, (await getDocs(collection(pB, 'presence'))).docs.filter((d) => d.id.startsWith(`${B.uid}__`))));
await check('member leaves the project', () => updateDoc(pB, { [`roles.${B.uid}`]: deleteField(), [`access.${B.uid}`]: deleteField(), memberUids: arrayRemove(B.uid), members: [] }));
await check('member deletes profile', () => deleteDoc(doc(B.db, 'users', B.uid)));
await check('member deletes sign-in', () => deleteUser(B.user));
await check('member’s message is gone', async () => {
  if ((await getDoc(doc(A.db, 'projects', pid, 'messages', 'mB'))).exists()) throw new Error('still there');
});

// A deletes their account: flag the project, clear everything inside, delete it, invites, profile, sign-in.
await check('owner flags project as deleting', () => updateDoc(pA, { deleting: true }));
for (const sub of ['messages', 'revisions', 'presence', 'walk', 'aiEvents']) await check(`owner clears ${sub}`, async () => del(A.db, (await getDocs(collection(pA, sub))).docs));
await check('owner deletes project', () => deleteDoc(pA));
await check('owner deletes invites', async () => del(A.db, (await getDocs(query(collection(A.db, 'invites'), where('createdBy', '==', A.uid)))).docs));
await check('owner deletes profile', () => deleteDoc(doc(A.db, 'users', A.uid)));
await check('owner deletes sign-in', () => deleteUser(A.user));

console.log(results.join('\n'));
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
