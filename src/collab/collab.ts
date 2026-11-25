/**
 * Crit Room transport. Messages, presence and "follow my camera" travel over
 * Firestore when Firebase is configured, and over a BroadcastChannel between
 * browser tabs otherwise (open a second tab as the tutor or client to demo).
 */
import { create } from 'zustand';
import { collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { openWalkRoom, type WalkRoom } from './walkRoom';
import { getFirebase } from '../firebase/config';
import type { CameraPose, Id, Member, Message, PlanMark } from '../model/types';

/** Where someone is while walking through the model (plan mm), with velocity for smooth motion. */
export interface WalkState {
  x: number;
  y: number;
  yaw: number;
  moving: boolean;
  elev?: number;
  /** Velocity, mm/s, so others can predict the position between updates. */
  vx?: number;
  vy?: number;
  at: number;
}

/** A walking figure as received: who, where, and when this browser heard it. */
export interface Walker {
  member: Pick<Member, 'id' | 'name' | 'role' | 'color' | 'figure' | 'look'>;
  walk: WalkState;
  receivedAt: number;
}

export interface Presence {
  member: Member;
  lastSeen: number;
  route: string;
  presenting: boolean;
  selection: Id[];
  camera?: CameraPose;
  /** Where this person is standing while walking through the model (plan mm). */
  walk?: WalkState | null;
  /** Their window is in the background (browsers pause animation and slow timers there). */
  away?: boolean;
  /** Doors and windows this person opened or closed (newest change wins for everyone). */
  doors?: Record<Id, { open: boolean; at: number }>;
  /** Marks this person has made and is writing a comment for. */
  draftMarks?: PlanMark[];
}

interface CollabState {
  projectId: string;
  messages: Message[];
  presence: Record<Id, Presence>;
  following: Id | null;
  remoteCamera: { from: Id; pose: CameraPose; at: number } | null;
  /** People walking through the model right now, by member id. */
  walkers: Record<Id, Walker>;
  setFollowing: (id: Id | null) => void;
}

export const useCollab = create<CollabState>((set) => ({
  projectId: '',
  messages: [],
  presence: {},
  following: null,
  remoteCamera: null,
  walkers: {},
  setFollowing: (following) => set({ following }),
}));

type Packet =
  | { t: 'msg'; m: Message }
  | { t: 'presence'; p: Presence }
  | { t: 'camera'; from: Id; pose: CameraPose }
  | { t: 'walk'; from: Id; walk: Presence['walk'] }
  | { t: 'resolve'; id: Id; resolved: boolean }
  | { t: 'erase'; id: Id }
  | { t: 'edit'; id: Id; text: string; mentions?: Id[]; editedAt: number }
  | { t: 'delete'; id: Id }
  | { t: 'hello'; from: Id }
  | { t: 'bye'; from: Id };

let channel: BroadcastChannel | null = null;
let me: Member | null = null;
let unsubs: (() => void)[] = [];
/** Walking figures heard over Firestore (older clients) and over the Realtime Database. */
const fsWalkers = new Map<string, Walker>();
const rtWalkers = new Map<string, Walker>();
let walkRoom: WalkRoom | null = null;
let walkRoomName = '';
function publishWalkers() {
  const now = Date.now();
  const walkers: Record<Id, Walker> = {};
  for (const w of [...fsWalkers.values(), ...rtWalkers.values()]) {
    if (now - w.receivedAt > PRESENCE_TTL || w.member.id === me?.id) continue;
    const cur = walkers[w.member.id];
    if (!cur || w.receivedAt > cur.receivedAt) walkers[w.member.id] = w;
  }
  useCollab.setState({ walkers });
}

/**
 * Open the fast walking channel for this project (Realtime Database). Without a walk key,
 * walking positions keep going through Firestore.
 */
export function setWalkChannel(projectId: string, key: string | undefined) {
  const name = key && fsMode() ? `${projectId}_${key}` : '';
  if (name === walkRoomName) return;
  walkRoom?.close();
  walkRoom = null;
  walkRoomName = name;
  rtWalkers.clear();
  publishWalkers();
  if (!name || !me) return;
  const myId = `${me.id}__${TAB_ID}`;
  void openWalkRoom(name, myId, (id, data) => {
    const d = data as { member?: Walker['member']; walk?: WalkState } | null;
    if (!d?.walk || !d.member) rtWalkers.delete(id);
    else {
      // Shift the receive time back by how old the update already is (server clock), so other
      // figures are predicted to where they are now, not where they were when they sent it.
      const age = walkRoom ? Math.max(0, Math.min(1500, walkRoom.serverNow() - d.walk.at)) : 0;
      rtWalkers.set(id, { member: d.member, walk: d.walk, receivedAt: Date.now() - age });
    }
    publishWalkers();
  })
    .then((room) => {
      if (walkRoomName !== name) return room?.close();
      walkRoom = room;
    })
    .catch((e) => console.warn('[ArchiMind] walk channel unavailable, using Firestore', e));
}
let presenceTimer: ReturnType<typeof setInterval> | undefined;
let myPresence: Omit<Presence, 'member' | 'lastSeen'> = { route: 'overview', presenting: false, selection: [], walk: null };

const storeKey = (pid: string) => `archimind.messages.${pid}`;

/**
 * How long someone stays "in the room" without an update. Browsers pause animation frames
 * and throttle timers (down to about once a minute) in hidden tabs and in windows covered by
 * other windows, so a short timeout made people vanish and reappear as windows were switched.
 * Leaving is announced explicitly instead (page hide / project switch).
 */
const PRESENCE_TTL = 120_000;

/**
 * One presence record per browser tab. With one record per person, two tabs of the same
 * account (one walking, one not) overwrote each other every few seconds, so the figure
 * kept vanishing and coming back for everyone else.
 */
const TAB_ID = (() => {
  try {
    const k = 'archimind.tab';
    const v = sessionStorage.getItem(k) ?? Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
})();

function persistLocal() {
  const { projectId, messages } = useCollab.getState();
  try {
    localStorage.setItem(storeKey(projectId), JSON.stringify(messages.slice(-300)));
  } catch {
    /* ignore */
  }
}

function upsertMessage(m: Message) {
  useCollab.setState((s) => {
    if (s.messages.some((x) => x.id === m.id)) return { messages: s.messages.map((x) => (x.id === m.id ? m : x)) };
    return { messages: [...s.messages, m].sort((a, b) => a.createdAt - b.createdAt) };
  });
}

function onPacket(p: Packet) {
  if (p.t === 'msg') {
    upsertMessage(p.m);
    persistLocal();
  } else if (p.t === 'presence') {
    if (p.p.member.id === me?.id) return;
    useCollab.setState((s) => ({ presence: { ...s.presence, [p.p.member.id]: { ...p.p, lastSeen: Date.now() } } }));
  } else if (p.t === 'camera') {
    if (p.from === me?.id) return;
    useCollab.setState({ remoteCamera: { from: p.from, pose: p.pose, at: Date.now() } });
  } else if (p.t === 'walk') {
    if (p.from === me?.id) return;
    const who = useCollab.getState().presence[p.from]?.member;
    useCollab.setState((s) => {
      const walkers = { ...s.walkers };
      if (p.walk && who) walkers[p.from] = { member: who, walk: p.walk, receivedAt: Date.now() };
      else delete walkers[p.from];
      return { walkers, ...(s.presence[p.from] ? { presence: { ...s.presence, [p.from]: { ...s.presence[p.from], walk: p.walk, lastSeen: Date.now() } } } : {}) };
    });
  } else if (p.t === 'resolve') {
    useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === p.id ? { ...m, resolved: p.resolved } : m)) }));
    persistLocal();
  } else if (p.t === 'erase') {
    useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === p.id ? { ...m, erased: true } : m)) }));
    persistLocal();
  } else if (p.t === 'edit') {
    useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === p.id ? { ...m, text: p.text, mentions: p.mentions, editedAt: p.editedAt } : m)) }));
    persistLocal();
  } else if (p.t === 'delete') {
    useCollab.setState((s) => ({ messages: s.messages.filter((m) => m.id !== p.id) }));
    persistLocal();
  } else if (p.t === 'bye') {
    useCollab.setState((s) => {
      const { [p.from]: _gone, ...rest } = s.presence;
      return { presence: rest };
    });
  } else if (p.t === 'hello') {
    broadcastPresence();
  }
}

