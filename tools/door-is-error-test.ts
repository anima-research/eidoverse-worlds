// door-is-error-test — a door tool that didn't do what it was asked says so
// with isError, so a host shows the call as failed rather than done.
//
//   bun tools/door-is-error-test.ts
//
// Acts are failed when the call didn't do what it asked (a refusal, a cut, a
// climb or glide that fell short, a name the world refused), and done when it
// did, including a no-op because what it asked for already held.

import { WorldAgent } from '../mcpl/agent.ts';
import { handleTool } from '../mcpl/tools.ts';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const said = (r: any) => String(r?.content?.[0]?.text ?? '');
const failed = (r: any) => r?.isError === true;

const WINGED = [
  'Hip', 'Spine02', 'Head',
  'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1',
  'L_Wing_Lower', 'R_Wing_Lower',
];
const ag: any = new WorldAgent({ name: 'mythos', world: 'is-error-bench' });
ag.bodyBoneNames = WINGED;
ag.loadBodyBones = async () => ag.bodyBoneNames;
const call = (name: string, a: Record<string, unknown> = {}) => handleTool({ agent: ag } as any, name, a);

console.log('\nFLIGHT');
ag.myRights = { role: 'builder', fly: false };
let r = await call('take_off');
check('a denied take_off is failed', failed(r) && /cannot fly/.test(said(r)), said(r));
r = await call('fold_wings');
check('folding wings is done', !failed(r) && /wings folded/.test(said(r)), said(r));
r = await call('fold_wings');
check('folding folded wings changes nothing, and is done', !failed(r) && /already folded/.test(said(r)), said(r));
ag.myRights = { role: 'builder', fly: true };
r = await call('take_off');
check('take_off with folded wings is failed', failed(r) && /wings folded/.test(said(r)), said(r));
r = await call('unfold_wings');
check('unfolding is done', !failed(r) && /wings open/.test(said(r)), said(r));
r = await call('land_at', { x: 0, z: 0 });
check('land_at on the ground is failed', failed(r) && /already on the ground/.test(said(r)), said(r));
r = await call('glide_to', { x: 10, z: 0 });
check('glide_to on the ground is failed', failed(r) && /take_off first/.test(said(r)), said(r));
r = await call('take_off');
check('take_off is done', !failed(r) && /took off/.test(said(r)), said(r));
// Airborne, the integrator answers a second unfold: open wings are what it asks for.
r = await call('unfold_wings');
check('unfolding open wings in flight changes nothing, and is done', !failed(r) && /already open/.test(said(r)), said(r));
// ...and a fold in the air is refused for being airborne.
r = await call('fold_wings');
check('folding in the air is failed', failed(r) && /airborne/.test(said(r)), said(r));
// A climb whose wait times out didn't reach its altitude: it isn't reported as there.
const realAwait = ag.flightAwait;
ag.flightAwait = async () => 'timed out aloft';
r = await call('climb_to', { altitude: 40 });
check('a climb that times out is failed, not reported at its target',
  failed(r) && /^timed out aloft at .*short of the climb$/.test(said(r)), said(r));
ag.flightAwait = realAwait;
// A cut during the landing's glide ends in a fall, not a landing.
const realGlide = ag.glideTo.bind(ag);
ag.glideTo = async () => { ag.flight.phase = 'RAGDOLL'; return { ok: false, text: 'cut mid-glide — you are on the ground at (1.0, 1.0)' }; };
r = await call('land_at', { x: 5, z: 5 });
check('a landing cut mid-glide is failed', failed(r) && /^cut mid-glide/.test(said(r)), said(r));
ag.glideTo = realGlide;

console.log('\nBONES NOT KNOWN');
const unread: any = new WorldAgent({ name: 'unread', world: 'is-error-bench' });
unread.bodyBoneNames = null;
unread.loadBodyBones = async () => null;
unread.myRights = { role: 'builder', fly: true };
const callU = (name: string, a: Record<string, unknown> = {}) => handleTool({ agent: unread } as any, name, a);
r = await callU('fold_wings');
check('a fold while the bones are unknown is failed', failed(r) && /^wings unchanged — /.test(said(r)), said(r));
unread.wingsFolded = true;
r = await callU('unfold_wings');
check('releasing a folded posture while the bones are unknown is done',
  !failed(r) && /^folded-wing posture released — /.test(said(r)) && unread.wingsFolded === false, said(r));

