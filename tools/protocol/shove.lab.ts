// LAB: body shove in a real browser (R's queue: "walking into a loose thing pushes it"). A founded world running eidosim, my
// own body walking (controller.walkTo: the keys' own path, collider and all) into small crates:
//   W  walk into a crate: one punt {shove: true} for that contact, the crate moves along the walk, and it leaves on MY screen
//      before the authority's answer is back (predicted, as a throw is)
//   P  pressed against a stack (three crates in a row against a static block, walking on into them for 3 s): at most
//      SHOVE_FEEL.perSec punts in any second, and a bounded total
//   S  standing still against a crate for 2 s: none
//   N  locked, held (in my own hand) and static crates walked into: none sent, none in the log
//   C  the control arm (physicsApi.shove.on(false)): walking into a crate sends nothing and it doesn't move
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/protocol/shove.lab.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
import { readLog } from "../../shared/protocol/fold.js";
import { SHOVE_FEEL } from "../../shared/shove.js";
const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "shovebot", WORLD = "shovelab";
process.env.TRUST_NAMES = "1";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb", RED = "eidoverse/assets/models/crate_large_red.glb";
let worldsDir = "";
const { evalJson, cleanup, BASE, cdp } = await scratchBench("shovelab", {
  prepare: (scratch) => { worldsDir = path.join(scratch, "worlds"); fs.mkdirSync(worldsDir, { recursive: true });
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "shove lab"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: worldsDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString()); },
});
const { check: check0, tally } = mkCheck();
const check = (name: string, ok: any, detail?: any) => check0(name, !!ok, detail === undefined ? "" : (typeof detail === "string" ? detail : JSON.stringify(detail) ?? "").slice(0, 900));
const page = (js: string, ms = 60000) => Promise.race([evalJson(`(async () => { ${js} })()`), sleep(ms).then(() => ({ timeout: ms }))]);
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
const entries = () => readLog(fs.readFileSync(path.join(worldsDir, WORLD, "world.jsonl")));
const puntsOf = (id: string) => entries().filter((e: any) => e.kind === "act" && e.verb === "punt" && e.body?.request?.id === id);
const okShoves = (id: string) => puntsOf(id).filter((e: any) => !e.body?.refused && e.body?.request?.shove === true);

// place me at (x, z) facing +z, and bring the authority's track of my body there
const STAND = (x: number, z: number) => `const c = await import('/lib/controller.js'), b = await import('/lib/base.js'), t = await import('/lib/thingphysics.js');
  c.myState.pos.set(${x}, 0, ${z}); c.myState.yaw = 0; c.myState.speed = 0; b.bus.emit('cut-adopted');
  await new Promise((z) => setTimeout(z, 1200)); const tr = await t.physicsApi.track(); await new Promise((z) => setTimeout(z, 300)); return { tracked: tr };`;
