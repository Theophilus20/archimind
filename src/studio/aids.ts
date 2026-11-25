/**
 * Drafting aids shared by the plan and the studio toolbar, with the names and keys common to drafting programs:
 * OSNAP (F3) object snaps, GRID (F7), ORTHO (F8) horizontal/vertical drawing, SNAP (F9) 50 mm grid snap.
 * Remembered per browser.
 */
import { create } from 'zustand';

export interface DraftingAids {
  osnap: boolean;
  grid: boolean;
  ortho: boolean;
  snap: boolean;
  /** Show dimensions: the automatic strings around the building and the ones placed by hand. */
  dims: boolean;
  /** 'drawing': black cut walls, white rooms, dimensions (construction-drawing look); 'colour': tinted rooms. */
  planStyle: 'drawing' | 'colour';
}

const KEY = 'archimind.aids';
const initial: DraftingAids = (() => {
  try {
    return { osnap: true, grid: true, ortho: true, snap: true, dims: true, planStyle: 'drawing', ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { osnap: true, grid: true, ortho: true, snap: true, dims: true, planStyle: 'drawing' };
  }
})();

type Toggle = 'osnap' | 'grid' | 'ortho' | 'snap' | 'dims';
const save = (s: DraftingAids) => {
  try {
    const { osnap, grid, ortho, snap, dims, planStyle } = s;
    localStorage.setItem(KEY, JSON.stringify({ osnap, grid, ortho, snap, dims, planStyle }));
  } catch {
    /* private mode */
  }
};
export const useAids = create<DraftingAids & { toggle: (k: Toggle) => void; setStyle: (s: DraftingAids['planStyle']) => void }>((set, get) => ({
  ...initial,
  toggle: (k) => {
    set({ [k]: !get()[k] } as Partial<DraftingAids>);
    save(get());
  },
  setStyle: (planStyle) => {
    set({ planStyle });
    save(get());
  },
}));

export const AIDS: { key: Toggle; label: string; fkey: string; hint: string }[] = [
  { key: 'osnap', label: 'OSNAP', fkey: 'F3', hint: 'Snap to wall ends, midpoints and wall lines' },
  { key: 'grid', label: 'GRID', fkey: 'F7', hint: 'Show the 1 m grid' },
  { key: 'ortho', label: 'ORTHO', fkey: 'F8', hint: 'Draw walls straight across or up and down (hold Shift to override)' },
  { key: 'snap', label: 'SNAP', fkey: 'F9', hint: 'Snap points to a 50 mm grid' },
  { key: 'dims', label: 'DIMS', fkey: '', hint: 'Show or hide all dimensions: the automatic ones around the building and the ones you add' },
];

/**
 * Messages from the command line and on-screen buttons to the plan: a typed wall length, and the
 * options while drawing a chain of walls (finish, close the shape, take back the last wall, cancel).
 */
export type DrawMessage = { type: 'length'; value: number } | { type: 'finish' } | { type: 'close' } | { type: 'undoSegment' } | { type: 'cancel' };

/** The chain of walls being drawn: how many walls so far, or null when not drawing. */
export const useDrawing = create<{ chain: number | null; setChain: (n: number | null) => void }>((set) => ({ chain: null, setChain: (chain) => set({ chain }) }));
const listeners = new Set<(m: DrawMessage) => void>();
export const drawBus = {
  send: (m: DrawMessage) => listeners.forEach((l) => l(m)),
  listen: (l: (m: DrawMessage) => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};
