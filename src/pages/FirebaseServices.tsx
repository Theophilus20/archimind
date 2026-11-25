import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { fetchAndActivate } from 'firebase/remote-config';
import { useStudio } from '../state/store';
import { useAuth } from '../firebase/auth';
import { appCheckEnabled, firebaseConfig, firebaseConfigured, getFirebase, telemetryState, usePlatform } from '../firebase/config';
import { Icon, timeAgo } from '../ui/common';

/** Team-wide hybrid telemetry from Firestore (metadata only), across every collaborator's device. */
export function TeamTelemetry() {
  const project = useStudio((s) => s.project);
  const user = useAuth((s) => s.user);
  const [events, setEvents] = useState<{ source: string; latencyMs: number; requestType: string; uid: string }[] | null>(null);
  useEffect(() => {
    const fb = getFirebase();
    if (!fb || !user) return;
    const q = query(collection(fb.db, 'projects', project.id, 'aiEvents'), orderBy('at', 'desc'), limit(300));
    // The project document may not exist yet on first load; a failed listener is retried.
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const start = () => {
      unsub = onSnapshot(
        q,
        (snap) => setEvents(snap.docs.map((d) => d.data() as { source: string; latencyMs: number; requestType: string; uid: string })),
        () => {
          setEvents((e) => e ?? []);
          if (tries++ < 10) timer = setTimeout(start, Math.min(15000, 1500 * tries));
        },
      );
    };
    start();
    return () => {
      clearTimeout(timer);
      unsub?.();
    };
  }, [project.id, user]);
  if (!firebaseConfigured) return null;
  const list = events ?? [];
  const dev = list.filter((e) => e.source === 'on_device').length;
  const cloud = list.filter((e) => e.source === 'in_cloud').length;
  const total = Math.max(1, dev + cloud);
  const people = new Set(list.map((e) => e.uid)).size;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <Icon name="groups" />
        <h2>Your team</h2>
        <span className="sub">
          {list.length} AI request{list.length === 1 ? '' : 's'} by {people} {people === 1 ? 'person' : 'people'} on this project
        </span>
      </div>
      <div className="card-body">
        {events === null ? (
          <div className="skeleton" style={{ height: 18 }} />
        ) : (
          <>
            <div style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', background: 'var(--surface-2)' }}>
              <span style={{ width: `${(dev / total) * 100}%`, background: 'var(--device)' }} title={`On device: ${dev}`} />
              <span style={{ width: `${(cloud / total) * 100}%`, background: 'var(--cloud)' }} title={`Cloud: ${cloud}`} />
            </div>
            <div className="row wrap small muted" style={{ marginTop: 8, gap: 14 }}>
              <span>
                <span className="dot" style={{ background: 'var(--device)' }} /> {Math.round((dev / total) * 100)}% on people’s own computers (private, free, works offline)
              </span>
              <span>
                <span className="dot" style={{ background: 'var(--cloud)' }} /> {Math.round((cloud / total) * 100)}% in Google’s cloud
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function FirebaseServices() {
  const user = useAuth((s) => s.user);
  const authError = useAuth((s) => s.error);
  const platform = usePlatform();
  const project = useStudio((s) => s.project);
  const toast = useStudio((s) => s.toast);
  const fb = getFirebase();
  const hosted = location.hostname.endsWith('.web.app') || location.hostname.endsWith('.firebaseapp.com');
  const services: { icon: string; name: string; on: boolean; status: string; uses: string[] }[] = [
    {
      icon: 'auto_awesome',
      name: 'Firebase AI Logic (hybrid)',
      on: firebaseConfigured,
      status: firebaseConfigured ? 'Gemini Developer API · Gemini Nano via the Chrome Prompt API' : 'Demo mode: labelled heuristic fallbacks',
      uses: [
        '9 bounded request types, each with a JSON schema (responseConstraint / responseJsonSchema)',
        'PREFER_ON_DEVICE with a 15 s limit and a cancellable Chrome session, then ONLY_IN_CLOUD; ONLY_ON_DEVICE in Private mode',
        'generateContentStream for the streamed design rationale',
        'Image input to read room labels from uploaded drawings',
        'inferenceSource and usageMetadata recorded for every request',
      ],
    },
    {
      icon: 'verified_user',
      name: 'App Check',
      on: appCheckEnabled(),
      status: appCheckEnabled() ? 'reCAPTCHA Enterprise · auto-refresh' : 'Not configured: needs a reCAPTCHA Enterprise site key',
      uses: ['Protects AI Logic, Firestore and Storage', 'AI requests carry cached App Check tokens; single-use tokens can be switched on with Remote Config', 'Debug token for local development'],
    },
    {
      icon: 'person',
      name: 'Authentication',
      on: Boolean(user),
      status: user ? `${user.isAnonymous ? 'Anonymous guest' : 'Google'} · uid ${user.uid.slice(0, 8)}…` : firebaseConfigured ? (authError ? `Retrying sign-in (${authError})` : 'Connecting…') : 'Demo identity',
      uses: ['Anonymous sign-in so the crit room works instantly', 'Google sign-in links the guest account and keeps its work', 'The uid drives membership, presence and authorship'],
    },
    {
      icon: 'database',
      name: 'Cloud Firestore',
      on: Boolean(fb),
      status: fb ? `projects/${project.id}${fb.offlineCache ? ' · persistent multi-tab offline cache' : ''}` : 'Demo mode: browser storage',
      uses: ['Real-time project sync (model, findings, tasks)', 'Revision snapshots in a subcollection', 'Crit messages, presence and live camera follow', 'Role-scoped invites enforced by security rules', 'Team-wide AI telemetry (aiEvents)'],
    },
    {
      icon: 'folder_open',
      name: 'Cloud Storage',
      on: Boolean(fb?.storage),
      status: fb?.storage ? `gs://${firebaseConfig.storageBucket}` : 'Demo mode: inline data',
      uses: ['Source drawings (PNG, JPEG, SVG, PDF)', 'Crit-room view snapshots', 'GLB exports with shareable links', 'Member-only access through rules that read Firestore'],
    },
    {
      icon: 'tune',
      name: 'Remote Config',
      on: Boolean(fb),
      status: fb ? `${platform.rcSource} values${platform.rcFetchedAt ? ` · updated ${timeAgo(platform.rcFetchedAt)}` : ''} · real-time listener` : 'Using defaults',
      uses: ['cloud_model: switch the Gemini model without a release', 'enable_cloud_review, on_device_first, stream_rationale', 'max_plan_px processing limit', 'announcement banner pushed live to open sessions'],
    },
    {
      icon: 'insights',
      name: 'Google Analytics',
      on: telemetryState.analytics,
      status: telemetryState.analytics ? 'Collecting product events' : firebaseConfig.measurementId ? 'Loading…' : 'Not configured: needs a measurement ID',
      uses: ['ai_inference (request type, source, latency)', 'plan_detected, plan_imported, revision_accepted', 'crit_message_sent, invite_created, model_exported'],
    },
    {
      icon: 'speed',
      name: 'Performance Monitoring',
      on: telemetryState.performance,
      status: telemetryState.performance ? 'Custom traces active' : 'Off',
      uses: ['ai_* traces per request type and inference mode', 'plan_detect trace around the Web Worker detector', 'storage_upload traces'],
    },
    {
      icon: 'public',
      name: 'Hosting',
      on: hosted,
      status: hosted ? location.hostname : 'firebase deploy --only hosting',
      uses: ['SPA rewrites and immutable asset caching (firebase.json)'],
    },
  ];
  return (
    <>
      <div className="grid grid-3">
        {services.map((sv) => (
          <div key={sv.name} className="card">
            <div className="card-header" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <span className="sev" style={{ width: 36, height: 36, background: sv.on ? 'var(--green-50)' : 'var(--surface-2)', color: sv.on ? 'var(--green)' : 'var(--text-3)' }}>
                <Icon name={sv.icon} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{sv.name}</div>
                <div className="small muted" style={{ wordBreak: 'break-word' }}>
                  {sv.status}
                </div>
              </div>
              <span className={`chip ${sv.on ? 'ok' : ''}`}>{sv.on ? 'active' : 'off'}</span>
            </div>
            <div className="card-body">
              <ul className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-2)' }}>
                {sv.uses.map((u) => (
                  <li key={u} style={{ marginBottom: 3 }}>
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
      {fb && (
        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="btn btn-outline"
            onClick={async () => {
              try {
                await fetchAndActivate(fb.remoteConfig);
                toast('Remote Config fetched', 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            <Icon name="sync" /> Fetch Remote Config now
          </button>
        </div>
      )}
    </>
  );
}
