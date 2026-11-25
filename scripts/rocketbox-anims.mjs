// Turn Rocketbox animation FBX files into compact three.js clip JSON for the walkthrough.
//  - keeps bone rotations, plus the root bone's position (up-and-down bob only for walks)
//  - removes the walk's forward travel so it loops in place (figures follow their own paths)
//  - trims idles to a short loop and drops redundant keyframes
// Usage: node scripts/rocketbox-anims.mjs <anims_dir> <out_dir>
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { nodeFbxLoader } from './rocketbox-inspect.mjs';

const [src, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const ROOT = 'Bip01';
const round = (x) => Math.round(x * 1e4) / 1e4;

for (const name of ['f_walk', 'm_walk', 'f_idle', 'm_idle']) {
  const file = join(src, `${name}.fbx`);
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    console.log(name, 'missing, skipped');
    continue;
  }
  const obj = nodeFbxLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  let clip = obj.animations[0];
  clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale') && !t.name.startsWith('Bip01_Footsteps') && (!t.name.endsWith('.position') || t.name === `${ROOT}.position`));
  const root = clip.tracks.find((t) => t.name === `${ROOT}.position`);
  const times = clip.tracks[0].times;
  const fps = Math.round((times.length - 1) / (times[times.length - 1] - times[0]));
  if (name.endsWith('walk') && root) {
    // Keep the vertical bob (y), remove travel along the ground (x, z).
    const v = root.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
  if (name.endsWith('idle')) {
    // Keep it short: played back and forth it loops without a jump, and the file stays small.
    const frames = Math.min(Math.round(5 * fps), times.length - 1);
    clip = THREE.AnimationUtils.subclip(clip, name, 0, frames, fps);
  }
  clip.name = name;
  clip.optimize();
  const json = THREE.AnimationClip.toJSON(clip);
  for (const t of json.tracks) {
    t.times = Array.from(t.times, round);
    t.values = Array.from(t.values, round);
  }
  const outFile = join(out, `${name}.json`);
  writeFileSync(outFile, JSON.stringify(json));
  console.log(`${name}: ${clip.duration.toFixed(2)} s at ${fps} fps, ${clip.tracks.length} tracks, ${(statSync(file).size / 1e6).toFixed(2)} MB FBX -> ${(statSync(outFile).size / 1e3).toFixed(0)} KB JSON`);
}
