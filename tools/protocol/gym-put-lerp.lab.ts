// LAB (not in the suite): R 10-11 23:17, "Lerp on put/attach: presentation-only easing from the hand to the rest/attach
// pose over ~120 ms". A founded world in the bench with a table (a static crate, top at 0.8 m) and a small crate beside
// it: grab the crate, put it ON the table, and sample the mesh's WORLD position every frame from the rest row's arrival.
// The drawn crate must leave the hand's place and close on the rest monotonically, arriving bit for bit, with the truth
// (whereIs) at the rest from the first frame. The control arm (physicsApi.settle(0)) must show the old shape: the first
// drawn frame already at the rest.
//   code/scripts/eido-probe.sh -C <worktree> -t 400 tools/protocol/gym-put-lerp.lab.ts
// (A gym arm — WORLDS_SRC=<dir holding gym/>, desk-crate-1 back onto the desk — is the same page script with ID=desk-crate-1
//  and TABLE=desk; the gym under headless Chrome passed the perf-guard's memory floor on this box, so the founded world
//  is the default.)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
const ENGINE = path.resolve(import.meta.dir, "../..");
const ME = "putbot", WORLD = "putlerp";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC ?? null;
const CRATE = "eidoverse/assets/models/crate_large_blue.glb", RED = "eidoverse/assets/models/crate_large_red.glb";
const ID = SRC ? (process.argv[2] ?? "desk-crate-1") : "pl-crate", TABLE = SRC ? "desk" : "pl-table";
const { evalJson, cleanup, BASE, cdp } = await scratchBench("gymputlerp", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    if (SRC) { for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); return; }
    const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", WORLD, "--owner", ME, "--title", "put lerp lab"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    if (r.exitCode !== 0) throw new Error("founding failed: " + r.stderr.toString()); },
});
const { check, tally } = mkCheck();
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
const waitFor = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evalJson(expr)) return true; } catch { /* busy */ } await sleep(100); } return false; };
// one put onto the table, sampled every frame from the row's arrival (settling() names the crate) to two frames past its end
const PUT = (settleMs: number) => `const t = await import('/lib/thingphysics.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
  t.physicsApi.settle(${settleMs});
  const o = w.entities.get('${ID}'); if (!o) return { missing: '${ID}' };
  const wp = () => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new T.Vector3()); };
  const tb = w.entities.get('${TABLE}'); tb.updateWorldMatrix(true, false); const top = tb.getWorldPosition(new T.Vector3()); const spot = [+(top.x + ${settleMs ? 0 : 0.2}).toFixed(3), +top.z.toFixed(3)];
  const g = await t.physicsApi.grab('${ID}'); if (!g?.ok) return { grab: g, body: t.physicsApi.body() };
  for (let i = 0; i < 90; i++) await new Promise((z) => requestAnimationFrame(z));
  const hand = wp().toArray();
  const pr = t.physicsApi.put('${ID}', spot);
  const samples = []; let seen = false, truth = null, over = 0; const t0 = performance.now();
  for (let i = 0; i < 600; i++) { await new Promise((z) => requestAnimationFrame(z));
    const on = t.physicsApi.settling().includes('${ID}'); const p = wp().toArray(); const dt = Math.round(performance.now() - t0);
    if (!seen && (on || (!t.physicsApi.holds()['${ID}'] && Math.hypot(p[0] - hand[0], p[1] - hand[1], p[2] - hand[2]) > 0.05))) { seen = true; truth = t.physicsApi.whereIs('${ID}'); }
    if (seen) { samples.push({ dt, p, on, truth: t.physicsApi.whereIs('${ID}') }); if (!on && ++over >= 3) break; } }
  const r = await pr; const after = wp().toArray();
  return { grab: !!g?.ok, put: !!r?.ok, refused: r?.refused ?? null, spot, hand, truth, samples, after, parent: w.parentIdOf('${ID}') ?? null, y: after[1] };`;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=${SRC ? "Riannon" : ME}&world=${SRC ? "gym" : WORLD}` });
  let secs = 0; for (let i = 0; i < 160 && secs < 4; i++) { secs = (await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0; if (secs < 4) await sleep(500); }
  check("boot: a world", await waitFor(`import('/lib/net.js').then((m) => m.replicaActive())`, 30000));
  await sleep(3000);
  if (!SRC) {
    // the table: a crate too big to lift, top at 0.8 m (crate_large is ~2 m tall at scale 1); the crate: a fifth of one, beside me
    const me = await evalJson(`import('/lib/controller.js').then((m) => m.myState.pos.toArray())`);
    const made = await page(`const n = await import('/lib/net.js');
      const a = await n.sendRequest('create', { id: '${TABLE}', model: '${RED}', components: { label: 'Table', physics: { kind: 'static' }, transform: { pos: [${me[0]} + 1.1, 0, ${me[2]}], scale: 0.4 } } });
      const b = await n.sendRequest('create', { id: '${ID}', model: '${CRATE}', components: { label: 'Small crate', grabbable: { enabled: true }, physics: { kind: 'dynamic', who: 'visitor' }, transform: { pos: [${me[0]}, 0, ${me[2]} + 0.8], scale: 0.2 } } });
      return { table: a?.ok ?? a, crate: b?.ok ?? b };`);
    check("(setup) a table and a small crate beside me", made.table && made.crate, JSON.stringify(made));
    check("(setup) both realized", await waitFor(`import('/lib/world.js').then((m) => m.entities.has('${ID}') && m.entities.has('${TABLE}') && !m.entities.get('${ID}').userData?.placeholder)`, 20000));
    await sleep(1500);
  } else {
    const stood = await page(`const c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js'), T = (await import('/lib/core.js')).THREE, t = await import('/lib/thingphysics.js');
      const o = w.entities.get('${ID}'); if (!o) return { missing: '${ID}' }; o.updateWorldMatrix(true, false); const p = o.getWorldPosition(new T.Vector3());
      const desk = w.entities.get('desk'); desk.updateWorldMatrix(true, false); const across = new T.Vector3(0, 0, 1).applyQuaternion(desk.getWorldQuaternion(new T.Quaternion())); across.y = 0; across.normalize();
      const me = p.clone().addScaledVector(across, 1.0); c.myState.pos.set(me.x, 0, me.z); c.myState.yaw = Math.atan2(p.x - me.x, p.z - me.z); b.bus.emit('cut-adopted');
      await new Promise((z) => setTimeout(z, 1500)); const tr = await t.physicsApi.track(); await new Promise((z) => setTimeout(z, 500)); return { tracked: tr, body: t.physicsApi.body() };`);
    check("(setup) standing at the desk", !stood.missing && stood.tracked, JSON.stringify(stood));
  }

  const r = await page(PUT(120));
  console.log(JSON.stringify({ ...r, samples: undefined }));
  if (!r.samples) { check("the put ran", false, JSON.stringify(r)); throw new Error("no samples"); }
  console.log("samples (dt ms · drawn · settling · |drawn−truth|):");
  for (const s of r.samples) console.log(`  ${String(s.dt).padStart(4)}  ${s.p.map((v: number) => v.toFixed(3)).join(",")}  ${s.on ? "ease" : "    "}  ${s.truth ? dist(s.p, s.truth).toFixed(3) : "-"}`);
  check("grab and put both went through", r.grab && r.put, JSON.stringify({ grab: r.grab, put: r.put, refused: r.refused }));
  check("it rests on the table's top, up off the floor (the authority parents a rest-on only under some hosts; the height is the proof)", r.y > 0.5 && Math.abs(r.truth[0] - r.spot[0]) < 0.01 && Math.abs(r.truth[2] - r.spot[1]) < 0.01, JSON.stringify({ parent: r.parent, y: r.y, truth: r.truth, spot: r.spot }));
  const S = r.samples, truth = r.truth;
  check("the rest row was seen while the crate was still away from the rest", S.length >= 3 && S[0].on, `${S.length} samples, first ${JSON.stringify(S[0])}`);
  check("the truth (whereIs) is the rest from the first frame, and never moves", S.every((s: any) => s.truth && dist(s.truth, truth) < 1e-6), JSON.stringify(S.map((s: any) => s.truth)));
  // (the first rAF after the row lands up to a frame into the ease: nearer the hand than the rest is the claim, not "at the hand" — the headless pin has t=0 exactly)
  check("first frame: nearer the hand than the rest, well off the rest", dist(S[0].p, r.hand) < dist(S[0].p, truth) && dist(S[0].p, truth) > 0.2, `hand ${dist(S[0].p, r.hand).toFixed(3)} rest ${dist(S[0].p, truth).toFixed(3)}`);
  const ds = S.map((s: any) => dist(s.p, truth));
  check("every frame closes on the rest (monotone)", ds.every((d: number, i: number) => i === 0 || d <= ds[i - 1] + 1e-9), ds.map((d: number) => d.toFixed(3)).join(" "));
  const eased = S.filter((s: any) => s.on);
  check("more than one frame on the way (an ease, not a snap)", eased.length >= 2 && eased.some((s: any) => dist(s.p, truth) > 0.01 && dist(s.p, r.hand) > 0.01), `${eased.length} easing frames`);
  check("it arrives: the last sample is the rest, bit for bit", ds.at(-1) < 1e-6 && dist(r.after, truth) < 1e-6, `${ds.at(-1)}`);
  check("the ease is over within ~220 ms of the row", S.find((s: any) => !s.on)?.dt - S[0].dt <= 220, `${S.find((s: any) => !s.on)?.dt - S[0].dt} ms`);

  // the control arm: the old shape (the lab knob at 0: the first drawn frame is the rest)
  const c0 = await page(PUT(0));
  console.log("control (settle 0):", JSON.stringify({ ...c0, samples: c0.samples?.slice(0, 3) }));
  check("control: with the ease off the first drawn frame is already the rest", c0.put && c0.samples?.length && dist(c0.samples[0].p, c0.truth) < 1e-6, JSON.stringify(c0.samples?.[0] ?? c0));
} finally { await cleanup(0); }
console.log(`\n${tally.passed} passed, ${tally.failed} failed`); process.exit(tally.failed ? 1 : 0);
