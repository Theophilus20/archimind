import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useRoute, navigate, type Route } from './ui/router';
import { Avatar, Icon, Spinner } from './ui/common';
import { Logo } from './ui/Logo';
import { useStudio, roleLabelFor, reopenFromCloud, isPlaceholder } from './state/store';
import { useAI } from './ai/log';
import { checkDevice } from './ai/hybrid';
import { useCollab, connectCollab, setMyMember, updatePresence, setWalkChannel } from './collab/collab';
import { firebaseConfigured, usePlatform, getFirebase } from './firebase/config';
import { openCloudProject, startProjectSync, type SyncStatus } from './firebase/sync';
import { startAuth, useAuth, GUEST_ALLOWED } from './firebase/auth';
import { SignInScreen } from './ui/SignIn';
import { watchMyProjects, saveUserProfile, loadUserProfile } from './firebase/projects';
import { Overview } from './pages/Overview';
import { ProjectsPage } from './pages/Projects';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { AccountMenu, ProjectMenu, SyncChip } from './ui/Shell';
import { useApplyTheme, useIsMobile, useOnline } from './ui/hooks';
import { useMyAccess, ACCESS_LABEL } from './firebase/access';
import { PEOPLE, lookFor } from './studio/People';

/**
 * After a new deploy, a page that was left open still points at the old script files,
 * which no longer exist. When loading a page fails that way, reload once to pick up
 * the new version instead of showing an error.
 */
function lazyPage<T extends React.ComponentType>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((e: unknown) => {
      const key = 'archimind.reloaded-for-update';
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (/dynamically imported module|Importing a module script failed|Loading chunk/i.test(String((e as Error)?.message ?? e)) && Date.now() - last > 30000) {
        sessionStorage.setItem(key, String(Date.now()));
        location.reload();
        return new Promise<{ default: T }>(() => undefined);
      }
      throw e;
    }),
  );
}

/** The sample team's student name, used before anyone signs in. */
const DEMO_NAME = 'Ada Mensah';

const Brief = lazyPage(() => import('./pages/Brief').then((m) => ({ default: m.BriefPage })));
const ImportPage = lazyPage(() => import('./pages/Import').then((m) => ({ default: m.ImportPage })));
const Studio = lazyPage(() => import('./pages/Studio').then((m) => ({ default: m.StudioPage })));
const Review = lazyPage(() => import('./pages/Review').then((m) => ({ default: m.ReviewPage })));
const Crit = lazyPage(() => import('./pages/Crit').then((m) => ({ default: m.CritPage })));
const Schedule = lazyPage(() => import('./pages/Schedule').then((m) => ({ default: m.SchedulePage })));
const Revisions = lazyPage(() => import('./pages/Revisions').then((m) => ({ default: m.RevisionsPage })));
const AILogic = lazyPage(() => import('./pages/AILogic').then((m) => ({ default: m.AILogicPage })));
const Join = lazyPage(() => import('./pages/Join').then((m) => ({ default: m.JoinPage })));

interface NavEntry {
  route: Route;
  label: string;
  short?: string;
  icon: string;
  count?: number;
}

