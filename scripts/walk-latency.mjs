// Measures how long a walking update takes to reach another client over the Realtime Database.
// Two anonymous test clients in a throwaway room; the room is removed afterwards.
// Usage: node scripts/walk-latency.mjs   (reads the Firebase web config from .env.local)
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, set, remove, onChildChanged, onChildAdded, goOffline } from 'firebase/database';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^VITE_FIREBASE_/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  databaseURL: `https://${env.VITE_FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`,
};
const room = `latencytest_${randomBytes(20).toString('hex')}`;

async function client(name) {
  const app = initializeApp(config, name);
  const user = (await signInAnonymously(getAuth(app))).user;
  return { app, uid: user.uid, db: getDatabase(app) };
}

const walker = await client('walker');
const watcher = await client('watcher');
const delays = [];
const sentAt = new Map();
const onUpdate = (s) => {
  const w = s.val()?.walk;
  if (w && sentAt.has(w.x)) delays.push(Date.now() - sentAt.get(w.x));
};
onChildAdded(ref(watcher.db, `walk/${room}`), onUpdate);
onChildChanged(ref(watcher.db, `walk/${room}`), onUpdate);

const mine = ref(walker.db, `walk/${room}/${walker.uid}__test`);
await set(mine, { member: { id: walker.uid, name: 'Latency test' }, walk: { x: -1, y: 0, yaw: 0, at: Date.now(), moving: true } });
await new Promise((r) => setTimeout(r, 800));
for (let i = 0; i < 30; i++) {
  sentAt.set(i, Date.now());
  void set(mine, { member: { id: walker.uid, name: 'Latency test' }, walk: { x: i, y: 0, yaw: 0, at: Date.now(), moving: true } });
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 1500));
await remove(mine);
const sorted = [...delays].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
console.log(JSON.stringify({ sent: 30, received: delays.length, medianMs: pct(50), p90Ms: pct(90), maxMs: sorted[sorted.length - 1] }));
goOffline(walker.db);
goOffline(watcher.db);
process.exit(0);
