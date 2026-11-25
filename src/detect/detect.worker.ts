/// <reference lib="webworker" />
import { binarize, detect } from './detector';

self.onmessage = (e: MessageEvent<{ rgba: Uint8ClampedArray; width: number; height: number }>) => {
  try {
    const { rgba, width, height } = e.data;
    const { dark, threshold, lum } = binarize(rgba, width, height);
    const result = detect(dark, width, height, threshold, lum);
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: (err as Error).message });
  }
};