export function App() {
  const { route } = useRoute();
  const project = useStudio((s) => s.project);
  const me = useStudio((s) => s.me);
  const setMe = useStudio((s) => s.setMe);
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  const messages = useCollab((s) => s.messages);
  const presence = useCollab((s) => s.presence);
  const user = useAuth((s) => s.user);
  const announcement = usePlatform((s) => s.rc.announcement);
  const online = useOnline();
  const isMobile = useIsMobile();
  const [sync, setSync] = useState<{ s: SyncStatus; d?: string }>({ s: 'off' });
  const [navOpen, setNavOpen] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);
  const profileLoaded = useRef(false);
  const access = useMyAccess();
  const limited = access !== 'full';
  useApplyTheme();

  // No project open (you deleted your last one): the projects page is where to go next.
  useEffect(() => {
    if (isPlaceholder(project.id) && route !== 'projects' && route !== 'join') navigate('projects');
  }, [project.id, route]);

  // People invited to the crit only ever see the crit room of this project.
  useEffect(() => {
    if (limited && route !== 'crit' && route !== 'join' && route !== 'projects') navigate('crit');
  }, [limited, route]);

  useEffect(() => {
    getFirebase();
    startAuth();
    checkDevice();
    return startProjectSync((s, d) => setSync({ s, d }));
  }, []);

  // Signed-in identity: messages, presence and membership use the Firebase uid.
  useEffect(() => {
    if (!user) return;
    profileLoaded.current = false;
    loadUserProfile(user.uid).then((p) => {
      // A name saved from a guest session may still be the demo placeholder: prefer the Google name.
      const saved = p?.name && p.name !== DEMO_NAME ? p.name : undefined;
      setMe({ id: user.uid, name: saved ?? user.displayName ?? (me.name === DEMO_NAME ? 'New user' : me.name), photo: p?.photo ?? user.photoURL ?? undefined, ...(p?.role ? { role: p.role } : {}), ...(p?.color ? { color: p.color } : {}), ...(p?.figure ? { figure: p.figure } : {}), ...(p?.look ? { look: p.look } : {}) });
      profileLoaded.current = true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid]);
  useEffect(() => watchMyProjects(user?.uid ?? ''), [user?.uid]);
  // The project you had open last time, when this browser has no copy of it: fetch it from the cloud.
  useEffect(() => {
    const id = reopenFromCloud.id;
    if (!user || !id) return;
    reopenFromCloud.id = null;
    openCloudProject(id)
      .then((p) => {
        if (p && useStudio.getState().project.id.startsWith('demo')) useStudio.getState().setProject(p);
      })
      .catch(() => undefined);
  }, [user?.uid]);
  useEffect(() => {
    if (user && me.id === user.uid && profileLoaded.current) saveUserProfile(user.uid, me, project.id);
  }, [user, me, project.id]);
  useEffect(() => {
    if (isPlaceholder(project.id)) return;
    connectCollab(project.id, me);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, user?.uid]);
  useEffect(() => setWalkChannel(project.id, project.walkKey), [project.id, project.walkKey, user?.uid]);
  useEffect(() => setMyMember(me), [me]);
  // Load your realistic person in the background, so walkthroughs and the customiser show it at once.
  const myPerson = lookFor(me.id, me.figure ?? 'woman', me.look?.top ?? me.color, me.look);
  useEffect(() => {
    if (!user || !PEOPLE.some((p) => p.id === myPerson.person)) return;
    const idle = (window as unknown as { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    idle(() => void import('./studio/RealPerson').then((m) => m.loadPerson(myPerson.person, myPerson.figure)).catch(() => undefined));
  }, [user, myPerson.person, myPerson.figure]);
  useEffect(() => updatePresence({ route }), [route]);
  useEffect(() => setNavOpen(false), [route]);

  const openFindings = project.findings.filter((f) => f.status === 'open').length;
  const openTasks = project.tasks.filter((t) => t.status !== 'done').length;
  // Unread = text messages from other people this browser has not shown in the crit room yet.
  const readKey = `archimind.read.${project.id}`;
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      setReadIds(new Set(JSON.parse(localStorage.getItem(readKey) ?? '[]')));
    } catch {
      setReadIds(new Set());
    }
  }, [readKey]);
  useEffect(() => {
    if (route !== 'crit') return;
    const ids = messages.map((m) => m.id);
    if (ids.every((id) => readIds.has(id))) return;
    const next = new Set([...readIds, ...ids]);
    setReadIds(next);
    try {
      localStorage.setItem(readKey, JSON.stringify([...next].slice(-600)));
    } catch {
      /* ignore */
    }
  }, [route, messages, readIds, readKey]);
  const unresolved = messages.filter((m) => m.kind === 'text' && m.authorId !== me.id && !readIds.has(m.id)).length;
  // A quiet heads-up when someone else writes while you are elsewhere in the app.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!known.current) {
      known.current = new Set(messages.map((m) => m.id));
      return;
    }
    for (const m of messages) {
      if (known.current.has(m.id)) continue;
      known.current.add(m.id);
      if (m.kind === 'text' && m.authorId !== me.id && m.mentions?.includes(me.id)) useStudio.getState().toast(`${m.authorName} mentioned you: ${m.text.slice(0, 70)}${m.text.length > 70 ? '…' : ''}`, 'info');
      else if (m.kind === 'text' && m.authorId !== me.id && route !== 'crit') useStudio.getState().toast(`${m.authorName}: ${m.text.slice(0, 70)}${m.text.length > 70 ? '…' : ''}`, 'info');
    }
  }, [messages, me.id, route]);
  useEffect(() => {
    known.current = null;
  }, [project.id]);

  const sections: { heading?: string; items: NavEntry[] }[] = [
    { items: [{ route: 'overview', label: 'Project overview', short: 'Home', icon: 'home' }] },
    {
      heading: 'Design',
      items: [
        { route: 'brief', label: 'Brief', icon: 'assignment' },
        { route: 'import', label: 'Plan import', icon: 'document_scanner' },
        { route: 'studio', label: 'Studio 2D + 3D', short: 'Studio', icon: 'view_in_ar' },
      ],
    },
    {
      heading: 'Review',
      items: [
        { route: 'review', label: 'Design review', short: 'Review', icon: 'rule', count: openFindings },
        { route: 'crit', label: 'Crit room', short: 'Crit', icon: 'forum', count: unresolved || undefined },
      ],
    },
    {
      heading: 'Deliver',
      items: [
        { route: 'schedule', label: 'Schedule', icon: 'event_note', count: openTasks },
        { route: 'revisions', label: 'Revisions', icon: 'history', count: project.revisions.length },
      ],
    },
    { heading: 'Assistant', items: [{ route: 'ai', label: 'AI assistant', short: 'AI', icon: 'auto_awesome' }] },
  ];
  const visibleSections = limited ? [{ heading: 'Shared with you', items: sections.flatMap((s) => s.items).filter((i) => i.route === 'crit') }] : sections;
  const openMine = () => {
    useStudio.getState().toast('Opening your projects…', 'info');
    return import('./firebase/sync').then((m) => m.openOwnWork(project.id)).then(() => navigate('overview'));
  };
  const all = sections.flatMap((s) => s.items);
  const bottom = (limited ? (['crit'] as Route[]) : (['overview', 'studio', 'review', 'crit', 'schedule'] as Route[])).map((r) => all.find((i) => i.route === r)!);
  const others = Object.values(presence);
  const authReady = useAuth((s) => s.ready);

  // Everyone has their own Google account (guests only on the local dev server).
  if (firebaseConfigured && !authReady)
    return (
      <div className="signin">
        <Spinner size={32} />
      </div>
    );
  if (firebaseConfigured && (!user || (user.isAnonymous && !GUEST_ALLOWED))) return <SignInScreen />;

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <nav className="nav" aria-label="Product navigation">
        <div className="nav-brand">
          <Logo />
          <span>
            Archi<b>Mind</b>
          </span>
          <div className="grow" />
          <button className="icon-btn only-mobile" style={{ color: 'var(--nav-text-2)' }} onClick={() => setNavOpen(false)} aria-label="Close navigation">
            <Icon name="close" />
          </button>
        </div>
        {visibleSections.map((sec, i) => (
          <div className="nav-section" key={i}>
            {sec.heading && <div className="nav-heading">{sec.heading}</div>}
            {sec.items.map((it) => (
              <button key={it.route} className={`nav-item ${route === it.route ? 'active' : ''}`} onClick={() => navigate(it.route)} title={it.label}>
                <Icon name={it.icon} fill={route === it.route} />
                <span>{it.label}</span>
                {!!it.count && <span className="count">{it.count}</span>}
              </button>
            ))}
          </div>
        ))}
        {limited && (
          <div className="nav-section">
            <div className="nav-heading">Your account</div>
            <button className="nav-item" onClick={openMine} title="Go back to your own projects">
              <Icon name="folder_open" />
              <span>My projects</span>
            </button>
          </div>
        )}
        <div className="nav-footer">
          <div className="spark">
            <Icon name="local_fire_department" style={{ color: 'var(--fb-amber)' }} />
            <span>Powered by Firebase AI</span>
          </div>
          <span>{firebaseConfigured ? (user ? (user.isAnonymous ? 'Signed in as a guest' : `Signed in as ${user.displayName ?? user.email}`) : 'Signing in…') : 'Offline demo'}</span>
        </div>
      </nav>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button className="icon-btn only-mobile" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Icon name="menu" />
          </button>
          <ProjectMenu />
          {limited ? (
            <span className="chip hide-mobile" title="What the owner shared with you">
              <Icon name="lock" /> {ACCESS_LABEL[access]}
            </span>
          ) : (
            <span className="chip hide-mobile">{project.brief.mode === 'studio' ? 'Studio project' : 'Practice project'}</span>
          )}
          <div className="spacer" />
          {!online && (
            <span className="chip warn" title="Offline: Firestore queues changes; on-device AI keeps working">
              <Icon name="cloud_off" /> <span className="hide-mobile">Offline</span>
            </span>
          )}
          {firebaseConfigured && <SyncChip status={sync.s} detail={sync.d} />}
          <AIStatusChip compact={isMobile} />
          {others.length > 0 && (
            <div className="presence hide-mobile" title={others.map((p) => `${p.member.name} (${roleLabelFor(p.member.role, me.role)})`).join(', ')} style={{ marginLeft: 8 }}>
              {others.slice(0, 4).map((p) => (
                <Avatar key={p.member.id} m={p.member} size={28} />
              ))}
            </div>
          )}
          <AccountMenu />
        </header>
        {announcement && !bannerHidden && (
          <div className="banner" role="status">
            <Icon name="campaign" style={{ color: 'var(--fb-orange)' }} />
            <span className="grow">{announcement}</span>
            <span className="small muted hide-mobile">via Remote Config</span>
            <button className="icon-btn" style={{ width: 28, height: 28 }} onClick={() => setBannerHidden(true)} aria-label="Dismiss announcement">
              <Icon name="close" size={18} />
            </button>
          </div>
        )}

        <main className="page" id="page">
          <ErrorBoundary key={route} label={route}>
            <Suspense
              fallback={
                <div className="empty">
                  <Spinner size={28} />
                </div>
              }
            >
              {!limited && route === 'overview' && <Overview />}
              {!limited && route === 'brief' && <Brief />}
              {!limited && route === 'import' && <ImportPage />}
              {!limited && route === 'studio' && <Studio />}
              {!limited && route === 'review' && <Review />}
              {route === 'crit' && <Crit />}
              {!limited && route === 'schedule' && <Schedule />}
              {!limited && route === 'revisions' && <Revisions />}
              {!limited && route === 'ai' && <AILogic />}
              {route === 'join' && <Join />}
              {route === 'projects' && <ProjectsPage />}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Primary">
        {bottom.map((it) => (
          <button key={it.route} className={route === it.route ? 'active' : ''} onClick={() => navigate(it.route)}>
            <span className="pill-bg">
              <Icon name={it.icon} fill={route === it.route} />
            </span>
            {it.short ?? it.label}
            {!!it.count && it.route !== 'schedule' && <span className="badge">{it.count}</span>}
          </button>
        ))}
      </nav>

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <Icon name={t.kind === 'success' ? 'check_circle' : t.kind === 'error' ? 'error' : 'info'} />
            <span className="grow">{t.text}</span>
            <button className="icon-btn" style={{ color: '#fff', width: 28, height: 28 }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="close" size={18} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AIStatusChip({ compact }: { compact?: boolean }) {
  const mode = useAI((s) => s.mode);
  const device = useAI((s) => s.device);
  const busy = useAI((s) => Object.values(s.busy).some(Boolean));
  const last = useAI((s) => s.log[0]);
  const deviceReady = device === 'available';
  const label =
    mode === 'local-only' ? (deviceReady ? 'Local only · Nano ready' : 'Local only · model unavailable') : mode === 'cloud-first' ? 'Cloud first' : deviceReady ? 'Hybrid · Nano ready' : device === 'checking' ? 'Hybrid · checking' : 'Hybrid · cloud fallback';
  const cls = mode === 'local-only' && !deviceReady ? 'blocked' : deviceReady ? 'device' : 'cloud';
  return (
    <button className={`chip clickable ${cls}`} onClick={() => navigate('ai')} title={last ? `Last request: ${last.label} → ${last.source}` : label} style={{ height: 30, padding: compact ? '0 8px' : '0 12px' }} aria-label={label}>
      {busy ? <Spinner size={16} /> : <Icon name={deviceReady ? 'laptop_chromebook' : 'cloud'} />}
      {!compact && label}
    </button>
  );
}
