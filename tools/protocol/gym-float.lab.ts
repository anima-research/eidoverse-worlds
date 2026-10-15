// LAB (not in the suite): R's gym, copied. (1) which movable things hang in the air (bottom > 3 cm over whatever is under
// them), (2) grab a crate the physics parented to the one under it: is it drawn in the hand?   R, 10-10 18:03 / 18:14.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC"); process.exit(2); }
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymfloat", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); },
});
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Marigold&world=gym&avatar=tigerbee` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(7000);
  const air = await page(`const w = await import('/lib/world.js'), { THREE: T, scene } = await import('/lib/core.js'); const out = [];
    for (const [id, o] of w.entities) { const c = w.bagOf(id); if (c?.physics?.kind !== 'dynamic') continue; o.updateWorldMatrix(true, true);
      const b = new T.Box3().setFromObject(o); if (b.isEmpty()) continue; const mid = b.getCenter(new T.Vector3());
      const others = [...w.entities].filter(([k]) => k !== id).map(([, x]) => x);
      const rc = new T.Raycaster(new T.Vector3(mid.x, b.min.y - 0.005, mid.z), new T.Vector3(0, -1, 0), 0, 50); const hit = rc.intersectObjects(others, true)[0];
      const gap = hit ? b.min.y - 0.005 - hit.distance - hit.point.y + hit.point.y : b.min.y; const under = hit ? (b.min.y - hit.point.y) : b.min.y;
      if (under > 0.03) out.push({ id, bottom: +b.min.y.toFixed(3), gap: +under.toFixed(3), parent: c.parent?.to ?? null }); }
    return out;`);
  console.log("IN THE AIR:", JSON.stringify(air));
  const id = process.argv[2] ?? "tower-3";
  const held = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js'), n = await import('/lib/net.js'), { THREE: T } = await import('/lib/core.js');
    const o = w.entities.get('${id}'); const p = o.getWorldPosition(new T.Vector3()); c.myState.pos.set(p.x - 0.8, 0, p.z); b.bus.emit('cut-adopted'); await new Promise((z) => setTimeout(z, 2500));
    const before = o.getWorldPosition(new T.Vector3()).toArray(); const g = await t.physicsApi.grab('${id}'); await new Promise((z) => setTimeout(z, 2500));
    const P = { p: new T.Vector3(), q: new T.Quaternion() }; t.palmOf(n.net.you, 'right', P); const after = o.getWorldPosition(new T.Vector3());
    const kids = [...w.entities].filter(([k]) => w.bagOf(k)?.parent?.to === '${id}').map(([k, x]) => [k, x.getWorldPosition(new T.Vector3()).toArray().map((v) => +v.toFixed(2))]);
    return { grab: g?.ok ?? g?.refused?.code, before: before.map((v) => +v.toFixed(2)), after: after.toArray().map((v) => +v.toFixed(2)), palm: P.p.toArray().map((v) => +v.toFixed(2)), toPalm: +after.distanceTo(P.p).toFixed(2),
      sceneParent: o.parent?.name || o.parent?.type, kids };`);
  console.log("HOLD", id, JSON.stringify(held));
} finally { await cleanup(); }
