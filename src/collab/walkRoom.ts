/**
 * Live walking positions over Firebase Realtime Database.
 *
 * Firestore suits about one write per second per document, but a walking figure needs ~10.
 * The Realtime Database streams small, frequent updates with low delay, and removes a tab's
 * record by itself when the tab disconnects (onDisconnect). Records live at
 * walk/<projectId>_<walkKey>/<uid>__<tab>; the walk key is a random value stored in the
 * Firestore project document, so only people who can open the project can find the room.
 * The SDK is loaded only when someone is in a project with a walk key.
 */
import { firebaseConfig, getFirebase } from '../firebase/config';

export interface WalkRoom {
  /** Server time in ms (local clock corrected by the database's offset). */
  serverNow: () => number;
  send: (data: object) => void;
  clear: () => void;
  close: () => void;
}

type Listener = (id: string, data: unknown | null) => void;

const DATABASE_URL = (import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined) || (firebaseConfig.projectId ? `https://${firebaseConfig.projectId}-default-rtdb.firebaseio.com` : '');

export async function openWalkRoom(room: string, myId: string, onChange: Listener): Promise<WalkRoom | null> {
  const fb = getFirebase();
  if (!fb || !DATABASE_URL) return null;
  const m = await import('firebase/database');
  const db = m.getDatabase(fb.app, DATABASE_URL);
  const roomRef = m.ref(db, `walk/${room}`);
  const mine = m.child(roomRef, myId);
  let offset = 0;
  let disconnectSet = false;
  const unsubs = [
    m.onValue(m.ref(db, '.info/serverTimeOffset'), (s) => (offset = Number(s.val()) || 0)),
    m.onChildAdded(roomRef, (s) => s.key !== myId && onChange(s.key!, s.val())),
    m.onChildChanged(roomRef, (s) => s.key !== myId && onChange(s.key!, s.val())),
    m.onChildRemoved(roomRef, (s) => s.key !== myId && onChange(s.key!, null)),
  ];
  return {
    serverNow: () => Date.now() + offset,
    send: (data) => {
      if (!disconnectSet) {
        disconnectSet = true;
        void m.onDisconnect(mine).remove().catch(() => (disconnectSet = false));
      }
      void m.set(mine, data).catch(() => undefined);
    },
    clear: () => void m.remove(mine).catch(() => undefined),
    close: () => {
      unsubs.forEach((u) => u());
      void m.remove(mine).catch(() => undefined);
    },
  };
}

/** A new random walk key (long enough that the database rules accept the room name). */
export function newWalkKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
