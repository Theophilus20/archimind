/**
 * Profile photos, always current. A project keeps a copy of each person from when they joined,
 * so a photo added later would not show. Avatars ask here instead: your own photo comes straight
 * from your profile, and other people's from their profile in Firestore (fetched once, then
 * refreshed every few minutes).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { loadUserProfile } from '../firebase/projects';
import { useStudio } from '../state/store';

const usePhotos = create<{ photos: Record<string, string | null> }>(() => ({ photos: {} }));
const asked = new Map<string, number>();
const FRESH_MS = 5 * 60_000;
// Firebase user ids; the sample team's ids (u-student...) have no profile to fetch.
const isUid = (id: string) => /^[A-Za-z0-9]{20,40}$/.test(id);

function fetchPhoto(id: string) {
  const t = asked.get(id);
  if (t && Date.now() - t < FRESH_MS) return;
  asked.set(id, Date.now());
  loadUserProfile(id)
    .then((p) => {
      if (p) usePhotos.setState((s) => ({ photos: { ...s.photos, [id]: p.photo ?? null } }));
    })
    .catch(() => undefined);
}

/** The photo to show for a person: their current one if known, else the copy we were given. */
export function usePhoto(id: string | undefined, fallback?: string): string | undefined {
  const myId = useStudio((s) => s.me.id);
  const myPhoto = useStudio((s) => s.me.photo);
  const cached = usePhotos((s) => (id ? s.photos[id] : undefined));
  useEffect(() => {
    if (id && id !== myId && isUid(id)) fetchPhoto(id);
  }, [id, myId]);
  if (id && id === myId) return myPhoto ?? undefined;
  if (cached === null) return undefined; // they have no photo now
  return cached ?? fallback;
}
