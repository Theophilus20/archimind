import { useState } from 'react';
import { useAI, type AIMode, type AILogEntry } from '../ai/log';
import { ROUTES, checkDevice, downloadDeviceModel, inferenceModeFor, type RequestType } from '../ai/hybrid';
import { explainElement, translateMessage } from '../ai/requests';
import { useStudio } from '../state/store';
import { Icon, PageHeader, SourceChip, Spinner, timeAgo, useNow } from '../ui/common';
import { appCheckEnabled, firebaseConfigured, RC_DEFAULTS, getFirebase, usePlatform } from '../firebase/config';
import { useAuth } from '../firebase/auth';
import { useRoute } from '../ui/router';
import { useDevMode } from '../ui/hooks';
import { FirebaseServices, TeamTelemetry } from './FirebaseServices';

type Tab = 'activity' | 'settings' | 'device' | 'firebase';

const MODES: { id: AIMode; title: string; icon: string; text: string }[] = [
  { id: 'auto', title: 'Balanced (recommended)', icon: 'device_hub', text: 'Quick tasks run privately on this computer when it can. Bigger tasks, like a full design review, use Google’s cloud AI.' },
  { id: 'local-only', title: 'Private', icon: 'lock', text: 'Everything stays on this computer. If the on-device AI isn’t available, ArchiMind tells you instead of sending your work anywhere.' },
  { id: 'cloud-first', title: 'Cloud', icon: 'cloud', text: 'Use Google’s cloud AI for everything. Good for computers without on-device AI.' },
];

/** Plain-language explanation of what happened to a request. */
function friendlyNote(e: AILogEntry) {
  const n = e.note ?? '';
  if (e.source === 'blocked') return 'The on-device AI isn’t available, so nothing was sent (Private mode).';
  if ((e.source === 'in_cloud' || e.source === 'on_device') && /answered/.test(n)) return n.replace(/\s*\(.*?\)/, '');
  if (/daily AI limit|exceeded your current quota|PerDay|free_tier_requests/i.test(n)) {
    const h = n.match(/about (\d+) h/)?.[1];
    return `The project’s free daily AI limit is used up${h ? ` (it resets in about ${h} hours)` : ''}, so ArchiMind used its built-in answer. Turning on billing for the Firebase project lifts the limit.`;
  }
  if (/high demand|overloaded|\b(500|503|429)\b|RESOURCE_EXHAUSTED/i.test(n)) return 'Google’s AI was busy, so ArchiMind used its built-in answer.';
  if (/app ?check|\b401\b/i.test(n)) return 'The security check (App Check) didn’t pass, so the request wasn’t sent. Reloading the page usually fixes it.';
  if (/\b403\b|PERMISSION_DENIED|API_NOT_ENABLED|has not been used/i.test(n)) return 'Google’s AI turned the request down for this project, so a built-in answer was used.';
  if (/\b404\b|not found/i.test(n)) return 'The cloud AI model wasn’t found, so a built-in answer was used.';
  const t = n.match(/(on-device|cloud) AI gave no answer within (\d+) s/);
  if (t) return `The ${t[1]} AI gave no answer within ${t[2]} s, so ArchiMind used its built-in answer.`;
  if (/timeout/i.test(n)) return 'The AI took too long, so ArchiMind used its built-in answer.';
  if (/failed to fetch|network|offline/i.test(n)) return 'Google’s AI couldn’t be reached (check the connection), so a built-in answer was used.';
  if (/demo/i.test(e.inferenceMode)) return 'Built-in answer (AI not connected).';
  if (/validation/i.test(n)) return 'The AI answer didn’t pass ArchiMind’s checks, so a built-in answer was used.';
  if (/retr/i.test(n)) return 'Succeeded after a short retry.';
  if (e.source === 'error') return 'The AI service couldn’t be reached, so a built-in answer was used.';
  return '';
}

export function AILogicPage() {
  const { params } = useRoute();
  const dev = useDevMode((s) => s.on);
  const [tab, setTab] = useState<Tab>(((params.get('tab') as Tab) || 'activity') as Tab);
  const tabs: [Tab, string, string][] = [
    ['activity', 'history', 'Activity'],
    ['settings', 'tune', 'Privacy & speed'],
    ['device', 'laptop_chromebook', 'On-device AI'],
    ...(dev ? ([['firebase', 'local_fire_department', 'Firebase (developer)']] as [Tab, string, string][]) : []),
  ];
  return (
    <>
      <PageHeader
        title="AI assistant"
        icon="auto_awesome"
        subtitle="ArchiMind’s AI runs on your computer when it can and in Google’s cloud when it needs to. Choose how private you want it to be."
        tabs={
          <>
            {tabs.map(([t, icon, label]) => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                <Icon name={icon} /> {label}
              </button>
            ))}
          </>
        }
      />
      <div className="page-inner">
        {tab === 'activity' && <Activity />}
        {tab === 'settings' && <Settings />}
        {tab === 'device' && <Device />}
        {tab === 'firebase' && dev && <FirebaseServices />}
      </div>
    </>
  );
}

