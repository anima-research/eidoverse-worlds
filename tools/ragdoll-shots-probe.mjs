// ragdoll-shots-probe (#282) — fallen bodies are drawn ON the ground, on every screen, whatever they fell from.
//
// A real client (the watcher) watches a headless AGENT (claude.vrm, tools/ragdoll-shots-agent.ts) fall over from
// stand / sit / lie, then a second browser person (the actor) do the same; for the actor's lie, a third browser
// joins late. Each row reads the DRAWN root and hips (the renderer's numbers, not body_state's), and the run
// fails if any fallen body's hips are drawn under the ground. `--shots <dir>` also saves side/above screenshots.
// LATE=1 instead has the agents fall before the watcher's page exists.
//
// Run under NODE: Playwright's pipe transport hangs under Bun on Windows. The agent half and the world server
// run under Bun (BUN_PATH for probe-harness, BUN_EXE here; both default to `bun` on PATH).
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
const BUN = process.env.BUN_EXE || process.env.BUN_PATH || 'bun';
process.env.BUN_PATH ||= BUN;   // probe-harness spawns the world server with it

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const wsUrl = `${world.origin.replace(/^http/, 'ws')}/ws`;

// the agent half
const agentProc = spawn(BUN, ['tools/ragdoll-shots-agent.ts'], {
  env: { ...process.env, WORLD_URL: wsUrl, WORLD_NAME: WORLD, WORLD_TOKEN: world.key }, stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = [];
createInterface({ input: agentProc.stdout }).on('line', (l) => {
  if (l.startsWith('ok ')) { const [, name, ...j] = l.split(' '); waiting.shift()?.(JSON.parse(j.join(' '))); }
  else if (!/VRMLookAt/.test(l)) console.log('  [agent]', l);
});
const agentCmd = (line) => new Promise((res) => { waiting.push(res); agentProc.stdin.write(line + '\n'); });

// a bare socket that shoves people
const shover = await new Promise((res) => {
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', world: WORLD, id: 'shover', token: world.key }));
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'snapshot') res(ws); };
});
const shove = (target) => shover.send(JSON.stringify({ type: 'puppet', target, ragdoll: true }));

// LATE=1: the agents fall BEFORE the watcher's page exists — what does a late joiner draw?
const LATE = !!process.env.LATE;
if (LATE) {
  for (const [i, kind] of ['idle', 'sit', 'lie'].entries()) await agentCmd(`spawn late-${kind} ${4 + i * 3} 3 ${kind}`);
  await sleep(2000);
  for (const kind of ['idle', 'sit', 'lie']) shove(`late-${kind}`);
  await sleep(8000);
}

// the watcher: a real client, standing at the origin
const { page, close } = await launchBrowser();
const pg = await page();
await pg.setViewportSize({ width: 1280, height: 720 });
await pg.context().addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
pg.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await pg.goto(`${world.origin}/?world=${WORLD}&name=watcher&key=${world.key}&avatar=claude`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.()?.vrm, null, { timeout: 180000 });
await sleep(2500);

// pin the camera: every render of the main camera is aimed where globalThis.__shot says
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

const read = (who) => pg.evaluate((who) => {
  const EW = globalThis.EW;
  const av = who === 'watcher' ? EW.me() : EW.remotes.get(who)?.avatar;
  if (!av?.vrm) return null;
  const hipsNode = av.vrm.humanoid?.getNormalizedBoneNode?.('hips');
  const hips = hipsNode ? hipsNode.getWorldPosition(new EW.THREE.Vector3()).toArray() : null;
  const box = new EW.THREE.Box3().setFromObject(av.vrm.scene);
  const r = av.root.position;
  const f = (a) => a?.map((x) => +x.toFixed(3));
  return { drawnRoot: f(r.toArray()), drawnHips: f(hips), meshLowestY: +box.min.y.toFixed(3), ground: +EW.groundAt(r.x, r.z).toFixed(3) };
}, who);

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

const rows = [];
// print each row as it lands, so a crash later in the run still leaves the numbers
const fmt = (r) => `ROW ${r.who.padEnd(28)} from=${String(r.from).padEnd(5)} beforeHips-root=${r.before?.drawnHips ? (r.before.drawnHips[1] - r.before.drawnRoot[1]).toFixed(3) : '?'}  after: root=${r.after?.drawnRoot?.[1]} hips=${r.after?.drawnHips?.[1]} ground=${r.after?.ground}${r.publishedRootAfter ? ` published=${r.publishedRootAfter[1]}` : ''}`;
rows.push = (...xs) => { for (const r of xs) console.log(fmt(r)); return Array.prototype.push.apply(rows, xs); };
let n = 0;
if (LATE) {
  await sleep(3000);
  for (const kind of ['idle', 'sit', 'lie']) {
    const st = await agentCmd(`state late-${kind}`);
    const a = await read(`late-${kind}`);
    rows.push({ who: 'agent, watcher joined LATE', from: kind, publishedRootAfter: st.p.map((x) => +x.toFixed(3)), before: null, after: a });
    await shoot(`late-${kind}`, st.p);
  }
}
for (const kind of LATE ? [] : ['idle', 'sit', 'lie']) {
  const name = `bot-${kind}`;
  n++;
  const s0 = await agentCmd(`spawn ${name} ${2 + n * 3} -3 ${kind}`);
  await sleep(2500);
  const before = await read(name);
  await shoot(`${n}-agent-from-${kind}-before`, s0.p);
  shove(name);
  await sleep(7000);
  const s1 = await agentCmd(`state ${name}`);
  const after = await read(name);
  rows.push({ who: name, from: kind, publishedRootBefore: s0.p.map((x) => +x.toFixed(3)), publishedRootAfter: s1.p.map((x) => +x.toFixed(3)), clip: s1.clip, before, after });
  await shoot(`${n}-agent-from-${kind}-fallen`, s1.p);
}

