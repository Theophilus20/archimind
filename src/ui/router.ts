import { useSyncExternalStore } from 'react';

export type Route = 'overview' | 'brief' | 'import' | 'studio' | 'review' | 'crit' | 'schedule' | 'revisions' | 'ai' | 'join' | 'projects';
const ROUTES: Route[] = ['overview', 'brief', 'import', 'studio', 'review', 'crit', 'schedule', 'revisions', 'ai', 'join', 'projects'];

function read(): { route: Route; params: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const route = (ROUTES.includes(path as Route) ? path : 'overview') as Route;
  return { route, params: new URLSearchParams(query ?? '') };
}

let snapshot = read();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  snapshot = read();
  listeners.forEach((l) => l());
});

export function useRoute() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}

export function navigate(route: Route, params?: Record<string, string>) {
  const q = params ? `?${new URLSearchParams(params)}` : '';
  location.hash = `#/${route}${q}`;
}
