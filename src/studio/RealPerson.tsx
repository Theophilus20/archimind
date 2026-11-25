/**
 * Realistic walkthrough people from the Microsoft Rocketbox avatar library (MIT licence,
 * © 2020 Microsoft; see public/people/LICENSE-Rocketbox.txt).
 *
 * Each person is a skinned FBX body with 1024 px WebP textures (skin, clothes, hair cards) and
 * shares motion-captured walk and idle clips with others of the same body type. A person loads
 * once and is cloned for every figure that uses them; walking blends from idle to walk with the
 * same "moving" value that drives the simple figure, so it works everywhere figures are used.
 */
import { use, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { FigureLook } from './People';

/** How the source files sit compared with ArchiMind's figures (metres, facing +z). Filled in from inspecting the files. */
export const ROCKETBOX = {
  /** Rocketbox bodies are modelled in centimetres. */
  unitScale: 0.01,
  /** Turn the body so it faces +z like the simple figure. */
  facing: 0,
  /** The bone that carries the walk's forward motion (removed so people walk in place on their own paths). */
  rootBone: 'Bip01',
};

interface Template {
  scene: THREE.Group;
  idle: THREE.AnimationClip | null;
  walk: THREE.AnimationClip | null;
}

const cache = new Map<string, Promise<Template>>();
const clipCache = new Map<string, Promise<THREE.AnimationClip | null>>();

/** An FBX loader for one person, plus a promise that settles once the body and all its textures have loaded. */
async function fbxLoader(base: string) {
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  let settle = () => {};
  const loaded = new Promise<void>((r) => (settle = r));
  const manager = new THREE.LoadingManager(() => settle(), undefined, () => undefined);
  // The FBX files name their original .tga textures; point them at the web-sized WebP copies.
  const files: [RegExp, string][] = [
    [/_body_color\.tga$/i, 'body.webp'],
    [/_body_normal\.tga$/i, 'body_n.webp'],
    [/_head_color\.tga$/i, 'head.webp'],
    [/_head_normal\.tga$/i, 'head_n.webp'],
    [/_opacity_color\.tga$/i, 'hair.webp'],
  ];
  const blank = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    for (const [re, file] of files) if (re.test(url)) return `${base}/${file}`;
    return /\.(tga|png|jpe?g|dds)$/i.test(url) ? blank : url;
  });
  return { loader: new FBXLoader(manager), loaded };
}

/** Shared walk and idle clips (prepared by scripts/rocketbox-anims.mjs: in place, trimmed, compact JSON). */
function loadClip(name: string): Promise<THREE.AnimationClip | null> {
  let p = clipCache.get(name);
  if (!p) {
    p = fetch(`/people/anim/${name}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${name}: ${r.status}`))))
      .then((json) => THREE.AnimationClip.parse(json))
      .catch(() => null);
    clipCache.set(name, p);
  }
  return p;
}

