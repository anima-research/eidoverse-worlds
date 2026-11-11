// flight-exit-test — an agent's flight has one way out and one current course (research LOCOMOTION-SHAPE 2026-11-10).
//
//   bun tools/flight-exit-test.ts
//
// One row per issue: #287 take_off aloft, #290 an older glide steering, #293 the flare's pitch, #298 a landed or
// knocked-down flight still owning the body, #300 close or a dropped link leaving a wait to its timer. A bare agent,
// no world server: its tick is called by hand, 0.1 s a tick.
import { tryUntil } from './protocol/wait.ts';
const { WorldAgent } = await import('../mcpl/agent.ts');
const { handleTool } = await import('../mcpl/tools.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const WINGED = ['Hip', 'Spine02', 'Head', 'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1', 'L_Wing_Lower', 'R_Wing_Lower'];
const agents: any[] = [];
const bench = (name = 'flyer', world = 'flight-exit-bench') => {
  const ag: any = new WorldAgent({ name, world });
  ag.bodyBoneNames = WINGED; ag.loadBodyBones = async () => WINGED;
  ag.myRights = { role: 'builder', fly: true };
  ag.joined = true;
  agents.push(ag);
  return ag;
};
/** One macrotask turn, so the agent's awaits run, then one tick. */
const turn = () => new Promise<void>((go) => setImmediate(go));
const tick = async (ag: any, n = 1) => { for (let i = 0; i < n; i++) { await turn(); ag.tick(); } };
/** Put the flight at height y in PILOT with take-off's launch spent, as the issues' probes did. */
const toAir = (ag: any, y: number) => {
  const f = ag.flight; f.pos.y = y; f.vel.y = 0; f.launchV = 0; f.launchT = 0; f.launchNow = 0; f.phase = 'PILOT';
  ag.pos.y = y;
};
const answerOf = (p: Promise<any>) => { const box: { r: any } = { r: null }; p.then((r) => { box.r = r; }); return box; };
const dist = (p: any, q: { x: number; z: number }) => Math.hypot(p.x - q.x, p.z - q.z);

console.log('\n#287 take_off on a body already flying');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 5);
  ag.flight.stamina = 10;
  const y0 = ag.flight.pos.y;
  const r = await ag.takeOff();
  check('take_off aloft is refused as already airborne', !r.ok && /already airborne/.test(r.text), r.text);
  check('...and leaves the flight where it was, its stamina unrefilled',
    ag.flight?.phase === 'PILOT' && Math.abs(ag.flight.pos.y - y0) < 1e-9 && ag.flight.stamina === 10,
    `${ag.flight?.phase} y ${ag.flight?.pos.y} (was ${y0}), stamina ${ag.flight?.stamina}`);
}

console.log('\n#290 a later glide replaces an earlier one');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 40);
  const o = { x: ag.flight.pos.x, z: ag.flight.pos.z };
  const T1 = { x: o.x + 60, z: o.z }, T2 = { x: o.x, z: o.z + 60 };
  const first = answerOf(ag.glideTo(T1.x, T1.z));
  await tick(ag, 10);
  const second = answerOf(ag.glideTo(T2.x, T2.z));
  await tick(ag, 2);
  check('the earlier glide is answered at once, as taken over', first.r != null && !first.r.ok && /taken over/.test(first.r.text), first.r?.text ?? 'no answer yet');
  for (let i = 0; i < 3000 && second.r == null; i++) await tick(ag);
  await tick(ag, 100);
  check('the later glide arrives, and the body holds over its point, not the earlier one\'s',
    second.r?.ok && dist(ag.flight?.pos ?? ag.pos, T2) < 15 && dist(ag.flight?.pos ?? ag.pos, T1) > 40,
    `${second.r?.text}; ${dist(ag.flight?.pos ?? ag.pos, T2).toFixed(1)} m from T2, ${dist(ag.flight?.pos ?? ag.pos, T1).toFixed(1)} m from T1`);
}

console.log('\n#293 the flare is flown through the integrator\'s input');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20);
  const land = answerOf(ag.landAt(ag.flight.pos.x + 3, ag.flight.pos.z));
  let ticks = 0;
  for (; ticks < 2000 && land.r == null; ticks++) await tick(ag);
  check('a landing from 20 m comes down in under 15 s of flight', land.r?.ok && ticks * 0.1 < 15, `${(ticks * 0.1).toFixed(1)} s; ${land.r?.text}`);
}

