// door-is-error-test — a door tool that didn't do what it was asked says so
// with isError, so a host shows the call as failed rather than done.
//
//   bun tools/door-is-error-test.ts
//
// Acts are failed when the call didn't do what it asked (a refusal, a cut, a
// climb or glide that fell short, a name the world refused), and done when it
// did, including a no-op because what it asked for already held.
//
// In this protocol main's flight tools are folded into move {mode: "fly"},
// act {verb: "land"} and anim's wings, and the rehearsal tools are no tools
// (tools.ts TOOL_FOLDS). Those calls add steps of their own (a fly-mode move
// takes off first and ends with where the flight stands), so the FLIGHT checks
// call the agent's acts as main's tools did, answered as the door answers an
// act, and FLIGHT THROUGH THE DOOR checks the door's own calls.
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
/** A call that answered and wasn't failed: a { rejected } stand-in, from settle() or midway(), is neither. */
const ok = (r: any) => r != null && r.rejected == null && !failed(r);
/** Run a call whose wait is the real flightAwait. Once its waiter is registered,
 *  set what the flight tick would have (`happen`) and settle it, as the tick does.
 *  The checks that need a wait to time out stand in for flightAwait instead (the
 *  climb's and the flare's timeouts, and the cut glide's flare), since a real
 *  one would take its whole budget. */