// walk to (x, z) as the keys would for `ms`, sampling every frame: the crate's drawn z, whether a guess is pending, shoves answered
const WALK = (id: string, x: number, z: number, ms: number) => `const c = await import('/lib/controller.js'), t = await import('/lib/thingphysics.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
  const o = w.entities.get('${id}'); const wp = () => { if (!o) return null; o.updateWorldMatrix(true, false); return o.getWorldPosition(new T.Vector3()).toArray(); };
  const n0 = t.physicsApi.shove.log().length; const z0 = wp()?.[2] ?? null; const samples = []; const t0 = performance.now();
  const walk = c.walkTo(${x}, ${z}, { ms: ${ms} });
  let done = null; walk.then((r) => (done = r));
  while (performance.now() - t0 < ${ms} + 400) { await new Promise((r) => requestAnimationFrame(r));
    samples.push({ dt: Math.round(performance.now() - t0), z: wp()?.[2] ?? null, pending: !!t.physicsApi.pending()['${id}'], answered: t.physicsApi.shove.log().length - n0, speed: +c.myState.speed.toFixed(2), ag: t.physicsApi.shove.against().includes('${id}') }); }
  const log = t.physicsApi.shove.log().slice(n0);
  return { done, z0, log, contact: samples.some((s) => s.ag), samples: samples.filter((s, i) => i % 2 === 0 || s.pending), me: c.myState.pos.toArray() };`;
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${ME}&world=${WORLD}` });
  const booted = await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`, 40000);
  check("boot: a world", booted); if (!booted) throw new Error("no world");
  await sleep(2500);
  const me = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
  const X = Math.round(me[0]), Z = Math.round(me[2]);
  const made = await page(`const n = await import('/lib/net.js');
    const out = {}; const mk = async (id, model, pos, scale, comps = {}) => (out[id] = (await n.sendRequest('create', { id, model, components: { label: id, transform: { pos, scale }, ...comps } }))?.ok ?? 'refused');
    out.engine = (await n.sendRequest('set', { id: '@world', component: 'physics-engine', value: { engine: 'eidosim@1.0.0' } }))?.ok;
    const dyn = { physics: { kind: 'dynamic', who: 'visitor' } };
    await mk('w-crate', '${CRATE}', [${X}, 0, ${Z} + 1.6], 0.25, dyn);
    for (let i = 0; i < 3; i++) await mk('p-crate-' + i, '${CRATE}', [${X} + 4 + (i - 1) * 0.55, 0, ${Z} + 1.2], 0.25, dyn);
    await mk('p-block', '${RED}', [${X} + 4, 0, ${Z} + 2.4], 0.6, { physics: { kind: 'static' } });
    await mk('s-crate', '${CRATE}', [${X} + 8, 0, ${Z} + 1.2], 0.25, dyn);
    await mk('n-locked', '${CRATE}', [${X} - 4, 0, ${Z} + 1.6], 0.25, { ...dyn, lock: true });
    await mk('n-static', '${CRATE}', [${X} - 8, 0, ${Z} + 1.6], 0.25, { physics: { kind: 'static' } });
    await mk('n-held', '${CRATE}', [${X} - 12, 0, ${Z} + 0.9], 0.15, { ...dyn, grabbable: { who: 'visitor' } });
    await mk('c-crate', '${CRATE}', [${X} + 12, 0, ${Z} + 1.6], 0.25, dyn);
    return out;`);
  check("(setup) physics on, and the crates made", made.engine && Object.entries(made).every(([, v]) => v === true), made);
  const ids = ["w-crate", "p-crate-0", "p-crate-1", "p-crate-2", "p-block", "s-crate", "n-locked", "n-static", "n-held", "c-crate"];
  check("(setup) realized, the dynamic ones measured", await waitFor(`Promise.all([import('/lib/world.js'), import('/lib/net.js')]).then(([w, n]) => ${JSON.stringify(ids)}.every((id) => w.entities.has(id) && !w.entities.get(id).userData?.placeholder) && ${JSON.stringify(ids.filter((i) => !/static|block/.test(i)))}.every((id) => Array.isArray(n.replica.st.entities[id]?.c.physics?.shape)))`, 30000));
  await sleep(1500);

  // ---- W
  { const st = await page(STAND(X, Z)); check("(W setup) standing south of the crate", st.tracked, st);
    await page(`const t = await import('/lib/thingphysics.js'); t.physicsApi.lag(300); return true;`);
    const r = await page(WALK("w-crate", X, Z + 3.2, 2500));
    await page(`const t = await import('/lib/thingphysics.js'); t.physicsApi.lag(0); return true;`);
    await sleep(2500);
    const s = okShoves("w-crate"), firstMove = r.samples?.find((x: any) => r.z0 !== null && x.z !== null && x.z - r.z0 > 0.02), firstAns = r.samples?.find((x: any) => x.answered > 0);
    console.log("W:", JSON.stringify({ done: r.done, z0: r.z0, log: r.log, firstMove, firstAns, me: r.me }));
    check("W walk into a crate: at least one shove, the first sent on the first contact", r.log?.length >= 1 && r.log[0].ok && r.log[0].id === "w-crate", r.log);
    check("W …one per contact: no two shoves of it within againMs", r.log.every((x: any, i: number) => i === 0 || x.t - r.log[i - 1].t >= SHOVE_FEEL.againMs - 1), r.log);
    check("W …the log has them as punts {shove: true}, none refused", s.length === r.log.length && puntsOf("w-crate").every((e: any) => !e.body?.refused), puntsOf("w-crate").map((e: any) => e.body));
    const rest = (await evalJson(`import('/lib/net.js').then((m) => m.replica.st.entities['w-crate'].c.transform.pos)`));
    check("W …it moved along the walk (+z) and came to rest there", rest[2] > Z + 1.6 + 0.1, rest);
    check("W …with the request held 300 ms (physicsApi.lag), it leaves on my screen well before the answer (predicted)", firstMove && firstAns && firstMove.dt <= firstAns.dt - 150, { firstMove, firstAns }); }

  // ---- P
  { const st = await page(STAND(X + 4, Z)); check("(P setup) standing south of the stack", st.tracked, st);
    const r = await page(WALK("p-crate-1", X + 4, Z + 4, 3000));
    await sleep(1500);
    const all = r.log ?? []; const perSec = Math.max(0, ...all.map((a: any) => all.filter((b: any) => b.t >= a.t && b.t - a.t < 1000).length));
    console.log("P:", JSON.stringify({ done: r.done, log: all, me: r.me }));
    check("P pressed against a stack: at least one shove", all.length >= 1, all);
    check(`P …at most ${SHOVE_FEEL.perSec} in any second`, perSec <= SHOVE_FEEL.perSec, `${perSec}/s`);
    check("P …and a bounded total over 3 s (no storm)", all.length <= 8, all.length); }

  // ---- S
  { const face = await page(`const n = await import('/lib/net.js'), s = await import('/shared/shove.js'); return s.footprint(n.replica.st, 's-crate');`);
    const st = await page(STAND(X + 8, face.min[2] - 0.32 - 0.02)); check("(S setup) standing against a crate", st.tracked, { st, face });
    const n0 = puntsOf("s-crate").length;
    const r = await page(`const t = await import('/lib/thingphysics.js'); const n0 = t.physicsApi.shove.log().length; const f0 = performance.now(); let frames = 0;
      while (performance.now() - f0 < 2000) { await new Promise((r) => requestAnimationFrame(r)); frames++; }
      return { frames, sent: t.physicsApi.shove.log().length - n0, against: t.physicsApi.shove.against() };`);
    check("S standing still against a crate (in contact) for 2 s (frames counted): none", r.frames > 20 && r.against.includes('s-crate') && r.sent === 0 && puntsOf("s-crate").length === n0, r); }

  // ---- N
  { const st = await page(STAND(X - 12, Z)); check("(N setup) standing by the small crate", st.tracked, st);
    const g = await page(`const t = await import('/lib/thingphysics.js'); const r = await t.physicsApi.grab('n-held'); return { ok: !!r?.ok, refused: r?.refused ?? null };`);
    check("(N setup) holding it", g.ok, g);
    const held = await page(WALK("n-held", X - 12, Z + 3, 1500));
    check("N walking while holding it: none", (held.log ?? []).length === 0 && puntsOf("n-held").length === 0, held.log);
    await page(`const t = await import('/lib/thingphysics.js'); await t.physicsApi.put('n-held'); return true;`);
    for (const [id, x] of [["n-locked", X - 4], ["n-static", X - 8]] as any) {
      await page(STAND(x, Z)); const r = await page(WALK(id, x, Z + 4, 2000));
      // a static thing is no shove's candidate, so against() never lists it: its contact is the collider stopping the walk at its face
      const against = id === "n-static" ? r.done === "blocked" && r.me[2] > Z + 1.0 : r.contact;
      check(`N walking into ${id} (in contact): none sent, none in the log`, against && (r.log ?? []).length === 0 && puntsOf(id).length === 0, { contact: r.contact, done: r.done, me: r.me, log: r.log, punts: puntsOf(id).map((e: any) => e.body) }); } }

  // ---- C (the control arm, last: the knob stays off)
  { await page(STAND(X + 12, Z)); await page(`const t = await import('/lib/thingphysics.js'); t.physicsApi.shove.on(false); return true;`);
    const r = await page(WALK("c-crate", X + 12, Z + 4, 2000)); await sleep(1500);
    const rest = await evalJson(`import('/lib/net.js').then((m) => m.replica.st.entities['c-crate'].c.transform.pos)`);
    check("C control (shove off): walking into a crate (in contact) sends nothing and it stays put", r.contact && (r.log ?? []).length === 0 && puntsOf("c-crate").length === 0 && Math.abs(rest[2] - (Z + 1.6)) < 1e-6, { log: r.log, rest, done: r.done }); }
} catch (e) { check("lab ran", false, String(e?.stack ?? e)); }
finally { await cleanup(0); }
console.log(`\n${tally.passed} passed, ${tally.failed} failed`); process.exit(tally.failed ? 1 : 0);
