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
check('fold emits an explicit true', JSON.stringify(wingFoldPresence(true)) === '{"wingsFolded":true}');
check('unfold emits an explicit false (absence is not release)',
  JSON.stringify(wingFoldPresence(false)) === '{"wingsFolded":false}');
const avatar: any = { wingsFolded: false };
check('remote renderer consumes fold', applyWingFoldPresence(avatar, { wingsFolded: true }) && avatar.wingsFolded);
check('remote renderer consumes unfold', applyWingFoldPresence(avatar, { wingsFolded: false }) && !avatar.wingsFolded);
check('legacy/absent field abstains', !applyWingFoldPresence(avatar, {}) && !avatar.wingsFolded);
const ownState: any = { wingsFolded: false };
const ownAvatar: any = { wingsFolded: false };
applyOwnedWingFold(ownState, ownAvatar, true);
check('the real owner operation joins local rig state to the wire field',
  ownAvatar.wingsFolded === true && wingFoldPresence(ownState.wingsFolded).wingsFolded === true);

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
check('headless body folds without a fly grant', ag.wingsFolded === true && /wings folded/.test(folded), folded);
check('a ground posture does not create a position-owning flight integrator', ag.flight == null);
check('takeoff remains separately denied', /cannot fly|not granted/.test(await ag.takeOff()));
ag.myRights = { role: 'builder', fly: true };
check('a granted body still cannot take off while folded', /wings folded/.test(await ag.takeOff()));
const opened = await ag.foldWings(false);
check('and unfolds without granting propulsion', ag.wingsFolded === false && /wings open/.test(opened), opened);
check('unfold tells the truth when propulsion remains denied', (() => {
  ag.myRights = { role: 'builder', fly: false };
  ag.wingsFolded = true; ag.flight = null;
  return true;
})() && /still not granted/.test(await ag.foldWings(false)));
ag.myRights = { role: 'builder', fly: true };
check('after unfold, a granted body can take off', /took off/.test(await ag.takeOff()));
const sent: any[] = [];
ag.wingsFolded = true;
ag.joined = true;
ag.ws = { send: (raw: string) => sent.push(JSON.parse(raw)) };
ag.tick();
check('the real headless tick puts fold state on the presence wire',
  sent.some((m) => m.type === 'pose' && m.pose?.wingsFolded === true));
ag.joined = false;
const wingless: any = new WorldAgent({ name: 'wingless', world: 'fold-bench' });
wingless.bodyBoneNames = ['Hip', 'Spine02', 'Head'];
wingless.loadBodyBones = async () => wingless.bodyBoneNames;
check('a wingless rig fails honestly', /no animatable wings/.test(await wingless.foldWings(true)));
wingless.wingsFolded = true;
check('a wingless swap can always release a carried folded posture',
  /posture released/.test(await wingless.foldWings(false)) && wingless.wingsFolded === false);

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
  /setFolded\(r\.wingsFolded === true\)/.test(mainSrc));
check('newly loaded and swapped bodies use one fold-aware owner',
  /me\.wingsFolded = folded\(\)/.test(mybodySrc) &&
  (mybodySrc.match(/setMe\(/g) ?? []).length >= 3);
check('browser owner path joins controller state to the semantic wire field',
  /wingsFolded = applyOwnedWingFold\(myState, me, fold\)/.test(controllerSrc));
check('browser toggle asks the current rig for physical wing evidence',
  /inspectBody\(flightBones \?\? \[\]\)\.canAnimateWings/.test(controllerSrc));
check('settled pose preserves unknown semantic fields for late join',
  /const \{ emote: _emote, \.\.\.still \} = pose/.test(serverSrc));
check('headless reconnect restores its own fold state',
  /this\.wingsFolded = msg\.restore\.wingsFolded === true/.test(agentSrc));
check('text-tier perception reports the public silhouette',
  /wings folded/.test(agentSrc) && /wings-fold/.test(agentSrc));
const foldActs: string[] = [];
const watcher: any = new WorldAgent({ name: 'watcher', world: 'fold-bench' });
watcher.gate = { act: (_id: string, key: string) => foldActs.push(key) };
watcher.noteActs('mythos', null, { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', wingsFolded: true });
check('first sighting establishes a fold baseline without inventing an act', foldActs.length === 0);
watcher.noteActs('mythos', { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', wingsFolded: false },
  { p: [0,0,0], yaw: 0, speed: 0, clip: 'idle', wingsFolded: true });
check('an observed explicit edge announces the fold once',
  foldActs.length === 1 && foldActs[0] === 'wings-fold');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