function fsMode() {
  return getFirebase()?.auth.currentUser ? getFirebase() : null;
}

export function connectCollab(projectId: string, member: Member) {
  disconnectCollab();
  me = member;
  let local: Message[] = [];
  try {
    local = JSON.parse(localStorage.getItem(storeKey(projectId)) ?? '[]');
  } catch {
    local = [];
  }
  useCollab.setState({ projectId, messages: local, presence: {}, walkers: {} });

  const fb = fsMode();
  if (fb) {
    const msgs = query(collection(fb.db, 'projects', projectId, 'messages'), orderBy('createdAt', 'asc'), limit(300));
    // Listeners can start before the project document (and its membership) exists, and a
    // Firestore listener stops for good after a permission error, so retry with backoff.
    const live = (subscribe: (onError: () => void) => () => void, attempt = 0) => {
      let unsub: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = (n: number) => {
        unsub = subscribe(() => {
          unsub?.();
          if (n < 12) timer = setTimeout(() => start(n + 1), Math.min(15000, 1500 * (n + 1)));
        });
      };
      start(attempt);
      unsubs.push(() => {
        clearTimeout(timer);
        unsub?.();
      });
    };
    live((onError) =>
      onSnapshot(
        msgs,
        (snap) => {
          const list = snap.docs.map((d) => ({ ...(d.data() as Message), id: d.id }));
          useCollab.setState({ messages: list });
          persistLocal();
        },
        onError,
      ),
    );
    // Presence is judged by when *this* browser last heard from someone, never by the
    // other computer's clock: clocks on two laptops are often a minute or more apart,
    // which used to make people vanish and reappear every few seconds.
    const heard = new Map<string, { p: Presence; at: number }>();
    live((onError) =>
      onSnapshot(
        collection(fb.db, 'projects', projectId, 'presence'),
        (snap) => {
          const now = Date.now();
          let cam: CollabState['remoteCamera'] = useCollab.getState().remoteCamera;
          for (const ch of snap.docChanges()) {
            const p = ch.doc.data() as Presence;
            if (!p?.member || p.member.id === me?.id) continue;
            if (ch.type === 'removed') {
              heard.delete(ch.doc.id);
              continue;
            }
            // A document that was already there when we arrived may be hours old: only trust it
            // if it looks recent; otherwise wait for its next update (every few seconds when live).
            if (ch.type === 'added' && Math.abs(now - (p.lastSeen ?? 0)) > 3 * 60_000) continue;
            heard.set(ch.doc.id, { p, at: now });
            if (p.presenting && p.camera) cam = { from: p.member.id, pose: p.camera, at: now };
          }
          // Several tabs of one person: show them walking / presenting if any tab is, else the latest.
          const presence: Record<Id, Presence> = {};
          const score = (x: { p: Presence; at: number }) => (x.p.walk ? 2e13 : 0) + (x.p.presenting ? 1e13 : 0) + x.at;
          for (const h of heard.values()) {
            if (now - h.at >= PRESENCE_TTL) continue;
            const id = h.p.member.id;
            const cur = presence[id];
            if (!cur || score(h) > score({ p: cur, at: cur.lastSeen })) presence[id] = { ...h.p, lastSeen: h.at };
          }
          useCollab.setState({ presence, remoteCamera: cam });
        },
        onError,
      ),
    );
  }
  if (fb) {
    // Walking figures: small records, one per tab, updated several times a second while moving.
    const live2 = (subscribe: (onError: () => void) => () => void) => {
      let unsub: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const start = (n: number) => {
        unsub = subscribe(() => {
          unsub?.();
          if (n < 12) timer = setTimeout(() => start(n + 1), Math.min(15000, 1500 * (n + 1)));
        });
      };
      start(0);
      unsubs.push(() => {
        clearTimeout(timer);
        unsub?.();
      });
    };
    fsWalkers.clear();
    const sessions = fsWalkers;
    live2((onError) =>
      onSnapshot(
        collection(fb.db, 'projects', projectId, 'walk'),
        (snap) => {
          const now = Date.now();
          for (const ch of snap.docChanges()) {
            const d = ch.doc.data() as { member?: Walker['member']; walk?: WalkState };
            if (ch.type === 'removed' || !d?.walk || !d.member) {
              sessions.delete(ch.doc.id);
              continue;
            }
            if (d.member.id === me?.id) continue;
            // An old record left behind by a closed tab: ignore unless it is recent.
            if (ch.type === 'added' && Math.abs(now - d.walk.at) > 3 * 60_000) continue;
            sessions.set(ch.doc.id, { member: d.member, walk: d.walk, receivedAt: now });
          }
          publishWalkers();
        },
        onError,
      ),
    );
  }
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel(`archimind-crit-${projectId}`);
    channel.onmessage = (e) => onPacket(e.data as Packet);
    channel.postMessage({ t: 'hello', from: member.id } satisfies Packet);
  }
  broadcastPresence();
  // Update the moment this tab is hidden or shown again, and say goodbye when the page goes away.
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  presenceTimer = setInterval(() => {
    broadcastPresence();
    // drop stale presence and walkers
    const cutoff = Date.now() - PRESENCE_TTL;
    useCollab.setState((s) => ({ walkers: Object.fromEntries(Object.entries(s.walkers).filter(([, w]) => w.receivedAt > cutoff)) }));
    useCollab.setState((s) => ({ presence: Object.fromEntries(Object.entries(s.presence).filter(([, p]) => p.lastSeen > cutoff)) }));
  }, 5000);
}

