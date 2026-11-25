export type Unit = 'mm' | 'm' | 'ft';

/** Parse "41'0\"", "41 ft 6 in", "12.5" (in the chosen unit) into millimetres. */
export function parseLength(value: string, unit: Unit): number {
  const v = value.trim().toLowerCase();
  if (!v) return 0;
  const ftin = v.match(/^(\d+(?:\.\d+)?)\s*(?:'|’|ft|feet)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|”|in|inch|inches)?)?$/);
  if (ftin) return Number(ftin[1]) * 304.8 + Number(ftin[2] ?? 0) * 25.4;
  const inches = v.match(/^(\d+(?:\.\d+)?)\s*(?:"|in|inch|inches)$/);
  if (inches) return Number(inches[1]) * 25.4;
  const metric = v.match(/^(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?$/);
  if (!metric) return 0;
  const n = Number(metric[1].replace(',', '.'));
  const u = metric[2] ?? unit;
  return u === 'm' ? n * 1000 : u === 'cm' ? n * 10 : u === 'ft' ? n * 304.8 : n;
}

