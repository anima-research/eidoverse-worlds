// Committed skeleton used by the wing/hair and lifecycle regression gates.
import { readFileSync } from 'node:fs';
import { humanBones, worldPositions, isVrm0 } from './rig-load.mjs';
export const dollGltf = JSON.parse(readFileSync(new URL('../spec/fixtures/ammodoll-rig.json', import.meta.url), 'utf8'));
const bones = humanBones(dollGltf), wp = worldPositions(dollGltf);
const P = Object.fromEntries(Object.entries(bones).map(([name, node]) => [name, wp(node)]));
const nodeOf = new Map(Object.entries(bones).map(([name, node]) => [node, name]));
const parent = new Map();
dollGltf.nodes.forEach((n, i) => (n.children ?? []).forEach(c => parent.set(c, i)));
const realParent = {};
for (const [name, node] of Object.entries(bones)) {
  let p = parent.get(node);
  while (p !== undefined && !nodeOf.has(p)) p = parent.get(p);
  realParent[name] = p === undefined ? null : nodeOf.get(p);
}
export const wingRig = { name: 'mythos-wings-fixture', P, realParent, vrm0: isVrm0(dollGltf), boneCount: Object.keys(P).length };
// Exercise the absence contract too, without needing another external asset.
const bareP = Object.fromEntries(Object.entries(P).filter(([name]) => !/Thumb|Index|Middle|Ring|Little/.test(name)).map(([name, p]) => [name, p.clone()]));
export const bareRig = { ...wingRig, name: 'fixture-without-digits', P: bareP,
  realParent: Object.fromEntries(Object.keys(bareP).map(name => [name, realParent[name]])), boneCount: Object.keys(bareP).length };