/** Tell everyone right away that this tab has left the room. */
function leavePresence() {
  if (!me) return;
  walkRoom?.clear();
  channel?.postMessage({ t: 'bye', from: me.id } satisfies Packet);
  const fb = fsMode();
  const pid = useCollab.getState().projectId;
  if (fb && pid) {
    try {
      void deleteDoc(doc(fb.db, 'projects', pid, 'presence', `${me.id}__${TAB_ID}`)).catch(() => undefined);
      void deleteDoc(doc(fb.db, 'projects', pid, 'walk', `${me.id}__${TAB_ID}`)).catch(() => undefined);
    } catch {
      /* not connected */
    }
  }
}

const onVisibility = () => broadcastPresence();
const onPageHide = () => leavePresence();

export function disconnectCollab() {
  leavePresence();
  walkRoom?.close();
  walkRoom = null;
  walkRoomName = '';
  rtWalkers.clear();
  fsWalkers.clear();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  unsubs.forEach((u) => u());
  unsubs = [];
  channel?.close();
  channel = null;
  clearInterval(presenceTimer);
}

export function setMyMember(member: Member) {
  me = member;
  broadcastPresence();
}

function broadcastPresence() {
  if (!me) return;
  const p: Presence = { member: me, lastSeen: Date.now(), ...myPresence, away: typeof document !== 'undefined' && document.visibilityState === 'hidden' };
  channel?.postMessage({ t: 'presence', p } satisfies Packet);
  const fb = fsMode();
  const pid = useCollab.getState().projectId;
  if (fb && pid && me.id) {
    try {
      setDoc(doc(fb.db, 'projects', pid, 'presence', `${me.id}__${TAB_ID}`), JSON.parse(JSON.stringify({ ...p, session: TAB_ID }))).catch(() => undefined);
    } catch {
      /* not connected to a project yet */
    }
  }
}

