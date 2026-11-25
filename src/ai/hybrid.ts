/**
 * Firebase AI Logic hybrid inference.
 *
 * Every AI feature in ArchiMind is a bounded, single-turn request type with its
 * own JSON schema. Compact requests (explaining a space, translating a message,
 * writing crit minutes, drafting a rationale) prefer Gemini Nano on-device; heavier
 * ones (reading a drawing, a full rubric review) prefer the cloud. "Local only" mode
 * uses ONLY_ON_DEVICE so project content is never silently uploaded.
 *
 * Every call:
 *  - goes through App Check (cached tokens; single-use tokens can be switched on in Remote Config),
 *  - is wrapped in a Performance Monitoring trace and logged to Analytics,
 *  - is recorded (source, latency, tokens — never content) in Firestore so the
 *    team can see how much of the project's AI ran on device,
 *  - is validated before use; on-device output that fails validation, or a device
 *    job that runs past 15 s (it is stopped, not abandoned), is retried
 *    once in the cloud (unless local-only), and the log says so.
 *
 * The geometry engine — never the model — applies edits.
 */
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel, type Part } from 'firebase/ai';
import { addDoc, collection } from 'firebase/firestore';
import { getToken } from 'firebase/app-check';
import { firebaseConfigured, getFirebase, rc, track, traced } from '../firebase/config';
import { useAI, type AIMode, type DeviceStatus, type AILogEntry } from './log';
import type { AISource } from '../model/types';
import { useStudio } from '../state/store';

export type RequestType =
  | 'brief.summarize'
  | 'element.explain'
  | 'review.interpretive'
  | 'edit.propose'
  | 'thread.minutes'
  | 'message.translate'
  | 'message.intent'
  | 'plan.labels'
  | 'rationale.draft'
  | 'roof.suggest'
  | 'plan.read'
  | 'plan.symbols'
;

interface Route {
  prefer: 'device' | 'cloud';
  image?: boolean;
  stream?: boolean;
  label: string;
  /** Bigger answers (a full review) get longer before falling back. */
  timeoutMs?: number;
}

export const ROUTES: Record<RequestType, Route> = {
  'brief.summarize': { prefer: 'device', label: 'Summarised the brief' },
  'element.explain': { prefer: 'device', label: 'Explained a space' },
  'edit.propose': { prefer: 'device', label: 'Suggested a plan change' },
  'thread.minutes': { prefer: 'device', label: 'Wrote crit minutes' },
  'message.translate': { prefer: 'device', label: 'Rewrote a message in plain language' },
  'message.intent': { prefer: 'device', label: 'Turned feedback into design goals' },
  'rationale.draft': { prefer: 'device', stream: true, label: 'Drafted the design rationale' },
  'roof.suggest': { prefer: 'device', label: 'Suggested a roof' },
  'review.interpretive': { prefer: 'cloud', label: 'Reviewed the design', timeoutMs: 45000 },
  'plan.labels': { prefer: 'cloud', image: true, label: 'Read room names from the drawing' },
  'plan.read': { prefer: 'cloud', image: true, label: 'Read doors, windows, outdoor spaces and furniture from the drawing', timeoutMs: 45000 },
  'plan.symbols': { prefer: 'cloud', image: true, label: 'Checked each symbol on the drawing against a legend', timeoutMs: 45000 },
};

export class LocalModelUnavailable extends Error {
  constructor() {
    super('On-device AI isn’t available. Private mode never sends your work to the cloud. Turn on on-device AI in Chrome, or switch to Balanced mode.');
  }
}

export type JsonSchema = Record<string, unknown>;

export interface AIRequest<T> {
  type: RequestType;
  system: string;
  prompt: string;
  image?: { mimeType: 'image/png' | 'image/jpeg'; data: string };
  schema: JsonSchema;
  validate: (x: unknown) => T | null;
  heuristic: () => T;
  /** A different cloud model for this request (for a second, more careful try). */
  cloudModel?: string;
}

export interface AIResult<T> {
  data: T;
  source: AISource;
  latencyMs: number;
  validated: boolean;
  note?: string;
}

