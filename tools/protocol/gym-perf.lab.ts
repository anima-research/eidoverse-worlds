// LAB (not in the suite): R's gym, copied, in the bench; how long the client's physics takes per frame at rest and
// after a domino is tipped. R, 10-10 15:45: "the physics work but MY GOD they are painfully slow. I'm only getting
// object location updates every few seconds".   bun tools/protocol/gym-perf.lab.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC=<a worlds dir holding gym/ and its .custody.json, .directory.json> (copied, never written)"); process.exit(2); }
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymperf", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); },
});
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(6000);
  const snap = () => page(`const t = await import('/lib/thingphysics.js'), n = await import('/lib/net.js'); const s = t.simShown(), st = t.physicsApi.body().stats;
    const bodies = s ? Object.values(s.bodies) : []; const canon = n.replica.sim;
    const rm = await import('/lib/remotes.js'), sl = await import('/shared/protocol/simlayer.js'); const wall = rm.serverNow();
    return { target: s ? sl.tickOf(s, wall) : null, behind: s ? Math.round((wall - (s.epoch.ts + s.tick * s.epoch.tickMs))) : null, epochTs: s?.epoch?.ts, wall: Math.round(wall), local: Date.now(), foreign: !!s?.epoch?.foreign, e2: !!s?.e2, frames: st.frames, ms: st.ms, maxMs: st.maxMs, clones: st.clones, tick: s?.tick ?? null, tickMs: s?.epoch?.tickMs ?? null, bodies: bodies.length, awake: bodies.filter((b) => !b.resting).length, canonTick: canon?.sim?.tick ?? canon?.tick ?? null, simVersion: n.replica.simVersion, now: performance.now() };`);
  const run = async (label: string, secs: number) => { let a = await snap(); console.log(label, JSON.stringify(a));
    for (let i = 0; i < secs; i++) { await sleep(1000); const b = await snap(); const fr = b.frames - a.frames, dt = (b.now - a.now) / 1000;
      console.log(`  +${i + 1}s  target-tick ${b.target - b.tick} wallBehindSim ${-b.behind} ms  frames ${fr} (${(fr / dt).toFixed(0)}/s)  physics ${(fr ? (b.ms - a.ms) / fr : 0).toFixed(2)} ms/frame  worst ever ${b.maxMs} ms  ticks +${b.tick - a.tick} (${b.tickMs} ms each)  bodies ${b.bodies} awake ${b.awake}  clones +${b.clones - a.clones}  simVersion ${b.simVersion}`); a = b; } };
  await run("at rest:", 3);
  const r = await page(`const t = await import('/lib/thingphysics.js'); const c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js');
    const d = w.entities.get('domino-0'); const p = d.position; c.myState.pos.set(p.x - 0.6, 0, p.z); b.bus.emit('cut-adopted'); await new Promise((z) => setTimeout(z, 1500));
    const r = await t.physicsApi.punt('domino-0 6'); return { ok: !!r?.ok, code: r?.refused?.code ?? null, reason: r?.refused?.reason ?? null, at: [p.x, p.y, p.z] };`);
  console.log("tip domino-0:", JSON.stringify(r));
  await run("after the tip:", 5);
} finally { await cleanup(0); }
process.exit(0);