export function updatePresence(patch: Partial<typeof myPresence>) {
  myPresence = { ...myPresence, ...patch };
  broadcastPresence();
}

let lastCam = 0;
export function broadcastCamera(pose: CameraPose) {
  if (!me || !myPresence.presenting) return;
  const now = Date.now();
  if (now - lastCam < 120) return;
  lastCam = now;
  channel?.postMessage({ t: 'camera', from: me.id, pose } satisfies Packet);
  // Firestore presence carries the camera at a lower rate to keep writes cheap.
  if (fsMode() && now % 4 === 0) updatePresence({ camera: pose });
}

let seq = 0;
export async function sendMessage(m: Omit<Message, 'id' | 'createdAt'>) {
  const msg: Message = { ...m, id: `m-${Date.now().toString(36)}-${(seq++).toString(36)}`, createdAt: Date.now() };
  const clean = JSON.parse(JSON.stringify(msg)) as Message; // strip undefined for Firestore
  const fb = fsMode();
  if (fb) {
    const pid = useCollab.getState().projectId;
    upsertMessage(clean);
    // The local cache shows it immediately; the server write completes in the background.
    void setDoc(doc(fb.db, 'projects', pid, 'messages', clean.id), { ...clean, serverAt: serverTimestamp() }).catch((e) => {
      console.warn('[ArchiMind] message write failed', e);
      useCollab.setState((st) => ({ messages: st.messages.filter((m) => m.id !== clean.id) }));
    });
  } else {
    upsertMessage(clean);
    persistLocal();
  }
  channel?.postMessage({ t: 'msg', m: clean } satisfies Packet);
  return clean;
}

export function setResolved(id: Id, resolved: boolean) {
  useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, resolved } : m)) }));
  persistLocal();
  channel?.postMessage({ t: 'resolve', id, resolved } satisfies Packet);
  const fb = fsMode();
  if (fb) setDoc(doc(fb.db, 'projects', useCollab.getState().projectId, 'messages', id), { resolved }, { merge: true }).catch(() => undefined);
}