console.log('\nOTHER TOOLS');
r = await call('spawn', {});
check('spawn with no model is failed', failed(r) && /no model/.test(said(r)), said(r));
r = await call('place', { id: 'nothing-here', x: 0, z: 0 });
check('place of an unknown entity is failed', failed(r) && /no entity nothing-here/.test(said(r)), said(r));
r = await call('posture', { kind: 'cartwheel' });
check('an unknown posture is failed, with the kinds', failed(r) && /posture kinds/.test(said(r)), said(r));
r = await call('emote', { name: 'juggle' });
check('an unknown emote is failed, with the names', failed(r) && /^emotes: /.test(said(r)), said(r));
r = await call('face', {});
check('face with neither a target nor x and z is failed', failed(r) && /pass x\+z or target/.test(said(r)), said(r));
r = await call('face', { target: 'nobody' });
check('face of an unknown target is failed', failed(r) && /no such target: nobody/.test(said(r)), said(r));
r = await call('library_preview', {});
check('library_preview with no name is failed', failed(r) && /pass `name`/.test(said(r)), said(r));
r = await call('reach', {});
check('reach with no target is failed', failed(r) && /^reach needs a target/.test(said(r)), said(r));
r = await call('reach', { who: 'someone' });
check('reaching for someone with no point is failed', failed(r) && /needs `point` too/.test(said(r)), said(r));
r = await call('reach', { point: 'elbow-of-the-moon' });
check('an unknown contact point is failed', failed(r) && /unknown contact point/.test(said(r)), said(r));
r = await call('ragdoll', {});
check('ragdoll with no target is failed', failed(r) && /ragdoll needs a `target`/.test(said(r)), said(r));
r = await call('animate', { tracks: {}, dur: 1 });
check('animate with no usable track is failed', failed(r) && /^nothing played/.test(said(r)), said(r));
r = await call('measure', {});
check('measure with no id or lib is failed', failed(r) && /^measure wants/.test(said(r)), said(r));
r = await call('check_model', { id: 'nothing-here' });
check('check_model of an unknown thing is failed', failed(r) && /no thing called "nothing-here"/.test(said(r)), said(r));
r = await call('check_model', {});
check('check_model with neither an id nor a lib is failed', failed(r) && /^check_model needs/.test(said(r)), said(r));
r = await call('kick', {});
check('kick with no id is failed', failed(r) && /kick needs an id/.test(said(r)), said(r));
// The world's answer decides a moderation verb's result.
ag.verb = () => {};
ag.modOutcome = async () => 'refused: only a world owner can ban';
r = await call('ban', { id: 'someone' });
check('a ban the world refused is failed, with its words', failed(r) && /^refused: only a world owner can ban$/.test(said(r)), said(r));
ag.modOutcome = async () => 'banned someone';
r = await call('ban', { id: 'someone' });
check('a ban the world confirmed is done', !failed(r) && said(r) === 'banned someone', said(r));
ag.modOutcome = async () => null;
r = await call('ban', { id: 'someone' });
check('a ban sent with no echo yet is not failed', !failed(r) && /no echo from the world yet/.test(said(r)), said(r));
ag.sendMod = () => {};
r = await call('list_bans', {});
check('a ban list that never arrives is failed', failed(r) && /no reply from the world/.test(said(r)), said(r));

console.log('\nNAMING A PLACE');
r = await call('name_place', { name: '!!' });
check('a malformed place name is failed', failed(r) && /^a place name is/.test(said(r)), said(r));
r = await call('name_place', { name: 'lookout', on: 'nothing-here' });
check('naming a place on an unknown thing is failed', failed(r) && /no thing called "nothing-here"/.test(said(r)), said(r));

console.log('\nWALK');
const walker: any = {
  pos: { x: 0, y: 0, z: 0 },
  walkStopReason: null as string | null,
  walkStall: null as string | null,
  walkTo: async () => false,
  placesAt: () => [],
  destination: (to: string) => ({ refusal: `nothing here is called "${to}"` }),
};
const walk = (a: Record<string, unknown>) => handleTool({ agent: walker } as any, 'walk_to', a);
walker.walkTo = async (_x: number, _z: number, _run: boolean, _ms: number, _tol: number, _y: unknown, _near: unknown, receipt: { refusal: string | null }) => {
  receipt.refusal = 'no route: the destination is inside a wall';
  return false;
};
r = await walk({ x: 3, z: 4 });
check('a refused walk is failed, with its reason', failed(r) && /inside a wall/.test(said(r)), said(r));
walker.walkTo = async () => false;
r = await walk({ x: 3, z: 4 });
check('a walk that stops short is failed', failed(r) && /interrupted or timed out/.test(said(r)), said(r));
r = await walk({ to: 'lookout/balcony' });
check('a walk to a place nobody named is failed', failed(r) && /nothing here is called "lookout\/balcony"/.test(said(r)), said(r));
walker.walkTo = async () => { walker.pos = { x: 3, y: 0, z: 4 }; return true; };
r = await walk({ x: 3, z: 4 });
check('an arrival is done', !failed(r) && /^arrived at/.test(said(r)), said(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
