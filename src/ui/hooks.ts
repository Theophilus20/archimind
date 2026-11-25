import { useEffect, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';

const MOBILE_Q = '(max-width: 760px)';

export function useIsMobile() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(MOBILE_Q);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(MOBILE_Q).matches,
  );
}

export type ThemePref = 'system' | 'light' | 'dark';

interface ThemeState {
  pref: ThemePref;
  resolved: 'light' | 'dark';
  setPref: (p: ThemePref) => void;
}

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const resolve = (p: ThemePref): 'light' | 'dark' => (p === 'system' ? (systemDark() ? 'dark' : 'light') : p);
const initialPref = (() => {
  try {
    return (localStorage.getItem('archimind.theme') as ThemePref) || 'light';
  } catch {
    return 'light' as ThemePref;
  }
})();

export const useTheme = create<ThemeState>((set) => ({
  pref: initialPref,
  resolved: resolve(initialPref),
  setPref: (pref) => {
    try {
      localStorage.setItem('archimind.theme', pref);
    } catch {
      /* ignore */
    }
    set({ pref, resolved: resolve(pref) });
  },
}));

/** Applies the theme to <html data-theme> and follows the OS when set to "system". */
export function useApplyTheme() {
  const pref = useTheme((s) => s.pref);
  const resolved = useTheme((s) => s.resolved);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#17191e' : '#1f2430');
  }, [resolved]);
  useEffect(() => {
    if (pref !== 'system') return;
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => useTheme.setState({ resolved: m.matches ? 'dark' : 'light' });
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [pref]);
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, []);
  return online;
}

/** Technical details (request types, inference modes, ids, Firebase internals) are hidden unless this is on. */
export const useDevMode = create<{ on: boolean; set: (v: boolean) => void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem('archimind.dev') === '1' || new URLSearchParams(location.search).has('dev');
    } catch {
      return false;
    }
  })(),
  set: (on) => {
    try {
      localStorage.setItem('archimind.dev', on ? '1' : '0');
    } catch {
      /* ignore */
    }
    set({ on });
  },
}));
