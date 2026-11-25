/**
 * Firebase Authentication: Google sign-in. Everyone has their own account, projects and
 * profile. People who used an older guest session keep everything: signing in with
 * Google links that guest account (same uid) instead of creating a new one.
 * Guest sign-in remains only on the local development server, for testing.
 */
import {
  GoogleAuthProvider,
  getRedirectResult,
  linkWithPopup,
  linkWithRedirect,
  onAuthStateChanged,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { create } from 'zustand';
import { getFirebase, track } from './config';

export interface AuthUser {
  uid: string;
  displayName: string | null;
  email: string | null;
  photoURL: string | null;
  isAnonymous: boolean;
  provider: string;
}

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  error: string | null;
}

export const useAuth = create<AuthState>(() => ({ user: null, ready: false, error: null }));

/** Guest (anonymous) accounts are only for local development and testing. */
export const GUEST_ALLOWED = import.meta.env.DEV || (typeof location !== 'undefined' && location.hostname === 'localhost' && location.port === '4173');

const toUser = (u: User): AuthUser => ({
  uid: u.uid,
  displayName: u.displayName,
  email: u.email,
  photoURL: u.photoURL,
  isAnonymous: u.isAnonymous,
  provider: u.isAnonymous ? 'anonymous' : u.providerData[0]?.providerId ?? 'password',
});

let started = false;
export function startAuth() {
  const fb = getFirebase();
  if (!fb || started) {
    if (!fb) useAuth.setState({ ready: true });
    return;
  }
  started = true;
  let attempt = 0;
  const guest = () => {
    signInAnonymously(fb.auth)
      .then(() => useAuth.setState({ error: null }))
      .catch((e) => {
        const msg = (e as { code?: string; message?: string }).code ?? (e as Error).message;
        console.warn('[ArchiMind] anonymous sign-in failed, retrying:', msg);
        useAuth.setState({ error: msg, ready: true });
        if (attempt++ < 6 && !fb.auth.currentUser) setTimeout(guest, Math.min(20000, 1500 * 2 ** attempt));
      });
  };
  onAuthStateChanged(fb.auth, (u) => {
    useAuth.setState({ user: u ? toUser(u) : null, ready: true, ...(u ? { error: null } : {}) });
    if (!u && GUEST_ALLOWED) guest();
  });
  completeRedirectSignIn();
}

export function onUser(cb: (u: AuthUser | null) => void) {
  startAuth();
  cb(useAuth.getState().user);
  return useAuth.subscribe((s, prev) => {
    if (s.user?.uid !== prev.user?.uid) cb(s.user);
  });
}

/** Plain-language messages for the sign-in errors people actually hit. */
function friendlyAuthError(e: unknown): Error {
  const code = (e as { code?: string }).code ?? '';
  const map: Record<string, string> = {
    'auth/popup-closed-by-user': 'The Google window was closed before signing in finished.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site, or try again.',
    'auth/unauthorized-domain': 'This web address is not allowed to sign in yet. Add it under Authentication, Settings, Authorized domains in the Firebase console.',
    'auth/operation-not-allowed': 'Google sign-in is switched off for this project. Turn it on under Authentication, Sign-in method.',
    'auth/network-request-failed': 'No internet connection. Check your connection and try again.',
    'auth/internal-error': 'Google sign-in failed inside the browser. Try again, or allow third-party cookies for this site.',
    'auth/account-exists-with-different-credential': 'An account with this email already exists with a different sign-in method.',
  };
  return new Error(map[code] ?? `Sign-in failed${code ? ` (${code.replace('auth/', '')})` : ''}. Please try again.`);
}

const POPUP_FALLBACK = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'];

export async function signInWithGoogle() {
  const fb = getFirebase();
  if (!fb) throw new Error('Sign-in is not connected in this offline demo.');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const current = fb.auth.currentUser;
  try {
    if (current?.isAnonymous) {
      try {
        const r = await linkWithPopup(current, provider);
        useAuth.setState({ user: toUser(r.user), error: null });
        track('login', { method: 'google_link' });
        return;
      } catch (e) {
        const code = (e as { code?: string }).code ?? '';
        if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
          // This Google account already has an ArchiMind account: sign in to it with the
          // credential we just received (no second pop-up, which browsers would block).
          const cred = GoogleAuthProvider.credentialFromError(e as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]);
          if (cred) {
            const r = await signInWithCredential(fb.auth, cred);
            useAuth.setState({ user: toUser(r.user), error: null });
            track('login', { method: 'google_existing' });
            return;
          }
        }
        if (POPUP_FALLBACK.includes(code)) {
          await linkWithRedirect(current, provider);
          return;
        }
        throw e;
      }
    }
    try {
      const r = await signInWithPopup(fb.auth, provider);
      useAuth.setState({ user: toUser(r.user), error: null });
      track('login', { method: 'google' });
    } catch (e) {
      if (POPUP_FALLBACK.includes((e as { code?: string }).code ?? '')) {
        await signInWithRedirect(fb.auth, provider);
        return;
      }
      throw e;
    }
  } catch (e) {
    console.warn('[ArchiMind] Google sign-in failed:', (e as { code?: string }).code, e);
    const friendly = friendlyAuthError(e);
    useAuth.setState({ error: friendly.message });
    throw friendly;
  }
}

/** Finish a redirect sign-in (used when the browser blocks pop-ups). */
export async function completeRedirectSignIn() {
  const fb = getFirebase();
  if (!fb) return;
  try {
    const r = await getRedirectResult(fb.auth);
    if (r?.user) {
      useAuth.setState({ user: toUser(r.user), error: null });
      track('login', { method: 'google_redirect' });
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    if (code === 'auth/credential-already-in-use') {
      const cred = GoogleAuthProvider.credentialFromError(e as Parameters<typeof GoogleAuthProvider.credentialFromError>[0]);
      if (cred) await signInWithCredential(fb.auth, cred).catch(() => undefined);
      return;
    }
    useAuth.setState({ error: friendlyAuthError(e).message });
  }
}

export async function signOutUser() {
  const fb = getFirebase();
  if (!fb) return;
  await signOut(fb.auth);
  if (GUEST_ALLOWED) await signInAnonymously(fb.auth);
}
