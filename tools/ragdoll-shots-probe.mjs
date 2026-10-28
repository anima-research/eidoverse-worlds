// ragdoll-shots-probe (#282) — fallen bodies are drawn ON the ground, on every screen, whatever they fell from.
//
// A real client (the watcher) watches a headless AGENT (claude.vrm, tools/ragdoll-shots-agent.ts) fall over from
// stand / sit / lie, then a second browser person (the actor) do the same; for the actor's lie, a third browser
// joins late. Each row reads the DRAWN root and hips (the renderer's numbers, not body_state's). The run fails if
// any fallen body's hips are drawn under the ground or floating over it, if a row it set out to measure was never
// drawn, if a body wasn't limp when it was read, or if a sit or lie wasn't drawn before its shove. `--shots <dir>`
// also saves side/above screenshots. LATE=1 instead has the agents fall before the watcher's page exists.
//
// Run under NODE: Playwright's pipe transport hangs under Bun on Windows. The agent half and the world server
// run under Bun (BUN_EXE / BUN_PATH, default `bun` on PATH).
//
//   EIDOVERSE_DIR=<library> node tools/ragdoll-shots-probe.mjs [--shots <dir>]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORLD = 'falls';
const LATE = !!process.env.LATE;
const BUN = process.env.BUN_EXE || process.env.BUN_PATH || 'bun';
process.env.BUN_PATH ||= BUN;   // probe-harness spawns the world server with it

// A fallen body lies with its hips a few cm over the ground (0.08–0.11 on claude.vrm, flat). Under it is #282
// (−0.65 before the fix); far over it is the mirror case, a body measured from the wrong hips the other way
// (+0.82). A fall from standing can still be settling when it is read (seen at +0.45–0.55), so the bound over
// sits between the two.
const UNDER = -0.02, OVER = 0.7;
const LOWERED = { sit: 0.6, lie: 0.3 };

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const wsUrl = `${world.origin.replace(/^http/, 'ws')}/ws`;

// ---- the agent half: a Bun child driven over stdin, every command answered within a deadline
const agentProc = spawn(BUN, ['tools/ragdoll-shots-agent.ts'], {
  env: { ...process.env, WORLD_URL: wsUrl, WORLD_NAME: WORLD, WORLD_TOKEN: world.key }, stdio: ['pipe', 'pipe', 'inherit'],
});
let browserClose = null;
const teardown = async () => {
  try { agentProc.stdin.write('bye\n'); } catch {}
  try { agentProc.kill(); } catch {}
  try { await browserClose?.(); } catch {}
  try { await world.close(); } catch {}
};
const fail = async (why) => { console.error(`\nprobe aborted: ${why}`); await teardown(); process.exit(2); };
process.once('uncaughtException', (e) => fail(e?.stack ?? String(e)));
process.once('unhandledRejection', (e) => fail(e?.stack ?? String(e)));
agentProc.once('exit', (code) => { if (waiting.length) fail(`the agent half exited (${code}) with a command pending`); });

const waiting = [];
createInterface({ input: agentProc.stdout }).on('line', (l) => {
  if (l.startsWith('ok ')) { const [, , ...j] = l.split(' '); waiting.shift()?.resolve(JSON.parse(j.join(' '))); }
  else if (!/VRMLookAt/.test(l)) console.log('  [agent]', l);
});
const agentCmd = (line, ms = 60000) => new Promise((resolve, reject) => {
  const entry = { resolve: (v) => { clearTimeout(t); resolve(v); } };
  const t = setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(new Error(`agent: no answer to "${line}" in ${ms} ms`)); }, ms);
  waiting.push(entry);
  agentProc.stdin.write(line + '\n');
});
const agentSpawn = async (name, x, z, posture) => {
  const s = await agentCmd(`spawn ${name} ${x} ${z} ${posture}`);
  if (s?.error) throw new Error(`agent: spawning ${name} failed: ${s.error}`);
  if (s.walk) console.log(`  [agent] ${name}: ${s.walk}`);
  return s;
};
const agentState = async (name) => {
  const s = await agentCmd(`state ${name}`);
  if (!s) throw new Error(`agent: no agent named ${name}`);
  return s;
};

// ---- a bare socket that shoves people
const shover = await new Promise((res) => {
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'shover', token: world.key }));
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'snapshot') res(ws); };
});
const shove = (target) => shover.send(JSON.stringify({ type: 'puppet', target, ragdoll: true }));

// LATE=1: the agents fall BEFORE the watcher's page exists — what does a late joiner draw?
if (LATE) {
  for (const [i, kind] of ['idle', 'sit', 'lie'].entries()) await agentSpawn(`late-${kind}`, 4 + i * 3, 3, kind);
  await sleep(2000);
  for (const kind of ['idle', 'sit', 'lie']) shove(`late-${kind}`);
  await sleep(8000);
}

