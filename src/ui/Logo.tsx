import { useId } from 'react';

/**
 * ArchiMind brand mark: a gable house drawn in two strokes (roof + walls) with an AI
 * spark at its heart: architecture plus intelligence. Built on a 48-unit grid with
 * 4.5 / 3.2 unit strokes so it stays crisp from 16 px favicons to large headers.
 */
export function LogoMark({ size = 28, mono = false }: { size?: number; mono?: boolean }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="ArchiMind">
      <defs>
        <linearGradient id={`bg${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#24324a" />
          <stop offset="1" stopColor="#0f1724" />
        </linearGradient>
        <linearGradient id={`roof${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ffca28" />
          <stop offset="1" stopColor="#ff7043" />
        </linearGradient>
        <linearGradient id={`spark${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8ab4f8" />
          <stop offset="1" stopColor="#c58af9" />
        </linearGradient>
      </defs>
      {!mono && <rect width="48" height="48" rx="12" fill={`url(#bg${id})`} />}
      <path d="M9.5 25.5 24 12l14.5 13.5" fill="none" stroke={mono ? 'currentColor' : `url(#roof${id})`} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 27.5v8.5h19v-8.5" fill="none" stroke={mono ? 'currentColor' : '#e8eaed'} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M24 26.2c.5 2.5 1.7 3.7 4.2 4.2-2.5.5-3.7 1.7-4.2 4.2-.5-2.5-1.7-3.7-4.2-4.2 2.5-.5 3.7-1.7 4.2-4.2Z"
        fill={mono ? 'currentColor' : `url(#spark${id})`}
      />
    </svg>
  );
}

/** Mark + wordmark lock-up. */
export function Logo({ size = 28, wordmark = false, light = true }: { size?: number; wordmark?: boolean; light?: boolean }) {
  if (!wordmark) return <LogoMark size={size} />;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.36 }}>
      <LogoMark size={size} />
      <span style={{ fontSize: size * 0.68, letterSpacing: '-0.01em', color: light ? 'inherit' : '#202124', lineHeight: 1 }}>
        Archi<b style={{ fontWeight: 600 }}>Mind</b>
      </span>
    </span>
  );
}