console.log('\n#298 every way down ends the flight');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 6);
  const climb = answerOf(ag.climbTo(-5));
  for (let i = 0; i < 600 && climb.r == null; i++) await tick(ag);
  check('a climb that meets the ground answers, and ends the flight', climb.r != null && ag.flight == null, `${climb.r?.text}; flight ${ag.flight?.phase ?? 'none'}`);
  const from = { x: ag.pos.x, z: ag.pos.z };
  const walk = answerOf(ag.walkTo(from.x + 5, from.z));
  for (let i = 0; i < 60 && walk.r == null; i++) await tick(ag);
  check('...so the body walks again', dist(ag.pos, from) > 4.5, `moved ${dist(ag.pos, from).toFixed(2)} m; walk ${walk.r}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20);
  const walk = answerOf(ag.walkTo(ag.pos.x + 5, ag.pos.z));
  await tick(ag, 2);
  check('a walk asked while flying replaces the flight', ag.flight == null, `flight ${ag.flight?.phase ?? 'none'}; walk ${walk.r}`);
}
{
  // R 11-10: a walk asked in the air ends the flight and the body FALLS, then walks on from where it lands.
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  const y0 = ag.pos.y, from = { x: ag.pos.x, z: ag.pos.z }, T = { x: from.x + 5, z: from.z };
  const walk = answerOf(ag.walkTo(T.x, T.z));
  await tick(ag);
  check('a walk asked at 20 m is no instant drop: a tick later the body is still high', ag.pos.y > y0 - 2, `y ${ag.pos.y.toFixed(2)} (was ${y0.toFixed(2)})`);
  check('...with no flight left, nor a flying body mode', ag.flight == null && ag.bodyModeNow() !== 'fly', `flight ${ag.flight?.phase ?? 'none'}, mode ${ag.bodyModeNow()}`);
  const ys: number[] = [ag.pos.y]; let drift = 0;
  for (let i = 0; i < 100 && ag.pos.y > ag.heightAt(ag.pos.x, ag.pos.z) + 1e-6; i++) {
    await tick(ag); ys.push(ag.pos.y); drift = Math.max(drift, dist(ag.pos, from));
  }
  const falling = ys.length > 5 && ys.every((y, i) => i === 0 || y < ys[i - 1]);
  check('...it falls: lower every tick, over more than half a second, down to the ground', falling && Math.abs(ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z)) < 1e-6,
    `${ys.length - 1} ticks: ${ys.map((y) => y.toFixed(1)).join(' ')}`);
  check('...and does not walk in the air: it comes down where it was', ys.length > 5 && drift < 1e-6, `${ys.length - 1} airborne ticks, ${drift.toFixed(3)} m off`);
  for (let i = 0; i < 100 && walk.r == null; i++) await tick(ag);
  check('...then the walk goes on from where it landed, and arrives', walk.r === true && dist(ag.pos, T) < 0.05 && Math.abs(ag.pos.y - ag.heightAt(T.x, T.z)) < 1e-6,
    `walk ${walk.r}; ${dist(ag.pos, T).toFixed(2)} m from the target, y ${ag.pos.y.toFixed(2)}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  const walk = answerOf(ag.walkTo(ag.pos.x + 5, ag.pos.z));
  await tick(ag, 3);
  ag.stop();
  await tick(ag, 2);
  check('a stop during the fall answers that walk at once', walk.r === false, `walk ${walk.r}`);
  for (let i = 0; i < 100; i++) await tick(ag);
  check('...and the body still comes down to the ground', Math.abs(ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z)) < 1e-6 && ag.target == null, `y ${ag.pos.y.toFixed(2)}, target ${JSON.stringify(ag.target)}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  const walk = answerOf(ag.walkTo(ag.pos.x + 5, ag.pos.z));
  await tick(ag, 3);
  ag.knockDown('shover', null, '(knocked over)');
  await tick(ag, 2);
  check('a knockdown during the fall answers the walk waiting on it at once', walk.r === false, `walk ${walk.r}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 45); ag.flight.stamina = 1e6;
  const climb = answerOf(ag.climbTo(55));
  await tick(ag, 10);
  ag.knockDown('shover', null, '(knocked over)');
  await tick(ag, 2);
  check('a knockdown in the air answers a climb under way at once, saying so', climb.r != null && !climb.r.ok && /knocked down/.test(climb.r.text), climb.r?.text ?? 'no answer yet');
  check('...and ends the flight, leaving the body to its fall', ag.flight == null, `flight ${ag.flight?.phase ?? 'none'}`);
}

