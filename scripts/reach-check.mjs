// Check the door-handle reach on a realistic person: the right hand should move forward and up.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { nodeFbxLoader } from './rocketbox-inspect.mjs';
const id = process.argv[2] ?? 'f1';
const buf = readFileSync(`public/people/${id}/body.fbx`);
const body = nodeFbxLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
body.scale.setScalar(0.01);
const clip = THREE.AnimationClip.parse(JSON.parse(readFileSync(`public/people/anim/${id[0]}_idle.json`, 'utf8')));
clip.tracks = clip.tracks.filter((t) => body.getObjectByName(t.name.slice(0, t.name.lastIndexOf('.'))));
const mixer = new THREE.AnimationMixer(body);
mixer.clipAction(clip).play();
mixer.update(0.5);
body.updateMatrixWorld(true);
const hand = body.getObjectByName('Bip01_R_Hand');
const before = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
const rootQ = body.getWorldQuaternion(new THREE.Quaternion());
const turn = (bone, angle) => {
  const axis = new THREE.Vector3(-1, 0, 0).applyQuaternion(rootQ);
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.applyQuaternion(parentQ.clone().invert()), angle));
  bone.updateMatrixWorld(true);
};
turn(body.getObjectByName('Bip01_R_UpperArm'), 1.35);
turn(body.getObjectByName('Bip01_R_Forearm'), 0.5);
body.updateMatrixWorld(true);
const after = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld);
const f = (v) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
console.log(id, 'right hand before', f(before), 'after', f(after), '| forward', (after.z - before.z).toFixed(2), 'm, up', (after.y - before.y).toFixed(2), 'm');