// ---- browsers
const { page, close } = await launchBrowser();
browserClose = close;
const bootPage = async (name, x, z) => {
  const p = await page();
  await p.setViewportSize({ width: 1280, height: 720 });
  await p.context().addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  p.on('pageerror', (e) => console.log(`  [pageerror ${name}]`, e.message));
  await p.goto(`${world.origin}/?world=${WORLD}&name=${name}&key=${world.key}&avatar=claude`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.()?.vrm, null, { timeout: 180000 });
  await sleep(2000);
  if (x != null) await p.evaluate(({ x, z }) => { const s = globalThis.EW.myState; s.pos.x = x; s.pos.z = z; }, { x, z });
  return p;
};
/** The drawn root and hips of a body on one page's screen: its own (`self`) or a remote's. */
const readOn = (pg, who, self) => pg.evaluate(({ who, self }) => {
  const EW = globalThis.EW;
  const av = self ? EW.me() : EW.remotes.get(who)?.avatar;
  if (!av?.vrm) return null;
  const hipsNode = av.vrm.humanoid?.getNormalizedBoneNode?.('hips');
  const hips = hipsNode ? hipsNode.getWorldPosition(new EW.THREE.Vector3()).toArray() : null;
  const r = av.root.position;
  const f = (a) => a?.map((x) => +x.toFixed(3));
  const clip = self ? EW.myState?.clip : EW.remotes.get(who)?.lastClip;
  return { drawnRoot: f(r.toArray()), drawnHips: f(hips), ground: +EW.groundAt(r.x, r.z).toFixed(3), clip };
}, { who, self });
/** Wait until a remote's body is drawn on a page (VRMs load after the splash). */
const drawn = (pg, ids, ms = 120000) => pg.waitForFunction((ids) => ids.every((id) => !!globalThis.EW.remotes.get(id)?.avatar?.vrm), ids, { timeout: ms }).then(() => true, () => false);
/** The reading a shove starts from. A sit or lie must be DRAWN lowered on this screen before the shove, or the row
 *  never tests the case #282 is about (the clip's hips under a limp remote): the posture clip loads and arrives on
 *  its own time, so this waits for it, up to `ms`, and hands back whatever it last read (the verdict judges it). */
const before = async (pg, who, self, kind, ms = 60000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await readOn(pg, who, self);
    const was = r?.drawnHips && r?.drawnRoot ? r.drawnHips[1] - r.drawnRoot[1] : null;
    if (!(kind in LOWERED) || (was != null && was < LOWERED[kind]) || Date.now() > deadline) return r;
    await sleep(500);
  }
};

// the watcher, standing at the origin, with its camera pinned: every render of the main camera is aimed where
// globalThis.__shot says (the follow camera would otherwise frame its own body)
const pg = await bootPage('watcher');
await pg.evaluate(() => {
  const { renderer, camera } = globalThis.EW;
  const orig = renderer.render.bind(renderer);
  renderer.render = (sc, cam) => {
    const s = globalThis.__shot;
    if (s && cam === camera) { cam.position.fromArray(s.p); cam.lookAt(s.t[0], s.t[1], s.t[2]); cam.updateMatrixWorld(true); }
    return orig(sc, cam);
  };
  document.body.classList.add('photo');
});
const shoot = async (name, at) => {
  if (!shotDir) return;
  const t = [at[0], 0.25, at[2]];
  for (const [view, p] of [['side', [t[0] + 2.4, 0.3, t[2] + 0.6]], ['above', [t[0] + 1.5, 2.0, t[2] + 1.5]]]) {
    await pg.evaluate((s) => { globalThis.__shot = s; }, { p, t });
    await sleep(500);
    const f = `${shotDir}/${name}-${view}.png`;
    await pg.screenshot({ path: f });
    console.log(`  · ${f}`);
  }
  await pg.evaluate(() => { globalThis.__shot = null; });
};

// ---- rows, printed as they land so a crash later still leaves the numbers
const rows = [];
const report = (r) => {
  rows.push(r);
  const b = r.before?.drawnHips && r.before?.drawnRoot ? (r.before.drawnHips[1] - r.before.drawnRoot[1]).toFixed(3) : '?';
  console.log(`ROW ${r.who.padEnd(28)} from=${String(r.from).padEnd(5)} beforeHips-root=${b}  after: root=${r.after?.drawnRoot?.[1]} hips=${r.after?.drawnHips?.[1]} ground=${r.after?.ground}${r.published != null ? ` published=${r.published}` : ''}${r.note ? `  (${r.note})` : ''}`);
};

if (LATE) {
  await drawn(pg, ['late-idle', 'late-sit', 'late-lie']);
  for (const kind of ['idle', 'sit', 'lie']) {
    const st = await agentState(`late-${kind}`);
    report({ who: 'agent, watcher joined LATE', from: kind, published: +st.p[1].toFixed(3), late: true, before: null, after: await readOn(pg, `late-${kind}`, false) });
    await shoot(`late-${kind}`, st.p);
  }
}