export function inferenceModeFor(type: RequestType, mode: AIMode): InferenceMode {
  if (mode === 'local-only') return InferenceMode.ONLY_ON_DEVICE;
  if (mode === 'cloud-first') return InferenceMode.ONLY_IN_CLOUD;
  return ROUTES[type].prefer === 'device' && rc('on_device_first') ? InferenceMode.PREFER_ON_DEVICE : InferenceMode.ONLY_IN_CLOUD;
}

const models = new Map<string, GenerativeModel>();
let limitedUse: boolean | undefined;

/**
 * A model for one request type. Pass `signal` for anything that may run on the device: Chrome's
 * on-device model ignores the SDK's request options, so the signal goes straight into Chrome's own
 * create and prompt calls, letting a slow job be stopped instead of blocking the next one.
 */
function modelFor(type: RequestType, system: string, schema: JsonSchema | null, mode: InferenceMode, signal?: AbortSignal, override?: string): GenerativeModel {
  const cloudModel = override || rc('cloud_model') || 'gemini-3.5-flash-lite';
  const key = `${type}|${mode}|${cloudModel}`;
  const hit = !signal && models.get(key);
  if (hit) return hit;
  const fb = getFirebase()!;
  // Limited-use App Check tokens: each AI request carries a single-use token.
  // Regular App Check tokens are cached and refreshed in the background, so a request never waits
  // on (or fails because of) a fresh reCAPTCHA check. Single-use tokens can be switched on with the
  // Remote Config flag limited_use_tokens; the choice is fixed after the first call.
  limitedUse ??= Boolean(rc('limited_use_tokens'));
  const ai = getAI(fb.app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: limitedUse });
  const model = getGenerativeModel(ai, {
    mode,
    inCloudParams: {
      model: cloudModel,
      systemInstruction: system,
      generationConfig: schema ? { responseMimeType: 'application/json', responseJsonSchema: schema, temperature: 0.4 } : { temperature: 0.6, maxOutputTokens: 700 },
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: 'text', languages: ['en'] }, ...(ROUTES[type].image ? [{ type: 'image' as const }] : [])],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{ role: 'system', content: [{ type: 'text', value: system }] }],
        ...(signal ? { signal } : {}),
      } as never,
      promptOptions: { ...(schema ? { responseConstraint: schema } : {}), ...(signal ? { signal } : {}) } as never,
    },
  });
  withTokenFallback(model);
  if (!signal) models.set(key, model);
  return model;
}

type TokenResult = { token: string; error?: Error };
/**
 * Each AI request first asks App Check for a single-use token (replay protection). That needs a
 * fresh reCAPTCHA check every time, which now and then fails. When it does, use the normal cached
 * App Check token instead of failing the request: still verified, just not single-use.
 */
function withTokenFallback(model: GenerativeModel) {
  const settings = (model as unknown as { _apiSettings?: { getAppCheckToken?: () => Promise<TokenResult> } })._apiSettings;
  const ac = getFirebase()?.appCheck;
  if (!settings?.getAppCheckToken || !ac) return;
  const singleUse = settings.getAppCheckToken;
  settings.getAppCheckToken = async () => {
    let first: TokenResult | undefined;
    try {
      first = await withTimeout(singleUse(), 8000);
      if (first?.token && !first.error) return first;
    } catch {
      // fall through to the cached token
    }
    try {
      const cached = await withTimeout(getToken(ac, false), 8000);
      tokenFallbacks++;
      return { token: cached.token };
    } catch (e) {
      return first ?? { token: '', error: e as Error };
    }
  };
}
/** How many requests used the cached App Check token because the single-use one failed. */
let tokenFallbacks = 0;
export const appCheckFallbackCount = () => tokenFallbacks;

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
    throw new Error('Response was not JSON');
  }
}

/** How long each engine gets. The device is tried first for quick tasks, so it gets a short leash. */
const DEVICE_LIMIT_MS = 15_000;
/** The device answers alone for this long; after that the cloud starts too and the first good answer wins. */
const HEAD_START_MS = 5_000;
const CLOUD_LIMIT_MS = 30_000;
const PRIVATE_LIMIT_MS = 60_000;
/** Device jobs still running (a stopped job can take a moment to wind down). */
let deviceJobs = 0;
/** After the device is too slow, quick tasks go to the cloud for a while instead of waiting again. */
let deviceSlowUntil = (() => {
  try {
    return Number(localStorage.getItem('archimind.deviceSlowUntil')) || 0;
  } catch {
    return 0;
  }
})();
/** This computer's on-device AI was too slow: send quick tasks to the cloud for a while (kept across reloads). */
function markDeviceSlow(ms = 30 * 60_000) {
  deviceSlowUntil = Date.now() + ms;
  try {
    localStorage.setItem('archimind.deviceSlowUntil', String(deviceSlowUntil));
  } catch {
    /* private mode */
  }
}
export const deviceSlowFor = () => Math.max(0, deviceSlowUntil - Date.now());

