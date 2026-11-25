import { useEffect, useState } from 'react';
import { useRoute, navigate } from '../ui/router';
import { useStudio, roleLabel } from '../state/store';
import { useAuth } from '../firebase/auth';
import { acceptInvite } from '../firebase/projects';
import { openCloudProject } from '../firebase/sync';
import { firebaseConfigured } from '../firebase/config';
import { Icon, Spinner } from '../ui/common';
import { ROLE_COLORS } from '../ui/Shell';
import type { UserRole } from '../model/types';

const DEMO_NAME = 'Ada Mensah';

/** Accepts an invite link: #/join?code=… (Firestore) or #/join?local=…&role=… (demo). */
export function JoinPage() {
  const { params } = useRoute();
  const user = useAuth((s) => s.user);
  const ready = useAuth((s) => s.ready);
  const me = useStudio((s) => s.me);
  const setMe = useStudio((s) => s.setMe);
  const setProject = useStudio((s) => s.setProject);
  const openLocal = useStudio((s) => s.openLocalProject);
  const toast = useStudio((s) => s.toast);
  const [error, setError] = useState<string | null>(null);
  // Guests start with the demo name; ask for a real one before joining.
  const needsName = !me.name || me.name === DEMO_NAME;
  // Google accounts already have a name; only ask when there is none.
  const [name, setName] = useState(needsName ? (user?.displayName ?? '') : me.name);
  const [named, setNamed] = useState(!needsName || !!user?.displayName);
  const code = params.get('code');
  const local = params.get('local');
  const role = (params.get('role') as UserRole) || 'lecturer';

  useEffect(() => {
    if (local) {
      if (openLocal(local) || useStudio.getState().project.id === local) {
        setMe({ role, color: ROLE_COLORS[role] });
        toast(`Joined as ${roleLabel(role)}`, 'success');
        navigate('crit');
      } else setError('That project is not in this browser. Demo invites only work between tabs of the same browser.');
      return;
    }
    if (!code) {
      setError('This invite link is incomplete.');
      return;
    }
    if (!firebaseConfigured) {
      setError('Invites need a Firebase project. Ask the sender for the hosted app link.');
      return;
    }
    if (!ready || !user || !named) return;
    let cancelled = false;
    (async () => {
      try {
        const inv = await acceptInvite(code, user.uid, useStudio.getState().me);
        const p = await openCloudProject(inv.projectId);
        if (cancelled) return;
        if (!p) throw new Error('Could not open the project.');
        setProject(p);
        setMe({ role: inv.role, color: ROLE_COLORS[inv.role] });
        toast(`Joined “${p.name}” as ${roleLabel(inv.role)}`, 'success');
        navigate('crit');
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, local, ready, user?.uid, named]);

  return (
    <div className="page-inner" style={{ maxWidth: 520, paddingTop: 64 }}>
      <div className="card card-pad" style={{ textAlign: 'center' }}>
        {error ? (
          <>
            <Icon name="link_off" size={40} style={{ color: 'var(--red)' }} />
            <h2 style={{ fontSize: 20, margin: '10px 0 6px' }}>Couldn’t join</h2>
            <div className="muted" style={{ marginBottom: 16 }}>
              {error}
            </div>
            <button className="btn btn-primary" onClick={() => navigate('overview')}>
              Go to ArchiMind
            </button>
          </>
        ) : !named && code ? (
          <form
            className="col"
            style={{ gap: 12, textAlign: 'left' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              setMe({ name: name.trim().slice(0, 40) });
              setNamed(true);
            }}
          >
            <Icon name="waving_hand" size={36} style={{ color: 'var(--blue)', alignSelf: 'center' }} />
            <h2 style={{ fontSize: 20, margin: 0, textAlign: 'center' }}>You have been invited to a crit</h2>
            <div className="field">
              <label htmlFor="join-name">Your name, as others will see it</label>
              <input id="join-name" className="input" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="For example: Dr. Bello" />
            </div>
            <button className="btn btn-primary" type="submit" disabled={!name.trim()} style={{ alignSelf: 'flex-end' }}>
              <Icon name="login" /> Join
            </button>
          </form>
        ) : (
          <>
            <Spinner size={32} />
            <h2 style={{ fontSize: 20, margin: '12px 0 6px' }}>Joining the crit…</h2>
            <div className="muted">Checking your invite{code ? ' with Firestore' : ''}.</div>
          </>
        )}
      </div>
    </div>
  );
}