const midway = async (agent: any, start: Promise<any>, happen: () => void) => {
  // A waiter left by an earlier call could answer for this one, so none may be waiting yet.
  if (agent.flightWaiters.length) return { rejected: 'a flight waiter from an earlier call was still registered' };
  for (let i = 0; i < 400 && !agent.flightWaiters.length; i++) await new Promise((res) => setTimeout(res, 5));
  // An act that never waited on the flight answered from something else, so no check here may pass on it.
  if (!agent.flightWaiters.length) return { rejected: 'the act registered no flight waiter' };
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
/** An act's answer as the door gives it: failed when it didn't do what it asked (tools.ts act()). */
const asAct = (x: any) => ({ content: [{ type: 'text', text: x?.text }], ...(x?.ok ? {} : { isError: true }) });
/** Main's flight tools, as they called the agent's acts. */
const acts = (agent: any): Record<string, (a: any) => any> => ({
  take_off: () => agent.takeOff(),
  climb_to: (a) => agent.climbTo(Number(a.altitude)),
  glide_to: (a) => agent.glideTo(Number(a.x), Number(a.z)),
  land_at: (a) => agent.landAt(Number(a.x), Number(a.z)),
  fold_wings: () => agent.foldWings(true),
  unfold_wings: () => agent.foldWings(false),
  rehearse_down: (a) => agent.flightBodyDown(String(a.eventId ?? 'rehearsal')),
  rehearse_recover: (a) => agent.flightBodyRecovered(String(a.eventId ?? 'rehearsal'), 'gen-rehearsal'),
});
const callOn = (agent: any, name: string, a: Record<string, unknown> = {}) => {
  const act = acts(agent)[name];
  return settle(act ? Promise.resolve().then(() => act(a)).then(asAct) : handleTool({ agent } as any, name, a));
};
const call = (name: string, a: Record<string, unknown> = {}) => callOn(ag, name, a);
/** One of the door's own calls, as a host makes it. */
const door = (name: string, a: Record<string, unknown> = {}) => settle(handleTool({ agent: ag } as any, name, a));

console.log('\nFLIGHT');
ag.myRights = { role: 'builder', fly: false };
/** A fresh flight, as after a body that went down has come to rest: a limp fall can't be launched out of. */
const relaunch = async () => { ag.flight = null; await call('take_off'); };
let r = await call('take_off');
check('a denied take_off is failed', failed(r) && /cannot fly/.test(said(r)), said(r));
r = await call('fold_wings');
check('folding wings is done', ok(r) && /wings folded/.test(said(r)), said(r));
r = await call('fold_wings');
check('folding folded wings changes nothing, and is done', ok(r) && /already folded/.test(said(r)), said(r));
ag.myRights = { role: 'builder', fly: true };
r = await call('take_off');
check('take_off with folded wings is failed', failed(r) && /your wings are folded; open them first/.test(said(r)), said(r));
r = await call('unfold_wings');
check('unfolding is done', ok(r) && /wings open/.test(said(r)), said(r));
r = await call('unfold_wings');
check('unfolding open wings on the ground changes nothing, and is done', ok(r) && said(r) === 'wings are already open', said(r));
r = await call('land_at', { x: 0, z: 0 });
check('land_at on the ground is failed', failed(r) && /already on the ground/.test(said(r)), said(r));
r = await call('glide_to', { x: 10, z: 0 });
check('glide_to on the ground is failed', failed(r) && /move \{mode: "fly"\} first/.test(said(r)), said(r));
r = await call('take_off');
check('take_off is done', ok(r) && /took off/.test(said(r)), said(r));
// Airborne, the integrator answers a second unfold: open wings are what it asks for.
r = await call('unfold_wings');
check('unfolding open wings in flight changes nothing, and is done', ok(r) && /already open/.test(said(r)), said(r));
// ...and a fold in the air is refused for being airborne.
r = await call('fold_wings');
check('folding in the air is failed', failed(r) && /airborne/.test(said(r)), said(r));
// A climb whose wait times out didn't reach its altitude: it isn't reported as there.
const realAwait = ag.flightAwait;
ag.flightAwait = async () => 'timed out aloft';
r = await call('climb_to', { altitude: 40 });
check('a climb that times out is failed, not reported at its target',
  failed(r) && /^timed out aloft at .*short of the climb; the climbing stops there and you fly on$/.test(said(r)), said(r));
check('...and it stops climbing, so the body is where the answer says', !!ag.flight && ag.flight.climbTo == null, String(ag.flight?.climbTo));
ag.flightAwait = realAwait;
// A climb, a descent and a landing's flare, flown by the agent's own flight tick, each end inside their wait. A climb
// rises at its lift less the polar's sink once the lift has eased in, about 1.5 m/s where the lift alone is 2 m/s,
// and a flare comes down at the polar's sink, about 0.46 m/s.
/** Fly an act through the agent's own flight tick, 0.1 s a tick as the main tick steps, until it answers. Its waits are
 *  the real flightAwait's, with flight time standing in for the clock: each wait's length is kept, with the flight time it took. */
const flownByTicks = async (act: () => Promise<any>) => {
  const waits: { ms: number; took: number }[] = [];
  let t = 0, answered = false;
  ag.flightAwait = (test: (s: any) => string | null, ms = 120_000) => {
    const w = { ms, took: -1 }, from = t;
    waits.push(w);
    return realAwait.call(ag, test, 3_600_000).then((v: string) => { w.took = t - from; return v; });
  };
  const answer = act().then((a) => { answered = true; return a; });
  // Ticking starts once the act waits on the flight, so no tick flies its earlier steps. An act that neither waits nor
  // answers within 10 s fails its check, saying so.
  for (let i = 0; i < 2000 && !waits.length && !answered; i++) await new Promise((res) => setTimeout(res, 5));
  if (!waits.length && !answered) {
    ag.flightAwait = realAwait;
    return { waits, answer: { rejected: 'the act neither waited on the flight nor answered within 10 s' } };
  }
  while (!answered && t < 600) {
    await new Promise((res) => setTimeout(res, 0));
    if (answered) break;
    if (ag.flight) ag.flightTick(0.1);
    t = Math.round((t + 0.1) * 10) / 10;
  }
  ag.flightAwait = realAwait;
  // An act still unanswered once the ticking stops fails its check now, rather than waiting out the hour-long stand-in.
  const settled = answered ? answer
    : Promise.race([answer, new Promise((res) => setTimeout(() => res({ rejected: `no answer 5 s after ${t} s of flight` }), 5000))]);
  return { waits, answer: await settled };
};
/** The wait outlasts the flight time its leg took, even were the tick that flew it 50% late, as a loaded host's timer can run. */
const inside = (w: { ms: number; took: number }[], i: number) => w.length > i && w[i].took >= 0 && w[i].ms > w[i].took * 1000 * 1.5;
/** A fresh flight at height y, with take-off's launch impulse spent, so the climb's own lift is all that lifts it. */
const flyingAt = async (y: number) => {
  await relaunch();
  ag.flight.stamina = 1e6; ag.flight.pos.x = 0; ag.flight.pos.z = 0; ag.flight.pos.y = y;
  ag.flight.vel.y = 0; ag.flight.launchV = 0; ag.flight.launchT = 0;
};
await flyingAt(10);
let flown = await flownByTicks(() => call('climb_to', { altitude: 60 }));
check('a 50 m climb flown by the tick gets there', ok(flown.answer) && /^at 60\.0m — 50 stamina spent/.test(said(flown.answer)), said(flown.answer));
check('...inside its wait, with ticks 50% late', inside(flown.waits, 0), JSON.stringify(flown.waits));
await flyingAt(50);
flown = await flownByTicks(() => call('climb_to', { altitude: 10 }));
check('a 40 m descent flown by the tick gets there, inside its wait with ticks 50% late', ok(flown.answer) && /^at 10\.0m/.test(said(flown.answer)) && inside(flown.waits, 0),
  `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
await flyingAt(45);
flown = await flownByTicks(() => call('land_at', { x: 20, z: 0 }));
check('a landing from 45 m flown by the tick comes down by its flare', ok(flown.answer) && / — landed at \(.*\), [0-9.]+m from \(20\.0, 0\.0\)$/.test(said(flown.answer)), said(flown.answer));
check('...inside the flare\'s wait, with ticks 50% late', inside(flown.waits, 1), JSON.stringify(flown.waits));
// A short climb leans on the 8 s beside: the lift's easing in, which the rate leaves out, is a fair share of it.
await flyingAt(10);
flown = await flownByTicks(() => call('climb_to', { altitude: 15 }));
check('a 5 m climb flown by the tick gets there, inside its wait with ticks 50% late', ok(flown.answer) && /^at 15\.0m/.test(said(flown.answer)) && inside(flown.waits, 0),
  `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
// Straight after take-off, the launch still lifts the body, which its height doesn't show: a landing then flares
// from well above where it began, and a descent first rises. Their waits are sized from the ceiling down.
await relaunch();
flown = await flownByTicks(() => call('land_at', { x: ag.flight.pos.x, z: ag.flight.pos.z }));
check('a landing straight after take-off comes down by its flare, inside the flare\'s wait with ticks 50% late',
  ok(flown.answer) && / — landed at /.test(said(flown.answer)) && inside(flown.waits, 1), `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
await relaunch();
flown = await flownByTicks(() => call('climb_to', { altitude: 0.3 }));
check('a descent straight after take-off gets there, inside its wait with ticks 50% late', ok(flown.answer) && /^at 0\.3m/.test(said(flown.answer)) && inside(flown.waits, 0),
  `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
// A climb to just above the body, asked while the launch still lifts it, is carried up out of the climb's 0.4 m and
// comes back down to it, so its wait is never shorter than a descent from the ceiling.
await relaunch();
for (let i = 0; i < 4; i++) ag.flightTick(0.1);
{
  const to = Math.round((ag.flight.pos.y + 0.1) * 10) / 10;
  flown = await flownByTicks(() => call('climb_to', { altitude: to }));
  check('a climb of 0.1 m asked 0.4 s into the launch gets there, inside its wait with ticks 50% late',
    ok(flown.answer) && new RegExp(`^at ${to.toFixed(1)}m`).test(said(flown.answer)) && inside(flown.waits, 0), `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
}
// Over ground far below 0, the flare comes down farther than the ceiling's height says.
{
  const realHeight = ag.heightAt;
  ag.heightAt = () => -100;
  await flyingAt(25);
  flown = await flownByTicks(() => call('land_at', { x: 20, z: 0 }));
  ag.heightAt = realHeight;
  check('a landing from 25 m over ground at -100 m comes down by its flare, inside the flare\'s wait with ticks 50% late',
    ok(flown.answer) && / — landed at /.test(said(flown.answer)) && inside(flown.waits, 1), `${said(flown.answer)}; ${JSON.stringify(flown.waits)}`);
}
// A wait whose time runs out answers "timed out aloft" and leaves no waiter behind.
{
  const before = ag.flightWaiters.length;
  const answer = await Promise.race([realAwait.call(ag, () => null, 30), new Promise((res) => setTimeout(() => res('no answer 5 s after its 30 ms'), 5000))]);
  check('a flight wait that runs out its time answers "timed out aloft", and leaves no waiter', answer === 'timed out aloft' && ag.flightWaiters.length === before,
    `${answer}; waiters ${before} then ${ag.flightWaiters.length}`);
}
await relaunch();
// The integrator's part of a climb, as the tick does it: it reaches the target and clears it.
const climbs = (altitude: number) => midway(ag, call('climb_to', { altitude }), () => {
  ag.flight.pos.y = ag.flight.climbTo; ag.flight.climbTo = null;
});
ag.flight.stamina = 1e6;
const ceiling = ag.flightCfg.bounds.ceiling;
r = await climbs(ceiling + 50);
check('a climb asked above the ceiling stops there and is failed, naming the ceiling',
  failed(r) && new RegExp(`^at ${ceiling.toFixed(1)}m, the ceiling here, short of the ${(ceiling + 50).toFixed(1)}m you asked for`).test(said(r)), said(r));
r = await climbs(ceiling - 1);
check('a climb that gets there is done, at the height asked', ok(r) && new RegExp(`^at ${(ceiling - 1).toFixed(1)}m.*stamina spent`).test(said(r)), said(r));
// A wait answered before its time clears its timer, so an answered act holds nothing open. The flight waits'
// timers are the ones of 8 s and more; the test's own polling waits are a few milliseconds.
{
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const flightTimers = new Set<unknown>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = realSet(() => { flightTimers.delete(h); fn(...rest); }, ms);
    if ((ms ?? 0) >= 8_000) flightTimers.add(h);
    return h;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((h: any) => { flightTimers.delete(h); realClear(h); }) as typeof clearTimeout;
  ag.flight.pos.y = 10;
  r = await climbs(20);
  globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
  check('a climb answered before its wait ends clears the wait\'s timer', ok(r) && flightTimers.size === 0, `${said(r)}; ${flightTimers.size} flight timer(s) still set`);
  ag.flight.pos.y = ceiling - 1; // where the climb above left the body, which the winded climb below starts from
}
// The pool pays for half a metre of the one asked for: the body climbs that far and no farther.
ag.flight.stamina = 0.5;
r = await climbs(ceiling);
check('a winded climb is failed, saying how far the pool reached', failed(r) && /^winded at .*only bought 0\.5m of the 1\.0 you asked for/.test(said(r)), said(r));
ag.flight.stamina = 1e6;
r = await midway(ag, call('climb_to', { altitude: ceiling - 5 }), () => { ag.flight.phase = 'RAGDOLL'; });
check('a climb cut midway is failed', failed(r) && /^cut mid-climb at /.test(said(r)), said(r));
check('...and the cut body keeps no climb to resume when it recovers', !!ag.flight && ag.flight.climbTo == null, String(ag.flight?.climbTo));
await relaunch(); ag.flight.stamina = 1e6;
r = await midway(ag, call('climb_to', { altitude: ceiling - 5 }), () => { ag.flight.phase = 'LEAF'; });
check('a climb cut in the air, falling limp, is failed', failed(r) && /^cut mid-climb at /.test(said(r)), said(r));
check('...and keeps no climb either', !!ag.flight && ag.flight.climbTo == null, String(ag.flight?.climbTo));
await relaunch(); ag.flight.stamina = 1e6;
ag.flight.pos.y = 30;
r = await midway(ag, call('climb_to', { altitude: 5 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 12; });
check('a descent that meets the ground above its target is failed, saying where it came down',
  failed(r) && /^came down on the ground at 12\.0m, above the 5\.0m you asked for$/.test(said(r)), said(r));
check('...and the landed body keeps no climb', !!ag.flight && ag.flight.climbTo == null, String(ag.flight?.climbTo));
await relaunch(); ag.flight.stamina = 1e6;
ag.flight.pos.y = 30;
r = await midway(ag, call('climb_to', { altitude: 5 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 5.2; });
check('a descent that comes down on the ground at its target is done, and says it came down',
  ok(r) && said(r) === 'came down on the ground at 5.2m, the height you asked for — move {mode: "fly"} to fly again', said(r));
check('...and keeps no climb', !!ag.flight && ag.flight.climbTo == null, String(ag.flight?.climbTo));
// A climb that comes down below where it was going says so.
await relaunch(); ag.flight.stamina = 1e6; ag.flight.pos.y = 2;
r = await midway(ag, call('climb_to', { altitude: 10 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 1; });
check('a climb that comes down on the ground below its target is failed, saying so',
  failed(r) && /^came down on the ground at 1\.0m, below the 10\.0m you asked for$/.test(said(r)), said(r));
// A winded climb's reach is short of the height asked, and a touchdown there is judged against what was asked.
await relaunch(); ag.flight.stamina = 0.5; ag.flight.pos.y = 2;
r = await midway(ag, call('climb_to', { altitude: 10 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 2.5; });
check('a winded climb that comes down where its pool ran out is failed, as below the height asked',
  failed(r) && /^came down on the ground at 2\.5m, below the 10\.0m you asked for$/.test(said(r)), said(r));
// Between its reach and the height asked, it's below what was asked, though above its reach.
await relaunch(); ag.flight.stamina = 0.5; ag.flight.pos.y = 2;
r = await midway(ag, call('climb_to', { altitude: 10 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 5; });
check('a winded climb that comes down between its reach and the height asked is failed, as below the height asked',
  failed(r) && /^came down on the ground at 5\.0m, below the 10\.0m you asked for$/.test(said(r)), said(r));
// A climb asked above the ceiling that comes down at the ceiling didn't reach the height asked either.
await relaunch(); ag.flight.stamina = 1e6; ag.flight.pos.y = 2;
r = await midway(ag, call('climb_to', { altitude: ceiling + 50 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = ceiling; });
check('a climb asked above the ceiling that comes down at the ceiling is failed, as below the height asked',
  failed(r) && new RegExp(`^came down on the ground at ${ceiling.toFixed(1)}m, below the ${(ceiling + 50).toFixed(1)}m you asked for$`).test(said(r)), said(r));
// The window is the tick's 0.4 m: just inside it is the height asked, just outside it isn't.
for (const [y, done] of [[5.39, true], [5.41, false]] as const) {
  await relaunch(); ag.flight.stamina = 1e6; ag.flight.pos.y = 30;
  r = await midway(ag, call('climb_to', { altitude: 5 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = y; });
  check(`a descent that comes down ${(y - 5).toFixed(2)} m above its target is ${done ? 'done' : 'failed as above it'}`,
    done ? ok(r) && /, the height you asked for/.test(said(r)) : failed(r) && /, above the 5\.0m you asked for$/.test(said(r)), said(r));
}
// The tick clears a climb that reaches its height; a landing in that same tick is still read as a landing.
await relaunch(); ag.flight.stamina = 1e6; ag.flight.pos.y = 30;
r = await midway(ag, call('climb_to', { altitude: 5 }), () => { ag.flight.phase = 'LANDED'; ag.flight.pos.y = 5.1; ag.flight.climbTo = null; });
check('a descent that comes down at its height as the tick clears its climb is read as touched down, not as there',
  ok(r) && said(r) === 'came down on the ground at 5.1m, the height you asked for — move {mode: "fly"} to fly again', said(r));
// The tick ends a climb met on the ground where the body stands, without lifting it to the climb's height.
await relaunch();
{
  const realHeight = ag.heightAt;
  ag.heightAt = () => 5.2;
  ag.flight.phase = 'LANDED'; ag.flight.pos.y = 5.2; ag.flight.climbTo = 5;
  ag.flightTick(0);
  check('the tick clears a climb met on the ground, and leaves the body where it stands', ag.flight?.climbTo == null && ag.flight?.pos.y === 5.2,
    `climbTo ${ag.flight?.climbTo}, y ${ag.flight?.pos.y}`);
  ag.heightAt = realHeight;
}
await relaunch(); ag.flight.stamina = 1e6;
r = await midway(ag, call('climb_to', { altitude: ceiling - 5 }), () => { ag.flight.phase = 'RECOVER'; });
check('a climb whose body sits up after a cut midway is failed as cut', failed(r) && /^cut mid-climb at /.test(said(r)), said(r));
// A body that's down flies nowhere until it recovers (in the air) or takes off again (on the ground).
for (const [phase, tool, a, words] of [
  ['LEAF', 'glide_to', { x: 10, z: 0 }, /^you're falling limp \(leaf\) — once you're down on the ground, move \{mode: "fly"\} launches you again$/],
  ['LEAF', 'take_off', {}, /^you're falling limp \(leaf\) — once you're down on the ground, move \{mode: "fly"\} launches you again$/],
  ['RAGDOLL', 'climb_to', { altitude: 20 }, /^you're down on the ground \(ragdoll\) — move \{mode: "fly"\} to fly again$/],
  ['RECOVER', 'land_at', { x: 5, z: 5 }, /^you're down on the ground \(recover\) — move \{mode: "fly"\} to fly again$/],
] as const) {
  await relaunch(); ag.flight.phase = phase;
  r = await call(tool, a);
  check(`${tool} while ${phase.toLowerCase()} is failed, and leaves the body down`, failed(r) && words.test(said(r)) && ag.flight?.phase === phase, `${said(r)}; ${ag.flight?.phase}`);
}
// No grant to fly is refused by every flight verb, not only take_off.
await relaunch();
ag.myRights = { role: 'builder', fly: false };
for (const [tool, a] of [['glide_to', { x: 10, z: 0 }], ['climb_to', { altitude: 20 }], ['land_at', { x: 5, z: 5 }]] as const) {
  r = await call(tool, a);
  check(`${tool} with no grant to fly is failed`, failed(r) && /^you cannot fly here — /.test(said(r)), said(r));
}
ag.myRights = { role: 'builder', fly: true };
ag.flight = null;
r = await call('climb_to', { altitude: 20 });
check('climb_to on the ground is failed', failed(r) && said(r) === 'you are on the ground — move {mode: "fly"} first', said(r));
// A limp fall whose recovery began in the air flies on by itself once it's done.
await relaunch(); ag.flight.phase = 'LEAF'; ag.flight.recoverAt = ag.flight.t ?? 0;
r = await call('take_off');
check('take_off while a limp fall recovers in the air is failed, saying it flies again once that\'s done',
  failed(r) && said(r) === "you're falling limp (leaf) with your recovery under way — you fly again once it's done, unless you reach the ground first", said(r));
ag.flight = null; // down, so the next take_off starts fresh
// A fly-mode move's altitude is a number of metres, or a string that reads as one, as Number() always took "5"; a
// boolean, a blank, a list or an object isn't, as main's climb_to refused them.
await relaunch(); ag.flight.stamina = 1e6;
for (const altitude of [false, true, '', ' ', 'high', [], {}, Infinity, NaN] as unknown[]) {
  r = await door('move', { mode: 'fly', altitude });
  check(`move {mode: "fly", altitude: ${typeof altitude === 'number' ? altitude : JSON.stringify(altitude)}} is failed before flying`,
    failed(r) && said(r) === 'move {mode: "fly"}: altitude is a number of metres' && ag.flight?.climbTo == null, said(r));
}
ag.flight.pos.y = 2;
r = await midway(ag, door('move', { mode: 'fly', altitude: '5' }), () => { ag.flight.pos.y = ag.flight.climbTo; ag.flight.climbTo = null; });
check('move {mode: "fly", altitude: "5"} climbs to 5 m', ok(r) && /^at 5\.0m/.test(said(r)), said(r));
// A touchdown within the arrival radius is an arrival; farther off, a shortfall.
/** A glide from a fresh launch whose real wait settles once the body is down at (x, z), or cut (`phase`). */
const glides = async (x: number, z: number, phase = 'LANDED') => {
  await relaunch();
  ag.flight.pos.x = ag.flight.pos.z = 0;
  return midway(ag, call('glide_to', { x: 10, z: 0 }), () => { ag.flight.phase = phase; ag.flight.pos.x = x; ag.flight.pos.z = z; });
};
r = await glides(9.2, 0.5);
check('a glide that touches down within 2 m of its target is done', ok(r) && /^touched down at .*at the target$/.test(said(r)), said(r));
for (const [x, done] of [[8.1, true], [7.9, false]] as const) {
  r = await glides(x, 0);
  check(`a touchdown ${(10 - x).toFixed(1)} m from the target is ${done ? 'done' : 'failed as short'}`,
    done ? ok(r) && /at the target$/.test(said(r)) : failed(r) && /^landed short at /.test(said(r)), said(r));
}
r = await glides(3, 0);
check('a glide that lands short is failed', failed(r) && /^landed short at .*7\.0m short/.test(said(r)), said(r));
r = await glides(4, 0, 'LEAF');
check('a glide cut in the air, falling limp, is failed as a cut', failed(r) && /^cut mid-glide — you are falling at /.test(said(r)), said(r));
r = await glides(4, 0, 'RAGDOLL');
check('a glide cut on the ground is failed as a cut', failed(r) && /^cut mid-glide — you are on the ground at /.test(said(r)), said(r));
r = await glides(4, 0, 'RECOVER');
check('a glide whose body sits up after a cut midway is failed as a cut', failed(r) && /^cut mid-glide — you are on the ground at /.test(said(r)), said(r));
// Its own success: an arrival in the air, which leaves the body holding over the point.
await relaunch();
ag.flight.pos.x = ag.flight.pos.z = 0;
r = await midway(ag, call('glide_to', { x: 10, z: 0 }), () => { ag.flight.pos.x = 9.5; ag.flight.pos.z = 0.5; });
check('a glide that arrives in the air is done, holding over the point',
  ok(r) && /^arrived at \(9\.5, 0\.5\), [0-9.]+m up — holding over it$/.test(said(r)) && ag.flight?.holdAt?.x === 10 && ag.flight?.holdAt?.z === 0,
  `${said(r)}; holdAt ${JSON.stringify(ag.flight?.holdAt)}`);
// A cut at the target is a cut, not an arrival.
r = await glides(10, 0, 'LEAF');
check('a glide cut at its target is failed as a cut', failed(r) && /^cut mid-glide — you are falling at \(10\.0, 0\.0\)/.test(said(r)), said(r));
// land_at is done only when its glide arrived and its flare came down.
const realGlide = ag.glideTo.bind(ag);
const arrived = { ok: true, text: 'arrived at (5.0, 5.0), 9.0m up — holding over it' };
/** A landing's glide that answers at once, counting the course as the real glide does, which a landing needs to go on
 *  to its flare. */
const glidesThere = async (_x: number, _z: number, took?: { course?: number }) => { if (took) took.course = ++ag.flightCourse; return arrived; };
/** land_at with its glide stood in for; its flare's wait is the real one, and `at` is where the flare comes down. */
const landing = async (glide: { ok: boolean; text: string; phase?: string }, flare: 'cut' | 'leaf' | 'down', at = { x: 5, z: 5 }) => {
  await relaunch();
  ag.glideTo = async (_x: number, _z: number, took?: { course?: number }) => {
    if (took) took.course = ++ag.flightCourse;
    if (glide.phase) ag.flight.phase = glide.phase;
    return { ok: glide.ok, text: glide.text };
  };
  const answer = await midway(ag, call('land_at', { x: 5, z: 5 }), () => {
    ag.flight.pos.x = ag.pos.x = at.x; ag.flight.pos.z = ag.pos.z = at.z;
    ag.flight.phase = flare === 'cut' ? 'RAGDOLL' : flare === 'leaf' ? 'LEAF' : 'LANDED';
  });
  ag.glideTo = realGlide;
  return answer;
};
// A cut mid-glide is a fall: the glide's answer is the whole answer, and no flare is flown. The glide set its course
// before the cut, as a real glide does, so the landing's down check is what answers.
for (const [phase, words] of [['RAGDOLL', 'cut mid-glide — you are on the ground at (1.0, 1.0)'], ['LEAF', 'cut mid-glide — you are falling at (1.0, 1.0)']] as const) {
  await relaunch();
  let flared = false;
  ag.glideTo = async (_x: number, _z: number, took?: { course?: number }) => {
    if (took) took.course = ++ag.flightCourse;
    ag.flight.phase = phase;
    return { ok: false, text: words };
  };
  ag.flightAwait = async () => { flared = true; return 'down'; };
  r = await call('land_at', { x: 5, z: 5 });
  ag.glideTo = realGlide; ag.flightAwait = realAwait;
  check(`a landing cut mid-glide (${phase.toLowerCase()}) is failed with the glide's own answer`, failed(r) && said(r) === words, said(r));
  check('...and no flare is flown for a body that fell, which keeps its flight state for its recovery', !flared && ag.flight?.phase === phase, `${flared}; ${ag.flight?.phase}`);
}
r = await landing({ ok: false, text: 'landed short at (2.0, 2.0) — 4.2m short.', phase: 'LANDED' }, 'down');
check('a landing whose glide fell short is failed', failed(r) && /^landed short at .* — landed at /.test(said(r)), said(r));
r = await landing({ ok: false, text: 'timed out aloft at (3.0, 3.0)' }, 'down');
check('a landing whose glide timed out is failed', failed(r) && /^timed out aloft at .* — landed at /.test(said(r)), said(r));
r = await landing(arrived, 'cut');
check('a landing cut during its flare is failed', failed(r) && / — cut during the flare, down at /.test(said(r)), said(r));
check('...and the cut body keeps its flight state for its recovery', ag.flight?.phase === 'RAGDOLL', String(ag.flight?.phase));
r = await landing(arrived, 'leaf');
check('a landing cut in the air during its flare is failed', failed(r) && / — cut during the flare, down at /.test(said(r)), said(r));
await relaunch();
ag.glideTo = glidesThere;
// The flare flies the body to (7, 3) before its wait runs out, so the answer says where it was set down, not where the
// flare began.
ag.flightAwait = async () => { ag.flight.pos.x = ag.pos.x = 7; ag.flight.pos.z = ag.pos.z = 3; ag.flight.pos.y = ag.pos.y = 20; return 'timed out aloft'; };
r = await call('land_at', { x: 5, z: 5 });
ag.glideTo = realGlide; ag.flightAwait = realAwait;
check('a landing whose flare timed out is failed, and the body is set down from 20 m where the flare had it, saying where',
  failed(r) && said(r).endsWith(' — the flare timed out aloft, so the body was set down at (7.0, 3.0)') && ag.flight === null && ag.pos.y < 20,
  `${said(r)}; flight ${ag.flight === null ? 'ended' : ag.flight?.phase}; y ${ag.pos.y}`);
// A later call that sets the flight's course takes it over, so a landing whose flare then ends, whether its wait hears
// the body come down or runs out, leaves the flight to that call: on the stdio door, a host that stopped waiting for
// the landing can send its next call while the flare still waits. A take-off's fresh flight takes it over too.
/** Hold the next flight wait open, whichever act asks for it first, and give later ones the real wait; `end` answers
 *  it. Later calls then wait for real, so a held act that starts late still meets this hold rather than a real wait. */
const holdNextWait = () => {
  const h = { held: false, end: (_v: string) => {} };
  ag.flightAwait = (test: (s: any) => string | null, ms?: number) => {
    if (h.held) return realAwait.call(ag, test, ms);
    h.held = true;
    return new Promise<string>((res) => { h.end = res; });
  };
  return h;
};
const waitFor = async (cond: () => boolean, ms = 10_000) => {
  for (let t = 0; t < ms && !cond(); t += 5) await new Promise((res) => setTimeout(res, 5));
  return cond();
};
/** Start the later call, and give back how to settle what it leaves waiting once its check is done. */
const laterCalls: Record<string, () => Promise<() => Promise<void>>> = {
  climb_to: async () => {
    const p = call('climb_to', { altitude: 30 });
    await waitFor(() => ag.flightWaiters.length > 0);
    return async () => { if (ag.flight) { ag.flight.climbTo = null; ag.flightSettle(); } await p; };
  },
  glide_to: async () => {
    const p = call('glide_to', { x: 40, z: 0 });
    await waitFor(() => ag.flightWaiters.length > 0);
    return async () => { if (ag.flight) { ag.flight.pos.x = 40; ag.flight.pos.z = 0; ag.flightSettle(); } await p; };
  },
  take_off: async () => { await call('take_off'); return async () => {}; },
};
for (const [end, later] of [['timed out aloft', 'climb_to'], ['down', 'glide_to'], ['timed out aloft', 'take_off']] as const) {
  await relaunch(); ag.flight.stamina = 1e6;
  ag.glideTo = glidesThere;
  const hold = holdNextWait();
  const landing = call('land_at', { x: 5, z: 5 });
  const flaring = await waitFor(() => hold.held);
  ag.glideTo = realGlide;
  const settleLater = await laterCalls[later]();
  const flight = ag.flight;
  hold.end(end);
  r = await landing;
  ag.flightAwait = realAwait;
  check(`a landing whose flare ${end === 'down' ? 'hears the body come down' : 'times out'} after a later ${later} took the flight is failed, and leaves the flight to it`,
    flaring && failed(r) && said(r).endsWith(' — a later call took over the flight during the flare') && flight != null && ag.flight === flight,
    `${flaring ? '' : 'the landing never reached its flare; '}${said(r)}; ${ag.flight === flight ? 'same flight' : 'flight ended or replaced'}`);
  await settleLater();
}
// A later climb_to, or a take-off's fresh flight, takes a climb over, so an earlier climb whose wait then ends, whether
// it runs out, hears a climb get there or comes down, leaves the climb alone and says it was taken over. A glide
// doesn't take a climb over: the two can fly together.
for (const [end, later] of [['timed out aloft', 'climb_to'], ['there', 'climb_to'], ['landed', 'climb_to'], ['cut', 'climb_to'], ['timed out aloft', 'take_off'], ['there', 'glide_to']] as const) {
  await relaunch(); ag.flight.stamina = 1e6;
  const hold = holdNextWait();
  const first = call('climb_to', { altitude: 20 });
  const waiting = await waitFor(() => hold.held);
  const settleLater = await laterCalls[later]();
  const flight = ag.flight, climbTo = ag.flight?.climbTo;
  hold.end(end);
  r = await first;
  ag.flightAwait = realAwait;
  if (later === 'glide_to') {
    check('a climb whose wait hears it get there while a later glide_to flies is done, since a glide doesn\'t take a climb over',
      waiting && ok(r) && /^at [0-9.]+m — /.test(said(r)), said(r));
  } else if (end === 'cut') {
    // A down cuts every climb on the flight at once, so a climb taken over that's cut answers the cut, as the later one does.
    check('a climb taken over by a later climb_to whose wait hears a cut is failed as cut, not as taken over',
      waiting && failed(r) && /^cut mid-climb at /.test(said(r)), said(r));
  } else {
    check(`a climb whose wait ${end === 'there' ? 'hears a climb get there' : end === 'landed' ? 'comes down' : 'runs out'} after a later ${later} is failed as taken over, and leaves the flight's climb alone`,
      waiting && failed(r) && /^taken over at [0-9.]+m by a later call$/.test(said(r)) && ag.flight === flight && ag.flight?.climbTo === climbTo,
      `${said(r)}; climbTo ${ag.flight?.climbTo}, was ${climbTo}`);
  }
  await settleLater();
}
// A landing takes over a climb still waiting: it clears the climb's height at once, so the climb lifts the body no
// further, and the climb's answer says it was taken over.
{
  await relaunch(); ag.flight.stamina = 1e6;
  const held: ((v: string) => void)[] = [];
  ag.flightAwait = () => new Promise<string>((res) => { held.push(res); });
  const climbing = call('climb_to', { altitude: 30 });
  const waiting = await waitFor(() => held.length === 1);
  const landing = call('land_at', { x: 5, z: 5 });
  const gliding = await waitFor(() => held.length === 2);
  const cleared = ag.flight?.climbTo == null;
  held[0]('there');
  r = await climbing;
  held[1]('arrived');
  const flaring = await waitFor(() => held.length === 3);
  held[2]?.('down');
  const landed = await landing;
  ag.flightAwait = realAwait;
  check('a landing takes over a climb still waiting: its glide clears the climb\'s height, and the climb is failed as taken over',
    waiting && gliding && flaring && cleared && failed(r) && /^taken over at [0-9.]+m by a later call$/.test(said(r)) && ok(landed),
    `cleared ${cleared}; ${said(r)}; landing: ${said(landed)}`);
}
// A climb_to that runs while a landing's glide still waits for the body's bones is taken over by that glide too, since
// the glide takes the climb in the same step as the course, after its own wait for the bones.
{
  await relaunch(); ag.flight.stamina = 1e6;
  const fastBones = ag.loadBodyBones;
  let bonesAsked = 0, releaseBones = () => {};
  // The landing asks for the bones, then its glide does; the glide's ask is held until the climb is waiting.
  ag.loadBodyBones = () => ++bonesAsked === 2 ? new Promise((res) => { releaseBones = () => res(ag.bodyBoneNames); }) : fastBones();
  const held: ((v: string) => void)[] = [];
  ag.flightAwait = () => new Promise<string>((res) => { held.push(res); });
  const landing = call('land_at', { x: 5, z: 5 });
  const glideAsked = await waitFor(() => bonesAsked === 2);
  const climbing = call('climb_to', { altitude: 30 });
  const climbWaits = await waitFor(() => held.length === 1);
  releaseBones();
  const gliding = await waitFor(() => held.length === 2);
  const cleared = ag.flight?.climbTo == null;
  held[0]('there');
  r = await climbing;
  held[1]?.('arrived');
  const flaring = await waitFor(() => held.length === 3);
  held[2]?.('down');
  const landed = await landing;
  ag.loadBodyBones = fastBones; ag.flightAwait = realAwait;
  check('a climb_to run while a landing\'s glide waits for the bones is taken over by that glide: its height is cleared, and it is failed as taken over',
    glideAsked && climbWaits && gliding && flaring && cleared && failed(r) && /^taken over at [0-9.]+m by a later call$/.test(said(r)) && ok(landed),
    `cleared ${cleared}; ${said(r)}; landing: ${said(landed)}`);
}
// A landing whose glide is refused before it sets a course, as when the flight right goes while the bones load, is
// refused with the glide's words, and makes no flare.
{
  await relaunch();
  ag.glideTo = async () => ({ ok: false, text: 'you cannot fly here — flight was withdrawn' });
  const hold = holdNextWait();
  const answer: any = await Promise.race([call('land_at', { x: 5, z: 5 }), new Promise((res) => setTimeout(() => res({ rejected: 'still waiting 5 s after its glide was refused' }), 5000))]);
  ag.glideTo = realGlide; ag.flightAwait = realAwait;
  check('a landing whose glide was refused before it set a course is refused with the glide\'s words, and makes no flare',
    failed(answer) && said(answer) === 'you cannot fly here — flight was withdrawn' && !hold.held, `${said(answer)}; flare ${hold.held ? 'waited' : 'none'}`);
  hold.end('timed out aloft');
}
// A refused take-off makes no fresh flight in the air, so it takes nothing over: the flight's course is as it was, and
// a climb waiting on the flight still answers for itself. The state is built by hand, the flight's wings folded and
// the posture's not: a body doesn't meet this refusal with a call waiting, since fold_wings folds both and take_off
// refuses on the posture first, and a recovery stands the flight up with its wings open. The check pins the order, so
// that a refusal flightTakeOff gains later still takes nothing over.
{
  await relaunch(); ag.flight.stamina = 1e6;
  const hold = holdNextWait();
  const climbing = call('climb_to', { altitude: 30 });
  const waiting = await waitFor(() => hold.held);
  ag.flight.phase = 'GROUND'; ag.flight.wings = 'FOLDED';
  const course = ag.flightCourse;
  const refusedTakeOff = await call('take_off');
  const courseKept = ag.flightCourse === course;
  hold.end('landed');
  r = await climbing;
  ag.flightAwait = realAwait;
  check('a refused take-off takes over nothing, leaving the flight\'s course, and a climb still waiting answers that it came down',
    waiting && courseKept && failed(refusedTakeOff) && /^still standing — /.test(said(refusedTakeOff)) && failed(r) && /^came down on the ground at /.test(said(r)),
    `course ${courseKept ? 'kept' : 'moved'}; ${said(refusedTakeOff)}; ${said(r)}`);
}
// A later call that sets the course while a landing still glides takes the flight over too, so the landing leaves it
// to that call and makes no flare.
{
  await relaunch(); ag.flight.stamina = 1e6;
  const hold = holdNextWait();
  const landing = call('land_at', { x: 80, z: 0 });
  const gliding = await waitFor(() => hold.held);
  const settleLater = await laterCalls.climb_to();
  const flight = ag.flight;
  hold.end('arrived');
  const answer: any = await Promise.race([landing, new Promise((res) => setTimeout(() => res({ rejected: 'still waiting 5 s after its glide ended' }), 5000))]);
  ag.flightAwait = realAwait;
  check('a landing whose glide a later climb_to took over is failed, leaves the flight to it, and makes no flare',
    gliding && failed(answer) && said(answer).endsWith(' — a later call took over the flight during the glide') && ag.flight === flight && ag.flight?.climbTo === 30
      && ag.flightWaiters.length === 1, `${said(answer)}; climbTo ${ag.flight?.climbTo}; ${ag.flightWaiters.length} waiter(s)`);
  await settleLater();
  // A flare the check didn't expect would still be waiting: answer it, so its timer doesn't hold the run.
  for (const w of ag.flightWaiters.splice(0)) w.done('timed out aloft');
  await landing;
}
// A glide whose flight a later landing has ended by the time its wait answers says where the body is, rather than
// throwing on the flight that's gone.
await relaunch();
ag.flightAwait = async () => { ag.flight = null; ag.pos.x = 12; ag.pos.z = 34; return 'timed out aloft'; };
r = await call('glide_to', { x: 40, z: 0 });
ag.flightAwait = realAwait;
check('a glide whose flight has ended by the time its wait answers is failed, saying where the body is',
  failed(r) && said(r) === 'timed out aloft at (12.0, 34.0)', said(r));
// The flare's wait is sized from the ground under the body as it begins, and is never shorter than 60 s: a flare
// that begins over high ground, here 55 m, and comes down on lower, 40 m, gets the 60 s. The asked point is away from
// the body, which the stand-in glide leaves where it was, so the check sees which ground the sizing read.
{
  await flyingAt(59);
  ag.glideTo = glidesThere;
  const realHeight = ag.heightAt;
  let sizedAt: number[] | null = null;
  ag.heightAt = (hx: number, hz: number) => { if (sizedAt) return 40; sizedAt = [hx, hz]; return 55; };
  flown = await flownByTicks(() => call('land_at', { x: 30, z: 0 }));
  ag.heightAt = realHeight; ag.glideTo = realGlide;
  check('a landing whose flare begins over a 55 m knoll under the body and comes down on 40 m ground does so inside its wait, which is 60 s',
    ok(flown.answer) && / — landed at /.test(said(flown.answer)) && flown.waits.length === 1 && flown.waits[0].ms === 60_000 && flown.waits[0].ms > flown.waits[0].took * 1000
      && sizedAt?.[0] === 0 && sizedAt?.[1] === 0,
    `${said(flown.answer)}; ${JSON.stringify(flown.waits)}; sized at ${JSON.stringify(sizedAt)}`);
}
// The flare sinks on the circle held over the point, so the answer says how far off it came down.
r = await landing(arrived, 'down', { x: 12, z: 6 });
check('a landing whose glide arrived and whose flare came down is done, saying how far from the point',
  ok(r) && / — landed at \(12\.0, 6\.0\), 7\.1m from \(5\.0, 5\.0\)$/.test(said(r)), said(r));
// The rehearsal seam, switched on for this run, refuses a body that isn't flying.
r = await call('rehearse_down', {});
check('rehearse_down with no flight is failed', failed(r) && said(r) === 'not airborne — move {mode: "fly"} first', said(r));
r = await call('rehearse_recover', {});
check('rehearse_recover with no flight is failed', failed(r) && said(r) === 'not airborne — move {mode: "fly"} first', said(r));
await relaunch();
r = await call('rehearse_recover', {});
check('rehearse_recover of a body that is flying, not down, is failed',
  failed(r) && /^nothing to recover from — the body isn't down \(/.test(said(r)), said(r));
ag.flightRagdoll = async () => {}; // the real ragdoll needs a physics body this bench hasn't got
r = await call('rehearse_down', {});
check('rehearse_down in flight is done', ok(r) && /^down — /.test(said(r)), said(r));
// A down answers a climb or a glide waiting on the flight at once. From the down the ragdoll's sim runs, and the flight
// tick, which settles waits, doesn't, so nothing else would answer the wait until the body came to rest.
for (const [tool, a, words] of [
  ['climb_to', { altitude: 40 }, /^cut mid-climb at /],
  ['glide_to', { x: 60, z: 0 }, /^cut mid-glide — you are falling at /],
] as const) {
  await relaunch(); ag.flight.stamina = 1e6;
  const waiting = call(tool, a);
  for (let i = 0; i < 400 && !ag.flightWaiters.length; i++) await new Promise((res) => setTimeout(res, 5));
  const waited = ag.flightWaiters.length > 0;
  await call('rehearse_down', {});
  const answer = await Promise.race([waiting, new Promise((res) => setTimeout(() => res({ rejected: 'still waiting 5 s after the down' }), 5000))]);
  check(`a down answers ${tool === 'climb_to' ? 'a climb' : 'a glide'} waiting on the flight at once, as cut`, waited && failed(answer) && words.test(said(answer)),
    waited ? said(answer) : 'the act registered no flight wait');
  ag.flightWaiters.splice(0); // a wait the down didn't answer would answer for the next call
}
// A world that withdraws flight mid-climb downs the body, and that answers the climb at once, as a down does.
await relaunch(); ag.flight.stamina = 1e6;
{
  const waiting = call('climb_to', { altitude: 40 });
  for (let i = 0; i < 400 && !ag.flightWaiters.length; i++) await new Promise((res) => setTimeout(res, 5));
  const waited = ag.flightWaiters.length > 0;
  ag.acceptEffectiveRights({ role: 'builder', fly: false }, 'world');
  const answer = await Promise.race([waiting, new Promise((res) => setTimeout(() => res({ rejected: 'still waiting 5 s after the withdrawal' }), 5000))]);
  ag.myRights = { role: 'builder', fly: true };
  check('a world withdrawing flight mid-climb answers the climb at once, as cut', waited && failed(answer) && /^cut mid-climb at /.test(said(answer)),
    waited ? said(answer) : 'the act registered no flight wait');
  ag.flightWaiters.splice(0); // a wait the withdrawal didn't answer would answer for the next call
}
await relaunch();
r = await call('rehearse_down', {});
r = await call('rehearse_recover', {});
check('rehearse_recover of a body that is down is done', ok(r) && said(r) === 'recovering', said(r));
const begun = ag.flight?.recoverAt;
r = await call('rehearse_recover', {});
check('a second recovery while one in the air has begun is done as already recovering, and doesn\'t start it over',
  ok(r) && said(r) === 'already recovering' && begun != null && ag.flight?.recoverAt === begun, `${said(r)}; recoverAt ${begun} then ${ag.flight?.recoverAt}`);
await relaunch(); ag.flight.phase = 'RAGDOLL';
r = await call('rehearse_recover', {});
check('rehearse_recover of a body down on the ground is done', ok(r) && said(r) === 'recovering' && ag.flight?.phase === 'RECOVER', `${said(r)}; ${ag.flight?.phase}`);
r = await call('rehearse_recover', {});
check('a second recovery while the body sits up is done, as already recovering', ok(r) && said(r) === 'already recovering', said(r));
// A fold before a down: recovery opens the flight's wings and leaves the folded posture set, which take_off reads.
// An unfold that finds the wings open is done, and clears the posture, or take_off would refuse wings unfold can't open.
await relaunch(); ag.flight.phase = 'GROUND'; ag.flight.wings = 'OPEN'; ag.wingsFolded = true;
r = await call('unfold_wings');
check('an unfold that finds the flight\'s wings open is done, and clears the folded posture, saying so',
  ok(r) && said(r) === 'wings stay as they are — already open; the folded-wing posture is released' && ag.wingsFolded === false, `${said(r)}; wingsFolded ${ag.wingsFolded}`);
r = await call('take_off');
check('...so take_off then flies', ok(r) && /^took off/.test(said(r)), said(r));
// The other way round: a fold that finds the flight's wings folded is done, and sets the posture to match.
// (The posture is cleared first, so a failure above doesn't stop this relaunch.)
ag.wingsFolded = false;
await relaunch(); ag.flight.phase = 'GROUND'; ag.flight.wings = 'FOLDED';
r = await call('fold_wings');
check('a fold that finds the flight\'s wings folded, with the rig known, is done, and sets the folded posture',
  ok(r) && said(r) === 'wings stay as they are — already folded; the posture now shows them folded' && ag.wingsFolded === true, `${said(r)}; wingsFolded ${ag.wingsFolded}`);
ag.wingsFolded = false; ag.flight = null;

console.log('\nBONES NOT KNOWN');
const unread: any = new WorldAgent({ name: 'unread', world: 'is-error-bench' });
unread.bodyBoneNames = null;
unread.loadBodyBones = async () => null;
unread.myRights = { role: 'builder', fly: true };
const callU = (name: string, a: Record<string, unknown> = {}) => callOn(unread, name, a);
r = await callU('fold_wings');
check('a fold while the bones are unknown is failed', failed(r) && /^wings unchanged — /.test(said(r)), said(r));
unread.wingsFolded = true;
r = await callU('fold_wings');
check('a fold of wings already folded, while the bones are unknown, changes nothing, and is done',
  ok(r) && said(r) === 'wings are already folded', said(r));
r = await callU('unfold_wings');
check('releasing a folded posture while the bones are unknown is done',
  ok(r) && /^folded-wing posture released — /.test(said(r)) && unread.wingsFolded === false, said(r));
r = await callU('unfold_wings');
check('an unfold with nothing folded while the bones are unknown changes nothing, and is done',
  ok(r) && /^nothing is folded — /.test(said(r)), said(r));
// In the air, the flight's own wings say whether they're folded.
unread.flight = { wings: 'OPEN', phase: 'PILOT' };
r = await callU('fold_wings');
check('a fold in the air while the bones are unknown is failed', failed(r) && /^wings unchanged — /.test(said(r)), said(r));
unread.flight = { wings: 'FOLDED', phase: 'PILOT' };
r = await callU('fold_wings');
check('a fold in the air of wings the flight holds folded, while the bones are unknown, is done, and the posture follows, saying so',
  ok(r) && said(r) === 'wings are already folded; the posture now shows them folded' && unread.wingsFolded === true, `${said(r)}; wingsFolded ${unread.wingsFolded}`);
unread.flight = null; unread.wingsFolded = false;
const wingless: any = new WorldAgent({ name: 'wingless', world: 'is-error-bench' });
wingless.bodyBoneNames = ['Hip', 'Spine02', 'Head'];
wingless.loadBodyBones = async () => wingless.bodyBoneNames;
r = await callOn(wingless, 'unfold_wings');
check('an unfold of a wingless body changes nothing, and is done',
  ok(r) && /^this body has no folded-wing posture to release$/.test(said(r)), said(r));

console.log('\nFLIGHT THROUGH THE DOOR');
// The door's flight calls answer each act's {ok} as isError (tools.ts act()), and a fly-mode move stops at the first
// step that didn't do what it asked, with where the flight stands after it.
{
  const pilot: any = new WorldAgent({ name: 'pilot', world: 'is-error-bench' });
  pilot.bodyBoneNames = WINGED;
  pilot.loadBodyBones = async () => pilot.bodyBoneNames;
  const fly = (name: string, a: Record<string, unknown> = {}) => settle(handleTool({ agent: pilot } as any, name, a));
  const linesOf = (x: any) => said(x).split('\n');
  pilot.myRights = { role: 'builder', fly: false };
  r = await fly('move', { mode: 'fly' });
  check('a fly-mode move with no grant to fly is failed, in the take-off\'s words', failed(r) && /^you cannot fly here — /.test(said(r)), said(r));
  pilot.myRights = { role: 'builder', fly: true };
  r = await fly('anim', { name: 'wings-folded' });
  check('anim {name: "wings-folded"} on the ground folds the wings and holds the pose, and is done',
    ok(r) && /^\{"playing":"wings-folded","mode":"hold"/.test(said(r)) && pilot.wingsFolded === true, said(r));
  r = await fly('move', { mode: 'fly' });
  check('a fly-mode move with the wings folded is failed, saying how to open them',
    failed(r) && /^still standing — your wings are folded; open them first/.test(said(r)) && pilot.flight?.phase !== 'PILOT', said(r));
  r = await fly('anim', { stop: 'wings-folded' });
  check('anim {stop: "wings-folded"} opens them, and is done', ok(r) && pilot.wingsFolded === false, said(r));
  r = await fly('move', { mode: 'fly' });
  check('a fly-mode move on the ground takes off, and is done, ending with where the flight stands',
    ok(r) && /^took off — /.test(linesOf(r)[0]) && linesOf(r).length >= 2, said(r));
  // A climb whose wait runs out: the move stops there, failed, before its glide, with the flight's status after it.
  const realAwaitP = pilot.flightAwait, glideOf = pilot.glideTo;
  let glides = 0;
  pilot.glideTo = (...a: unknown[]) => { glides++; return glideOf.apply(pilot, a); };
  pilot.flightAwait = async () => 'timed out aloft';
  r = await fly('move', { mode: 'fly', altitude: 40, to: [30, 0] });
  pilot.flightAwait = realAwaitP; pilot.glideTo = glideOf;
  check('a fly-mode move whose climb times out is failed, stops before its glide, and ends with where the flight stands',
    failed(r) && /^timed out aloft at .*short of the climb/.test(linesOf(r)[0]) && linesOf(r).length >= 2 && glides === 0, `${said(r)}; glides ${glides}`);
  // A glide that lands short: the move is failed with the glide's words; one that arrives is done.
  const realGlideP = pilot.glideTo;
  pilot.glideTo = async () => ({ ok: false, text: 'landed short at (2.0, 2.0) — 4.2m short.' });
  r = await fly('move', { mode: 'fly', to: [30, 0] });
  check('a fly-mode move whose glide lands short is failed, with the glide\'s words', failed(r) && /^landed short at /.test(linesOf(r)[0]), said(r));
  pilot.glideTo = async () => ({ ok: true, text: 'arrived at (30.0, 0.0), 9.0m up — holding over it' });
  r = await fly('move', { mode: 'fly', to: [30, 0] });
  check('...and one whose glide arrives is done', ok(r) && /^arrived at \(30\.0, 0\.0\)/.test(linesOf(r)[0]), said(r));
  pilot.glideTo = realGlideP;
  // act {verb: "land"}: the landing's own answer.
  const realLand = pilot.landAt;
  pilot.landAt = async () => ({ ok: false, text: 'timed out aloft at (3.0, 3.0) — landed at (3.0, 3.0), 2.8m from (5.0, 5.0)' });
  r = await fly('act', { verb: 'land', args: { to: [5, 5] } });
  check('a landing the agent answers as failed is failed through act', failed(r) && /^timed out aloft at /.test(said(r)), said(r));
  pilot.landAt = async () => ({ ok: true, text: 'arrived at (5.0, 5.0), 9.0m up — holding over it — landed at (5.0, 5.0), 0.0m from (5.0, 5.0)' });
  r = await fly('act', { verb: 'land', args: { to: [5, 5] } });
  check('...and one it answers as done is done', ok(r) && / — landed at /.test(said(r)), said(r));
  pilot.landAt = realLand;
  // A body down on the ground after a cut takes off again through a fly-mode move, as the down refusals say.
  for (const phase of ['RAGDOLL', 'RECOVER']) {
    pilot.flight.phase = phase;
    r = await fly('move', { mode: 'fly' });
    check(`a fly-mode move of a body down on the ground (${phase.toLowerCase()}) takes off afresh, and is done`, ok(r) && /^took off — /.test(linesOf(r)[0]), said(r));
  }
  pilot.flight = null;
  r = await fly('act', { verb: 'land', args: { to: [5, 5] } });
  check('act {verb: "land"} on the ground is failed', failed(r) && said(r) === 'land: you are on the ground — move {mode: "fly"} gets you up', said(r));
  // A wingless body's fold didn't happen, so nothing plays.
  const bare: any = new WorldAgent({ name: 'bare', world: 'is-error-bench' });
  bare.bodyBoneNames = ['Hip', 'Spine02', 'Head'];
  bare.loadBodyBones = async () => bare.bodyBoneNames;
  r = await settle(handleTool({ agent: bare } as any, 'anim', { name: 'wings-folded' }));
  check('anim {name: "wings-folded"} on a wingless body is failed, in the fold\'s words, and holds nothing',
    failed(r) && said(r) === 'this body has no animatable wings to fold' && !(bare.anims ?? []).some((x: any) => x.name === 'wings-folded'), said(r));
}

console.log('\nOTHER TOOLS');
r = await call('face', {});
check('face with neither a target nor x and z is failed', failed(r) && /^face needs x and z, or a target/.test(said(r)), said(r));
r = await call('face', { target: 'nobody' });
check('face of an unknown target is failed', failed(r) && /nothing here is called "nobody"/.test(said(r)), said(r));
r = await call('library', {});
check('library with none of query, kind or preview is failed', failed(r) && /^library takes one of: /.test(said(r)), said(r));
r = await call('reach', {});
check('reach with no target is failed', failed(r) && /^reach needs a target/.test(said(r)), said(r));
r = await call('reach', { who: 'someone' });
check('reaching for someone with no point is failed', failed(r) && /needs `point` too/.test(said(r)), said(r));
r = await call('reach', { point: 'elbow-of-the-moon' });
check('an unknown contact point is failed', failed(r) && /unknown contact point/.test(said(r)), said(r));
r = await call('reach', { limb: 'tail', x: 1, y: 1, z: 1 });
check('a reach with an unknown limb is failed', failed(r) && /^unknown limb "tail"/.test(said(r)), said(r));
r = await call('act', { verb: 'shove', args: {} });
check('a shove with no target is failed', failed(r) && /^shove needs a `target`/.test(said(r)), said(r));
r = await call('anim', { tracks: {}, dur: 1 });
check('anim with no usable track is failed', failed(r) && /^nothing played/.test(said(r)), said(r));
r = await call('measure', {});
check('measure with no id or lib is failed', failed(r) && /^measure wants/.test(said(r)), said(r));
r = await call('measure', { check: true, id: 'nothing-here' });
check('measure {check} of an unknown thing is failed', failed(r) && /no thing called "nothing-here"/.test(said(r)), said(r));
r = await call('measure', { check: true });
check('measure {check} with neither an id nor a lib is failed', failed(r) && /^measure \{check: true\} needs/.test(said(r)), said(r));
r = await call('act', { verb: 'kick', args: {} });
check('a kick with no who is failed', failed(r) && /^kick needs who/.test(said(r)), said(r));
r = await call('reach', { release: true, limb: 'tail' });
check('releasing an unknown limb is failed', failed(r) && /^unknown limb "tail"/.test(said(r)), said(r));
ag.reaches.set('rightHand', { t: { p: [1, 1, 1] } });
r = await call('reach', { release: true, limb: ['rightHand'] });
check('a release with a limb that is not a name is failed, releasing nothing', failed(r) && /^reach \{release\}'s `limb`/.test(said(r)) && ag.reaches.has('rightHand'),
  `${said(r)}; reaches ${[...ag.reaches.keys()]}`);
r = await call('reach', { release: true, limb: 'leftHand' });
check('releasing a limb that was not reaching changes nothing, and is done', ok(r) && /wasn't reaching for anything$/.test(said(r)), said(r));
r = await call('reach', { release: true });
check('a bare release lets go of every reach, and is done', ok(r) && said(r) === 'let go — all reaches released' && ag.reaches.size === 0, said(r));
r = await call('reach', { release: true });
check('...and with nothing reaching it changes nothing, and is done', ok(r) && said(r) === "you weren't reaching for anything", said(r));
r = await call('body_state', { who: 'nobody-here' });
check('body_state of someone not here is failed', failed(r), said(r).slice(0, 200));
r = await call('anim', { joints: { leftUpperArm: [0, 0, 1] } });
check('a pose with nothing usable is failed', failed(r) && /^no pose set — nothing usable/.test(said(r)), said(r));
r = await call('anim', {});
check('a bare anim that cannot read the rig to list its bones is failed', failed(r) && /^can't read your rig to list its bones/.test(said(r)), said(r));
const TRACKS = { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, -0.7, 0.7] }] };
r = await call('anim', { tracks: TRACKS });
check('an animation with no duration is failed', failed(r) && /^animate needs dur/.test(said(r)), said(r));
// With the link down, nothing reaches the world, and the call says so in the agent's words (notJoined()).
const reconnecting = (x: any) => /^this body is reconnecting to the world, so nothing was sent; it rejoins on its own/.test(said(x));
r = await call('anim', { dur: 1, tracks: TRACKS });
check('your own animation with the link down is failed, saying the body is reconnecting', failed(r) && reconnecting(r), said(r));
const held = { leftUpperArm: [0, 0, -0.7, 0.7] };
ag.heldPose = held;
r = await call('anim', { replace: true, dur: 1, tracks: TRACKS });
check('a replacing animation with the link down is failed, saying the body is reconnecting, and the held pose stays',
  failed(r) && reconnecting(r) && ag.heldPose === held, `${said(r)}; held ${JSON.stringify(ag.heldPose)}`);
ag.heldPose = null;
// Someone the door can see, so a request to them is sent (and here meets the link down).
ag.people.set('someone', { id: 'someone', avatar: 'a.vrm', pose: null, agent: false, observedAt: null });
r = await call('act', { verb: 'shove', args: { target: 'someone' } });
check('a shove with the link down is failed, saying the body is reconnecting', failed(r) && reconnecting(r), said(r));
r = await call('anim', { stop: true, target: 'someone' });
check('releasing someone else\'s pose with the link down is failed, saying the body is reconnecting', failed(r) && reconnecting(r), said(r));
r = await call('say', { text: 'hello' });
check('a say with the link down is failed', failed(r), said(r));
// Joined, with the socket closed under it, nothing can go out either.
const realWs = ag.ws;
ag.joined = true;
ag.ws = { readyState: 3, send: () => { throw new Error('sent on a closed socket'); } };
for (const [tool, a] of [['anim', { dur: 1, tracks: TRACKS }], ['act', { verb: 'shove', args: { target: 'someone' } }]] as const) {
  r = await call(tool, a);
  check(`${tool === 'act' ? 'a shove' : 'your own animation'} while joined with the socket closed is failed, saying the body is reconnecting`, failed(r) && reconnecting(r), said(r));
}
// With the socket open, each goes out on it.
const out: any[] = [];
ag.ws = { readyState: 1, send: (s: string) => { out.push(JSON.parse(s)); } };
r = await call('anim', { dur: 1, tracks: TRACKS });
check('with the socket open, your own animation is sent', ok(r) && out.some((f) => f.type === 'anim' && f.dur === 1), `${said(r)}; ${JSON.stringify(out)}`);
r = await call('act', { verb: 'shove', args: { target: 'someone' } });
check('...and a shove of someone here', ok(r) && out.some((f) => f.type === 'puppet' && f.target === 'someone'), `${said(r)}; ${JSON.stringify(out)}`);
ag.joined = false; ag.ws = realWs;
// A handler that throws is answered in the result, where the model reads it, and the throw goes to the operator's log.
const logged: string[] = [];
const realConsoleError = console.error;
const realSay = ag.say;
for (const [thrown, words] of [
  [new Error('the world socket is busy'), 'the world socket is busy'],
  ['the world socket is busy', 'the world socket is busy'],
  [new TypeError(''), 'say failed, and its error gave no reason (TypeError)'],
  ['', 'say failed, and its error gave no reason'],
] as const) {
  ag.say = () => { throw thrown; };
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  r = await call('say', { text: 'hello' });
  console.error = realConsoleError;
  check(`a handler that throws ${thrown instanceof Error ? `${thrown.name}(${JSON.stringify(thrown.message)})` : JSON.stringify(thrown)} is failed, saying ${JSON.stringify(words)}`,
    failed(r) && said(r) === words, said(r));
}
ag.say = realSay;
check('...and each throw is in the operator\'s log, naming the tool', logged.filter((l) => l.startsWith('[door] say threw:')).length === 4, logged.join(' | '));
// What the world's HTTP side answers, stood in for.
const realFetch = globalThis.fetch;
const serve = (handler: (url: string) => Response) => { globalThis.fetch = (async (u: any) => handler(String(u))) as any; };
const unreachable = () => { globalThis.fetch = (async () => { throw new Error('connect ECONNREFUSED'); }) as any; };
serve(() => new Response('[]', { status: 200 }));
r = await call('library', { kind: 'avatars' });
check('a library sheet of an empty roster is an answer, not a failure', ok(r) && said(r) === 'there are no avatars to show yet', said(r));
r = await call('library', { kind: 'models' });
check('a library sheet of an empty library is an answer, not a failure', ok(r) && said(r) === 'there are no models to show yet', said(r));
serve(() => new Response(JSON.stringify([{ name: 'kestrel', height: 1.7 }]), { status: 200 }));
r = await call('library', { kind: 'avatars', page: 5 });
check('a library sheet page past the end is failed', failed(r) && /^no page 5: there are 1 avatars on 1 page/.test(said(r)), said(r));
serve(() => new Response(JSON.stringify([{ name: 'kestrel', path: 'avatars/kestrel.vrm' }]), { status: 200 }));
r = await call('set_avatar', { avatar: 'heron' });
check('wearing a body not on the roster is failed', failed(r) && /^no body named "heron"/.test(said(r)), said(r));
serve(() => new Response('not found', { status: 404 }));
r = await call('library', { preview: 'heron' });
check('a preview the world has none of is failed', failed(r) && /^no preview for "heron"/.test(said(r)), said(r));
unreachable();
r = await call('library', { preview: 'heron' });
check('a preview with the world\'s server unreachable says so', failed(r)
  && /^couldn't get a preview of "heron" from the world's server \(connect ECONNREFUSED\); calling again may work$/.test(said(r)), said(r));
serve(() => new Response('forbidden', { status: 403 }));
r = await call('library', { preview: 'heron' });
check('a preview refused with a 403 isn\'t reported as missing, and says calling again won\'t change it', failed(r) && said(r) === 'couldn\'t get a preview of "heron" from the world\'s server (it answered 403); calling again won\'t change that', said(r));
serve((url) => new Response(/\/thumb\//.test(url) ? 'forbidden' : 'busy', { status: /\/thumb\//.test(url) ? 403 : 503 }));
r = await call('library', { preview: 'heron' });
check('a preview refused at one place and busy at the other names both, and may work on another call',
  failed(r) && said(r) === 'couldn\'t get a preview of "heron" from the world\'s server (it answered 403; it answered 503); calling again may work', said(r));
serve(() => new Response('slow down', { status: 429 }));
r = await call('library', { preview: 'heron' });
check('...and one answered 429 may work on another call', failed(r) && /\(it answered 429\); calling again may work$/.test(said(r)), said(r));
serve(() => new Response('timed out', { status: 408 }));
r = await call('library', { preview: 'heron' });
check('...and one answered 408', failed(r) && /\(it answered 408\); calling again may work$/.test(said(r)), said(r));
globalThis.fetch = (async () => { throw new Error(''); }) as any;
r = await call('library', { preview: 'heron' });
check('a fetch that fails with no message still counts as not reached', failed(r) && /^couldn't get a preview of "heron" .*\(the request failed\); calling again may work$/.test(said(r)), said(r));
const unreadable = () => new Response(new ReadableStream({ start(c) { c.error(new Error('connection dropped')); } }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
serve(unreadable);
r = await call('library', { preview: 'heron' });
check('a preview whose body can\'t be read says so', failed(r) && /^couldn't get a preview of "heron" .*\(a preview it sent couldn't be read: connection dropped\); calling again may work$/.test(said(r)), said(r));
serve((url) => new Response(/\/thumb\//.test(url) ? 'not found' : 'busy', { status: /\/thumb\//.test(url) ? 404 : 503 }));
r = await call('library', { preview: 'heron' });
check('a preview whose second place answers 503 isn\'t reported as missing', failed(r) && /^couldn't get a preview of "heron" .*\(it answered 503\)/.test(said(r)), said(r));
serve((url) => /\/thumb\//.test(url) ? unreadable() : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
r = await call('library', { preview: 'heron' });
check('a preview the library has is shown when the portrait can\'t be read', ok(r) && r?.content?.[0]?.type === 'image' && r.content[0].data === 'AQID', JSON.stringify(r).slice(0, 200));
serve(() => new Response('no renderer', { status: 503 }));
r = await call('screenshot', {});
check('a screenshot with no view available is failed', failed(r) && /^screenshot: no picture was taken; the world server answered "no renderer" \(503\)/.test(said(r)), said(r));
unreachable();
r = await call('screenshot', {});
check('a screenshot that cannot reach the world is failed', failed(r) && /^screenshot failed: no picture arrived from the world server \(connect ECONNREFUSED\)/.test(said(r)), said(r));
unreachable();
r = await call('measure', { check: true, lib: 'models/stone.glb' });
check('a model check that can\'t reach the check is failed', failed(r) && /^the check could not be reached: connect ECONNREFUSED/.test(said(r)), said(r));
serve(() => new Response(JSON.stringify({ error: 'not a GLB' }), { status: 200 }));
r = await call('measure', { check: true, lib: 'models/stone.glb' });
check('a model check the world answers with an error is failed', failed(r) && said(r) === "couldn't check models/stone.glb: not a GLB", said(r));
unreachable();
r = await call('measure', { lib: 'models/stone.glb' });
check('a measure that can\'t reach the world server is failed', failed(r) && /^measure: the world server didn't answer /.test(said(r)), said(r));
serve(() => new Response('<html>bad gateway</html>', { status: 502 }));
r = await call('measure', { lib: 'models/stone.glb' });
check('a measure answered with something that isn\'t geometry is failed', failed(r) && /^measure: the world server answered 502 with something that isn't geometry/.test(said(r)), said(r));
serve(() => new Response('needs a key', { status: 401 }));
r = await call('measure', { lib: 'models/stone.glb' });
check('a measure the world\'s read key refuses is failed', failed(r) && /^measure: the world's state needs a read key/.test(said(r)), said(r));
serve(() => new Response(JSON.stringify({ error: 'no such model' }), { status: 404 }));
r = await call('measure', { lib: 'models/stone.glb' });
check('a measure the world answers with an error is failed', failed(r) && said(r) === 'measure: the world server answered "no such model", so nothing was measured', said(r));
serve(() => new Response(JSON.stringify({ lib: 'models/stone.glb' }), { status: 200 }));
r = await call('measure', { lib: 'models/stone.glb' });
check('a measure whose answer holds no geometry is failed', failed(r) && /^no geometry available for that/.test(said(r)), said(r));
unreachable();
r = await call('worlds', {});
check('a worlds list that can\'t reach the world server is failed', failed(r) && /^worlds: the world server didn't answer /.test(said(r)), said(r));
serve(() => new Response('busy', { status: 503 }));
r = await call('worlds', {});
check('a worlds list the world server answers 503 is failed', failed(r) && /^worlds: the world server answered 503/.test(said(r)), said(r));
globalThis.fetch = realFetch;
// What a say sends, with the world taking it.
const says: string[] = [];
ag.say = async (text: string) => { says.push(text); return { ok: true }; };
r = await call('say', { text: 's'.repeat(4001) });
check('a say over 4000 characters sends the first 4000, and says so',
  ok(r) && said(r) === 'said — only its first 4000 characters were sent; say the rest in another call' && says.at(-1)?.length === 4000, said(r));
r = await call('say', { text: 's'.repeat(4000) });
check('...and one of exactly 4000 is just said', ok(r) && said(r) === 'said', said(r));
// A cut never ends in half of a character: here the 4000th unit is the first half of an emoji.
r = await call('say', { text: 's'.repeat(3999) + '😀' + 's' });
check('a say whose cut would split a character sends what comes before it, and says how much',
  ok(r) && said(r) === 'said — only its first 3999 characters were sent; say the rest in another call' && says.at(-1) === 's'.repeat(3999), said(r));
r = await call('say', { text: '😀'.repeat(2001) });
check('a cut is counted in characters: 2000 emoji, not their 4000 units', ok(r) && said(r) === 'said — only its first 2000 characters were sent; say the rest in another call' && says.at(-1) === '😀'.repeat(2000), said(r));
ag.say = realSay;
// A request to another body is sent, and the target decides.
const puppets: [string, unknown][] = [];
const realPuppet = ag.puppet;
ag.puppet = (target: string, spec: unknown) => { puppets.push([target, spec]); };
r = await call('anim', { stop: true, target: 'someone' });
check('releasing someone else\'s pose says it was asked, and that they decide', ok(r) && said(r) === 'asked someone to release their pose. They decide whether to.', said(r));
check('...and asks them to clear it', JSON.stringify(puppets.at(-1)) === '["someone",{"pose":{}}]', JSON.stringify(puppets.at(-1)));
ag.puppet = realPuppet;
ag.people.delete('someone');
// The world's answer decides a moderation verb's result.
const realSendMod = ag.sendMod, realOutcome = ag.modOutcome;
ag.sendMod = () => {};
ag.modOutcome = async () => 'refused: only a world admin can ban everywhere';
r = await call('act', { verb: 'ban', args: { who: 'someone', global: true } });
check('a global ban the world refused is failed, with its words', failed(r) && said(r) === 'refused: only a world admin can ban everywhere', said(r));
ag.modOutcome = async () => 'banned someone';
r = await call('act', { verb: 'ban', args: { who: 'someone', global: true } });
check('a global ban the world confirmed is done', ok(r) && said(r) === 'banned someone', said(r));
ag.modOutcome = async () => null;
r = await call('act', { verb: 'ban', args: { who: 'someone', global: true } });
check('a global ban sent with no echo yet is not failed', ok(r) && /no echo yet/.test(said(r)), said(r));
r = await call('act', { verb: 'bans', args: { global: true } });
check('a global ban list that never arrives is failed', failed(r) && /no reply from the world/.test(said(r)), said(r));
ag.modOutcome = async () => 'refused: only an operator can list every world\'s bans';
r = await call('act', { verb: 'bans', args: { global: true } });
check('a global ban list the world refused is failed, with its words', failed(r) && said(r) === "refused: only an operator can list every world's bans", said(r));
ag.sendMod = realSendMod; ag.modOutcome = realOutcome;

console.log('\nNAMING A PLACE');
r = await call('name_place', { name: '!!' });
check('a malformed place name is failed', failed(r) && /^a place name is/.test(said(r)), said(r));
r = await call('name_place', { name: 'lookout', on: 'nothing-here' });
check('naming a place on an unknown thing is failed', failed(r) && /no thing called "nothing-here"/.test(said(r)), said(r));
ag.entities.set('lamp', { id: 'lamp', pos: [0, 2, 0] });
r = await call('name_place', { name: 'lookout', on: 'lamp' });
check('naming a place on a thing with no model is failed', failed(r) && /has no model — places hang on placed things/.test(said(r)), said(r));
ag.entities.delete('lamp');
{
  ag.entities.set('stone', { id: 'stone', model: 'models/stone.glb', pos: [0, 0, 0] });
  const realEff = ag.eff, realSendOps = ag.sendOps;
  ag.eff = () => ({ ok: true, pos: [0, 0, 0], yaw: 0, scale: 1 });
  ag.sendOps = async () => ({ ok: false, refused: { code: 'locked', reason: 'that thing is locked' } });
  r = await call('name_place', { name: 'gate', on: 'stone' });
  check('a name the world refuses is failed, with its words', failed(r) && said(r) === 'not named — the world refused: that thing is locked', said(r));
  ag.sendOps = realSendOps; ag.eff = realEff;
  ag.entities.delete('stone');
}

console.log('\nFOLDED AND REMOVED TOOLS');
// Main's tools that this protocol folds into general tools are refused with the call that does it now, and nothing
// runs; world_access, folded into @world's own components, says so, and whisper says it was removed with world chat's
// private channel (both had fallen through to the unknown-tool reply, whisper's naming whois).
for (const name of ['take_off', 'climb_to', 'glide_to', 'land_at', 'fold_wings', 'unfold_wings', 'rehearse_down', 'rehearse_recover',
  'clear_reach', 'clear_pose', 'ragdoll', 'library_preview', 'library_sheet', 'remove', 'kick', 'list_bans']) {
  r = await door(name, {});
  check(`${name} is refused as folded, and nothing runs`, failed(r) && new RegExp(`^${name} folded into a general tool: .* — nothing ran$`).test(said(r)), said(r));
}
r = await door('world_access', {});
check('world_access is refused as folded, and nothing runs', failed(r) && /^world_access folded into a general tool: .* — nothing ran$/.test(said(r)), said(r));
r = await door('whisper', {});
check('whisper is refused as removed, saying why, and nothing runs', failed(r) && /^whisper was removed: world chat has no private channel .* — nothing ran$/.test(said(r)) && !/whois/.test(said(r)), said(r));

console.log('\nWALK');
const walker: any = {
  pos: { x: 0, y: 0, z: 0 },
  walkStopReason: null as string | null, walkStall: null as string | null, lastWalkNote: null, lastWalkRefusal: null,
  myOccupancy: null, entities: new Map(), replica: null,
  walkTo: async () => false,
  placesAt: () => [],
  refName: (id: string) => id,
  destination: (to: string) => ({ refusal: `nothing here is called "${to}"` }),
};
const walk = (a: Record<string, unknown>) => settle(handleTool({ agent: walker } as any, 'move', a));
walker.walkTo = async (_x: number, _z: number, _run: boolean, _ms: number, _tol: number, _y: unknown, _near: unknown, receipt: { refusal: string | null }) => {
  receipt.refusal = 'no route: the destination is inside a wall';
  return false;
};
r = await walk({ to: [3, 4] });
check('a refused walk is failed, with its reason', failed(r) && /^move refused before a step: no route: the destination is inside a wall/.test(said(r)), said(r));
walker.walkTo = async () => false;
r = await walk({ to: [3, 4] });
check('a walk that stops short is failed', failed(r) && /interrupted or timed out/.test(said(r)), said(r));
r = await walk({ to: 'lookout/balcony' });
check('a walk to a place nobody named is failed', failed(r) && /nothing here is called "lookout\/balcony"/.test(said(r)), said(r));
walker.walkTo = async () => { walker.pos = { x: 3, y: 0, z: 4 }; return true; };
r = await walk({ to: [3, 4] });
check('an arrival is done', ok(r) && /^arrived at/.test(said(r)), said(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