/** Resolve with the first attempt that gives a valid answer (or the last one, if none do). */
function firstValid<A extends { parsed: unknown }>(ps: Promise<A>[]): Promise<A> {
  return new Promise((resolve, reject) => {
    let left = ps.length;
    let invalid: A | null = null;
    let error: unknown;
    const done = () => (invalid ? resolve(invalid) : reject(error));
    for (const p of ps)
      p.then(
        (r) => {
          if (r.parsed) resolve(r);
          else {
            invalid = r;
            if (--left === 0) done();
          }
        },
        (e) => {
          error = e;
          if (--left === 0) done();
        },
      );
  });
}
const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/** Can this request start on the device right now? */
function deviceReady(type: RequestType, mode: AIMode) {
  if (mode !== 'auto' || ROUTES[type].prefer !== 'device' || !rc('on_device_first')) return false;
  return useAI.getState().device === 'available' && deviceJobs === 0 && Date.now() > deviceSlowUntil;
}

/** When the cloud fails or stalls, check whether the security check (App Check) is the reason. */
async function appCheckProblem(): Promise<string | null> {
  const ac = getFirebase()?.appCheck;
  if (!ac) return null;
  try {
    const t = await withTimeout(getToken(ac, false), 6000);
    return t.token ? null : 'App Check returned no token';
  } catch (e) {
    return `App Check failed: ${/timeout/i.test(String((e as Error)?.message)) ? 'no answer within 6 s' : (e as Error).message}`;
  }
}

class TimedOut extends Error {
  constructor(where: 'device' | 'cloud', ms: number) {
    super(`timeout: the ${where === 'device' ? 'on-device' : 'cloud'} AI gave no answer within ${Math.round(ms / 1000)} s`);
  }
}

/** No request should leave someone waiting forever: give up after `ms` and use the built-in answer. */
function withTimeout<R>(p: Promise<R>, ms = 25000): Promise<R> {
  return Promise.race([p, new Promise<R>((_, rej) => setTimeout(() => rej(new Error('timeout: the AI took too long to answer')), ms))]);
}

/**
 * A model's daily quota used up (the Gemini API free tier allows only a few requests a day for
 * some models): no use retrying it today. It is skipped until its quota resets, across reloads.
 */
export const isQuotaError = (e: unknown) => /exceeded your current quota|quota exceeded|PerDay|free_tier_requests/i.test(String((e as Error)?.message ?? e));
const QUOTA_KEY = 'archimind.ai.quota';
function quotaTable(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(QUOTA_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
/** When this model can be asked again (0: now). */
export const quotaResetsAt = (model: string) => (quotaTable()[model] ?? 0) > Date.now() ? quotaTable()[model] : 0;
/** How long Google says to wait: "Please retry in 17h13m6.9s", or "retryDelay":"61986s"; else an hour. */
export function quotaRetrySeconds(msg: string) {
  const a = msg.match(/retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  const b = msg.match(/retryDelay\W+(\d+)s/);
  if (a) return Number(a[1] ?? 0) * 3600 + Number(a[2] ?? 0) * 60 + parseFloat(a[3]);
  if (b) return Number(b[1]);
  return 3600;
}
function markQuotaUsed(model: string, e: unknown) {
  const secs = quotaRetrySeconds(String((e as Error)?.message ?? e));
  const t = quotaTable();
  t[model] = Date.now() + Math.min(secs, 26 * 3600) * 1000;
  try {
    localStorage.setItem(QUOTA_KEY, JSON.stringify(t));
  } catch {
    /* private window: remembered for this page only */
  }
}
/** Every cloud model's daily quota is used up: when the first one comes back. */
export class QuotaUsedUp extends Error {
  constructor(public resetsAt: number) {
    super(`The free daily AI limit is used up; it resets in about ${Math.max(1, Math.round((resetsAt - Date.now()) / 3600000))} h.`);
  }
}

/** Model overload / rate-limit errors are temporary: retry with backoff before falling back. */
const isTransient = (e: unknown) => !isQuotaError(e) && /\b(500|502|503|429)\b|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED|try again later/i.test(String((e as Error)?.message ?? e));
async function withRetry<R>(fn: () => Promise<R>, onRetry?: () => void, tries = 3): Promise<R> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !isTransient(e)) throw e;
      onRetry?.();
      await new Promise((r) => setTimeout(r, 1200 * (i + 1) ** 2));
    }
  }
}

