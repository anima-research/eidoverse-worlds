// LAB: put {at} a ball, grab it again within 2 s, walk 4 m: is it drawn in my hand or left where the put landed it?
// (R 10-11 23:56: "I'm holding this ball several meters away")
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../tools/harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = "/home/claude/eido/scratch-worlds/garden";
const { evalJson, cleanup, BASE } = await scratchBench("putgrab", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { try { ${js} } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; } })()`);
try {
  await evalJson(`(location.href = ${JSON.stringify(`${BASE}/?name=Riannon&world=gym`)}, true)`).catch(() => {});
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  const r = await page(`
    const t = await import('/lib/thingphysics.js'); const w = await import('/lib/world.js'); const n = await import('/lib/net.js'); let c; try { c = await import('/lib/controller.js'); } catch (e) { return { err: 'controller: ' + String(e).slice(0, 200) }; }
    const P = (id) => { const o = w.entities.get(id); if (!o) return null; const v = o.position.clone(); o.getWorldPosition(v); return [v.x, v.y, v.z].map((x) => +x.toFixed(2)); };
    const me = () => [c.myState.pos.x, c.myState.pos.y, c.myState.pos.z].map((x) => +x.toFixed(2));
    const id = 'desk-ball';
    await n.sendRequest('move', { to: [-3, 0, -13.5], teleport: true, client: 'human' }); c.myState.pos.set(-3, 0, -13.5); await new Promise((z) => setTimeout(z, 800));
    const g0 = await t.physicsApi.grab(id); await new Promise((z) => setTimeout(z, 600));
    const p0 = await t.physicsApi.put(id, { at: [-3, -13.2] }); await new Promise((z) => setTimeout(z, 300));   // a click-to-put at a spot
    const g1 = await t.physicsApi.grab(id); await new Promise((z) => setTimeout(z, 1500));
    const heldA = t.physicsApi.mine().includes(id), ballA = P(id), meA = me();
    await c.walkTo(-3, -9.5, {}); await new Promise((z) => setTimeout(z, 1200));
    const heldB = t.physicsApi.mine().includes(id), ballB = P(id), meB = me();
    const d = (a, b) => a && b ? +Math.hypot(a[0] - b[0], a[2] - b[2]).toFixed(2) : null;
    const R = (x) => x?.ok ? 'ok' : JSON.stringify(x).slice(0, 160);
    return { g0: R(g0), p0: R(p0), g1: R(g1), heldA, dA: d(ballA, meA), heldB, dB: d(ballB, meB), ballB, meB };`);
  console.log("RESULT", JSON.stringify(r));
  console.log(r.heldB && r.dB != null && r.dB < 1.2 ? "PG1 ok: a ball grabbed right after a put rides in the hand" : "PG1 FAIL");
} finally { await cleanup(); }