console.log('\n#300 close, or a dropped link, answers a wait under way at once');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 45); ag.flight.stamina = 1e6;
  const climb = answerOf(ag.climbTo(55));
  await tick(ag, 10);
  ag.close();
  await tryUntil('the climb answers', () => climb.r, { ms: 2000, step: 20 });
  check('close() answers a climb under way at once, as interrupted', climb.r != null && !climb.r.ok && /interrupted/.test(climb.r.text), climb.r?.text ?? 'no answer 2 s after close');
  check('...and ends the flight', ag.flight == null, `flight ${ag.flight?.phase ?? 'none'}`);
}
{
  // A socket that opens and drops on cue: the agent's own onclose is the link loss.
  const RealWS = globalThis.WebSocket;
  class DropWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = DropWS;
  const ag = bench('dropper');
  ag.connect().catch(() => {});
  ag.joined = true;
  await ag.takeOff(); toAir(ag, 45); ag.flight.stamina = 1e6;
  const climb = answerOf(ag.climbTo(55));
  await tick(ag, 10);
  ag.ws.onclose({ code: 1006, reason: '' });
  await tryUntil('the climb answers', () => climb.r, { ms: 2000, step: 20 });
  (globalThis as any).WebSocket = RealWS;
  check('a dropped link answers a climb under way at once, as interrupted', climb.r != null && !climb.r.ok && /interrupted/.test(climb.r.text), climb.r?.text ?? 'no answer 2 s after the drop');
  check('...and ends the flight', ag.flight == null, `flight ${ag.flight?.phase ?? 'none'}`);
}

