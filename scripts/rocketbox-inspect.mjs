// Inspect Rocketbox FBX files (bones, size, materials, animation tracks) without a browser.
// Usage: node scripts/rocketbox-inspect.mjs <file.fbx> [...]
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

/** Textures are not needed here: hand back empty ones instead of loading images (no DOM in Node). */
export function nodeFbxLoader() {
  const manager = new THREE.LoadingManager();
  const dummy = { path: '', setPath() { return this; }, load: (url) => Object.assign(new THREE.Texture(), { name: url }) };
  manager.addHandler(/.*/, dummy);
  return new FBXLoader(manager);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('rocketbox-inspect.mjs')) {
  const loader = nodeFbxLoader();
  for (const file of process.argv.slice(2)) {
    const buf = readFileSync(file);
    const obj = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const bones = [];
    const meshes = [];
    obj.traverse((o) => {
      if (o.isBone) bones.push(o.name);
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        meshes.push(`${o.name}${o.isSkinnedMesh ? ' (skinned)' : ''}: ${mats.map((m) => `${m.name}[${m.type}] map=${m.map?.name ?? '-'} normal=${m.normalMap?.name ?? '-'} alpha=${m.alphaMap?.name ?? '-'} transparent=${m.transparent}`).join(' | ')}`);
      }
    });
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    console.log(`\n## ${file.split(/[\\/]/).pop()}`);
    console.log(`size ${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}  min y ${box.min.y.toFixed(1)}  bones ${bones.length}: ${bones.slice(0, 8).join(', ')}…`);
    for (const m of meshes) console.log('mesh', m);
    for (const clip of obj.animations) {
      const pos = clip.tracks.filter((t) => t.name.endsWith('.position'));
      console.log(`clip "${clip.name}" ${clip.duration.toFixed(2)} s, ${clip.tracks.length} tracks; position tracks: ${pos.map((t) => t.name).join(', ')}`);
      for (const t of pos.slice(0, 2)) {
        const v = t.values;
        const n = v.length / 3;
        console.log(`  ${t.name}: first (${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}) last (${v[(n - 1) * 3].toFixed(1)}, ${v[(n - 1) * 3 + 1].toFixed(1)}, ${v[(n - 1) * 3 + 2].toFixed(1)}) keys ${n}`);
      }
    }
  }
}
