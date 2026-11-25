import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { HumanFigure, type FigureLook } from '../studio/People';
import { loadPerson } from '../studio/RealPerson';

/** The walkthrough figure itself, turning slowly, so the customiser shows exactly what others see. */
function Turntable({ look }: { look: FigureLook }) {
  const g = useRef<THREE.Group>(null);
  const anim = useRef({ phase: 0, moving: 0 });
  useFrame((_, dt) => {
    if (g.current) g.current.rotation.y += dt * 0.45;
  });
  return (
    <group ref={g} rotation={[0, 0.35, 0]}>
      <HumanFigure look={look} phaseRef={anim} />
    </group>
  );
}

/**
 * Full-length preview. The camera frames about 2.15 m so the head and feet always show. When the
 * person changes, the current one stays on screen until the new one has loaded (no blank gap).
 */
export default function FigurePreview3D({ look, size }: { look: FigureLook; size: number }) {
  const [shown, setShown] = useState(look);
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (look.person === shown.person && look.figure === shown.figure) return;
    let alive = true;
    setSwitching(true);
    loadPerson(look.person, look.figure)
      .catch(() => undefined)
      .finally(() => {
        if (!alive) return;
        setShown(look);
        setSwitching(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look.person, look.figure]);
  return (
    <div style={{ width: size * 0.62, height: size, position: 'relative' }} className="figure-preview-3d" role="img" aria-label="Preview of your figure">
      <Canvas camera={{ position: [0, 0.98, 4.1], fov: 30 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }} onCreated={({ camera }) => camera.lookAt(0, 0.92, 0)} style={{ display: 'block' }}>
        <hemisphereLight args={['#ffffff', '#b8a690', 1.1]} />
        <directionalLight position={[1.6, 2.6, 2.2]} intensity={2.2} />
        <directionalLight position={[-2, 1.5, -1.5]} intensity={0.9} color="#cfe0ff" />
        <ambientLight intensity={0.25} />
        <Turntable look={shown} />
      </Canvas>
      {switching && <span className="figure-loading" aria-live="polite">Loading…</span>}
    </div>
  );
}
