// flight-headless-test — the path Mythos will actually fly.
//
//   bun tools/flight-headless-test.ts
//
// He flies through mcpl, not a browser, and that is a different body: the
// stand-in skeleton in mcpl/physics.ts is built from HUMANOID bones, and
// [LR]_Wing_* are not humanoid. So everything the browser proves about wings
// proves nothing here, and this file exists to stop that gap being invisible
// twice -- the hair went missing the same way and nothing noticed until
// someone read the code.
//
// No browser, no three, no DOM. Parses the shipped VRM the way the agent does
// and asserts on what the agent would receive.

import { readFileSync } from 'node:fs';
import { makeConfig, initialState, step, bodyDown, bodyRecovered, takeOff } from '../shared/flight.js';
import { DEFAULT_LEAF_FORCE, terminalOf, leafForceFor } from '../shared/leafforce.js';
import { inspectBody } from '../shared/flightbody.js';
import { devFlightProvider, resolveFlight } from '../shared/flightcap.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const VRM = 'assets/opt/eidoverse/assets/vrms/mythos-wings.vrm';
const rig: any = await import('./rig-load.mjs');

// ---- the stand-in, built exactly as mcpl/physics.ts skeletonFor() builds it
console.log('\nSTAND-IN -- what an mcpl agent actually gets');
const buf = new Uint8Array(readFileSync(VRM));
const g = rig.glbJson(buf);
const bones = rig.humanBones(g);
const wp = rig.worldPositions(g);
const P: Record<string, any> = {};
for (const [b, n] of Object.entries(bones)) if (g.nodes[n as number]) P[b] = wp(n);

const byName = new Map<string, number>();
g.nodes.forEach((n: any, i: number) => { if (n.name) byName.set(n.name, i); });
const parentOf = new Map<number, number>();
g.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));

const hairParent: Record<string, string> = {};
for (const [name, i] of byName) {
  if (!/^Hair_\d+_\d+$/.test(name)) continue;
  P[name] = wp(i);
  const pn = parentOf.get(i) != null ? g.nodes[parentOf.get(i)!]?.name : null;
  hairParent[name] = (pn && /^Hair_\d+_\d+$/.test(pn)) ? pn : 'head';
}
const wingParent: Record<string, string> = {};
for (const [name, i] of byName) {
  if (!/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(name)) continue;
  P[name] = wp(i);
  const pn = parentOf.get(i) != null ? g.nodes[parentOf.get(i)!]?.name : null;
  wingParent[name] = (pn && /^[LR]_Wing_/.test(pn)) ? pn : 'chest';
}

check(`humanoid bones present (${Object.keys(bones).length})`, Object.keys(bones).length >= 50);
check(`hair grafted (${Object.keys(hairParent).length} bones)`, Object.keys(hairParent).length > 100);
check(`WINGS grafted (${Object.keys(wingParent).length} bones)`, Object.keys(wingParent).length === 12,
      'this is the gap: humanoid-only stand-ins have none');
check('wing roots reparent to chest (no clavicle body in this rig cut)',
      Object.values(wingParent).filter(v => v === 'chest').length === 4);
check('wing segments continue their own chain',
      wingParent['L_Wing_Upper_2'] === 'L_Wing_Upper_1' &&
      wingParent['R_Wing_Lower_1'] === 'R_Wing_Lower');
// worldPositions() yields {x,y,z}, not a triple -- the first version of this
// assertion tested for an array and failed a graft that was perfectly correct.
check('every grafted bone has a finite world position in P',
      Object.keys(wingParent).every(n => {
        const v = P[n];
        return v && ['x', 'y', 'z'].every(k => Number.isFinite(v[k]));
      }));
// The wing ROOTS sit above the hips; the lower tips sweep down PAST them,
// which is what a folded wing does -- an earlier version of this asserted all
// twelve were above the hips and failed a graft that was correct. Assert the
// thing that is actually true: roots high, span wide, left and right opposed.
const roots = ['L_Wing_Upper', 'L_Wing_Lower', 'R_Wing_Upper', 'R_Wing_Lower'];
check('wing ROOTS sit above the hips',
      roots.every(n => P[n].y > P.hips.y));