/** Physically based materials from the FBX's simple ones: soft skin and cloth, cut-out hair. */
function upgradeMaterials(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // skinned bounds don't follow the animation
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshPhongMaterial[];
    const next = mats.map((m) => {
      const map = m.map ?? null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      if (m.normalMap) m.normalMap.colorSpace = THREE.NoColorSpace;
      const hairCards = !!map && /hair|opacity/i.test(`${m.name} ${map.name ?? ''}`) || m.transparent || !!m.alphaMap;
      const mat = new THREE.MeshPhysicalMaterial({
        name: m.name,
        map,
        normalMap: m.normalMap ?? null,
        normalScale: new THREE.Vector2(1, 1),
        roughness: hairCards ? 0.55 : 0.68,
        metalness: 0,
        sheen: hairCards ? 0.6 : 0.25,
        sheenRoughness: 0.6,
        side: hairCards ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: hairCards ? 0.45 : 0,
        transparent: false,
      });
      if (map) map.anisotropy = 8;
      m.dispose();
      return mat;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
}

export function loadPerson(id: string, figure: FigureLook['figure']): Promise<Template> {
  const key = id;
  let p = cache.get(key);
  if (!p) {
    const g = figure === 'woman' ? 'f' : 'm';
    p = (async () => {
      const { loader, loaded } = await fbxLoader(`/people/${id}`);
      const [scene, idle, walk] = await Promise.all([loader.loadAsync(`/people/${id}/body.fbx`), loadClip(`${g}_idle`), loadClip(`${g}_walk`)]);
      // Build the materials only once every texture is in: a shader compiled while a normal map is
      // still empty renders the person black.
      await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
      upgradeMaterials(scene);
      scene.scale.setScalar(ROCKETBOX.unitScale);
      scene.rotation.y = ROCKETBOX.facing;
      // The clips also animate face bones these bodies don't have; keep only tracks for bones that exist.
      const fit = (c: THREE.AnimationClip | null) => (c ? new THREE.AnimationClip(c.name, c.duration, c.tracks.filter((t) => scene.getObjectByName(t.name.slice(0, t.name.lastIndexOf('.'))))) : null);
      return { scene, idle: fit(idle), walk: fit(walk) };
    })();
    // A failure is remembered for the session (the simple figure is shown instead), never retried in a loop.
    cache.set(key, p);
  }
  return p;
}

export function RealPerson({ look, phaseRef, label, tagScale = 1, makeTag }: { look: FigureLook; phaseRef: React.MutableRefObject<{ phase: number; moving: number; reach?: number }>; label?: string; tagScale?: number; makeTag?: (text: string, color: string) => { tex: THREE.Texture; w: number; h: number } }) {
  const t = use(loadPerson(look.person, look.figure));
  const body = useMemo(() => cloneSkinned(t.scene) as THREE.Group, [t]);
  const mixer = useMemo(() => new THREE.AnimationMixer(body), [body]);
  const actions = useRef<{ idle?: THREE.AnimationAction; walk?: THREE.AnimationAction }>({});
  const tag = useMemo(() => (label && makeTag ? makeTag(label, look.top) : null), [label, look.top, makeTag]);

  useEffect(() => {
    const a: typeof actions.current = {};
    // The idle is a short clip played back and forth, so it loops without a jump.
    if (t.idle) a.idle = mixer.clipAction(t.idle).setLoop(THREE.LoopPingPong, Infinity).play();
    if (t.walk) a.walk = mixer.clipAction(t.walk).play();
    // Start at a random point so people side by side don't move in lockstep.
    if (a.walk) a.walk.time = Math.random() * (t.walk?.duration ?? 1);
    if (a.idle) a.idle.time = Math.random() * (t.idle?.duration ?? 1);
    actions.current = a;
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
    };
  }, [mixer, body, t]);

  // Right arm bones, for raising a hand to door handles on top of the walk/idle animation.
  const arm = useMemo(() => ({ upper: body.getObjectByName('Bip01_R_UpperArm'), fore: body.getObjectByName('Bip01_R_Forearm') }), [body]);
  const tmp = useMemo(() => ({ parentQ: new THREE.Quaternion(), rootQ: new THREE.Quaternion(), delta: new THREE.Quaternion(), axis: new THREE.Vector3() }), []);

  useFrame((_, dt) => {
    const moving = Math.max(0, Math.min(1, phaseRef.current.moving));
    const { idle, walk } = actions.current;
    if (walk) walk.setEffectiveWeight(moving);
    if (idle) idle.setEffectiveWeight(1 - moving);
    mixer.update(Math.min(dt, 0.1));
    const reach = phaseRef.current.reach ?? 0;
    if (reach > 0.001 && arm.upper && arm.fore) {
      // Rotate about the person's own left-right axis so the arm swings forward (they face +z).
      body.getWorldQuaternion(tmp.rootQ);
      const turn = (bone: THREE.Object3D, angle: number) => {
        tmp.axis.set(-1, 0, 0).applyQuaternion(tmp.rootQ);
        bone.parent!.getWorldQuaternion(tmp.parentQ);
        // world-space rotation, expressed in the bone's parent space
        tmp.delta.setFromAxisAngle(tmp.axis.applyQuaternion(tmp.parentQ.clone().invert()), angle);
        bone.quaternion.premultiply(tmp.delta);
        bone.updateMatrixWorld(true);
      };
      turn(arm.upper, reach * 1.35);
      turn(arm.fore, reach * 0.5);
    }
  });

  return (
    <group>
      <primitive object={body} />
      {tag && (
        <sprite position={[0, 1.9 + 0.1 * tagScale, 0]} scale={[tag.w * tagScale, tag.h * tagScale, 1]}>
          <spriteMaterial map={tag.tex} depthTest={false} transparent />
        </sprite>
      )}
    </group>
  );
}