// the human control: a second person, `actor`, falls from each posture, read on their own screen and on the
// watcher's (as a REMOTE). controller.setPosture is the same module instance the client runs — a dynamic import
// of its URL returns it.
const readOn = (page, who, self) => page.evaluate(({ who, self }) => {
  const EW = globalThis.EW;
  const av = self ? EW.me() : EW.remotes.get(who)?.avatar;
  if (!av?.vrm) return null;
  const hipsNode = av.vrm.humanoid?.getNormalizedBoneNode?.('hips');
  const hips = hipsNode ? hipsNode.getWorldPosition(new EW.THREE.Vector3()).toArray() : null;
  const r = av.root.position;
  const f = (a) => a?.map((x) => +x.toFixed(3));
  return { drawnRoot: f(r.toArray()), drawnHips: f(hips), ground: +EW.groundAt(r.x, r.z).toFixed(3) };
}, { who, self });
const bootPage = async (name, x, z) => {
  const p = await page();
  await p.setViewportSize({ width: 1280, height: 720 });
  await p.context().addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });
  await p.goto(`${world.origin}/?world=${WORLD}&name=${name}&key=${world.key}&avatar=claude`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.()?.vrm, null, { timeout: 180000 });
  await sleep(2000);
  if (x != null) await p.evaluate(({ x, z }) => { const s = globalThis.EW.myState; s.pos.x = x; s.pos.z = z; }, { x, z });
  return p;
};
for (const kind of process.env.ONLY_AGENT || LATE ? [] : ['stand', 'sit', 'lie']) {
  n++;
  const name = `actor-${kind}`;
  const ap = await bootPage(name, -4 - n * 3, -3);
  await ap.evaluate(() => globalThis.EW.setPushable(true));
  if (kind !== 'stand') await ap.evaluate(async (k) => { const c = await import('/lib/controller.js'); c.setPosture(k); }, kind);
  await sleep(3000);
  const ownBefore = await readOn(ap, name, true), remoteBefore = await readOn(pg, name, false);
  shove(name);
  await sleep(7000);
  const own = await readOn(ap, name, true), remote = await readOn(pg, name, false);
  rows.push({ who: 'actor, OWN view', from: kind, before: ownBefore, after: own });
  rows.push({ who: 'actor, seen by WATCHER', from: kind, before: remoteBefore, after: remote });
  await shoot(`${n}-human-from-${kind}-fallen-seen-by-watcher`, own?.drawnRoot ?? [0, 0, 0]);
  if (kind !== 'lie') await ap.context().close();   // room for the latecomer; the lying actor stays to be seen
  if (kind === 'lie') {
    // a late joiner, after the fall
    const lp = await bootPage('latecomer');
    // remotes load their VRMs after the splash: wait until both fallen bodies are drawn
    await lp.waitForFunction((ids) => ids.every((id) => !!globalThis.EW.remotes.get(id)?.avatar?.vrm), [name, 'bot-lie'], { timeout: 120000 }).catch(() => {});
    await sleep(2000);
    rows.push({ who: 'actor, seen by LATE joiner', from: kind, before: null, after: await readOn(lp, name, false) });
    rows.push({ who: 'agent bot-lie, LATE joiner', from: 'lie', before: null, after: await readOn(lp, 'bot-lie', false) });
    await lp.context().close();
  }
}

// The verdict. A fallen body lies with its hips a few cm over the ground; under it means the renderer drew the
// body sunk (#282 was −0.65). A row the browser never drew is reported, not passed.
let bad = 0;
for (const r of rows) {
  const h = r.after?.drawnHips?.[1], g = r.after?.ground;
  if (h == null || g == null) { console.log(`  ?  ${r.who} from ${r.from}: not drawn, not measured`); continue; }
  if (h < g - 0.02) { bad++; console.log(`  ✗  ${r.who} from ${r.from}: hips drawn ${(g - h).toFixed(3)} m under the ground`); }
}
console.log(bad ? `\n${bad} fallen bod${bad === 1 ? 'y' : 'ies'} drawn under the ground` : `\nevery fallen body measured is drawn on the ground`);
agentProc.stdin.write('bye\n');
await close();
await world.close();
process.exit(bad ? 1 : 0);
