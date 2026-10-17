// door-is-error-test — a door tool that didn't do what it was asked says so
// with isError, so a host shows the call as failed rather than done.
//
//   bun tools/door-is-error-test.ts
//
// Acts are failed when the call didn't do what it asked (a refusal, a cut, a
// climb or glide that fell short, a name the world refused), and done when it
// did, including a no-op because what it asked for already held.

// Whispers and rehearsal are switched by the environment when tools.ts loads,
// so their "off" answers are checked in a child run of this file (SWITCHED OFF,
// below), and this run loads tools.ts with rehearsal on.
if (process.env.DOOR_IS_ERROR_CHILD === 'switched-off') {
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const { handleTool } = await import('../mcpl/tools.ts');
  const off: any = new WorldAgent({ name: 'switched-off', world: 'is-error-bench' });
  const answer = async (name: string, a: Record<string, unknown>) => {
    const r: any = await handleTool({ agent: off } as any, name, a);
    return { failed: r?.isError === true, text: String(r?.content?.[0]?.text ?? '') };
  };
  console.log(JSON.stringify({
    whisper: await answer('whisper', { to: 'someone', text: 'hello' }),
    rehearse: await answer('rehearse_down', {}),
  }));
  process.exit(0);
}
process.env.EIDO_FLIGHT_REHEARSAL = '1';
process.env.EIDO_WHISPERS_ENABLED = '1';
const { WorldAgent } = await import('../mcpl/agent.ts');
const { handleTool } = await import('../mcpl/tools.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
/** A call's answer, or { rejected } when it throws, so one throwing call fails its check and the rest still run. */
const settle = async (p: Promise<unknown>): Promise<any> => { try { return await p; } catch (e) { return { rejected: (e as Error).message }; } };
const said = (r: any) => r?.rejected != null ? `(rejected: ${r.rejected})` : String(r?.content?.[0]?.text ?? '');
const failed = (r: any) => r?.isError === true;
/** Run a call whose wait is the real flightAwait. Once its waiter is registered,
 *  set what the flight tick would have (`happen`) and settle it, as the tick does. */
const midway = async (agent: any, start: Promise<any>, happen: () => void) => {
  const before = agent.flightWaiters.length;
  for (let i = 0; i < 400 && agent.flightWaiters.length <= before; i++) await new Promise((res) => setTimeout(res, 5));
  happen(); agent.flightSettle();
  return start;
};

const WINGED = [
  'Hip', 'Spine02', 'Head',
  'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1',
  'L_Wing_Lower', 'R_Wing_Lower',
];
const ag: any = new WorldAgent({ name: 'mythos', world: 'is-error-bench' });
ag.bodyBoneNames = WINGED;
ag.loadBodyBones = async () => ag.bodyBoneNames;
const call = (name: string, a: Record<string, unknown> = {}) => settle(handleTool({ agent: ag } as any, name, a));

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
r = await call('unfold_wings');
check('unfolding open wings on the ground changes nothing, and is done', !failed(r) && said(r) === 'wings are already open', said(r));
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
let waitedMs = 0;
ag.flightAwait = async (_test: unknown, ms: number) => { waitedMs = ms; return 'timed out aloft'; };
r = await call('climb_to', { altitude: 40 });
check('a climb that times out is failed, not reported at its target',
  failed(r) && /^timed out aloft at .*short of the climb; the climbing stops there and you fly on$/.test(said(r)), said(r));
check('...and it stops climbing, so the body is where the answer says', ag.flight?.climbTo == null, String(ag.flight?.climbTo));
// A descent waits for its distance too: 40 m at 2 m/s, beside the 8 s every climb gets.
ag.flight.pos.y = 50;
r = await call('climb_to', { altitude: 10 });
check('a descent of 40 m waits at least the 28 s it takes', waitedMs >= 28_000, String(waitedMs));
ag.flightAwait = realAwait;
// The integrator's part of a climb, as the tick does it: it reaches the target and clears it.
const climbs = (altitude: number) => midway(ag, call('climb_to', { altitude }), () => {
  ag.flight.pos.y = ag.flight.climbTo; ag.flight.climbTo = null;
});
ag.flight.stamina = 1e6;
const ceiling = ag.flightCfg.bounds.ceiling;
r = await climbs(ceiling + 50);
check('a climb asked above the ceiling stops there and is failed, naming the ceiling',
  failed(r) && new RegExp(`^at ${ceiling.toFixed(1)}m, the ceiling here, short of the ${ceiling + 50}m you asked for`).test(said(r)), said(r));
r = await climbs(ceiling - 1);
check('a climb that gets there is done', !failed(r) && /^at .*stamina spent/.test(said(r)), said(r));
// The pool pays for half a metre of the one asked for: the body climbs that far and no farther.
ag.flight.stamina = 0.5;
r = await climbs(ceiling);
check('a winded climb is failed, saying how far the pool reached', failed(r) && /^winded at .*only bought 0\.5m of the 1\.0 you asked for/.test(said(r)), said(r));
ag.flight.stamina = 1e6;
r = await midway(ag, call('climb_to', { altitude: ceiling - 5 }), () => { ag.flight.phase = 'RAGDOLL'; });
check('a climb cut midway is failed', failed(r) && /^cut mid-climb at /.test(said(r)), said(r));
check('...and the cut body keeps no climb to resume when it recovers', ag.flight?.climbTo == null, String(ag.flight?.climbTo));
ag.flight = null; // down, so the next take_off starts fresh
for (const [tool, a, words] of [
  ['climb_to', {}, /^climb_to needs `altitude`/],
  ['climb_to', { altitude: 'high' }, /^climb_to needs `altitude`/],
  ['glide_to', { x: 'east', z: 0 }, /^glide_to needs `x` and `z`/],
  ['land_at', { z: 4 }, /^land_at needs `x` and `z`/],
  // Number() makes each of these 0 or 1, which is no coordinate anyone sent.
  ['glide_to', { x: true, z: 0 }, /^glide_to needs `x` and `z`/],
  ['climb_to', { altitude: false }, /^climb_to needs `altitude`/],
  ['land_at', { x: ' ', z: 4 }, /^land_at needs `x` and `z`/],
  ['land_at', { x: 4, z: [] }, /^land_at needs `x` and `z`/],
] as const) {
  r = await call(tool, a);
  check(`${tool} ${JSON.stringify(a)} is failed before flying`, failed(r) && words.test(said(r)), said(r));
}
// A string that reads as a number flies, as Number() always took it.
await call('take_off');
ag.flightAwait = async () => 'there';
r = await call('climb_to', { altitude: '5' });
check('climb_to with altitude "5" is not refused as non-numeric', !/needs `altitude`/.test(said(r)), said(r));
ag.flightAwait = realAwait;
// A touchdown within the arrival radius is an arrival; farther off, a shortfall.
const glideDown = (x: number, z: number) => async (test: any) => {
  ag.flight.phase = 'LANDED'; ag.flight.pos.x = x; ag.flight.pos.z = z; return test(ag.flight);
};
// From a fresh launch, so each landing check starts in flight whatever the calls before it did.
await call('take_off');
ag.flightAwait = glideDown(9.2, 0.5);
r = await call('glide_to', { x: 10, z: 0 });
check('a glide that touches down within 2 m of its target is done', !failed(r) && /^touched down at .*at the target$/.test(said(r)), said(r));
for (const [x, done] of [[8.1, true], [7.9, false]] as const) {
  await call('take_off');
  ag.flightAwait = glideDown(x, 0);
  r = await call('glide_to', { x: 10, z: 0 });
  check(`a touchdown ${(10 - x).toFixed(1)} m from the target is ${done ? 'done' : 'failed as short'}`,
    done ? !failed(r) && /at the target$/.test(said(r)) : failed(r) && /^landed short at /.test(said(r)), said(r));
}
ag.flightAwait = realAwait;
r = await call('take_off');
ag.flightAwait = glideDown(3, 0);
r = await call('glide_to', { x: 10, z: 0 });
check('a glide that lands short is failed', failed(r) && /^landed short at .*7\.0m short/.test(said(r)), said(r));
ag.flightAwait = realAwait;
// land_at is done only when its glide arrived and its flare came down.
const realGlide = ag.glideTo.bind(ag);
const arrived = { ok: true, text: 'arrived at (5.0, 5.0), 9.0m up — holding over it' };
/** land_at with its glide stood in for; its flare's wait is the real one, and `at` is where the flare comes down. */
const landing = async (glide: { ok: boolean; text: string; phase?: string }, flare: 'cut' | 'down', at = { x: 5, z: 5 }) => {
  await call('take_off');
  ag.glideTo = async () => { if (glide.phase) ag.flight.phase = glide.phase; return { ok: glide.ok, text: glide.text }; };
  const answer = await midway(ag, call('land_at', { x: 5, z: 5 }), () => {
    ag.flight.pos.x = ag.pos.x = at.x; ag.flight.pos.z = ag.pos.z = at.z;
    ag.flight.phase = flare === 'cut' ? 'RAGDOLL' : 'LANDED';
  });
  ag.glideTo = realGlide;
  return answer;
};
// A cut mid-glide is a fall: the glide's answer is the whole answer, and no flare is flown.
await call('take_off');
let flared = false;
ag.glideTo = async () => { ag.flight.phase = 'RAGDOLL'; return { ok: false, text: 'cut mid-glide — you are on the ground at (1.0, 1.0)' }; };
ag.flightAwait = async () => { flared = true; return 'down'; };
r = await call('land_at', { x: 5, z: 5 });
ag.glideTo = realGlide; ag.flightAwait = realAwait;
check('a landing cut mid-glide is failed with the glide\'s own answer', failed(r) && said(r) === 'cut mid-glide — you are on the ground at (1.0, 1.0)', said(r));
check('...and no flare is flown for a body that fell', !flared);
r = await landing({ ok: false, text: 'landed short at (2.0, 2.0) — 4.2m short.', phase: 'LANDED' }, 'down');
check('a landing whose glide fell short is failed', failed(r) && /^landed short at .* — landed at /.test(said(r)), said(r));
r = await landing({ ok: false, text: 'timed out aloft at (3.0, 3.0)' }, 'down');
check('a landing whose glide timed out is failed', failed(r) && /^timed out aloft at .* — landed at /.test(said(r)), said(r));
r = await landing(arrived, 'cut');
check('a landing cut during its flare is failed', failed(r) && / — cut during the flare, down at /.test(said(r)), said(r));
await call('take_off');
ag.glideTo = async () => arrived;
ag.flightAwait = async () => 'timed out aloft';
r = await call('land_at', { x: 5, z: 5 });
ag.glideTo = realGlide; ag.flightAwait = realAwait;
check('a landing whose flare timed out is failed', failed(r) && / — the flare timed out aloft, so the body was set down at /.test(said(r)), said(r));
// The flare sinks on the circle held over the point, so the answer says how far off it came down.
r = await landing(arrived, 'down', { x: 12, z: 6 });
check('a landing whose glide arrived and whose flare came down is done, saying how far from the point',
  !failed(r) && / — landed at \(12\.0, 6\.0\), 7\.1m from \(5\.0, 5\.0\)$/.test(said(r)), said(r));
// The rehearsal seam, switched on for this run, refuses a body that isn't flying.
r = await call('rehearse_down', {});
check('rehearse_down with no flight is failed', failed(r) && said(r) === 'not airborne — take_off first', said(r));
r = await call('rehearse_recover', {});
check('rehearse_recover with no flight is failed', failed(r) && said(r) === 'not airborne — take_off first', said(r));
await call('take_off');
r = await call('rehearse_recover', {});
check('rehearse_recover of a body that is flying, not down, is failed',
  failed(r) && /^nothing to recover from — the body isn't down \(/.test(said(r)), said(r));
ag.flightRagdoll = async () => {}; // the real ragdoll needs a physics body this bench hasn't got
r = await call('rehearse_down', {});
check('rehearse_down in flight is done', !failed(r) && /^down — /.test(said(r)), said(r));
r = await call('rehearse_recover', {});
check('rehearse_recover of a body that is down is done', !failed(r) && said(r) === 'recovering', said(r));

console.log('\nBONES NOT KNOWN');
const unread: any = new WorldAgent({ name: 'unread', world: 'is-error-bench' });
unread.bodyBoneNames = null;
unread.loadBodyBones = async () => null;
unread.myRights = { role: 'builder', fly: true };
const callU = (name: string, a: Record<string, unknown> = {}) => settle(handleTool({ agent: unread } as any, name, a));
r = await callU('fold_wings');
check('a fold while the bones are unknown is failed', failed(r) && /^wings unchanged — /.test(said(r)), said(r));
unread.wingsFolded = true;
r = await callU('fold_wings');
check('a fold of wings already folded, while the bones are unknown, changes nothing, and is done',
  !failed(r) && said(r) === 'wings are already folded', said(r));
r = await callU('unfold_wings');
check('releasing a folded posture while the bones are unknown is done',
  !failed(r) && /^folded-wing posture released — /.test(said(r)) && unread.wingsFolded === false, said(r));
r = await callU('unfold_wings');
check('an unfold with nothing folded while the bones are unknown changes nothing, and is done',
  !failed(r) && /^nothing is folded — /.test(said(r)), said(r));
const wingless: any = new WorldAgent({ name: 'wingless', world: 'is-error-bench' });
wingless.bodyBoneNames = ['Hip', 'Spine02', 'Head'];
wingless.loadBodyBones = async () => wingless.bodyBoneNames;
r = await settle(handleTool({ agent: wingless } as any, 'unfold_wings', {}));
check('an unfold of a wingless body changes nothing, and is done',
  !failed(r) && /^this body has no folded-wing posture to release$/.test(said(r)), said(r));

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
r = await call('reach', { limb: 'tail', x: 1, y: 1, z: 1 });
check('a reach with an unknown limb is failed', failed(r) && /^unknown limb "tail"/.test(said(r)), said(r));
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
r = await call('clear_reach', { limb: 'tail' });
check('clear_reach of an unknown limb is failed', failed(r) && /^unknown limb "tail"/.test(said(r)), said(r));
r = await call('clear_reach', { limb: ['rightHand'] });
check('clear_reach with a limb that is not a name is failed, releasing nothing', failed(r) && /^clear_reach's `limb`/.test(said(r)), said(r));
r = await call('clear_reach', { limb: 'leftHand' });
check('clear_reach of a limb that was not reaching changes nothing, and is done', !failed(r) && /wasn't reaching for anything$/.test(said(r)), said(r));
r = await call('body_state', { who: 'nobody-here' });
check('body_state of someone not here is failed', failed(r), said(r).slice(0, 200));
r = await call('pose', { bones: { leftUpperArm: [0, 0, 1] } });
check('a pose with nothing usable is failed', failed(r) && /^no pose set — nothing usable/.test(said(r)), said(r));
r = await call('pose', {});
check('a pose that cannot read the rig to list its bones is failed', failed(r) && /^can't read your rig to list its bones/.test(said(r)), said(r));
r = await call('animate', { tracks: { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, -0.7, 0.7] }] } });
check('animate with no duration is failed', failed(r) && /^pass `dur`/.test(said(r)), said(r));
// With the link down, nothing reaches the world, and the call says so as verb() does.
// A handler that throws is answered in the result, where the model reads it, not as a protocol error.
for (const a of [{ to: 'someone' }, { text: 'hello' }, { to: 'someone', text: '' }]) {
  r = await call('whisper', a);
  check(`whisper ${JSON.stringify(a)} is failed before sending`, failed(r) && /^whisper needs `to`/.test(said(r)), said(r));
}
r = await call('whisper', { to: 'someone', text: 'hello' });
check('a whisper with the link down is failed as not joined', failed(r) && said(r) === 'not joined', said(r));
r = await call('animate', { dur: 1, tracks: { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, -0.7, 0.7] }] } });
check('your own animation with the link down is failed as not joined', failed(r) && said(r) === 'not joined', said(r));
r = await call('ragdoll', { target: 'someone' });
check('a shove with the link down is failed as not joined', failed(r) && said(r) === 'not joined', said(r));
r = await call('clear_pose', { target: 'someone' });
check('releasing someone else\'s pose with the link down is failed as not joined', failed(r) && said(r) === 'not joined', said(r));
const logged: string[] = [];
const realConsoleError = console.error;
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
r = await call('say', { text: 'hello' });
console.error = realConsoleError;
check('a say with the link down, which verb() refuses, is failed in the result', failed(r) && said(r) === 'not joined', said(r));
check('...and the throw is in the operator\'s log, naming the tool', logged.some((l) => l.startsWith('[door] say threw:')), logged.join(' | '));
// What the world's HTTP side answers, stood in for.
const realFetch = globalThis.fetch;
const serve = (handler: (url: string) => Response) => { globalThis.fetch = (async (u: any) => handler(String(u))) as any; };
const unreachable = () => { globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as any; };
serve(() => new Response('[]', { status: 200 }));
r = await call('library_sheet', {});
check('a library sheet of an empty roster is an answer, not a failure', !failed(r) && said(r) === 'the roster has no bodies yet', said(r));
r = await call('library_sheet', { kind: 'models' });
check('a library sheet of an empty library is an answer, not a failure', !failed(r) && said(r) === 'the library has no models yet', said(r));
serve(() => new Response(JSON.stringify([{ name: 'kestrel', height: 1.7 }]), { status: 200 }));
r = await call('library_sheet', { page: 5 });
check('a library sheet page past the end is failed', failed(r) && /^no page 5 — 1 avatars, 1 page$/.test(said(r)), said(r));
serve(() => new Response(JSON.stringify([{ name: 'kestrel', path: 'avatars/kestrel.vrm' }]), { status: 200 }));
r = await call('set_avatar', { avatar: 'heron' });
check('wearing a body not on the roster is failed', failed(r) && /^no body named "heron"/.test(said(r)), said(r));
serve(() => new Response('not found', { status: 404 }));
r = await call('library_preview', { name: 'heron' });
check('a preview the world has none of is failed', failed(r) && /^no preview for "heron"/.test(said(r)), said(r));
unreachable();
r = await call('library_preview', { name: 'heron' });
check('a preview with the world\'s server unreachable says so', failed(r)
  && /^couldn't reach the world's server for a preview of "heron" \(connect ECONNREFUSED\); calling again may work once it answers$/.test(said(r)), said(r));
