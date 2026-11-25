import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { FigureLook } from '../studio/People';

const FigurePreview3D = lazy(() => import('./FigurePreview3D'));

/** If WebGL isn't available, show the person's photo instead. */
class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Your walkthrough person: their face on small buttons, the turning 3D person in the customiser and profiles. */
export function FigurePreview({ look, size = 150 }: { look: FigureLook; size?: number }) {
  const face = <img src={`/people/${look.person}/face.webp`} alt="Your person" width={Math.round(size * (size < 100 ? 0.87 : 0.62))} height={size < 100 ? size : Math.round(size * 0.72)} className="figure-face" />;
  if (size < 100) return face;
  const waiting = (
    <div style={{ width: size * 0.62, height: size, display: 'grid', placeItems: 'center' }} aria-busy="true">
      {face}
    </div>
  );
  return (
    <Fallback fallback={waiting}>
      <Suspense fallback={waiting}>
        <FigurePreview3D look={look} size={size} />
      </Suspense>
    </Fallback>
  );
}
