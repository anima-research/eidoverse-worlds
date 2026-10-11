// LAB (not in the suite): R's gym, copied, in the bench. R 10-11 13:09: "There's a pretty long time delay between taking a
// box in this stack and the rest dropping down". Walk to the tower, grab a lower box, and time on THIS client, frame by
// frame: the grab's reply, the launch reaching the replica, the rider's first visible drop (2 cm), and its landing.
//   WORLDS_SRC=/home/claude/eido/scratch-worlds/v4-garden bun tools/protocol/gym-stack.lab.ts [grabId] [riderId]
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC"); process.exit(2); }
const GRAB = process.argv[2] ?? "tower-1", RIDER = process.argv[3] ?? "tower-3";
const { evalJson, cleanup, BASE, cdp } = await scratchBench("gymstack", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true });
    if (process.env.CUT) { const f = path.join(w, "gym/world.jsonl"), T = Date.parse(process.env.CUT);   // the world as it stood just before her grab
      const ls = fs.readFileSync(f, "utf8").split("\n").filter(Boolean); const k = ls.findIndex((l) => JSON.parse(l).ts >= T); if (k > 0) fs.writeFileSync(f, ls.slice(0, k).join("\n") + "\n"); } },
});
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  const r = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), n = await import('/lib/net.js'), T = (await import('/lib/core.js')).THREE;
    const o = w.entities.get('${GRAB}'); if (!o) return { missing: '${GRAB}' };
    const p0 = o.getWorldPosition(new T.Vector3()); const walked = await c.walkTo(p0.x - 0.8, p0.z, { ms: 15000 }); c.myState.yaw = Math.PI / 2; await new Promise((z) => setTimeout(z, 1500));
    const yOf = () => { const r = w.entities.get('${RIDER}'); r.updateWorldMatrix(true, false); return r.getWorldPosition(new T.Vector3()).y; };
    const y0 = yOf(); const t0 = performance.now(); const ev = []; const mark = (k) => ev.push([k, Math.round(performance.now() - t0)]);
    let launchSeen = null; const sv0 = n.replica.simVersion;
    const g = t.physicsApi.grab('${GRAB}').then((x) => { mark('grab-reply'); return x; });
    const ys = []; let first = null, landed = null;
    for (let i = 0; i < 240; i++) { await new Promise((z) => requestAnimationFrame(z)); const dt = Math.round(performance.now() - t0);
      if (launchSeen === null && n.replica.simVersion !== sv0) { launchSeen = dt; mark('replica-sim-changed'); }
      const y = yOf(); if (i % 3 === 0) ys.push([dt, +(y - y0).toFixed(3)]);
      if (first === null && y < y0 - 0.02) { first = dt; mark('rider-first-drop'); }
      if (first !== null && landed === null && Math.abs(y - (y0 - 0.5)) < 0.03) { landed = dt; mark('rider-near-landing'); }
      if (landed !== null && dt > landed + 800) break; }
    const sh = t.simShown(); const b = sh?.bodies?.['${RIDER}']; const sl = await import('/shared/protocol/simlayer.js'); const rm = await import('/lib/remotes.js');
    const probe = { shownTick: sh?.tick, target: sh ? sl.tickOf(sh, rm.serverNow()) : null, body: b ? { p: b.p, v: b.v, resting: b.resting, sleep: b.sleep, kind: b.kind } : null, bodyIds: sh ? Object.keys(sh.bodies) : null, parentNow: w.comps.get('${RIDER}')?.parent?.to ?? null, objParent: w.entities.get('${RIDER}').parent?.userData?.entityId ?? w.entities.get('${RIDER}').parent?.type, canonBodies: Object.keys(n.replica.sim?.bodies ?? n.replica.sim?.sim?.bodies ?? {}) };
    const gg = await g; return { probe, walked, grab: gg?.ok ?? gg?.refused?.code, ev, ys: ys.slice(0, 80) };`);
  console.log(JSON.stringify(r));
} finally { await cleanup(0); }
process.exit(0);