serve(() => new Response('bad gateway', { status: 502 }));
r = await call('library_preview', { name: 'heron' });
check('a preview behind a proxy that answers 502 says the server wasn\'t reached', failed(r) && /^couldn't reach .* \(it answered 502\)/.test(said(r)), said(r));
serve(() => new Response(new ReadableStream({ start(c) { c.error(new Error('connection dropped')); } }), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
r = await call('library_preview', { name: 'heron' });
check('a preview whose body can\'t be read says so', failed(r) && /^the world's server sent a preview of "heron" that couldn't be read: /.test(said(r)), said(r));
serve(() => new Response('no renderer', { status: 503 }));
r = await call('snapshot', {});
check('a snapshot with no view available is failed', failed(r) && /^no view available: no renderer$/.test(said(r)), said(r));
unreachable();
r = await call('snapshot', {});
check('a snapshot that cannot reach the world is failed', failed(r) && /^snapshot failed: connect ECONNREFUSED$/.test(said(r)), said(r));
globalThis.fetch = realFetch;
// From here the world takes every verb, and the test keeps what was sent.
const sent: [string, unknown][] = [];
ag.verb = (verb: string, args: unknown) => { sent.push([verb, args]); };
r = await call('remove', {});
check('remove with no id is failed, and sends nothing', failed(r) && /^remove needs `id`/.test(said(r)) && sent.length === 0,
  `${said(r)}; sent ${JSON.stringify(sent)}`);
serve((url) => new Response(JSON.stringify(/library-models\?q=chair/.test(url) ? [{ path: 'furniture/chair.glb' }] : []), { status: 200 }));
r = await call('spawn', { lib: '', query: 'chair' });
check('spawn with an empty lib and a query searches, as with lib left out',
  !failed(r) && /^spawned \[.*\] chair\.glb/.test(said(r)) && (sent.at(-1)?.[1] as any)?.lib === 'furniture/chair.glb',
  `${said(r)}; sent ${JSON.stringify(sent.at(-1))}`);
r = await call('spawn', { lib: '' });
check('spawn with an empty lib and no query is failed', failed(r) && /no model/.test(said(r)), said(r));
globalThis.fetch = realFetch;
// A puppet request is sent, and the target decides.
const puppets: [string, unknown][] = [];
const realPuppet = ag.puppet;
ag.puppet = (target: string, spec: unknown) => { puppets.push([target, spec]); };
r = await call('clear_pose', { target: 'someone' });
check('releasing someone else\'s pose says it was asked, and that they decide', !failed(r) && said(r) === 'asked someone to release their pose. They decide whether to.', said(r));
r = await call('ragdoll', { target: 'someone' });
check('a shove says what it asked, and that they decide', !failed(r) && /^you shove someone, asking them to go limp\. They decide whether to\.$/.test(said(r)), said(r));
ag.puppet = realPuppet;
// The world's answer decides a moderation verb's result.
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
ag.entities.set('lamp', { id: 'lamp', lib: '(light)', pos: [0, 2, 0] });
r = await call('name_place', { name: 'lookout', on: 'lamp' });
check('naming a place on a light is failed', failed(r) && /^\[lamp\] is a light/.test(said(r)), said(r));
ag.entities.delete('lamp');
// Sent, with no refusal and no echo within the wait: done, and it says it isn't confirmed.
ag.entities.set('stone', { id: 'stone', lib: 'models/stone.glb', pos: [0, 0, 0] });
const realEff = ag.eff;
ag.eff = () => ({ ok: true, pos: [0, 0, 0], yaw: 0, scale: 1 });
ag.lastRefusal = null;
r = await call('name_place', { name: 'lookout', on: 'stone' });
check('a name sent and not refused within the wait is done, and says it is unconfirmed',
  !failed(r) && /^sent "lookout" to \[stone\], but the world has not confirmed it yet/.test(said(r)), said(r));
ag.eff = realEff;
ag.entities.delete('stone');

console.log('\nSWITCHED OFF');
const child = Bun.spawnSync([process.execPath, import.meta.path], {
  env: { ...process.env, DOOR_IS_ERROR_CHILD: 'switched-off', EIDO_WHISPERS_ENABLED: '0', EIDO_FLIGHT_REHEARSAL: '0' },
});
let off: any = {};
try { off = JSON.parse(child.stdout.toString().trim().split('\n').pop() ?? '{}'); } catch { /* checked below */ }
check('a whisper while whispers are off is failed', off.whisper?.failed === true && off.whisper.text === 'whispers are disabled in this world', JSON.stringify(off.whisper) + child.stderr.toString().slice(0, 300));
check('a rehearsal tool while rehearsal is off is failed', off.rehearse?.failed === true && off.rehearse.text === 'no such tool', JSON.stringify(off.rehearse));

console.log('\nWALK');
const walker: any = {
  pos: { x: 0, y: 0, z: 0 },
  walkStopReason: null as string | null,
  walkStall: null as string | null,
  walkTo: async () => false,
  placesAt: () => [],
  destination: (to: string) => ({ refusal: `nothing here is called "${to}"` }),
};
const walk = (a: Record<string, unknown>) => settle(handleTool({ agent: walker } as any, 'walk_to', a));
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
