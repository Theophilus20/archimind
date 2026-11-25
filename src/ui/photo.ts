/** Read an image file as a square, 128 px JPEG data URL (fits comfortably in Firestore). */
export async function readProfilePhoto(file: File): Promise<string> {
  if (file.size > 10_000_000) throw new Error('Please choose an image under 10 MB.');
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Could not read that image.'));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('That file does not look like an image.'));
    i.src = src;
  });
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}
