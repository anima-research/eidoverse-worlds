// wing-fold-presence-test — issue #159's exact missing wire.
//
//   bun tools/wing-fold-presence-test.ts
//
// Folding is a semantic body posture on the existing lossy presence plane.
// It is independent of propulsion permission, carried by browser and headless
// owners, rendered by remote clients, and retained in the settled pose used for
// reconnect/late join. No rig-specific quaternion crosses the wire.

import { readFileSync } from 'node:fs';
import { wingFoldPresence, applyWingFoldPresence, applyOwnedWingFold } from '../shared/wingpresence.js';
import { WorldAgent } from '../mcpl/agent.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('\nSEMANTIC FIELD');
check('fold emits the named pose wings-folded (R 10-17: a pose by name, not a boolean)', JSON.stringify(wingFoldPresence(true)) === '{"poses":["wings-folded"]}');
check('unfold emits an explicit empty list (absence is not release)',
  JSON.stringify(wingFoldPresence(false)) === '{"poses":[]}');
const avatar: any = { wingsFolded: false };
check('remote renderer consumes fold', applyWingFoldPresence(avatar, { poses: ['wings-folded'] }) && avatar.wingsFolded);
check('remote renderer consumes unfold', applyWingFoldPresence(avatar, { poses: [] }) && !avatar.wingsFolded);
check('an older sample\'s boolean wingsFolded still reads as the pose', applyWingFoldPresence(avatar, { wingsFolded: true }) && avatar.wingsFolded && applyWingFoldPresence(avatar, { wingsFolded: false }) && !avatar.wingsFolded);
check('legacy/absent field abstains', !applyWingFoldPresence(avatar, {}) && !avatar.wingsFolded);
const ownState: any = { wingsFolded: false };
const ownAvatar: any = { wingsFolded: false };
applyOwnedWingFold(ownState, ownAvatar, true);
check('the real owner operation joins local rig state to the wire field',
  ownAvatar.wingsFolded === true && wingFoldPresence(ownState.wingsFolded).poses.includes('wings-folded'));

console.log('\nBODY AUTONOMY');
const ag: any = new WorldAgent({ name: 'mythos', world: 'fold-bench' });
ag.bodyBoneNames = [
  'Hip', 'Spine02', 'Head',
  'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1',
  'L_Wing_Lower', 'R_Wing_Lower',
];
ag.loadBodyBones = async () => ag.bodyBoneNames;
ag.myRights = { role: 'builder', fly: false };
const folded = await ag.foldWings(true);
check('headless body folds without a fly grant', ag.wingsFolded === true && folded.ok && /wings folded/.test(folded.text), folded.text);
check('a ground posture does not create a position-owning flight integrator', ag.flight == null);
const denied = await ag.takeOff();
check('takeoff remains separately denied', !denied.ok && /cannot fly|not granted/.test(denied.text), denied.text);
ag.myRights = { role: 'builder', fly: true };
const whileFolded = await ag.takeOff();
check('a granted body still cannot take off while folded', !whileFolded.ok && /your wings are folded/.test(whileFolded.text), whileFolded.text);
const opened = await ag.foldWings(false);
check('and unfolds without granting propulsion', ag.wingsFolded === false && opened.ok && /wings open/.test(opened.text), opened.text);
ag.myRights = { role: 'builder', fly: false };
ag.wingsFolded = true; ag.flight = null;
const deniedUnfold = await ag.foldWings(false);
check('unfold tells the truth when propulsion remains denied, and is done',
  deniedUnfold.ok && /still not granted/.test(deniedUnfold.text), deniedUnfold.text);
ag.myRights = { role: 'builder', fly: true };
const tookOff = await ag.takeOff();
check('after unfold, a granted body can take off', tookOff.ok && /took off/.test(tookOff.text), tookOff.text);
const sent: any[] = [];
ag.wingsFolded = true;
ag.joined = true;
ag.ws = { send: (raw: string) => sent.push(JSON.parse(raw)) };
ag.tick();
check('the real headless tick puts fold state on the presence wire',
  sent.some((m) => m.type === 'pose' && m.pose?.poses?.includes('wings-folded') && !('wingsFolded' in m.pose)));
ag.joined = false;
const wingless: any = new WorldAgent({ name: 'wingless', world: 'fold-bench' });
wingless.bodyBoneNames = ['Hip', 'Spine02', 'Head'];
wingless.loadBodyBones = async () => wingless.bodyBoneNames;
const winglessFold = await wingless.foldWings(true);
check('a wingless rig fails honestly', !winglessFold.ok && /no animatable wings/.test(winglessFold.text), winglessFold.text);
wingless.wingsFolded = true;
const released = await wingless.foldWings(false);
check('a wingless swap can always release a carried folded posture',
  released.ok && /posture released/.test(released.text) && wingless.wingsFolded === false, released.text);

console.log('\nACTUAL WIRE SITES');
const agentSrc = readFileSync('mcpl/agent.ts', 'utf8');
const netSrc = readFileSync('client/lib/net.js', 'utf8');
const remoteSrc = readFileSync('client/lib/remotes.js', 'utf8');
const mainSrc = readFileSync('client/main.js', 'utf8');
const mybodySrc = readFileSync('client/lib/mybody.js', 'utf8');
const controllerSrc = readFileSync('client/lib/controller.js', 'utf8');
const serverSrc = readFileSync('server/server.ts', 'utf8');
check('headless presence emits the semantic field',
  /\.\.\.wingFoldPresence\(this\.wingsFolded\)/.test(agentSrc));
check('browser presence emits the semantic field',
  /\.\.\.wingFoldPresence\(s\.wingsFolded\)/.test(netSrc));
check('mounted and unmounted remote paths both consume it through the rig',
  (remoteSrc.match(/applyWingFoldPresence\(r\.avatar, s\)/g) ?? []).length === 2);
check('own reconnect restores the semantic fold',
  /setFolded\(foldedIn\(r\) === true\)/.test(mainSrc));
check('newly loaded and swapped bodies use one fold-aware owner',
  /me\.wingsFolded = folded\(\)/.test(mybodySrc) &&
  (mybodySrc.match(/setMe\(/g) ?? []).length >= 3);
check('browser owner path joins controller state to the semantic wire field',
  /wingsFolded = applyOwnedWingFold\(myState, me, fold\)/.test(controllerSrc));
check('browser toggle asks the current rig for physical wing evidence',
  /inspectBody\(flightBones \?\? \[\]\)\.canAnimateWings/.test(controllerSrc));
check('settled pose preserves unknown semantic fields for late join',
  // live readings (mic/hear) are dropped by name; everything else rides the rest spread
  /const \{ (?:\w+: _\w+, )*\.\.\.still \} = withoutOnceAnim\(pose/.test(serverSrc));
check('headless reconnect restores its own fold state',
  /this\.wingsFolded = foldedIn\(msg\.restore\) === true/.test(agentSrc));
check('text-tier perception reports the public silhouette',
  /wings folded/.test(agentSrc) && /wings-fold/.test(agentSrc));
const foldActs: string[] = [];
const watcher: any = new WorldAgent({ name: 'watcher', world: 'fold-bench' });
watcher.gate = { act: (_id: string, key: string) => foldActs.push(key) };
watcher.noteActs('mythos', null, { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', poses: ['wings-folded'] });
check('first sighting establishes a fold baseline without inventing an act', foldActs.length === 0);
watcher.noteActs('mythos', { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', poses: [] },
  { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', poses: ['wings-folded'] });
check('an observed explicit edge announces the fold once',
  foldActs.length === 1 && foldActs[0] === 'wings-fold');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