/** Erase the marks of one of my messages (everyone sees them disappear). */
export function setErased(id: Id) {
  useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, erased: true } : m)) }));
  persistLocal();
  channel?.postMessage({ t: 'erase', id } satisfies Packet);
  const fb = fsMode();
  if (fb) setDoc(doc(fb.db, 'projects', useCollab.getState().projectId, 'messages', id), { erased: true }, { merge: true }).catch(() => undefined);
}

/** Correct the text of one of my messages. Everyone sees the new text, marked "edited". */
export async function editMessage(id: Id, text: string, mentions?: Id[]) {
  const before = useCollab.getState().messages.find((m) => m.id === id);
  if (!before) return;
  const editedAt = Date.now();
  const patch = { text, mentions: mentions ?? [], editedAt };
  useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  persistLocal();
  channel?.postMessage({ t: 'edit', id, ...patch } satisfies Packet);
  const fb = fsMode();
  if (fb) {
    try {
      await updateDoc(doc(fb.db, 'projects', useCollab.getState().projectId, 'messages', id), patch);
    } catch (e) {
      // Put the old text back so nobody sees a change that didn't save.
      useCollab.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? before : m)) }));
      throw e;
    }
  }
}

/** Delete one of my messages for everyone. */
export async function deleteMessage(id: Id) {
  const before = useCollab.getState().messages;
  useCollab.setState((s) => ({ messages: s.messages.filter((m) => m.id !== id) }));
  persistLocal();
  channel?.postMessage({ t: 'delete', id } satisfies Packet);
  const fb = fsMode();
  if (fb) {
    try {
      await deleteDoc(doc(fb.db, 'projects', useCollab.getState().projectId, 'messages', id));
    } catch (e) {
      useCollab.setState({ messages: before });
      throw e;
    }
  }
}

let lastWalk = 0;
let lastWalkFs = 0;
/** Share where I am while walking through the model (null when I stop walking). */
let lastSentMoving = false;
export function broadcastWalk(pose: { x: number; y: number; yaw: number; moving: boolean; elev?: number; vx?: number; vy?: number } | null) {
  if (!me) return;
  const now = Date.now();
  if (pose && now - lastWalk < 80) return;
  lastWalk = now;
  const walk: WalkState | null = pose ? { ...pose, x: Math.round(pose.x), y: Math.round(pose.y), vx: Math.round(pose.vx ?? 0), vy: Math.round(pose.vy ?? 0), at: now } : null;
  const started = !myPresence.walk && !!walk;
  myPresence = { ...myPresence, walk };
  channel?.postMessage({ t: 'walk', from: me.id, walk } satisfies Packet);
  if (walkRoom) {
    if (!walk) {
      lastSentMoving = false;
      walkRoom.clear();
      return;
    }
    const changed = walk.moving !== lastSentMoving;
    const due = walk.moving ? now - lastWalkFs >= 95 : now - lastWalkFs > 3000;
    if (!started && !changed && !due) return;
    lastWalkFs = now;
    lastSentMoving = walk.moving;
    const member = JSON.parse(JSON.stringify({ id: me.id, name: me.name.slice(0, 80), role: me.role, color: me.color, figure: me.figure ?? 'woman', look: me.look }));
    walkRoom.send({ member, walk: { ...walk, at: walkRoom.serverNow() } });
    return;
  }
  const fb = fsMode();
  const pid = useCollab.getState().projectId;
  if (!fb || !pid) return;
  const ref = doc(fb.db, 'projects', pid, 'walk', `${me.id}__${TAB_ID}`);
  if (!walk) {
    lastSentMoving = false;
    void deleteDoc(ref).catch(() => undefined);
    return;
  }
  // Moving: about 2 updates a second (others predict the motion in between). Standing still:
  // one update when you stop, then a slow heartbeat. Starting or stopping is sent at once.
  const changed = walk.moving !== lastSentMoving;
  const due = walk.moving ? now - lastWalkFs > 900 : now - lastWalkFs > 4000;
  if (!started && !changed && !due) return;
  lastWalkFs = now;
  lastSentMoving = walk.moving;
  const m = JSON.parse(JSON.stringify({ id: me.id, name: me.name, role: me.role, color: me.color, figure: me.figure ?? 'woman', look: me.look }));
  void setDoc(ref, { member: m, walk }).catch(() => undefined);
}

/** For the developer page and tests: is the fast walking channel open? */
export const walkChannelInfo = () => ({ named: !!walkRoomName, ready: !!walkRoom });