let logSeq = 0;
function log(entry: Omit<AILogEntry, 'id' | 'at'>) {
  const e: AILogEntry = { ...entry, id: `ai-${Date.now()}-${logSeq++}`, at: Date.now() };
  useAI.getState().push(e);
  track('ai_inference', { request_type: e.requestType, source: e.source, latency_ms: e.latencyMs, validated: e.validated });
  // Team-wide hybrid telemetry (metadata only: prompts and outputs never leave the request).
  const fb = getFirebase();
  if (fb?.auth.currentUser) {
    const pid = useStudio.getState().project.id;
    addDoc(collection(fb.db, 'projects', pid, 'aiEvents'), {
      requestType: e.requestType,
      source: e.source,
      inferenceMode: e.inferenceMode,
      latencyMs: e.latencyMs,
      tokens: e.tokens ?? null,
      validated: e.validated,
      retriedInCloud: e.retriedInCloud ?? false,
      uid: fb.auth.currentUser.uid,
      at: e.at,
    }).catch(() => undefined);
  }
}

/** Run one bounded request through Firebase AI Logic (or the labelled heuristic in demo mode). */
export async function runAI<T>(req: AIRequest<T>): Promise<AIResult<T>> {
  const { mode, setBusy } = useAI.getState();
  const route = ROUTES[req.type];
  const started = performance.now();
  setBusy(req.type, true);
  try {
    if (!firebaseConfigured) {
      const data = req.heuristic();
      const latencyMs = Math.round(performance.now() - started);
      log({ requestType: req.type, label: route.label, inferenceMode: 'demo (no Firebase config)', source: 'heuristic', latencyMs, promptChars: req.prompt.length, validated: true, note: 'Built-in answer: Firebase AI Logic is not connected.' });
      return { data, source: 'heuristic', latencyMs, validated: true };
    }
    if (req.type === 'review.interpretive' && mode !== 'local-only' && !rc('enable_cloud_review')) {
      const data = req.heuristic();
      log({ requestType: req.type, label: route.label, inferenceMode: 'disabled by Remote Config', source: 'heuristic', latencyMs: 0, promptChars: req.prompt.length, validated: true });
      return { data, source: 'heuristic', latencyMs: 0, validated: true };
    }

    const inferenceMode = inferenceModeFor(req.type, mode);
    const parts: (string | Part)[] = [req.prompt];
    if (req.image) parts.push({ type: 'inlineData', inlineData: { mimeType: req.image.mimeType, data: req.image.data } });

    type Attempt = { parsed: T | null; source: AISource; tokens?: number };
    /** One try on one engine, stopped (not just abandoned) when it runs past its limit. */
    const attempt = async (im: InferenceMode, limitMs: number, stop?: AbortSignal, cloudModel?: string): Promise<Attempt> => {
      const onDevice = im !== InferenceMode.ONLY_IN_CLOUD;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), limitMs);
      stop?.addEventListener('abort', () => ctrl.abort(), { once: true });
      if (onDevice) deviceJobs++;
      const job = traced(
        `ai_${req.type.replace('.', '_')}`,
        async () => {
          const result = await modelFor(req.type, req.system, req.schema, im, onDevice ? ctrl.signal : undefined, cloudModel).generateContent(parts, { signal: ctrl.signal, timeout: limitMs });
          const source: AISource = result.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud';
          let parsed: T | null = null;
          try {
            parsed = req.validate(parseJson(result.response.text()));
          } catch {
            parsed = null;
          }
          return { parsed, source, tokens: result.response.usageMetadata?.totalTokenCount };
        },
        { mode: im },
      );
      void job.catch(() => undefined).finally(() => onDevice && deviceJobs--);
      try {
        // The extra second is a safety net in case something ignores the abort signal.
        return await withTimeout(job, limitMs + 1000);
      } catch (e) {
        if (stop?.aborted) throw new Error('stopped: another engine answered first');
        if (ctrl.signal.aborted || /timeout/i.test(String((e as Error)?.message))) throw new TimedOut(onDevice ? 'device' : 'cloud', limitMs);
        throw e;
      } finally {
        clearTimeout(timer);
        ctrl.abort();
      }
    };
    let overloadRetries = 0;
    /**
     * Cloud answer: the main model, then the fallback model(s) when it is overloaded, does not
     * answer, or has used up its daily quota. A model whose quota is used up is skipped until it
     * resets. An answer that fails ArchiMind's checks gets one more try.
     */
    const cloud = async (stop?: AbortSignal) => {
      const limit = route.timeoutMs ?? CLOUD_LIMIT_MS;
      const main = req.cloudModel || rc('cloud_model') || 'gemini-3.5-flash-lite';
      const chain = [main, ...String(rc('cloud_model_fallback') || '').split(',').map((x) => x.trim())].filter((x, i, all) => x && all.indexOf(x) === i);
      const once = async (): Promise<Attempt> => {
        const ready = chain.filter((x) => !quotaResetsAt(x));
        if (!ready.length) throw new QuotaUsedUp(Math.min(...chain.map(quotaResetsAt)));
        let last: unknown = null;
        let busy: unknown = null;
        for (let i = 0; i < ready.length; i++) {
          const model = ready[i];
          try {
            // fewer tries when another model can take over (an overloaded request can hang for 30 s)
            return await withRetry(() => attempt(InferenceMode.ONLY_IN_CLOUD, limit, stop, model === main ? req.cloudModel : model), () => overloadRetries++, i < ready.length - 1 ? 2 : 3);
          } catch (e) {
            last = e;
            if (stop?.aborted) throw e;
            if (isQuotaError(e)) markQuotaUsed(model, e);
            // (an overloaded model often just doesn't answer, so a timeout counts too)
            else if (!(isTransient(e) || e instanceof TimedOut)) throw e;
            else busy ??= e;
            if (i < ready.length - 1) overloadRetries++;
          }
        }
        const left = chain.filter((x) => !quotaResetsAt(x));
        if (!left.length) throw new QuotaUsedUp(Math.min(...chain.map(quotaResetsAt)));
        // say what stopped the main model (busy) rather than the fallback's quota
        throw busy ?? last;
      };
      const r = await once();
      return r.parsed || stop?.aborted ? r : once();
    };

    let res: Attempt;
    let retried = false;
    let deviceNote: string | undefined;
    if (mode === 'local-only') {
      try {
        res = await attempt(InferenceMode.ONLY_ON_DEVICE, Math.max(PRIVATE_LIMIT_MS, route.timeoutMs ?? 0));
      } catch (e) {
        log({ requestType: req.type, label: route.label, inferenceMode, source: 'blocked', latencyMs: Math.round(performance.now() - started), promptChars: req.prompt.length, validated: false, note: (e as Error).message });
        throw new LocalModelUnavailable();
      }
    } else if (deviceReady(req.type, mode)) {
      // Quick task: Gemini Nano gets a head start. If it hasn't given a good answer by then, the
      // cloud starts as well and whichever answers well first is used; the other one is stopped.
      const devStop = new AbortController();
      const cloudStop = new AbortController();
      const dev = attempt(InferenceMode.PREFER_ON_DEVICE, DEVICE_LIMIT_MS, devStop.signal);
      const early = await Promise.race([dev.then((r) => ({ ok: r }), (e: Error) => ({ err: e })), sleep(HEAD_START_MS)]);
      if (early && 'ok' in early && early.ok.parsed) {
        res = early.ok;
      } else {
        retried = true;
        const stillRunning = early === null;
        try {
          res = await firstValid(stillRunning ? [cloud(cloudStop.signal), dev] : [cloud(cloudStop.signal)]);
        } finally {
          devStop.abort();
          cloudStop.abort();
        }
        if (res.source === 'on_device') deviceNote = 'On-device AI answered (the cloud was started as a backup).';
        else if (stillRunning) {
          markDeviceSlow();
          deviceNote = 'On-device AI was slow, so the cloud answered.';
        } else if (early && 'err' in early) deviceNote = `On-device AI failed (${early.err.message}), so the cloud answered.`;
        else deviceNote = 'The on-device answer didn’t pass checks, so the cloud answered.';
      }
    } else {
      // Cloud only: if it fails, the real reason is logged instead of quietly waiting on the device.
      res = await cloud();
    }

    const latencyMs = Math.round(performance.now() - started);
    if (!res.parsed) {
      const data = req.heuristic();
      log({ requestType: req.type, label: route.label, inferenceMode, source: 'heuristic', latencyMs, promptChars: req.prompt.length, validated: false, retriedInCloud: retried, tokens: res.tokens, note: 'Model output failed validation; used deterministic fallback.' });
      return { data, source: 'heuristic', latencyMs, validated: false, note: 'fallback' };
    }
    log({ requestType: req.type, label: route.label, inferenceMode, source: res.source, latencyMs, promptChars: req.prompt.length, validated: true, retriedInCloud: retried, tokens: res.tokens, note: [deviceNote, overloadRetries ? `succeeded after ${overloadRetries} retr${overloadRetries === 1 ? 'y' : 'ies'} (model busy)` : ''].filter(Boolean).join(' ') || undefined });
    return { data: res.parsed, source: res.source, latencyMs, validated: true };
  } catch (e) {
    if (e instanceof LocalModelUnavailable) throw e;
    const data = req.heuristic();
    const latencyMs = Math.round(performance.now() - started);
    let note = (e as Error).message;
    if (e instanceof TimedOut || /401|app ?check|fetch/i.test(note)) {
      const ac = await appCheckProblem();
      if (ac) note = `${ac} (${note})`;
    }
    log({ requestType: req.type, label: route.label, inferenceMode: inferenceModeFor(req.type, mode), source: 'error', latencyMs, promptChars: req.prompt.length, validated: false, note });
    return { data, source: 'heuristic', latencyMs, validated: false, note };
  } finally {
    setBusy(req.type, false);
  }
}

