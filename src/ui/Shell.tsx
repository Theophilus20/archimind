/** Top-bar menus and dialogs: project switcher, invites, account, sync status. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStudio, roleLabel, isPlaceholder } from '../state/store';
import { useProjects, createInvite, listInvites, revokeInvite, removeMember, leaveProject, type InviteInfo } from '../firebase/projects';
import { openCloudProject, openOwnWork, type SyncStatus } from '../firebase/sync';
import { useAuth, signInWithGoogle, signOutUser } from '../firebase/auth';
import { deleteAccount, deleteProject, planAccountDeletion, type AccountPlan } from '../firebase/account';
import { firebaseConfigured, firebaseConfig } from '../firebase/config';
import { useTheme, useDevMode, type ThemePref } from './hooks';
import { Avatar, Dialog, Icon, Spinner } from './common';
import { navigate } from './router';
import { readProfilePhoto } from './photo';
import { FigurePreview } from './FigurePreview';
import { PEOPLE, lookFor } from '../studio/People';
import type { AccessLevel, Figure, UserRole } from '../model/types';
import { ACCESS_HINT, ACCESS_LABEL, accessFor, defaultAccess, setMemberAccess, useIsOwner, useMyAccess } from '../firebase/access';

export const ROLE_COLORS: Record<UserRole, string> = { student: '#1a73e8', lecturer: '#e37400', architect: '#7b1fa2', client: '#188038' };

function useClickAway(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    setTimeout(() => window.addEventListener('mousedown', on), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', on);
      window.removeEventListener('keydown', key);
    };
  }, [open, close]);
  return ref;
}

export function ProjectMenu() {
  const project = useStudio((s) => s.project);
  const openLocal = useStudio((s) => s.openLocalProject);
  const setProject = useStudio((s) => s.setProject);
  const renameProject = useStudio((s) => s.renameProject);
  const toast = useStudio((s) => s.toast);
  const list = useProjects((s) => s.list);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'invite' | 'rename' | 'delete' | null>(null);
  const isOwner = useIsOwner();
  const [busy, setBusy] = useState<string | null>(null);
  const myAccess = useMyAccess();
  const user = useAuth((s) => s.user);
  const ref = useClickAway(open, () => setOpen(false));

  const openProject = async (id: string, _cloud: boolean) => {
    setOpen(false);
    if (id === project.id) return;
    // Opened before on this device: show it straight away; Firestore refreshes it in the background.
    if (openLocal(id)) return;
    // Not in this browser (or its saved copy was cleared to make room): fetch it from the cloud.
    if (!firebaseConfigured) {
      toast('That project isn’t saved in this browser any more.', 'error');
      return;
    }
    setBusy(id);
    try {
      const p = await openCloudProject(id);
      if (p) setProject(p);
      else toast('Project not found or you no longer have access', 'error');
    } catch (e) {
      toast(`Couldn’t open that project: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const others = list.filter((p) => p.id !== project.id && p.owned !== false);
  const shared = list.filter((p) => p.id !== project.id && p.owned === false);
  return (
    <div style={{ position: 'relative', minWidth: 0 }} ref={ref}>
      <button className="project-switch" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <span className="text-ellipsis">{project.name}</span>
        {busy ? <Spinner size={16} /> : <Icon name="arrow_drop_down" />}
      </button>
      {open && (
        <div className="menu" role="menu" style={{ top: 44, left: 0, width: 320 }}>
          <div className="menu-label">Current project</div>
          <button className="menu-item active" onClick={() => (setOpen(false), navigate(myAccess === 'full' ? 'overview' : 'crit'))}>
            <Icon name="home_work" />
            <span className="grow text-ellipsis">{project.name}</span>
          </button>
          {firebaseConfigured && project.owner && user && project.owner !== user.uid && (
            <button
              className="menu-item"
              onClick={async () => {
                setOpen(false);
                if (!confirm(`Leave "${project.name}"? You will need a new invite to come back.`)) return;
                try {
                  await leaveProject(project, user.uid);
                  toast(`You left "${project.name}"`, 'success');
                  await openOwnWork(project.id);
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <Icon name="logout" /> Leave this project
            </button>
          )}
          {myAccess === 'full' && !isPlaceholder(project.id) && (
            <>
              <button className="menu-item" onClick={() => (setOpen(false), setDialog('rename'))}>
                <Icon name="edit" /> Rename
              </button>
              <button className="menu-item" onClick={() => (setOpen(false), setDialog('invite'))}>
                <Icon name="person_add" /> {project.brief.mode === 'studio' ? 'Invite a coursemate or lecturer' : 'Invite a client or colleague'}
              </button>
            </>
          )}
          {others.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Your projects</div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {others.map((p) => (
                  <button key={p.id} className="menu-item" onClick={() => openProject(p.id, p.cloud)}>
                    <Icon name={busy === p.id ? 'progress_activity' : p.cloud ? 'cloud_done' : 'folder'} />
                    <span className="grow text-ellipsis">{p.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {shared.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Shared with you</div>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {shared.map((p) => (
                  <button key={p.id} className="menu-item" onClick={() => openProject(p.id, p.cloud)} title={p.sharedBy ? `Shared by ${p.sharedBy}` : undefined}>
                    <Icon name={busy === p.id ? 'progress_activity' : 'folder_shared'} />
                    <span className="grow text-ellipsis">{p.name}</span>
                    <span className="chip" style={{ height: 20, maxWidth: 120 }}>
                      <span className="text-ellipsis">{p.sharedBy ? `from ${p.sharedBy.split(' ')[0]}` : roleLabel(p.role)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (setOpen(false), setDialog('new'))}>
            <Icon name="add" /> New project
          </button>
          <button className="menu-item" onClick={() => (setOpen(false), navigate('projects'))}>
            <Icon name="folder_open" /> Close project and see all projects
          </button>
          {isOwner && !isPlaceholder(project.id) && (
            <button className="menu-item" style={{ color: 'var(--red)' }} onClick={() => (setOpen(false), setDialog('delete'))}>
              <Icon name="delete" /> Delete this project…
            </button>
          )}
        </div>
      )}
      {dialog === 'new' && <NewProjectDialog onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <InviteDialog onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameDialog current={project.name} onSave={(n) => (renameProject(n), setDialog(null))} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <Dialog
          title={`Delete “${project.name}”?`}
          onClose={() => setDialog(null)}
          actions={
            <>
              <button className="btn btn-text" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const { id, name } = project;
                  setDialog(null);
                  setBusy(id);
                  try {
                    // Move off the project first, so nothing saves into it while it is deleted.
                    await openOwnWork(id);
                    await deleteProject(id);
                    toast(`Deleted “${name}”`, 'success');
                    navigate('projects');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Delete for everyone
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>This removes the project for you and everyone you invited: the model, revisions, crit messages, schedule and files. It can’t be undone.</p>
        </Dialog>
      )}
    </div>
  );
}

function RenameDialog({ current, onSave, onClose }: { current: string; onSave: (n: string) => void; onClose: () => void }) {
  const [name, setName] = useState(current);
  return (
    <Dialog
      title="Rename project"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>
            Save
          </button>
        </>
      }
    >
      <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())} />
    </Dialog>
  );
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const createProject = useStudio((s) => s.createProject);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'sample' | 'blank' | 'sketch'>('blank');
  const [mode, setMode] = useState<'studio' | 'practice'>('studio');
  const create = () => {
    if (kind === 'sketch') {
      createProject('blank', name.trim() || 'My sketch', mode);
      onClose();
      navigate('studio', { draw: 'wall' });
      return;
    }
    createProject(kind, name.trim() || (kind === 'sample' ? 'Family Home (copy)' : 'Untitled project'), mode);
    onClose();
    navigate(kind === 'blank' ? 'brief' : 'overview');
  };
  return (
    <Dialog
      title="New project"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={create}>
            Create project
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="field">
          <label>Project name</label>
          <input className="input" autoFocus placeholder="e.g. Riverside studio, Week 4" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </div>
        <div className="field">
          <label>Start from</label>
          <div className="grid grid-3 stack-mobile">
            {(
              [
                ['blank', 'draft', 'Blank project', 'Write a brief, then import your own plan.'],
                ['sketch', 'design_services', 'Draw a plan', 'Start on an empty plan and draw it wall by wall, as in drafting programs.'],
                ['sample', 'home', 'Sample family home', 'A complete example to explore every feature.'],
              ] as const
            ).map(([k, icon, title, text]) => (
              <button key={k} className="card card-pad" onClick={() => setKind(k)} style={{ textAlign: 'left', cursor: 'pointer', borderColor: kind === k ? 'var(--blue)' : undefined, background: kind === k ? 'var(--blue-50)' : undefined }}>
                <Icon name={icon} style={{ color: kind === k ? 'var(--blue)' : 'var(--text-2)' }} />
                <div style={{ fontWeight: 500, marginTop: 6 }}>{title}</div>
                <div className="small muted">{text}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Context</label>
          <div className="seg">
            <button className={mode === 'studio' ? 'on' : ''} onClick={() => setMode('studio')}>
              <Icon name="school" /> Student studio
            </button>
            <button className={mode === 'practice' ? 'on' : ''} onClick={() => setMode('practice')}>
              <Icon name="business_center" /> Practice
            </button>
          </div>
        </div>
        <div className="small muted">{firebaseConfigured ? 'The project is saved to Firestore and works offline.' : 'Demo mode: projects are saved in this browser.'}</div>
      </div>
    </Dialog>
  );
}

function InviteDialog({ onClose }: { onClose: () => void }) {
  const project = useStudio((s) => s.project);
  const user = useAuth((s) => s.user);
  const studio = project.brief.mode === 'studio';
  const [role, setRole] = useState<UserRole>(studio ? 'student' : 'client');
  const [access, setAccess] = useState<AccessLevel>(defaultAccess(studio ? 'student' : 'client', studio));
  const isOwner = !project.owner || project.owner === user?.uid;
  // In a studio project you are a student, so another student is your coursemate.
  const who = (r: UserRole) => (studio && r === 'student' ? 'Coursemate' : roleLabel(r));
  const what: Partial<Record<UserRole, string>> = {
    student: studio ? 'Designs with you as an equal: edits the plan, chats, pins comments and walks through the model with you.' : 'Can edit the plan, chat and comment.',
    lecturer: 'Gives feedback: joins crits, pins comments, can follow or lead the view. Usually does not edit your plan.',
    client: 'Sees the design in plain language, comments and walks through it.',
    architect: 'A colleague who can edit the plan and review it.',
  };
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      setLink(await createInvite(project.id, role, user?.uid ?? null, access));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={studio ? 'Invite a coursemate or lecturer' : 'Invite someone to this project'}
      onClose={onClose}
      actions={
        <button className="btn btn-text" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="small muted">People you invite see the same model, can pin comments to it, walk through it with you and follow your view live.</div>
        <div className="row wrap">
          {((studio ? ['student', 'lecturer'] : ['client', 'architect', 'lecturer', 'student']) as UserRole[]).map((r) => (
            <button key={r} className={`chip chip-select ${role === r ? 'on' : ''}`} onClick={() => (setRole(r), setAccess(defaultAccess(r, studio)), setLink(null))}>
              <span className="dot" style={{ background: ROLE_COLORS[r] }} /> {who(r)}
            </button>
          ))}
        </div>
        {what[role] && <div className="small">{what[role]}</div>}
        <div className="field">
          <label>What they can open</label>
          <div className="access-options" role="radiogroup">
            {(['crit', 'markup', 'full'] as AccessLevel[]).map((a) => (
              <button key={a} role="radio" aria-checked={access === a} className={`access-option ${access === a ? 'on' : ''}`} onClick={() => (setAccess(a), setLink(null))}>
                <Icon name={a === 'crit' ? 'forum' : a === 'markup' ? 'draw' : 'lock_open'} />
                <span>
                  <b>{ACCESS_LABEL[a]}</b>
                  <small>{ACCESS_HINT[a]}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        {link ? (
          <div className="row">
            <input className="input input-sm grow" readOnly value={link} onFocus={(e) => e.target.select()} />
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(link).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name={copied ? 'check' : 'content_copy'} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={make} disabled={busy} style={{ alignSelf: 'flex-start' }}>
            {busy ? <Spinner /> : <Icon name="link" />} Create {who(role).toLowerCase()} link
          </button>
        )}
        {err && <div className="small" style={{ color: 'var(--red)' }}>{err}</div>}
        {firebaseConfigured && user && <InviteLinks key={link ?? 'none'} projectId={project.id} uid={user.uid} />}
        {firebaseConfigured && isOwner && <PeopleWithAccess />}
        <div className="small faint">{firebaseConfigured ? 'Links expire after 7 days and are checked by Firestore security rules.' : 'Demo mode: the link opens this project in another tab of this browser.'}</div>
      </div>
    </Dialog>
  );
}

/** Invite links you created for this project, with a way to close each one. */
function InviteLinks({ projectId, uid }: { projectId: string; uid: string }) {
  const toast = useStudio((s) => s.toast);
  const [list, setList] = useState<InviteInfo[] | null>(null);
  useEffect(() => {
    listInvites(projectId, uid).then(setList).catch(() => setList([]));
  }, [projectId, uid]);
  if (!list?.length) return null;
  const days = (t: number) => Math.max(1, Math.round((t - Date.now()) / 86400000));
  return (
    <div className="field">
      <label>Open invite links</label>
      <div className="col" style={{ gap: 6 }}>
        {list.map((i) => (
          <div key={i.code} className="row" style={{ gap: 10 }}>
            <Icon name="link" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small">
                {i.role === 'student' ? 'Coursemate' : roleLabel(i.role)} · {ACCESS_LABEL[i.access].toLowerCase()}
              </div>
              <div className="small muted">expires in {days(i.expiresAt)} day{days(i.expiresAt) === 1 ? '' : 's'}</div>
            </div>
            <button
              className="btn btn-text btn-sm"
              onClick={async () => {
                try {
                  await revokeInvite(i.code);
                  setList((l) => (l ?? []).filter((x) => x.code !== i.code));
                  toast('Invite link closed. Nobody new can join with it.', 'success');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <Icon name="link_off" /> Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Owner view: everyone in the project and what they can open (changes apply instantly). */
function PeopleWithAccess() {
  const project = useStudio((s) => s.project);
  const me = useAuth((s) => s.user?.uid);
  const toast = useStudio((s) => s.toast);
  const people = project.members.filter((m) => m.id !== me && m.id !== project.owner && project.access && m.id in project.access);
  if (!people.length) return null;
  return (
    <div className="field">
      <label>People with access</label>
      <div className="col" style={{ gap: 6 }}>
        {people.map((m) => (
          <div key={m.id} className="row" style={{ gap: 10 }}>
            <Avatar m={m} size={28} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="text-ellipsis">{m.name}</div>
              <div className="small muted">{project.brief.mode === 'studio' && m.role === 'student' ? 'Coursemate' : roleLabel(m.role)}</div>
            </div>
            <select
              className="select input-sm"
              style={{ width: 'auto' }}
              value={accessFor(project, m.id)}
              onChange={(e) =>
                setMemberAccess(project.id, m.id, e.target.value as AccessLevel)
                  .then(() => toast(`${m.name} now has: ${ACCESS_LABEL[e.target.value as AccessLevel].toLowerCase()}`, 'success'))
                  .catch((x) => toast((x as Error).message, 'error'))
              }
            >
              {(['crit', 'markup', 'full'] as AccessLevel[]).map((a) => (
                <option key={a} value={a}>
                  {ACCESS_LABEL[a]}
                </option>
              ))}
            </select>
            <button
              className="icon-btn"
              title={`Remove ${m.name} from this project`}
              aria-label={`Remove ${m.name}`}
              onClick={async () => {
                if (!confirm(`Remove ${m.name} from this project? They will lose access straight away.`)) return;
                try {
                  await removeMember(project, m.id);
                  useStudio.setState((s) => ({ project: { ...s.project, members: s.project.members.filter((x) => x.id !== m.id), access: Object.fromEntries(Object.entries(s.project.access ?? {}).filter(([k]) => k !== m.id)) } }));
                  toast(`${m.name} was removed`, 'success');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              }}
            >
              <Icon name="person_remove" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AccountMenu() {
  const me = useStudio((s) => s.me);
  const setMe = useStudio((s) => s.setMe);
  const toast = useStudio((s) => s.toast);
  const user = useAuth((s) => s.user);
  const pref = useTheme((s) => s.pref);
  const setPref = useTheme((s) => s.setPref);
  const dev = useDevMode((s) => s.on);
  const setDev = useDevMode((s) => s.set);
  const brief = useStudio((s) => s.project.brief);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const roles: UserRole[] = brief.mode === 'studio' ? ['student', 'lecturer'] : ['architect', 'client', 'student', 'lecturer'];
  const [figureOpen, setFigureOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const ref = useClickAway(open, () => setOpen(false));
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="btn btn-text" onClick={() => setOpen((v) => !v)} style={{ color: 'var(--text)', gap: 10, padding: '0 6px' }} aria-label="Account" aria-expanded={open}>
        <Avatar m={me} size={30} />
        <span className="col hide-mobile" style={{ gap: 0, alignItems: 'flex-start', lineHeight: 1.2 }}>
          <span style={{ fontWeight: 500, maxWidth: 140 }} className="text-ellipsis">
            {me.name}
          </span>
          <span className="small muted">{roleLabel(me.role)}</span>
        </span>
        <Icon name="expand_more" className="hide-mobile" />
      </button>
      {open && (
        <div className="menu" style={{ right: 0, top: 46, width: 300 }}>
          <div style={{ padding: '10px 16px 6px' }} className="col">
            <div className="row" style={{ gap: 12 }}>
              <Avatar m={me} size={48} />
              <div className="col" style={{ gap: 4 }}>
                <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
                  <Icon name="add_a_photo" /> {me.photo ? 'Change photo' : 'Add a photo'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    hidden
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      try {
                        setMe({ photo: await readProfilePhoto(f) });
                        toast('Photo updated. Others see it in the crit room.', 'success');
                      } catch (x) {
                        toast((x as Error).message, 'error');
                      }
                    }}
                  />
                </label>
                {me.photo && (
                  <button className="btn btn-text btn-sm" onClick={() => setMe({ photo: user?.photoURL ?? undefined })}>
                    {user?.photoURL && me.photo !== user.photoURL ? 'Use my Google photo' : 'Remove photo'}
                  </button>
                )}
              </div>
            </div>
            <div className="field">
              <label>Display name</label>
              <input className="input input-sm" value={me.name} onChange={(e) => setMe({ name: e.target.value })} />
            </div>
            <div className="label" style={{ marginTop: 6 }}>
              Join the crit as
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {roles.map((r) => (
                <button key={r} className={`chip chip-select ${me.role === r ? 'on' : ''}`} onClick={() => setMe({ role: r, color: ROLE_COLORS[r] })}>
                  {roleLabel(r)}
                </button>
              ))}
            </div>
            <div className="label" style={{ marginTop: 6 }}>
              Your figure in walkthroughs
            </div>
            <button className="figure-button" onClick={() => (setOpen(false), setFigureOpen(true))}>
              <FigurePreview look={lookFor(me.id, me.figure ?? 'woman', me.look?.top ?? me.color, me.look)} size={64} />
              <span className="grow" style={{ textAlign: 'left' }}>
                <b>Customise your figure</b>
                <small className="muted" style={{ display: 'block' }}>
                  Choose your person and outfit. Others see them when you walk together.
                </small>
              </span>
              <Icon name="chevron_right" />
            </button>
            <div className="label" style={{ marginTop: 6 }}>
              Theme
            </div>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              {(
                [
                  ['light', 'light_mode', 'Light'],
                  ['dark', 'dark_mode', 'Dark'],
                  ['system', 'contrast', 'Auto'],
                ] as [ThemePref, string, string][]
              ).map(([p, icon, label]) => (
                <button key={p} className={pref === p ? 'on' : ''} onClick={() => setPref(p)}>
                  <Icon name={icon} /> {label}
                </button>
              ))}
            </div>
          </div>
          <div className="menu-sep" />
          {firebaseConfigured ? (
            <>
              <div className="menu-label">Account</div>
              <div style={{ padding: '0 16px 8px' }} className="small muted">
                {user ? (user.isAnonymous ? 'Guest account. Sign in to keep your projects on every device.' : `Signed in as ${user.email ?? user.displayName}`) : 'Connecting…'}
              </div>
              {user?.isAnonymous !== false ? (
                <button
                  className="menu-item"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await signInWithGoogle();
                      toast('Signed in with Google. Your guest work was kept.', 'success');
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Icon name="login" /> Sign in with Google
                </button>
              ) : (
                <>
                  <button className="menu-item" onClick={() => signOutUser()}>
                    <Icon name="logout" /> Sign out
                  </button>
                  <button className="menu-item danger" onClick={() => (setOpen(false), setDeleteOpen(true))}>
                    <Icon name="person_remove" /> Delete account…
                  </button>
                </>
              )}
              {dev && (
                <div style={{ padding: '4px 16px 6px' }} className="small faint">
                  Firebase project <code>{firebaseConfig.projectId}</code>
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: '6px 16px 8px' }} className="small muted">
              Offline demo: sign-in and sharing are not connected.
            </div>
          )}
          <div className="menu-sep" />
          <div className="row" style={{ padding: '6px 16px 8px' }}>
            <span className="grow small">Show technical details</span>
            <button className={`switch ${dev ? 'on' : ''}`} role="switch" aria-checked={dev} aria-label="Show technical details" onClick={() => setDev(!dev)} />
          </div>
        </div>
      )}
      {figureOpen && <FigureDialog onClose={() => setFigureOpen(false)} />}
      {deleteOpen && <DeleteAccountDialog onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}

const SYNC: Record<SyncStatus, { label: string; color: string; icon: string }> = {
  off: { label: 'Saved in browser', color: 'var(--text-3)', icon: 'save' },
  connecting: { label: 'Connecting', color: 'var(--warn)', icon: 'sync' },
  synced: { label: 'Synced', color: 'var(--green)', icon: 'cloud_done' },
  saving: { label: 'Saving', color: 'var(--blue)', icon: 'cloud_upload' },
  offline: { label: 'Offline, changes saved for later', color: 'var(--warn)', icon: 'cloud_off' },
  error: { label: 'Sync error', color: 'var(--red)', icon: 'error' },
};

export function SyncChip({ status, detail }: { status: SyncStatus; detail?: string }) {
  const s = SYNC[status];
  return (
    <span className="chip hide-mobile" title={detail ?? `Firestore: ${s.label}`} style={{ height: 30, padding: '0 10px' }}>
      <Icon name={s.icon} className={status === 'saving' || status === 'connecting' ? 'pulse' : ''} style={{ color: s.color }} />
      {s.label}
    </span>
  );
}

export function MenuButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="icon-btn only-mobile" onClick={onClick} aria-label="Open navigation">
      {children}
    </button>
  );
}

/** Customise your walkthrough figure; everyone in the room sees it. */
function FigureDialog({ onClose }: { onClose: () => void }) {
  const me = useStudio((s) => s.me);
  const setMe = useStudio((s) => s.setMe);
  const look = lookFor(me.id, me.figure ?? 'woman', me.look?.top ?? me.color, me.look);
  // People load in the background (one at a time) so choosing one shows them at once.
  const preload = (id: string, figure: Figure) => void import('../studio/RealPerson').then((m) => m.loadPerson(id, figure)).catch(() => undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of PEOPLE.filter((x) => x.figure === look.figure)) {
        if (cancelled) return;
        await import('../studio/RealPerson').then((m) => m.loadPerson(p.id, p.figure)).catch(() => undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [look.figure]);
  return (
    <Dialog
      title="Customise your figure"
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-text" onClick={() => setMe({ look: undefined })}>
            Reset
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="figure-editor">
        <div className="figure-stage">
          <FigurePreview look={look} size={220} />
        </div>
        <div className="col" style={{ gap: 12, minWidth: 0 }}>
          <div className="field">
            <label>Body</label>
            <div className="seg">
              {(
                [
                  ['woman', 'woman', 'Woman'],
                  ['man', 'man', 'Man'],
                ] as [Figure, string, string][]
              ).map(([f, icon, label]) => (
                <button
                  key={f}
                  className={look.figure === f ? 'on' : ''}
                  onClick={() => {
                    if (look.figure === f) return;
                    // Switching body type picks a person of that type.
                    const next = PEOPLE.find((p) => p.figure === f)!.id;
                    setMe({ figure: f, look: { ...(me.look ?? {}), person: next } });
                  }}
                >
                  <Icon name={icon} /> {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Person and outfit</label>
            <div className="person-grid" role="radiogroup" aria-label="Person and outfit">
              {PEOPLE.filter((p) => p.figure === look.figure).map((p) => (
                <button key={p.id} role="radio" aria-checked={look.person === p.id} className={`person-tile ${look.person === p.id ? 'on' : ''}`} onPointerEnter={() => preload(p.id, p.figure)} onFocus={() => preload(p.id, p.figure)} onClick={() => setMe({ figure: p.figure, look: { ...(me.look ?? {}), person: p.id } })} title={p.label}>
                  <img src={`/people/${p.id}/face.webp`} alt={p.label} loading="lazy" />
                </button>
              ))}
            </div>
            <small className="muted">Each person comes with their own look and outfit. Others see them when you walk together.</small>
          </div>
          <small className="faint">People: Microsoft Rocketbox avatar library (MIT licence).</small>
        </div>
      </div>
    </Dialog>
  );
}

/** Delete your account: shows exactly what goes, asks you to type DELETE, then confirms with Google. */
function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [plan, setPlan] = useState<AccountPlan | null>(null);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    planAccountDeletion()
      .then(setPlan)
      .catch(() => setPlan({ owned: [], shared: [] }));
  }, []);
  const working = step !== null && !error;
  const run = async () => {
    setError(null);
    setStep('Starting…');
    try {
      await deleteAccount(setStep);
      setStep('Your account has been deleted.');
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      setError((e as Error).message || 'Something went wrong. Nothing more was deleted.');
    }
  };
  const list = (xs: { name: string }[]) => (xs.length <= 4 ? xs.map((x) => `“${x.name}”`).join(', ') : `${xs.slice(0, 4).map((x) => `“${x.name}”`).join(', ')} and ${xs.length - 4} more`);
  return (
    <Dialog
      title="Delete your account"
      onClose={() => !working && onClose()}
      actions={
        <>
          <button className="btn btn-text" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button className="btn btn-danger-filled" onClick={run} disabled={typed.trim().toUpperCase() !== 'DELETE' || working || !plan}>
            {working ? <Spinner size={16} /> : <Icon name="delete_forever" />} Delete account
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12, maxWidth: 520 }}>
        <div>This permanently deletes:</div>
        {!plan ? (
          <div className="row small muted" style={{ gap: 8 }}>
            <Spinner size={16} /> Checking your projects…
          </div>
        ) : (
          <ul className="delete-list">
            <li>
              {plan.owned.length ? (
                <>
                  <b>
                    {plan.owned.length} project{plan.owned.length === 1 ? '' : 's'} you own
                  </b>{' '}
                  ({list(plan.owned)}), with their chat, revisions and files.
                  {plan.owned.some((p) => p.people > 0) && <span className="danger-text"> People you shared them with lose them too.</span>}
                </>
              ) : (
                'You own no projects.'
              )}
            </li>
            {plan.shared.length > 0 && (
              <li>
                <b>Your messages</b> in {list(plan.shared)}, and you leave {plan.shared.length === 1 ? 'that project' : 'those projects'}. Changes you made to their designs stay in their history.
              </li>
            )}
            <li>Your invite links, profile, photo and walkthrough figure.</li>
            <li>Your ArchiMind sign-in. Your Google account itself is not affected.</li>
          </ul>
        )}
        <div className="danger-text" style={{ fontWeight: 500 }}>
          This can’t be undone.
        </div>
        <div className="field">
          <label htmlFor="delete-confirm">Type DELETE to confirm</label>
          <input id="delete-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" disabled={working} placeholder="DELETE" />
        </div>
        {step && !error && (
          <div className="row small" style={{ gap: 8 }}>
            {working && <Spinner size={16} />} {step}
          </div>
        )}
        {error && <div className="small danger-text">{error}</div>}
      </div>
    </Dialog>
  );
}