check('the span is wide and mirrored',
      Math.max(...Object.keys(wingParent).map(n => Math.abs(P[n].x))) > 0.3 &&
      P['L_Wing_Upper'].x > 0 && P['R_Wing_Upper'].x < 0);

// ---- the capability, resolved the way an agent would
console.log('\nCAPABILITY -- headless, from the real bone list');
const boneNames = [...byName.keys()];
const report = inspectBody(boneNames);
check('the shipped body is flight-capable headless', report.canFly && report.canAnimateWings);
const dev = devFlightProvider({ allow: ['mythos'], label: 'headless-test' });
const grant = resolveFlight(dev, { identity: 'mythos', avatar: { boneNames } });
check('a granted agent gets a rig profile', grant.enabled === true && !!grant.profile?.digest);
check('an unlisted agent does not',
      resolveFlight(dev, { identity: 'someone', avatar: { boneNames } }).enabled === false);

// ---- a whole sortie, no renderer anywhere
console.log('\nSORTIE -- cut, leaf, ground, recover, fly again (no browser)');
const cfg = makeConfig();
const DT = 1 / 120, flat = () => 0;
let s = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: 12 }, cfg);
const seen: string[] = [];
const run = (n: number) => { for (let i = 0; i < n; i++) { s = step(cfg, s, DT, { groundY: flat }); for (const e of s.events) seen.push(e.kind); } };
run(240);
check('she flies', s.phase === 'PILOT' && s.pos.y < 30);
s = bodyDown(s, { eventId: 'headless-cut' }); seen.push(...s.events.map(e => e.kind));
check('a cut sends her limp', s.phase === 'LEAF' && s.wings === 'LIMP');
let guard = 0; while (s.phase === 'LEAF' && guard++ < 400000) run(1);
check('and she reaches the ground as a ragdoll', s.phase === 'RAGDOLL');
check('with no landing animation', !seen.includes('ground.landed'));
s = bodyRecovered(s, { eventId: 'headless-rec', recoveryGeneration: 'g1' }); seen.push(...s.events.map(e => e.kind));
guard = 0; while (s.phase === 'RECOVER' && guard++ < 400000) run(1);
check('she sits up and stands', s.phase === 'GROUND' && s.wings === 'OPEN');
s = takeOff(cfg, s); seen.push(...s.events.map(e => e.kind));
check('and takes off again', s.phase === 'PILOT');
check('the whole sortie logged its events', seen.includes('down.airborne') &&
      seen.includes('ground.ragdoll') && seen.includes('took off'));

// ---- the leaf forces, on the bodies the agent would actually have
console.log('\nLEAF FORCES -- measured on the grafted rig, not on a browser doll');
const rigJson = JSON.parse(readFileSync(
  '/Users/lariareynolds/Documents/mythos-models/ragdoll-web/rig.json', 'utf8'));
const L = DEFAULT_LEAF_FORCE;
const wingBodies = rigJson.bodies.filter((b: any) => b.worldOnly);
check(`the ragdoll has ${wingBodies.length} wing bodies to push on`, wingBodies.length === 12);
let area = 0, wingArea = 0, mass = 0, wingMass = 0;
for (const b of rigJson.bodies) {
  const d = b.halfExtents.slice().sort((x: number, y: number) => x - y);
  const a = 4 * d[1] * d[2];
  area += a; mass += b.mass;
  if (b.worldOnly) { wingArea += a; wingMass += b.mass; }
}
const share = wingArea / area;
check(`wings are ${(100 * share).toFixed(0)}% of the drag area on ${(100 * wingMass / mass).toFixed(0)}% of the mass`,
      share > 0.5, 'this is why a wingless stand-in falls wrong');
const tWing = terminalOf(L, wingBodies[0]);
const tChest = terminalOf(L, rigJson.bodies.find((b: any) => b.name === 'chest'));
check(`a wing plate terminals at ${tWing.toFixed(1)} m/s, the chest at ${tChest.toFixed(1)}`,
      tWing < tChest / 3);
const f = leafForceFor(L, { mass: 0.11, halfExtents: [0.017, 0.136, 0.096],
  vel: { x: 0, y: -6, z: 0 }, normal: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 } }, 0.4);
check('a broadside wing feels lift-ward drag', f.force.y > 0);
check('and a flutter torque, not just drag', Math.abs(f.torque.y) > 1e-6);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
