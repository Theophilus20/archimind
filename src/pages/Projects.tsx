/**
 * All your projects: open one, start a new one, delete the ones you own, or leave ones shared
 * with you. "Close project" in the project menu comes here.
 */
import { useState } from 'react';
import { useStudio, roleLabel } from '../state/store';
import { useProjects, leaveProject, readLocalIndex } from '../firebase/projects';
import { openCloudProject, openOwnWork } from '../firebase/sync';
import { deleteProject } from '../firebase/account';
import { firebaseConfigured } from '../firebase/config';
import { useAuth } from '../firebase/auth';
import { navigate } from '../ui/router';
import { Dialog, Icon, PageHeader, Spinner, timeAgo } from '../ui/common';
import { NewProjectDialog } from '../ui/Shell';

export function ProjectsPage() {
  const project = useStudio((s) => s.project);
  const openLocal = useStudio((s) => s.openLocalProject);
  const setProject = useStudio((s) => s.setProject);
  const toast = useStudio((s) => s.toast);
  const cloudList = useProjects((s) => s.list);
  const user = useAuth((s) => s.user);
  const list = firebaseConfigured ? cloudList : readLocalIndex();
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ id: string; name: string; owned: boolean } | null>(null);

  const open = async (id: string) => {
    if (id === project.id) return navigate('overview');
    if (openLocal(id)) return navigate('overview');
    if (!firebaseConfigured) return toast('That project isn’t saved in this browser any more.', 'error');
    setBusy(id);
    try {
      const p = await openCloudProject(id);
      if (!p) return toast('Project not found or you no longer have access', 'error');
      setProject(p);
      navigate('overview');
    } catch (e) {
      toast(`Couldn’t open that project: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirm) return;
    const { id, name, owned } = confirm;
    setConfirm(null);
    setBusy(id);
    try {
      // Move off the project first, so nothing saves into it while it is being deleted.
      if (id === project.id) await openOwnWork(id);
      if (owned) await deleteProject(id);
      else if (user) {
        // Leaving rewrites the member list without you, so it needs the current list.
        const members = id === project.id ? project.members : (await openCloudProject(id))?.members;
        if (!members) throw new Error('Couldn’t load that project to leave it. Try again.');
        await leaveProject({ id, members }, user.uid);
      }
      toast(owned ? `Deleted “${name}”` : `You left “${name}”`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const rows = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      <PageHeader
        title="Your projects"
        icon="folder_open"
        subtitle="Open a project, start a new one, or delete ones you no longer need."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="add" /> New project
          </button>
        }
      />
      <div className="page-inner">
        {rows.length === 0 ? (
          <div className="empty">No projects yet. Start one with New project.</div>
        ) : (
          <div className="grid grid-3 stack-mobile">
            {rows.map((p) => {
              const owned = p.owned !== false;
              const current = p.id === project.id;
              return (
                <div key={p.id} className="card card-pad col" style={{ gap: 8, borderColor: current ? 'var(--blue)' : undefined }}>
                  <div className="row" style={{ gap: 8 }}>
                    <Icon name={owned ? 'home_work' : 'folder_shared'} style={{ color: 'var(--text-2)' }} />
                    <b className="grow text-ellipsis" title={p.name}>
                      {p.name}
                    </b>
                    {current && <span className="chip blue">Open now</span>}
                  </div>
                  <div className="small muted">
                    {owned ? 'Yours' : p.sharedBy ? `Shared by ${p.sharedBy}` : `Shared with you as ${roleLabel(p.role)}`}
                    {p.updatedAt ? ` · changed ${timeAgo(p.updatedAt)}` : ''}
                  </div>
                  <div className="row" style={{ gap: 8, marginTop: 4 }}>
                    <button className="btn btn-tonal btn-sm" onClick={() => open(p.id)} disabled={busy === p.id}>
                      {busy === p.id ? <Spinner size={16} /> : <Icon name="open_in_new" />} {current ? 'Back to it' : 'Open'}
                    </button>
                    <div className="grow" />
                    <button className="btn btn-text btn-sm" style={{ color: 'var(--red)' }} onClick={() => setConfirm({ id: p.id, name: p.name, owned })} disabled={busy === p.id}>
                      <Icon name={owned ? 'delete' : 'logout'} /> {owned ? 'Delete' : 'Leave'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
      {confirm && (
        <Dialog
          title={confirm.owned ? `Delete “${confirm.name}”?` : `Leave “${confirm.name}”?`}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="btn btn-text" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={remove}>
                {confirm.owned ? 'Delete for everyone' : 'Leave'}
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            {confirm.owned
              ? 'This removes the project for you and everyone you invited: the model, revisions, crit messages, schedule and files. It can’t be undone.'
              : 'You will need a new invite to come back. Your messages stay in the project.'}
          </p>
        </Dialog>
      )}
    </>
  );
}
