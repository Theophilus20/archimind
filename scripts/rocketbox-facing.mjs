// Which way does a Rocketbox body face? Compares toe and foot bone positions (toes point forward).
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { nodeFbxLoader } from './rocketbox-inspect.mjs';
const buf = readFileSync(process.argv[2]);
const obj = nodeFbxLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
obj.updateMatrixWorld(true);
const w = (n) => { const b = obj.getObjectByName(n); return b ? new THREE.Vector3().setFromMatrixPosition(b.matrixWorld) : null; };
const foot = w('Bip01_L_Foot'), toe = w('Bip01_L_Toe0'), head = w('Bip01_Head'), lh = w('Bip01_L_Hand');
console.log(JSON.stringify({ foot, toe, head, leftHand: lh }, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
console.log('faces', toe.z > foot.z ? '+z' : '-z', '| left hand on', lh.x > 0 ? '+x' : '-x');
