/**
 * Cloud Storage for large assets: source drawings, crit snapshots and GLB exports.
 * Firestore keeps only their download URLs, as the architecture recommends.
 */
import { getDownloadURL, ref, uploadBytes, uploadString } from 'firebase/storage';
import { getFirebase, traced } from './config';

export const storageAvailable = () => Boolean(getFirebase()?.storage && getFirebase()?.auth.currentUser);

export async function uploadDataUrl(path: string, dataUrl: string, meta: Record<string, string> = {}): Promise<string | null> {
  const fb = getFirebase();
  if (!fb?.storage || !fb.auth.currentUser) return null;
  const contentType = dataUrl.slice(5, dataUrl.indexOf(';')) || 'application/octet-stream';
  return traced('storage_upload', async () => {
    const r = ref(fb.storage!, path);
    await uploadString(r, dataUrl, 'data_url', { contentType, customMetadata: { uploadedBy: fb.auth.currentUser!.uid, ...meta } });
    return getDownloadURL(r);
  }, { kind: path.split('/')[2] ?? 'file' });
}

export async function uploadBlob(path: string, blob: Blob, meta: Record<string, string> = {}): Promise<string | null> {
  const fb = getFirebase();
  if (!fb?.storage || !fb.auth.currentUser) return null;
  return traced('storage_upload', async () => {
    const r = ref(fb.storage!, path);
    await uploadBytes(r, blob, { contentType: blob.type || 'application/octet-stream', customMetadata: { uploadedBy: fb.auth.currentUser!.uid, ...meta } });
    return getDownloadURL(r);
  }, { kind: path.split('/')[2] ?? 'file' });
}
