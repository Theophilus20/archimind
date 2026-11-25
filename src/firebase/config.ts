/**
 * Firebase bootstrap.
 *
 *  - App Check (reCAPTCHA Enterprise; debug token in development) — required by Firebase AI Logic
 *  - Authentication (anonymous first, upgradeable to Google)
 *  - Firestore with a persistent multi-tab offline cache — the studio, like the on-device model, keeps working offline
 *  - Cloud Storage for drawings, crit snapshots and GLB exports
 *  - Remote Config with real-time updates (feature flags, model choice, limits, announcements)
 *  - Google Analytics and Performance Monitoring (lazy, only where supported)
 *
 * Without a config the app runs in demo mode and every feature degrades gracefully.
 */
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
import { activate, fetchAndActivate, getRemoteConfig, getValue, onConfigUpdate, type RemoteConfig } from 'firebase/remote-config';
import { create } from 'zustand';

const env = import.meta.env;

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: env.VITE_FIREBASE_APP_ID as string | undefined,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
};

export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

export interface FirebaseHandles {
  app: FirebaseApp;
  appCheck: AppCheck | null;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage | null;
  remoteConfig: RemoteConfig;
  offlineCache: boolean;
}

/** Remote Config defaults — model choice, feature availability, limits and an announcement banner. */
export const RC_DEFAULTS = {
  cloud_model: (env.VITE_CLOUD_MODEL as string) || '',
  /** Used when the cloud model is overloaded ("high demand") even after retries. */
  cloud_model_fallback: 'gemini-3.5-flash',
  enable_cloud_review: true,
  max_plan_px: 1600,
  on_device_first: true,
  /** Single-use App Check tokens for AI requests (needs a reCAPTCHA check per request). */
  limited_use_tokens: false,
  crit_room_live: true,
  stream_rationale: true,
  announcement: '',
};
export type RCKey = keyof typeof RC_DEFAULTS;
type RCValues = { -readonly [K in RCKey]: (typeof RC_DEFAULTS)[K] };

interface PlatformState {
  rc: RCValues;
  rcSource: 'default' | 'remote' | 'realtime';
  rcFetchedAt: number | null;
  set: (p: Partial<PlatformState>) => void;
}

/** Reactive platform state (Remote Config values update live without a reload). */
export const usePlatform = create<PlatformState>((set) => ({
  rc: { ...RC_DEFAULTS },
  rcSource: 'default',
  rcFetchedAt: null,
  set: (p) => set(p),
}));

let handles: FirebaseHandles | null = null;

function readAll(remoteConfig: RemoteConfig): RCValues {
  const out = { ...RC_DEFAULTS } as RCValues;
  for (const key of Object.keys(RC_DEFAULTS) as RCKey[]) {
    const v = getValue(remoteConfig, key);
    const def = RC_DEFAULTS[key];
    (out as Record<string, unknown>)[key] = typeof def === 'boolean' ? v.asBoolean() : typeof def === 'number' ? v.asNumber() || def : v.asString() || def;
  }
  return out;
}

export function getFirebase(): FirebaseHandles | null {
  if (!firebaseConfigured) return null;
  if (handles) return handles;
  const app = initializeApp(firebaseConfig as Required<typeof firebaseConfig>);

  let appCheck: AppCheck | null = null;
  const debug = env.VITE_APPCHECK_DEBUG_TOKEN as string | undefined;
  if (debug) {
    // Debug tokens are accepted by the hackathon; keep real tokens out of the repo.
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = debug === 'true' ? true : debug;
  }
  const siteKey = env.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY as string | undefined;
  if (siteKey) appCheck = initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });

  const auth = getAuth(app);

  // Offline-first Firestore: persistent IndexedDB cache shared across tabs.
  let db: Firestore;
  let offlineCache = true;
  try {
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    offlineCache = false;
    db = initializeFirestore(app, {});
  }

  let storage: FirebaseStorage | null = null;
  try {
    storage = firebaseConfig.storageBucket ? getStorage(app) : null;
  } catch {
    storage = null;
  }

  const remoteConfig = getRemoteConfig(app);
  remoteConfig.settings.minimumFetchIntervalMillis = 10 * 60 * 1000;
  remoteConfig.defaultConfig = RC_DEFAULTS;
  fetchAndActivate(remoteConfig)
    .then(() => usePlatform.getState().set({ rc: readAll(remoteConfig), rcSource: 'remote', rcFetchedAt: Date.now() }))
    .catch(() => undefined);
  // Real-time Remote Config: flags flip in open sessions without a reload.
  try {
    onConfigUpdate(remoteConfig, {
      next: async () => {
        await activate(remoteConfig);
        usePlatform.getState().set({ rc: readAll(remoteConfig), rcSource: 'realtime', rcFetchedAt: Date.now() });
      },
      error: () => undefined,
      complete: () => undefined,
    });
  } catch {
    /* realtime not available */
  }

  handles = { app, appCheck, auth, db, storage, remoteConfig, offlineCache };
  initTelemetry(app);
  return handles;
}

/** Current Remote Config value (reactive callers should use usePlatform). */
export function rc<K extends RCKey>(key: K): (typeof RC_DEFAULTS)[K] {
  getFirebase();
  return usePlatform.getState().rc[key] as (typeof RC_DEFAULTS)[K];
}

export const appCheckEnabled = () => Boolean(getFirebase()?.appCheck);

// ---------------------------------------------------------------------------
// Analytics + Performance Monitoring (loaded lazily so the main bundle stays lean)
// ---------------------------------------------------------------------------

type LogFn = (name: string, params?: Record<string, string | number | boolean>) => void;
type TraceFn = <T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string>) => Promise<T>;
let logFn: LogFn | null = null;
let perfTrace: ((name: string) => { start: () => void; stop: () => void; putAttribute: (k: string, v: string) => void; putMetric: (k: string, v: number) => void }) | null = null;
const pending: [string, Record<string, string | number | boolean> | undefined][] = [];

export const telemetryState = { analytics: false, performance: false };

function initTelemetry(app: FirebaseApp) {
  if (firebaseConfig.measurementId)
    import('firebase/analytics')
      .then(async ({ getAnalytics, isSupported, logEvent }) => {
        if (!(await isSupported())) return;
        const a = getAnalytics(app);
        telemetryState.analytics = true;
        logFn = (name, params) => logEvent(a, name, params);
        while (pending.length) {
          const [n, p] = pending.shift()!;
          logFn(n, p);
        }
      })
      .catch(() => undefined);
  import('firebase/performance')
    .then(({ getPerformance, trace }) => {
      const perf = getPerformance(app);
      telemetryState.performance = true;
      perfTrace = (name) => trace(perf, name);
    })
    .catch(() => undefined);
}

/** Log a Google Analytics event (no-op in demo mode). */
export const track: LogFn = (name, params) => {
  if (!firebaseConfigured) return;
  if (logFn) logFn(name, params);
  else if (pending.length < 50) pending.push([name, params]);
};

/** Wrap work in a Performance Monitoring custom trace (no-op in demo mode). */
export const traced: TraceFn = async (name, fn, attrs) => {
  const t = perfTrace?.(name.slice(0, 100));
  t?.start();
  const started = performance.now();
  try {
    const out = await fn();
    if (attrs) for (const [k, v] of Object.entries(attrs)) t?.putAttribute(k, v.slice(0, 100));
    return out;
  } finally {
    t?.putMetric('duration_ms', Math.round(performance.now() - started));
    t?.stop();
  }
};
