import { create } from 'zustand';
import type { AISource } from '../model/types';

export type AIMode = 'auto' | 'local-only' | 'cloud-first';
export type DeviceStatus = 'checking' | 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

export interface AILogEntry {
  id: string;
  at: number;
  requestType: string;
  label: string;
  inferenceMode: string;
  source: AISource | 'blocked' | 'error';
  latencyMs: number;
  promptChars: number;
  validated: boolean;
  retriedInCloud?: boolean;
  tokens?: number;
  note?: string;
}

interface AIState {
  mode: AIMode;
  device: DeviceStatus;
  downloadProgress: number | null;
  log: AILogEntry[];
  busy: Record<string, boolean>;
  setMode: (m: AIMode) => void;
  setDevice: (s: DeviceStatus) => void;
  setProgress: (p: number | null) => void;
  push: (e: AILogEntry) => void;
  setBusy: (key: string, v: boolean) => void;
  clear: () => void;
}

const savedMode = (() => {
  try {
    return (localStorage.getItem('archimind.aiMode') as AIMode) || 'auto';
  } catch {
    return 'auto';
  }
})();

export const useAI = create<AIState>((set) => ({
  mode: savedMode,
  device: 'checking',
  downloadProgress: null,
  log: [],
  busy: {},
  setMode: (mode) => {
    try {
      localStorage.setItem('archimind.aiMode', mode);
    } catch {
      /* storage unavailable */
    }
    set({ mode });
  },
  setDevice: (device) => set({ device }),
  setProgress: (downloadProgress) => set({ downloadProgress }),
  push: (e) => set((s) => ({ log: [e, ...s.log].slice(0, 200) })),
  setBusy: (key, v) => set((s) => ({ busy: { ...s.busy, [key]: v } })),
  clear: () => set({ log: [] }),
}));
