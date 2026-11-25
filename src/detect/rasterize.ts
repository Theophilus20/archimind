import { straightenScan } from './detector';
/** Load PNG / JPEG / SVG / PDF into a canvas, keeping any vector text (labels, dimensions) with positions. */
export interface TextItem {
  text: string;
  x: number;
  y: number;
}

export interface Rasterized {
  name: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  dataUrl: string;
  texts: TextItem[];
  kind: 'image' | 'svg' | 'pdf';
}

function toCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}

async function loadImage(url: string) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

function finish(name: string, c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, texts: TextItem[], kind: Rasterized['kind']): Rasterized {
  let data = ctx.getImageData(0, 0, c.width, c.height);
  // A photo or scan of paper: turn it square to the page first, so walls run straight across.
  // (Exported drawings, SVG and PDF are already square.)
  if (kind === 'image') {
    const s = straightenScan(data.data, c.width, c.height);
    if (s.skew) {
      data = new ImageData(new Uint8ClampedArray(s.rgba), c.width, c.height);
      ctx.putImageData(data, 0, 0);
    }
  }
  // PNG keeps linework crisp for the underlay; fall back to JPEG for large scans.
  let dataUrl = c.toDataURL('image/png');
  if (dataUrl.length > 900_000) dataUrl = c.toDataURL('image/jpeg', 0.82);
  return { name, width: c.width, height: c.height, rgba: data.data, dataUrl, texts, kind };
}

export async function rasterizeFile(file: File | { name: string; url: string; type: string }, maxDim = 1600): Promise<Rasterized> {
  const name = file.name;
  const type = file.type || (name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.pdf') ? 'application/pdf' : '');
  const url = 'url' in file ? file.url : URL.createObjectURL(file);

  if (type === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const buf = 'url' in file ? await (await fetch(url)).arrayBuffer() : await (file as File).arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, maxDim / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const { c, ctx } = toCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvasContext: ctx, viewport, canvas: c } as unknown as Parameters<typeof page.render>[0]).promise;
    const content = await page.getTextContent();
    const texts: TextItem[] = [];
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (!it.str?.trim() || !it.transform) continue;
      const m = pdfjs.Util.transform(viewport.transform, it.transform);
      texts.push({ text: it.str.trim(), x: m[4], y: m[5] });
    }
    return finish(name, c, ctx, texts, 'pdf');
  }

  if (type === 'image/svg+xml' || name.toLowerCase().endsWith('.svg')) {
    const src = await (await fetch(url)).text();
    const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
    const svg = doc.documentElement;
    const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const sw = vb.length === 4 ? vb[2] : Number(svg.getAttribute('width')) || 1000;
    const sh = vb.length === 4 ? vb[3] : Number(svg.getAttribute('height')) || 800;
    const scale = Math.min(2, maxDim / Math.max(sw, sh));
    const { c, ctx } = toCanvas(Math.round(sw * scale), Math.round(sh * scale));
    const img = await loadImage(URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' })));
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const texts: TextItem[] = [...doc.querySelectorAll('text')].map((t) => ({ text: (t.textContent ?? '').trim(), x: (Number(t.getAttribute('x')) - (vb[0] || 0)) * scale, y: (Number(t.getAttribute('y')) - (vb[1] || 0)) * scale })).filter((t) => t.text);
    return finish(name, c, ctx, texts, 'svg');
  }

  const img = await loadImage(url);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const { c, ctx } = toCanvas(Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return finish(name, c, ctx, [], 'image');
}

/** Largest number in the drawing text that looks like a millimetre dimension. */
export function suggestDimension(texts: TextItem[]): number | null {
  let best: number | null = null;
  for (const t of texts) {
    const m = t.text.replace(/\s/g, '').match(/^(\d{1,3}(?:[,.]?\d{3})+|\d{4,6})(mm)?$/i);
    if (!m) continue;
    const n = Number(m[1].replace(/[,.]/g, ''));
    if (n >= 1000 && n <= 100000 && (!best || n > best)) best = n;
  }
  return best;
}

const TYPE_WORDS: [RegExp, string][] = [
  [/bed|master|guest|nursery/i, 'bedroom'],
  [/bath|wc|toilet|shower|ensuite|en-suite/i, 'bathroom'],
  [/living|lounge|sitting|family/i, 'living'],
  [/kitchen/i, 'kitchen'],
  [/dining/i, 'dining'],
  [/hall|entry|corridor|foyer|lobby|landing/i, 'hall'],
  [/study|office|den|library/i, 'study'],
  [/utility|laundry|store|storage|pantry|closet/i, 'utility'],
  [/garage|carport/i, 'garage'],
];

export function roomTypeFromText(s: string) {
  for (const [re, t] of TYPE_WORDS) if (re.test(s)) return t;
  return null;
}
