// LAB (not in the suite): R's gym, copied, in the bench. R 10-11 23:17: "Lerp on put/attach: presentation-only easing
// from the hand to the rest/attach pose over ~120 ms". Stand at the desk, take a crate off it, put it back on the desk,
// and sample the mesh's WORLD position every frame from the rest row's arrival: the drawn crate must leave the hand's
// place and close on the rest monotonically, arriving bit for bit, with the truth (whereIs) at the rest from the first
// frame. The control arm (physicsApi.settle(0)) must show the old shape: the first sample already at the rest.
//   WORLDS_SRC=<the scratch worlds dir holding gym/> code/scripts/eido-probe.sh -C <worktree> -t 400 tools/protocol/gym-put-lerp.lab.ts [crateId]
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, mkCheck, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC=<a worlds dir holding gym/ and its .custody.json, .directory.json> (copied, never written)"); process.exit(2); }
const ID = process.argv[2] ?? "desk-crate-1";
const { evalJson, cleanup, BASE, cdp } = await scratchBench("gymputlerp", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); },
});
const { check, tally } = mkCheck();
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
// one put, sampled every frame from the row's arrival (settling() names the crate) to two frames past its end
const PUT = (settleMs: number) => `const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), T = (await import('/lib/core.js')).THREE;
  t.physicsApi.settle(${settleMs});
  const o = w.entities.get('${ID}'); if (!o) return { missing: '${ID}' };
  const wp = () => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new T.Vector3()); };
  const home = wp(); const spot = [+home.x.toFixed(3), +home.z.toFixed(3)];
  const g = await t.physicsApi.grab('${ID}'); if (!g?.ok) return { grab: g };
  for (let i = 0; i < 90; i++) await new Promise((z) => requestAnimationFrame(z));
  const hand = wp().toArray();
  const pr = t.physicsApi.put('${ID}', spot);
  const samples = []; let seen = false, truth = null, over = 0; const t0 = performance.now();
  for (let i = 0; i < 600; i++) { await new Promise((z) => requestAnimationFrame(z));
    const on = t.physicsApi.settling().includes('${ID}'); const p = wp().toArray(); const dt = Math.round(performance.now() - t0);
    if (!seen && (on || (!t.physicsApi.holds()['${ID}'] && Math.hypot(p[0] - hand[0], p[1] - hand[1], p[2] - hand[2]) > 0.05))) { seen = true; truth = t.physicsApi.whereIs('${ID}'); }
    if (seen) { samples.push({ dt, p, on, truth: t.physicsApi.whereIs('${ID}') }); if (!on && ++over >= 3) break; } }
  const r = await pr; const after = wp().toArray();
  return { grab: !!g?.ok, put: !!r?.ok, refused: r?.refused ?? null, home: home.toArray(), spot, hand, truth, samples, after, parent: w.comps.get('${ID}')?.parent?.to ?? null };`;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  // stand beside the desk crate, facing it
  const stood = await page(`const c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js'), T = (await import('/lib/core.js')).THREE;
    const t = await import('/lib/thingphysics.js');
    const o = w.entities.get('${ID}'); if (!o) return { missing: '${ID}' }; o.updateWorldMatrix(true, false); const p = o.getWorldPosition(new T.Vector3());
    const desk = w.entities.get('desk'); desk.updateWorldMatrix(true, false); const across = new T.Vector3(0, 0, 1).applyQuaternion(desk.getWorldQuaternion(new T.Quaternion())); across.y = 0; across.normalize();
    const me = p.clone().addScaledVector(across, 1.0); c.myState.pos.set(me.x, 0, me.z); c.myState.yaw = Math.atan2(p.x - me.x, p.z - me.z); b.bus.emit('cut-adopted');
    await new Promise((z) => setTimeout(z, 1500)); const tr = await t.physicsApi.track(); await new Promise((z) => setTimeout(z, 500));
    return { at: [p.x, p.y, p.z], me: [me.x, me.z], tracked: tr, body: t.physicsApi.body() };`);
  console.log("stood:", JSON.stringify(stood));
  check("the crate is in the gym", !stood.missing, JSON.stringify(stood));

  const r = await page(PUT(120));
  console.log(JSON.stringify({ ...r, samples: undefined }));
  if (!r.samples) { check("the put ran", false, JSON.stringify(r)); throw new Error("no samples"); }
  console.log("samples (dt ms · drawn · settling · |drawn−truth|):");
  for (const s of r.samples) console.log(`  ${String(s.dt).padStart(4)}  ${s.p.map((v: number) => v.toFixed(3)).join(",")}  ${s.on ? "ease" : "    "}  ${s.truth ? dist(s.p, s.truth).toFixed(3) : "-"}`);
  check("grab and put both went through", r.grab && r.put, JSON.stringify({ grab: r.grab, put: r.put, refused: r.refused }));
  check("it rests on the desk (its parent)", r.parent === "desk", JSON.stringify(r.parent));
  const S = r.samples, truth = r.truth;
  check("the rest row was seen while the crate was still away from the rest", S.length >= 3 && S[0].on, `${S.length} samples, first ${JSON.stringify(S[0])}`);
  check("the truth (whereIs) is the rest from the first frame, and never moves", S.every((s: any) => s.truth && dist(s.truth, truth) < 1e-6), JSON.stringify(S.map((s: any) => s.truth)));
  check("first frame: drawn near the hand, not at the rest", dist(S[0].p, r.hand) < 0.15 && dist(S[0].p, truth) > 0.2, `hand ${dist(S[0].p, r.hand).toFixed(3)} rest ${dist(S[0].p, truth).toFixed(3)}`);
  const ds = S.map((s: any) => dist(s.p, truth));
  check("every frame closes on the rest (monotone)", ds.every((d: number, i: number) => i === 0 || d <= ds[i - 1] + 1e-9), ds.map((d: number) => d.toFixed(3)).join(" "));
  const eased = S.filter((s: any) => s.on);
  check("more than one frame on the way (an ease, not a snap)", eased.length >= 2 && eased.some((s: any) => dist(s.p, truth) > 0.01 && dist(s.p, r.hand) > 0.01), `${eased.length} easing frames`);
  check("it arrives: the last sample is the rest, bit for bit", ds.at(-1) < 1e-6 && dist(r.after, truth) < 1e-6, `${ds.at(-1)}`);
  check("the ease is over within ~200 ms of the row", S.find((s: any) => !s.on)?.dt - S[0].dt <= 220, `${S.find((s: any) => !s.on)?.dt - S[0].dt} ms`);

  // the control arm: the old shape (the lab knob at 0: the first drawn frame is the rest)
  const c0 = await page(PUT(0));
  console.log("control (settle 0):", JSON.stringify({ ...c0, samples: c0.samples?.slice(0, 3) }));
  check("control: with the ease off the first drawn frame is already the rest", c0.put && c0.samples.length && dist(c0.samples[0].p, c0.truth) < 1e-6, JSON.stringify(c0.samples?.[0]));
} finally { await cleanup(0); }
console.log(`\n${tally.passed} passed, ${tally.failed} failed`); process.exit(tally.failed ? 1 : 0);