let n = 0;
for (const kind of LATE ? [] : ['idle', 'sit', 'lie']) {
  const name = `bot-${kind}`;
  n++;
  const s0 = await agentSpawn(name, 2 + n * 3, -3, kind);
  await drawn(pg, [name], 60000);
  await sleep(2000);
  const b0 = await before(pg, name, false, kind);
  await shoot(`${n}-agent-from-${kind}-before`, s0.p);
  shove(name);
  await sleep(7000);
  const s1 = await agentState(name);
  report({ who: name, from: kind, published: +s1.p[1].toFixed(3), before: b0, after: await readOn(pg, name, false), note: s0.walk });
  await shoot(`${n}-agent-from-${kind}-fallen`, s1.p);
}

// the human control: a second person, `actor`, falls from each posture, read on their own screen and on the
// watcher's (as a REMOTE). controller.setPosture is the same module instance the client runs — a dynamic import
// of its URL returns it.
for (const kind of process.env.ONLY_AGENT || LATE ? [] : ['stand', 'sit', 'lie']) {
  n++;
  const name = `actor-${kind}`;
  const ap = await bootPage(name, -4 - n * 3, -3);
  await ap.evaluate(() => globalThis.EW.setPushable(true));
  if (kind !== 'stand') await ap.evaluate(async (k) => { const c = await import('/lib/controller.js'); c.setPosture(k); }, kind);
  await drawn(pg, [name], 60000);
  await sleep(2000);
  const ownBefore = await before(ap, name, true, kind), remoteBefore = await before(pg, name, false, kind);
  shove(name);
  await sleep(7000);
  const own = await readOn(ap, name, true);
  report({ who: 'actor, OWN view', from: kind, before: ownBefore, after: own });
  report({ who: 'actor, seen by WATCHER', from: kind, before: remoteBefore, after: await readOn(pg, name, false) });
  await shoot(`${n}-human-from-${kind}-fallen-seen-by-watcher`, own?.drawnRoot ?? [0, 0, 0]);
  if (kind !== 'lie') { await ap.context().close(); continue; }   // the lying actor stays, to be seen late
  // A body's load waits on real rendered frames (avatar.js warm), and headless Chromium renders on the CPU: with
  // three pages up, whichever body loads last starved past any deadline (one run lost the actor, the next the
  // agent). The watcher's work is done, so it leaves, and the latecomer gets the front.
  await pg.context().close();
  const lp = await bootPage('latecomer');
  await lp.bringToFront();
  const both = await drawn(lp, [name, 'bot-lie'], 240000);
  // when a body never arrives, say what the latecomer holds instead: no record, a capsule, or a load still owed
  const why = both ? null : await lp.evaluate((id) => {
    const r = globalThis.EW.remotes.get(id);
    if (!r) return `no record for ${id}`;
    return `record for ${id}: avatarPath=${r.avatarPath ?? '?'} avatar=${r.avatar ? (r.avatar.vrm ? 'vrm' : 'no vrm') : 'none'} capsuleFor=${r.capsuleFor ?? '-'} loading=${!!r.loading} frames=${r.buf?.length ?? 0}`;
  }, name);
  report({ who: 'actor, seen by LATE joiner', from: kind, late: true, before: null, after: await readOn(lp, name, false), note: why });
  report({ who: 'agent bot-lie, LATE joiner', from: 'lie', late: true, before: null, after: await readOn(lp, 'bot-lie', false) });
  await lp.context().close();
}

// ---- the verdict. A row that was never drawn is a failure to measure, not a pass.
const failed = new Set();
for (const r of rows) {
  const h = r.after?.drawnHips?.[1], g = r.after?.ground;
  const d = h != null && g != null ? h - g : null;
  if (d == null) { failed.add(r); console.log(`  ✗  ${r.who} from ${r.from}: never drawn, so not measured`); }
  else if (d < UNDER) { failed.add(r); console.log(`  ✗  ${r.who} from ${r.from}: hips drawn ${(-d).toFixed(3)} m under the ground`); }
  else if (d > OVER) { failed.add(r); console.log(`  ✗  ${r.who} from ${r.from}: hips drawn ${d.toFixed(3)} m over the ground`); }
  if (d != null && r.after.clip !== 'ragdoll') { failed.add(r); console.log(`  ✗  ${r.who} from ${r.from}: not limp when read (clip ${r.after.clip})`); }
  const was = r.before?.drawnHips && r.before?.drawnRoot ? r.before.drawnHips[1] - r.before.drawnRoot[1] : null;
  if (r.from in LOWERED && !r.late && !(was != null && was < LOWERED[r.from])) {
    failed.add(r); console.log(`  ✗  ${r.who} from ${r.from}: the ${r.from} wasn't drawn before the shove (hips ${was == null ? 'unmeasured' : `${was.toFixed(3)} m`} over the root)`);
  }
}
const bad = failed.size;
console.log(bad ? `\n${bad} of ${rows.length} rows failed` : `\nall ${rows.length} fallen bodies are drawn on the ground`);
await teardown();
process.exit(bad ? 1 : 0);