function Activity() {
  const log = useAI((s) => s.log);
  const clear = useAI((s) => s.clear);
  const project = useStudio((s) => s.project);
  const dev = useDevMode((s) => s.on);
  const now = useNow(10000);
  const [busy, setBusy] = useState<string | null>(null);
  const count = (src: string[]) => log.filter((l) => src.includes(l.source)).length;
  const tryIt = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k);
    try {
      await fn();
    } catch {
      /* shown in the list */
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="grid grid-3 stats-grid">
        <div className="card stat">
          <div className="k">
            <SourceChip source="on_device" compact /> On this computer
          </div>
          <div className="v">{count(['on_device'])}</div>
          <div className="d">private, fast, works offline</div>
        </div>
        <div className="card stat">
          <div className="k">
            <SourceChip source="in_cloud" compact /> Google cloud
          </div>
          <div className="v">{count(['in_cloud'])}</div>
          <div className="d">for bigger tasks</div>
        </div>
        <div className="card stat">
          <div className="k">
            <SourceChip source="heuristic" compact /> Built-in answers
          </div>
          <div className="v">{count(['heuristic', 'error', 'blocked'])}</div>
          <div className="d">when AI wasn’t available</div>
        </div>
      </div>

      <TeamTelemetry />

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h2>Try it</h2>
          <span className="sub">see where each request runs</span>
        </div>
        <div className="card-body row wrap">
          <button className="btn btn-outline" disabled={!!busy} onClick={() => tryIt('explain', () => explainElement(project.model, project.brief, project.findings, project.model.rooms[0]?.id ?? 'R1'))}>
            {busy === 'explain' ? <Spinner /> : <Icon name="help" />} Explain {project.model.rooms[0]?.name ?? 'a room'}
          </button>
          <button className="btn btn-outline" disabled={!!busy} onClick={() => tryIt('translate', () => translateMessage(project.model, 'Re-hang D1 off the hall to improve circulation and zoning; the door swing currently clashes with the threshold.', 'client'))}>
            {busy === 'translate' ? <Spinner /> : <Icon name="translate" />} Rewrite a message in plain language
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header">
          <h2>Recent activity</h2>
          <span className="sub">{log.length ? `${log.length} this session` : ''}</span>
          <div className="grow" />
          <button className="btn btn-text btn-sm" onClick={clear} disabled={!log.length}>
            Clear
          </button>
        </div>
        {log.length === 0 ? (
          <div className="empty">
            <Icon name="query_stats" />
            Nothing yet. Explain a room, summarise the brief, suggest a roof or write crit minutes.
          </div>
        ) : (
          <div>
            {log.map((l) => (
              <div key={l.id} className="row" style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-2)', alignItems: 'flex-start', gap: 12 }}>
                <SourceChip source={l.source} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{ROUTES[l.requestType as RequestType]?.label ?? l.label}</div>
                  <div className="small muted" title={l.source === 'error' ? l.note : undefined}>
                    {timeAgo(l.at, now)} · {(l.latencyMs / 1000).toFixed(1)} s{friendlyNote(l) ? ` · ${friendlyNote(l)}` : ''}
                  </div>
                  {dev && (
                    <div className="small faint" style={{ fontFamily: 'var(--mono)', marginTop: 2, wordBreak: 'break-word' }}>
                      {l.requestType} · {l.inferenceMode} · {l.promptChars} chars{l.tokens ? ` · ${l.tokens} tokens` : ''} · {l.validated ? 'valid' : 'invalid'}
                      {l.note ? ` · ${l.note}` : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Settings() {
  const mode = useAI((s) => s.mode);
  const setMode = useAI((s) => s.setMode);
  const dev = useDevMode((s) => s.on);
  return (
    <>
      <div className="grid grid-3">
        {MODES.map((m) => (
          <button key={m.id} className="card card-pad card-link" onClick={() => setMode(m.id)} style={{ textAlign: 'left', borderColor: mode === m.id ? 'var(--blue)' : undefined, boxShadow: mode === m.id ? 'inset 0 0 0 1px var(--blue)' : undefined, background: mode === m.id ? 'var(--blue-50)' : undefined }}>
            <div className="row" style={{ marginBottom: 8 }}>
              <Icon name={m.icon} style={{ color: mode === m.id ? 'var(--blue)' : 'var(--text-2)' }} />
              <b className="grow">{m.title}</b>
              {mode === m.id && <Icon name="radio_button_checked" style={{ color: 'var(--blue)' }} />}
            </div>
            <div className="small muted">{m.text}</div>
          </button>
        ))}
      </div>
      <div className="card card-pad small muted" style={{ marginTop: 16, lineHeight: 1.6 }}>
        Measurements, room areas, door clearances and your schedule are always worked out by ArchiMind itself, never guessed by AI. AI suggestions are checked before you see them, and any change to your plan is only made after you preview and accept it.
      </div>
      {dev && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h2>Request routing</h2>
            <span className="sub">developer</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Request type</th>
                <th>Purpose</th>
                <th>Default</th>
                <th>Inference mode now</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(ROUTES) as RequestType[]).map((t) => (
                <tr key={t}>
                  <td>
                    <code>{t}</code>
                  </td>
                  <td>{ROUTES[t].label}</td>
                  <td>{ROUTES[t].prefer === 'device' ? 'on device' : 'cloud'}</td>
                  <td>
                    <code>{inferenceModeFor(t, mode)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Device() {
  const device = useAI((s) => s.device);
  const progress = useAI((s) => s.downloadProgress);
  const dev = useDevMode((s) => s.on);
  const user = useAuth((s) => s.user);
  const rcValues = usePlatform((s) => s.rc);
  const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
  const chromeVersion = chromeMatch ? Number(chromeMatch[1]) : 0;
  const status: Record<string, { ok: boolean | null; text: string }> = {
    available: { ok: true, text: 'Ready. Quick AI tasks run privately on this computer.' },
    downloadable: { ok: null, text: 'Supported. Download the model once to use it.' },
    downloading: { ok: null, text: 'Downloading the model…' },
    unavailable: { ok: false, text: 'Not available on this computer. ArchiMind will use the cloud instead.' },
    unsupported: { ok: false, text: 'Not switched on in this browser yet (see the steps below).' },
    checking: { ok: null, text: 'Checking…' },
  };
  const s = status[device] ?? status.checking;
  const rows: { ok: boolean | null; title: string; detail: string }[] = [
    { ok: chromeVersion >= 139, title: 'Google Chrome on a computer', detail: chromeVersion ? `Chrome ${chromeVersion}${chromeVersion < 139 ? ' (please update to 139 or newer)' : ''}` : 'Open ArchiMind in Google Chrome on a desktop or laptop.' },
    { ok: s.ok, title: 'On-device AI (Gemini Nano)', detail: s.text },
  ];
  if (dev) {
    rows.push(
      { ok: firebaseConfigured, title: 'Firebase project', detail: firebaseConfigured ? 'Connected' : 'Not configured (demo mode)' },
      { ok: appCheckEnabled(), title: 'App Check', detail: appCheckEnabled() ? 'reCAPTCHA Enterprise' : 'Not configured' },
      { ok: Boolean(user), title: 'Authentication', detail: user ? (user.isAnonymous ? 'Guest' : 'Google') : 'Not signed in' },
    );
  }
  return (
    <>
      <div className="card">
        {rows.map((r) => (
          <div key={r.title} className="row" style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-2)', alignItems: 'flex-start' }}>
            <Icon name={r.ok ? 'check_circle' : r.ok === null ? 'pending' : 'info'} fill style={{ color: r.ok ? 'var(--green)' : r.ok === null ? 'var(--warn)' : 'var(--text-3)' }} />
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{r.title}</div>
              <div className="small muted">{r.detail}</div>
            </div>
          </div>
        ))}
        <div className="row wrap" style={{ padding: '14px 20px' }}>
          <button className="btn btn-primary" onClick={() => downloadDeviceModel().catch(() => undefined)} disabled={device === 'available' || device === 'unsupported' || device === 'unavailable' || progress !== null}>
            <Icon name="download" /> {device === 'available' ? 'On-device AI is ready' : 'Download on-device AI'}
          </button>
          <button className="btn btn-outline" onClick={() => checkDevice()}>
            <Icon name="refresh" /> Check again
          </button>
          {progress !== null && (
            <div className="grow row">
              <div className="meter grow">
                <span style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="small">{Math.round(progress * 100)}%</span>
            </div>
          )}
        </div>
      </div>
      {device === 'unsupported' && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Turn on on-device AI in Chrome</div>
          <ol className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Make sure Chrome is version 139 or newer (Settings, About Chrome).</li>
            <li>
              Open <code>chrome://flags/#prompt-api-for-gemini-nano-multimodal-input</code> and set it to Enabled.
            </li>
            <li>Restart Chrome, come back here and press Download on-device AI.</li>
          </ol>
        </div>
      )}
      {dev && getFirebase() && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h2>Remote Config</h2>
            <span className="sub">developer</span>
          </div>
          <table className="table">
            <tbody>
              {(Object.keys(RC_DEFAULTS) as (keyof typeof RC_DEFAULTS)[]).map((k) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{String(rcValues[k] === '' ? '(default)' : rcValues[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