console.log('\nreview 2026-11-10: the fall is the feet\'s, whatever ended the flight');
/** Tick until the feet are on the ground under them (or n ticks); the heights on the way. */
const fallOut = async (ag: any, n = 200) => {
  const ys: number[] = [ag.pos.y];
  for (let i = 0; i < n && ag.pos.y > ag.heightAt(ag.pos.x, ag.pos.z) + 1e-6; i++) { await tick(ag); ys.push(ag.pos.y); }
  return ys;
};
const onGround = (ag: any) => Math.abs(ag.pos.y - ag.heightAt(ag.pos.x, ag.pos.z)) < 1e-6;
const walkAloft = async (ag: any, y = 20, timeoutMs?: number) => {
  await ag.takeOff(); toAir(ag, y); await tick(ag, 3);
  const receipt = { refusal: null as string | null };
  const walk = answerOf(ag.walkTo(ag.pos.x + 5, ag.pos.z, false, timeoutMs, undefined, undefined, {}, receipt));
  await tick(ag);
  return { walk, receipt };
};
{
  const ag = bench();
  await walkAloft(ag);
  const y0 = ag.pos.y, r = await ag.takeOff();
  check('take_off during the fall is refused as already airborne', !r.ok && /already airborne/.test(r.text) && ag.flight == null, `${r.text}; flight ${ag.flight?.phase ?? 'none'}`);
  await tick(ag);
  check('...and the body falls on from where it was, not from the ground', ag.flight == null && ag.pos.y < y0 && ag.pos.y > y0 - 3, `y ${ag.pos.y.toFixed(2)} (was ${y0.toFixed(2)}), flight ${ag.flight?.phase ?? 'none'}`);
  const m = await handleTool({ agent: ag } as any, 'move', { mode: 'fly', to: [ag.pos.x + 30, ag.pos.z] });
  check('move {mode: "fly"} during the fall is refused too', m.isError === true && /already airborne/.test(m.content?.[0]?.text ?? '') && ag.flight == null, `${m.content?.[0]?.text}; flight ${ag.flight?.phase ?? 'none'}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  ag.flightBodyDown('cut'); await tick(ag, 2);
  const y0 = ag.pos.y, from = { x: ag.pos.x, z: ag.pos.z }, T = { x: from.x + 5, z: from.z };
  const phase = ag.flight?.phase;
  const walk = answerOf(ag.walkTo(T.x, T.z));
  await tick(ag);
  check('a walk asked of a body falling limp (LEAF) is no instant drop: a tick later it is still high', phase === 'LEAF' && ag.pos.y > y0 - 2 && ag.flight == null, `${phase}; y ${ag.pos.y.toFixed(2)} (was ${y0.toFixed(2)}), flight ${ag.flight?.phase ?? 'none'}`);
  const ys = await fallOut(ag);
  check('...it falls to the ground where it was', ys.length > 5 && onGround(ag) && dist(ag.pos, from) < 1e-6, `${ys.length - 1} ticks, ${dist(ag.pos, from).toFixed(3)} m off`);
  for (let i = 0; i < 100 && walk.r == null; i++) await tick(ag);
  check('...then walks on from there', walk.r === true && dist(ag.pos, T) < 0.5, `walk ${walk.r}; ${dist(ag.pos, T).toFixed(2)} m from the target`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 45); await tick(ag, 3);
  ag.knockDown('shover', null, '(knocked over)');
  await tick(ag, 2);
  const sim = !!ag.simTicker;
  const ys = await fallOut(ag, 300);
  check('a knockdown in the air with no sim to run comes down to the ground, falling', !sim && onGround(ag) && ys.length > 10 && ag.clip === 'ragdoll', `sim ${sim}; y ${ag.pos.y.toFixed(2)} after ${ys.length - 1} ticks, clip ${ag.clip}`);
  const r = await ag.takeOff();
  check('...and once down it can take off again', r.ok, r.text);
}
{
  const ag = bench();
  const { walk } = await walkAloft(ag);
  const second = answerOf(ag.walkTo(ag.pos.x - 5, ag.pos.z));
  await tick(ag, 2);
  check('a newer walk during the fall answers the one waiting at once', walk.r === false && second.r == null && !onGround(ag), `first ${walk.r}, second ${second.r}, y ${ag.pos.y.toFixed(2)}`);
}
{
  const ag = bench();
  const { walk, receipt } = await walkAloft(ag, 40, 50);
  await new Promise((go) => setTimeout(go, 150));
  await turn();
  check('a walk whose time runs out during the fall answers false, as timed out falling, not as superseded',
    walk.r === false && receipt.refusal == null && /timed out falling/.test(ag.walkStopReason ?? ''), `walk ${walk.r}; receipt ${receipt.refusal}; stop ${ag.walkStopReason}`);
  await fallOut(ag);
  check('...and the body still comes down', onGround(ag), `y ${ag.pos.y.toFixed(2)}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  ag.flightBodyDown('cut');
  await fallOut(ag, 300); await tick(ag, 5);
  const phase = ag.flight?.phase, from = { x: ag.pos.x, z: ag.pos.z }, T = { x: from.x + 5, z: from.z };
  const walk = answerOf(ag.walkTo(T.x, T.z));
  for (let i = 0; i < 100 && walk.r == null; i++) await tick(ag);
  check('a walk asked of a cut body lying on the ground ends its flight, and walks', phase != null && ag.flight == null && walk.r === true && dist(ag.pos, T) < 0.5,
    `phase ${phase} -> ${ag.flight?.phase ?? 'none'}; walk ${walk.r}; ${dist(ag.pos, T).toFixed(2)} m from the target`);
}
console.log('\nreview 2026-11-10: every other way out ends the flight');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 45); ag.flight.stamina = 1e6;
  const climb = answerOf(ag.climbTo(55));
  await tick(ag, 10);
  ag.setOccupant({ to: 'chair/seat' });
  await turn();
  check('taking a seat answers a climb under way at once, and ends the flight', climb.r != null && /taking a seat/.test(climb.r.text) && ag.flight == null, `${climb.r?.text ?? 'no answer'}; flight ${ag.flight?.phase ?? 'none'}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 45); ag.flight.stamina = 1e6;
  ag.replica = { st: { entities: {} } }; ag.request = async () => ({ ok: true });
  const climb = answerOf(ag.climbTo(55));
  await tick(ag, 10);
  await ag.respawnFell();
  await turn();
  check('a respawn answers a climb under way at once, and ends the flight', climb.r != null && /fell out of the world/.test(climb.r.text) && ag.flight == null, `${climb.r?.text ?? 'no answer'}; flight ${ag.flight?.phase ?? 'none'}`);
}
{
  const RealWS = globalThis.WebSocket;
  class DragWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = DragWS;
  const ag = bench('dragged');
  ag.connect().catch(() => {});
  ag.joined = true;
  await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
  ag.flightBodyDown('cut'); await tick(ag, 2);
  const waits = ag.flightWaiters.length, phase = ag.flight?.phase;
  await ag.ws.onmessage({ data: JSON.stringify({ type: 'bodydrag', grab: 'Hip', by: 'dragger' }) });
  (globalThis as any).WebSocket = RealWS;
  check('a hand taking a limp flier ends its flight, and the dragger has it', phase === 'LEAF' && ag.flight == null && ag.draggedBy === 'dragger', `${phase} -> ${ag.flight?.phase ?? 'none'}; dragged by ${ag.draggedBy}; ${waits} waits`);
}
{
  const RealWS = globalThis.WebSocket;
  class DropWS { readyState = 1; onopen: any; onclose: any; onmessage: any; onerror: any; send() {} close() {} }
  (globalThis as any).WebSocket = DropWS;
  const ag = bench('rejoiner');
  ag.connect().catch(() => {});
  ag.joined = true;
  await ag.takeOff(); toAir(ag, 30); await tick(ag, 3);
  const from = { x: ag.pos.x, z: ag.pos.z };
  ag.ws.onclose({ code: 1006, reason: '' });
  (globalThis as any).WebSocket = RealWS;
  ag.joined = true;   // back: the flight is over (#300), and the body comes down under where it was
  await tick(ag, 2);
  const ys = await fallOut(ag, 300);
  check('after a dropped link the flight is over, and on rejoin the body comes down to stand under where it was',
    ag.flight == null && onGround(ag) && dist(ag.pos, from) < 1e-6 && ag.bodyModeNow() !== 'fly', `flight ${ag.flight?.phase ?? 'none'}; y ${ag.pos.y.toFixed(2)} after ${ys.length - 1} ticks, ${dist(ag.pos, from).toFixed(3)} m off`);
}
console.log('\nreview 2026-11-10: the course');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 40);
  const o = { x: ag.flight.pos.x, z: ag.flight.pos.z };
  const first = answerOf(ag.glideTo(o.x + 60, o.z));
  await tick(ag, 3);
  const second = answerOf(ag.glideTo(o.x, o.z + 60));
  for (let i = 0; i < 5; i++) await turn();
  check('a later glide answers the earlier one as taken over in the same step, not on the next tick', first.r != null && /taken over/.test(first.r.text), first.r?.text ?? 'no answer before a tick');
  void second;
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 40);
  const T = { x: ag.flight.pos.x + 30, z: ag.flight.pos.z };
  const glide = answerOf(ag.glideTo(T.x, T.z));
  for (let i = 0; i < 2000 && glide.r == null; i++) await tick(ag);
  check('a glide that arrives holds over its point: its course becomes a hold', glide.r?.ok && ag.flight?.course?.kind === 'hold' && ag.flight.course.x === T.x, `${glide.r?.text}; course ${JSON.stringify(ag.flight?.course)}`);
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 40);
  const real = ag.flightAwait;
  ag.flightAwait = async () => 'timed out aloft';
  const r = await ag.glideTo(ag.flight.pos.x + 60, ag.flight.pos.z);
  ag.flightAwait = real;
  check('a glide whose wait times out stops steering, as a climb does', !r.ok && /timed out/.test(r.text) && ag.flight?.course == null, `${r.text}; course ${JSON.stringify(ag.flight?.course)}`);
}
console.log('\nreview 2026-11-10: a landing ended another way says how');
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 40);
  const land = answerOf(ag.landAt(ag.flight.pos.x + 80, ag.flight.pos.z));
  await tick(ag, 10);
  ag.close();
  await tryUntil('the landing answers', () => land.r, { ms: 2000, step: 20 });
  check('a landing whose glide is ended by close() is refused, saying so', land.r != null && !land.r.ok && /interrupted: the body was closed/.test(land.r.text), land.r?.text ?? 'no answer');
}
{
  const ag = bench();
  await ag.takeOff(); toAir(ag, 6);
  const land = answerOf(ag.landAt(ag.flight.pos.x + 2, ag.flight.pos.z));
  for (let i = 0; i < 400 && ag.flight?.course?.kind !== 'land'; i++) await tick(ag);
  const flaring = ag.flight?.course?.kind === 'land';
  ag.knockDown('shover', null, '(knocked over)');
  await tryUntil('the landing answers', () => land.r, { ms: 2000, step: 20 });
  check('a landing knocked down during its flare is refused as knocked down during the flare', flaring && land.r != null && !land.r.ok && /knocked down during the flare/.test(land.r.text), `flaring ${flaring}; ${land.r?.text ?? 'no answer'}`);
}
{
  // #293's flare: the land course noses up its last FLARE_HEIGHT, through the integrator's input (coursePilot).
  const ag = bench();
  await ag.takeOff(); toAir(ag, 20);
  const land = answerOf(ag.landAt(ag.flight.pos.x + 3, ag.flight.pos.z));
  let low = 0, pitched = 0, enter = NaN, last = NaN;
  for (let t = 0; t < 2000 && land.r == null; t++) {
    await tick(ag);
    const f = ag.flight;
    if (f?.course?.kind === 'land' && f.pos.y - ag.heightAt(f.pos.x, f.pos.z) < 2) {
      low++; if (f.pitch > 0.1) pitched++;
      if (Number.isNaN(enter)) enter = f.airspeed; last = f.airspeed;
    }
  }
  // (It doesn't lessen the sink: the spoilers stay on through the flare, ~3 m/s to touchdown; for R.)
  check('a flare noses up its last 2 m through the integrator: the pitch is flown, and the airspeed bleeds',
    land.r?.ok && low > 2 && pitched >= low - 1 && enter - last > 0.2, `${land.r?.text}; ${low} ticks low, ${pitched} pitched, airspeed ${enter?.toFixed(2)} -> ${last?.toFixed(2)}`);
}

console.log('\nreview 2026-11-10: with the colliders loaded (last: once loaded they stay loaded for this process)');
{
  // A solid platform 3 m high under the flier: the fall ends on it, not on the terrain under it.
  const { boxMesh } = await import('./two-storey-fixture.ts');
  const { registerMeshSupport, removeSupport, collidersReady } = await import('../mcpl/physics.ts');
  const W = 'flight-exit-colliders', TOP = 3;
  const { pos, idx } = boxMesh([[-8, 0, -8, 8, TOP, 8]]);
  const fitted = await registerMeshSupport('flight-exit-test', `${W}/deck`, { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, { position: [0, 0, 0], yaw: 0, scale: 1 });
  check('setup: the platform is a collider, and the colliders are loaded', fitted && collidersReady(), `fitted ${fitted}, ready ${collidersReady()}`);
  {
    const ag = bench('deck-leaf', W);
    ag.pos.y = TOP;
    await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
    ag.flightBodyDown('cut'); await tick(ag, 2);
    const y0 = ag.pos.y, from = { x: ag.pos.x, z: ag.pos.z };
    const walk = answerOf(ag.walkTo(from.x + 3, from.z));
    await tick(ag);
    check('colliders on: a walk asked falling limp over a platform is no instant drop', ag.flight == null && ag.pos.y > y0 - 2, `y ${ag.pos.y.toFixed(2)} (was ${y0.toFixed(2)}), flight ${ag.flight?.phase ?? 'none'}`);
    const ys: number[] = [ag.pos.y];
    for (let i = 0; i < 200 && walk.r == null && ag.pos.y > TOP + 1e-3; i++) { await tick(ag); ys.push(ag.pos.y); }
    check('...it falls onto the platform, not through it to the terrain', ys.length > 5 && Math.abs(ag.pos.y - TOP) < 0.05 && dist(ag.pos, from) < 0.05,
      `${ys.length - 1} ticks: y ${ag.pos.y.toFixed(2)}, ${dist(ag.pos, from).toFixed(3)} m off`);
    for (let i = 0; i < 100 && walk.r == null; i++) await tick(ag);
    check('...then walks on along its top', walk.r === true && Math.abs(ag.pos.y - TOP) < 0.05, `walk ${walk.r}; y ${ag.pos.y.toFixed(2)}; ${ag.walkRefusal ?? ''}`);
  }
  {
    const ag = bench('deck-knock', W);
    ag.pos.y = TOP;
    await ag.takeOff(); toAir(ag, 20); await tick(ag, 3);
    ag.knockDown('shover', null, '(knocked over)');
    for (let i = 0; i < 200 && (ag.pos.y > TOP + 1e-3 || ag.simTicker); i++) await tick(ag);
    check('colliders on: a knockdown in the air with no sim comes to rest on the platform', !ag.simTicker && Math.abs(ag.pos.y - TOP) < 0.05, `y ${ag.pos.y.toFixed(2)}, sim ${!!ag.simTicker}`);
  }
  await removeSupport('flight-exit-test', `${W}/deck`);
}

for (const a of agents) { try { a.close(); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
