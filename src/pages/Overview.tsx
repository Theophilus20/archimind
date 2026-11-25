import { useMemo } from 'react';
import { allRooms } from '../model/levels';
import { useStudio } from '../state/store';
import { useAI } from '../ai/log';
import { useCollab } from '../collab/collab';
import { derive } from '../model/derive';
import { schedule } from '../schedule/scheduler';
import { Plan2D } from '../studio/Plan2D';
import { Icon, SourceChip, fmtDate, timeAgo, useNow } from '../ui/common';
import { IsoPreview } from '../ui/IsoPreview';
import { navigate, type Route } from '../ui/router';
import { firebaseConfigured, appCheckEnabled, getFirebase, telemetryState, usePlatform } from '../firebase/config';
import { useAuth } from '../firebase/auth';
import { useDevMode } from '../ui/hooks';

export function Overview() {
  const project = useStudio((s) => s.project);
  const resetDemo = useStudio((s) => s.resetDemo);
  const device = useAI((s) => s.device);
  const log = useAI((s) => s.log);
  const messages = useCollab((s) => s.messages);
  const presence = useCollab((s) => s.presence);
  const dev = useDevMode((s) => s.on);
  const now = useNow();
  const { brief, model, findings } = project;
  const d = derive(model);
  const sched = useMemo(() => schedule(project.tasks, brief), [project.tasks, brief]);
  const daysLeft = Math.ceil((Date.parse(brief.deadline) - Date.now()) / 86400000);
  const open = findings.filter((f) => f.status === 'open');
  const resolved = findings.filter((f) => f.status === 'resolved').length;
  const reqTotal = brief.requirements.reduce((s, q) => s + q.count, 0);
  const reqOk = brief.requirements.reduce((s, q) => s + Math.min(q.count, allRooms(project.model).filter((r) => (r.type === q.type || (q.type === 'kitchen' && r.type === 'dining')) && r.area >= q.minArea).length), 0);
  const onDevice = log.filter((l) => l.source === 'on_device').length;
  const inCloud = log.filter((l) => l.source === 'in_cloud').length;
  const unresolved = messages.filter((m) => m.kind === 'text' && m.anchor && !m.resolved).length;

  const steps: { route: Route; icon: string; title: string; text: string; done: boolean }[] = [
    { route: 'brief', icon: 'assignment', title: 'Brief', text: reqTotal ? `${reqTotal} required spaces · ${brief.goals.join(', ') || 'no goals yet'}` : 'Add required spaces and goals', done: brief.requirements.length > 0 },
    { route: 'import', icon: 'document_scanner', title: 'Plan → model', text: model.walls.length ? (model.source ? `From ${model.source.name}` : `${model.walls.length} walls · ${d.rooms.length} rooms`) : 'Upload a floor plan', done: model.walls.length > 0 },
    { route: 'studio', icon: 'view_in_ar', title: 'Explore in 3D', text: 'Walk through, cut sections, move the sun', done: project.revisions.length > 1 },
    { route: 'review', icon: 'rule', title: 'Evidence-linked review', text: `${open.length} open · ${resolved} resolved`, done: resolved > 0 },
    { route: 'crit', icon: 'forum', title: 'Crit room', text: `${messages.length} messages · ${unresolved} open pins`, done: messages.length > 0 },
    { route: 'schedule', icon: 'event_note', title: 'Schedule', text: `Finish ${fmtDate(sched.projectedFinish)}`, done: project.tasks.some((t) => t.origin === 'revision') },
  ];

  const activity = [
    ...project.revisions.map((r) => ({ at: r.createdAt, icon: 'history', text: `Revision ${r.number}: ${r.label}`, who: r.author || 'ArchiMind' })),
    ...messages.slice(-8).map((m) => ({ at: m.createdAt, icon: m.kind === 'minutes' ? 'summarize' : 'chat', text: m.text, who: m.authorName })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);

  const ghostBtn = { background: 'rgba(255,255,255,0.04)', color: '#fff', borderColor: 'rgba(255,255,255,.35)' };

  return (
    <div className="page-inner">
      <div className="hero">
        <div className="copy">
          <div className="row wrap" style={{ gap: 8, marginBottom: 14 }}>
            <span className="pill">
              <Icon name="laptop_chromebook" size={14} /> ON DEVICE{device === 'available' ? ' · READY' : ''}
            </span>
            <span className="pill amber">
              <Icon name="local_fire_department" size={14} /> FIREBASE AI LOGIC
            </span>
            <span className="pill">
              <Icon name="cloud" size={14} /> CLOUD
            </span>
          </div>
          <h1>{project.name}</h1>
          <p style={{ margin: '6px 0 18px' }}>
            {brief.title}. {brief.occupants} Due {fmtDate(brief.deadline)}, {daysLeft >= 0 ? `${daysLeft} days left` : `${-daysLeft} days overdue`}.
          </p>
          <div className="row wrap">
            <button className="btn btn-amber" onClick={() => navigate('studio')}>
              <Icon name="view_in_ar" /> Open studio
            </button>
            <button className="btn btn-outline" style={ghostBtn} onClick={() => navigate('import')}>
              <Icon name="upload_file" /> Import a plan
            </button>
            <button className="btn btn-outline" style={ghostBtn} onClick={() => navigate('crit')}>
              <Icon name="forum" /> Start a crit
            </button>
            {/* only on the sample house (a first project of your own starts empty and has nothing to reset) */}
            {project.id.startsWith('demo') && project.model.id === 'family-home' && (
              <button className="btn btn-text" style={{ color: '#8ab4f8' }} onClick={resetDemo}>
                <Icon name="restart_alt" /> Reset demo
              </button>
            )}
          </div>
        </div>
        <IsoPreview model={model} className="iso-preview" />
      </div>

      <div className="grid grid-4 stats-grid" style={{ marginTop: 16 }}>
        <div className="card stat card-link" onClick={() => navigate('brief')}>
          <div className="k">
            <Icon name="checklist" size={18} /> Brief fit
          </div>
          <div className="v">
            {reqOk}/{reqTotal}
          </div>
          <div className="meter" style={{ margin: '6px 0' }}>
            <span style={{ width: `${(reqOk / Math.max(1, reqTotal)) * 100}%`, background: reqOk === reqTotal && reqTotal ? 'var(--green)' : undefined }} />
          </div>
          <div className="d">spaces at target size</div>
        </div>
        <div className="card stat card-link" onClick={() => navigate('review')}>
          <div className="k">
            <Icon name="rule" size={18} /> Open findings
          </div>
          <div className="v">{open.length}</div>
          <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
            {(['critical', 'warning', 'advice'] as const).map((s) => {
              const n = open.filter((f) => f.severity === s).length;
              return n ? (
                <span key={s} className={`chip ${s === 'critical' ? 'error' : s === 'warning' ? 'warn' : 'blue'}`}>
                  {n} {s}
                </span>
              ) : null;
            })}
          </div>
        </div>
        <div className="card stat card-link" onClick={() => navigate('schedule')}>
          <div className="k">
            <Icon name="event_available" size={18} /> Projected finish
          </div>
          <div className="v" style={{ color: sched.overrunDays ? 'var(--red)' : undefined }}>
            {fmtDate(sched.projectedFinish)}
          </div>
          <div className="d">
            {sched.remainingHours} h left · {sched.overrunDays ? `${sched.overrunDays} workdays late` : 'on track'}
          </div>
        </div>
        <div className="card stat card-link" onClick={() => navigate('ai')}>
          <div className="k">
            <Icon name="auto_awesome" size={18} /> AI requests
          </div>
          <div className="v">{log.length}</div>
          <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>
            <SourceChip source="on_device" compact />
            <span className="small muted">{onDevice}</span>
            <SourceChip source="in_cloud" compact />
            <span className="small muted">{inCloud}</span>
            {!firebaseConfigured && <span className="chip heuristic">demo</span>}
          </div>
        </div>
      </div>

      <h2 className="section-title">The connected loop</h2>
      <div className="grid grid-3">
        {steps.map((s, i) => (
          <div key={s.route} className="card card-link" onClick={() => navigate(s.route)}>
            <div className="card-body row" style={{ alignItems: 'flex-start', gap: 14 }}>
              <span className="sev" style={{ width: 40, height: 40, background: s.done ? 'var(--green-50)' : 'var(--blue-50)', color: s.done ? 'var(--green)' : 'var(--blue)' }}>
                <Icon name={s.done ? 'check' : s.icon} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small faint">Step {i + 1}</div>
                <div style={{ fontWeight: 500, fontSize: 15 }}>{s.title}</div>
                <div className="small muted">{s.text}</div>
              </div>
              <Icon name="chevron_right" style={{ color: 'var(--text-3)' }} />
            </div>
          </div>
        ))}
      </div>

      <div className="grid stack-mobile" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', marginTop: 24 }}>
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="card-header">
            <h2>Plan</h2>
            <span className="sub">
              rev {model.revision} · {d.rooms.length} rooms · {d.rooms.reduce((s, r) => s + r.area, 0).toFixed(1)} m² net
            </span>
            <div className="grow" />
            <button className="btn btn-text btn-sm" onClick={() => navigate('studio')}>
              Open <Icon name="open_in_new" />
            </button>
          </div>
          <div style={{ height: 340, position: 'relative' }}>
            {model.walls.length ? (
              <Plan2D model={model} editable={false} showUnderlay={false} />
            ) : (
              <div className="empty">
                <Icon name="document_scanner" />
                <div style={{ marginBottom: 12 }}>No plan yet.</div>
                <button className="btn btn-primary" onClick={() => navigate('import')}>
                  <Icon name="upload_file" /> Import a plan
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2>Recent activity</h2>
            {Object.keys(presence).length > 0 && <span className="chip ok">{Object.keys(presence).length} online</span>}
          </div>
          <div>
            {activity.length === 0 && <div className="empty">No activity yet.</div>}
            {activity.map((a, i) => (
              <div key={i} className="row" style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-2)', alignItems: 'flex-start' }}>
                <Icon name={a.icon} style={{ color: 'var(--text-2)', marginTop: 2 }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.text}</div>
                  <div className="small faint">
                    {a.who} · {timeAgo(a.at, now)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {dev && <FirebaseStrip />}
    </div>
  );
}

function FirebaseStrip() {
  const user = useAuth((s) => s.user);
  const rcSource = usePlatform((s) => s.rcSource);
  const fb = getFirebase();
  const items: { name: string; icon: string; on: boolean; detail: string }[] = [
    { name: 'AI Logic', icon: 'auto_awesome', on: true, detail: firebaseConfigured ? 'hybrid · on-device + cloud' : 'heuristic fallback (demo)' },
    { name: 'App Check', icon: 'verified_user', on: appCheckEnabled(), detail: appCheckEnabled() ? 'reCAPTCHA Enterprise' : 'not configured' },
    { name: 'Authentication', icon: 'person', on: Boolean(user), detail: user ? (user.isAnonymous ? 'anonymous guest' : 'Google') : firebaseConfigured ? 'connecting' : 'demo identity' },
    { name: 'Firestore', icon: 'database', on: Boolean(fb), detail: fb ? `real-time${fb.offlineCache ? ' · offline cache' : ''}` : 'browser storage (demo)' },
    { name: 'Cloud Storage', icon: 'folder_open', on: Boolean(fb?.storage), detail: fb?.storage ? 'drawings · snapshots · GLB' : 'inline (demo)' },
    { name: 'Remote Config', icon: 'tune', on: Boolean(fb), detail: fb ? `${rcSource} values · real-time` : 'defaults' },
    { name: 'Analytics', icon: 'insights', on: telemetryState.analytics, detail: telemetryState.analytics ? 'product events' : 'off' },
    { name: 'Performance', icon: 'speed', on: telemetryState.performance, detail: telemetryState.performance ? 'AI + detection traces' : 'off' },
  ];
  return (
    <div className="card card-link" style={{ marginTop: 24 }} onClick={() => navigate('ai', { tab: 'firebase' })}>
      <div className="card-header">
        <Icon name="local_fire_department" style={{ color: 'var(--fb-amber)' }} />
        <h2>Firebase in this project</h2>
        <span className="sub hide-mobile">{items.filter((i) => i.on).length} of {items.length} services active</span>
        <div className="grow" />
        <Icon name="chevron_right" style={{ color: 'var(--text-3)' }} />
      </div>
      <div className="card-body grid grid-4" style={{ gap: 10 }}>
        {items.map((i) => (
          <div key={i.name} className="row" style={{ alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
            <span className="sev" style={{ width: 32, height: 32, background: i.on ? 'var(--green-50)' : 'var(--surface-2)', color: i.on ? 'var(--green)' : 'var(--text-3)' }}>
              <Icon name={i.icon} size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{i.name}</div>
              <div className="small muted text-ellipsis">{i.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
