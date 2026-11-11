// flight-exit-test — an agent's flight has one way out and one current course (research LOCOMOTION-SHAPE 2026-11-10).
//
//   bun tools/flight-exit-test.ts
//
// One row per issue: #287 take_off aloft, #290 an older glide steering, #293 the flare's pitch, #298 a landed or
// knocked-down flight still owning the body, #300 close or a dropped link leaving a wait to its timer. A bare agent,
// no world server: its tick is called by hand, 0.1 s a tick.
import { tryUntil } from './protocol/wait.ts';
const { WorldAgent } = await import('../mcpl/agent.ts');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}
const WINGED = ['Hip', 'Spine02', 'Head', 'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1', 'L_Wing_Lower', 'R_Wing_Lower'];
const agents: any[] = [];
const bench = (name = 'flyer') => {
  const ag: any = new WorldAgent({ name, world: 'flight-exit-bench' });
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

for (const a of agents) { try { a.close(); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