/**
 * Streamed free-text request (generateContentStream works on device and in the cloud).
 * `onText` receives the accumulated text as tokens arrive.
 */
export async function runAIStream(req: { type: RequestType; system: string; prompt: string; heuristic: () => string }, onText: (text: string) => void): Promise<{ text: string; source: AISource; latencyMs: number }> {
  const { mode, setBusy } = useAI.getState();
  const route = ROUTES[req.type];
  const started = performance.now();
  setBusy(req.type, true);
  const fakeStream = async (full: string) => {
    const words = full.split(/(\s+)/);
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      acc += words[i];
      if (i % 6 === 0) {
        onText(acc);
        await new Promise((r) => setTimeout(r, 18));
      }
    }
    onText(full);
  };
  try {
    if (!firebaseConfigured || !rc('stream_rationale')) {
      const text = req.heuristic();
      await fakeStream(text);
      const latencyMs = Math.round(performance.now() - started);
      log({ requestType: req.type, label: route.label, inferenceMode: firebaseConfigured ? 'disabled by Remote Config' : 'demo (no Firebase config)', source: 'heuristic', latencyMs, promptChars: req.prompt.length, validated: true, note: 'Deterministic draft (typed out locally).' });
      return { text, source: 'heuristic', latencyMs };
    }
    const inferenceMode = inferenceModeFor(req.type, mode);
    /** Stream from one engine; stop if the first words take too long or the whole answer runs past 60 s. */
    const streamFrom = (im: InferenceMode, firstWordsMs: number) =>
      traced(`ai_${req.type.replace('.', '_')}`, async () => {
        const onDevice = im !== InferenceMode.ONLY_IN_CLOUD;
        const ctrl = new AbortController();
        let timer = setTimeout(() => ctrl.abort(), firstWordsMs);
        if (onDevice) deviceJobs++;
        try {
          const result = await withRetry(() => modelFor(req.type, req.system, null, im, onDevice ? ctrl.signal : undefined).generateContentStream(req.prompt, { signal: ctrl.signal }));
          let acc = '';
          for await (const chunk of result.stream) {
            if (!acc) {
              clearTimeout(timer);
              timer = setTimeout(() => ctrl.abort(), 60_000);
            }
            acc += chunk.text();
            onText(acc);
          }
          const final = await result.response;
          return { text: acc, source: (final.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud') as AISource, tokens: final.usageMetadata?.totalTokenCount };
        } catch (e) {
          if (ctrl.signal.aborted) throw new TimedOut(onDevice ? 'device' : 'cloud', firstWordsMs);
          throw e;
        } finally {
          clearTimeout(timer);
          ctrl.abort();
          if (onDevice) deviceJobs--;
        }
      });
    try {
      let out: { text: string; source: AISource; tokens?: number };
      if (mode === 'local-only') out = await streamFrom(InferenceMode.ONLY_ON_DEVICE, PRIVATE_LIMIT_MS);
      else if (deviceReady(req.type, mode)) {
        try {
          out = await streamFrom(InferenceMode.PREFER_ON_DEVICE, HEAD_START_MS);
        } catch (e) {
          if (e instanceof TimedOut) markDeviceSlow();
          onText('');
          out = await streamFrom(InferenceMode.ONLY_IN_CLOUD, CLOUD_LIMIT_MS);
        }
      } else out = await streamFrom(InferenceMode.ONLY_IN_CLOUD, CLOUD_LIMIT_MS);
      const latencyMs = Math.round(performance.now() - started);
      log({ requestType: req.type, label: route.label, inferenceMode, source: out.source, latencyMs, promptChars: req.prompt.length, validated: out.text.trim().length > 0, tokens: out.tokens, note: 'streamed' });
      return { text: out.text, source: out.source, latencyMs };
    } catch (e) {
      if (mode === 'local-only') {
        log({ requestType: req.type, label: route.label, inferenceMode, source: 'blocked', latencyMs: Math.round(performance.now() - started), promptChars: req.prompt.length, validated: false, note: (e as Error).message });
        throw new LocalModelUnavailable();
      }
      const text = req.heuristic();
      await fakeStream(text);
      const latencyMs = Math.round(performance.now() - started);
      log({ requestType: req.type, label: route.label, inferenceMode, source: 'error', latencyMs, promptChars: req.prompt.length, validated: false, note: (e as Error).message });
      return { text, source: 'heuristic', latencyMs };
    }
  } finally {
    setBusy(req.type, false);
  }
}

// ---------------------------------------------------------------------------
// On-device setup check
// ---------------------------------------------------------------------------

interface ChromeLanguageModel {
  availability: (opts?: unknown) => Promise<string>;
  create: (opts?: unknown) => Promise<{ destroy: () => void }>;
}
const LM = () => (globalThis as unknown as { LanguageModel?: ChromeLanguageModel }).LanguageModel;

export async function checkDevice(): Promise<DeviceStatus> {
  const api = LM();
  if (!api?.availability) {
    useAI.getState().setDevice('unsupported');
    return 'unsupported';
  }
  try {
    const s = (await api.availability({ expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] })) as DeviceStatus;
    const status: DeviceStatus = ['available', 'downloadable', 'downloading', 'unavailable'].includes(s) ? s : 'unavailable';
    useAI.getState().setDevice(status);
    return status;
  } catch {
    useAI.getState().setDevice('unavailable');
    return 'unavailable';
  }
}

/** Must be called from a user gesture. Uses the SDK's initializeDeviceModel when Firebase is configured. */
export async function downloadDeviceModel() {
  const { setProgress, setDevice } = useAI.getState();
  setProgress(0);
  setDevice('downloading');
  try {
    if (firebaseConfigured) {
      await modelFor('element.explain', 'You are ArchiMind.', null, InferenceMode.PREFER_ON_DEVICE).initializeDeviceModel((p) => setProgress(p));
    } else {
      const api = LM();
      if (!api) throw new Error('Prompt API unavailable');
      const s = await api.create({
        monitor: (mon: { addEventListener: (t: string, cb: (e: { loaded: number }) => void) => void }) => mon.addEventListener('downloadprogress', (e) => setProgress(e.loaded)),
      });
      s.destroy();
    }
    setProgress(1);
    track('device_model_ready');
  } finally {
    await checkDevice();
    setTimeout(() => setProgress(null), 1500);
  }
}

export const sourceLabel = (s: AISource | 'blocked' | 'error') =>
  s === 'on_device' ? 'On device' : s === 'in_cloud' ? 'Cloud' : s === 'blocked' ? 'Blocked (local only)' : s === 'error' ? 'Error → fallback' : 'Heuristic';
