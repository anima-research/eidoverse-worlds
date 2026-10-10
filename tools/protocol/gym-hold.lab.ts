// LAB (not in the suite): R's gym, copied: pick up a wrecking ball, put it down, and watch the camera and the ball.
// R, 10-10 15:43: "the camera resets/jerks when you put down something".   bun tools/protocol/gym-hold.lab.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = "/home/claude/eido/scratch-worlds/v4-garden";
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymhold", {
  prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
    for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f));
    fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); },
});
const page = (js: string) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  const id = process.argv[2] ?? "wrecker-1";
  const r = await page(`const t = await import('/lib/thingphysics.js'), c = await import('/lib/controller.js'), w = await import('/lib/world.js'), b = await import('/lib/base.js'), k = await import('/lib/core.js'), T = k.THREE;
    const o = w.entities.get('${id}'); const p = o.getWorldPosition(new T.Vector3()); c.myState.pos.set(p.x - 1.0, 0, p.z); b.bus.emit('cut-adopted'); await new Promise((z) => setTimeout(z, 2000));
    const box = new T.Box3().setFromObject(o), size = box.getSize(new T.Vector3());
    const look = () => { o.updateWorldMatrix(true, false); const q = o.getWorldPosition(new T.Vector3()), me = c.myState.pos; const cam = k.camera.position;
      return { camDist: +cam.distanceTo(new T.Vector3(me.x, me.y + 1.45, me.z)).toFixed(2), ball: [+(q.x - me.x).toFixed(2), +q.y.toFixed(2), +(q.z - me.z).toFixed(2)], body: [+me.x.toFixed(2), +me.z.toFixed(2)] }; };
    const out = { size: size.toArray().map((v) => +v.toFixed(2)), boxMinY: +box.min.y.toFixed(2), origin: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], comps: Object.keys(w.comps.get('${id}') ?? {}), physics: w.comps.get('${id}')?.physics, scale: o.scale.toArray(), before: look() };
    const g = await t.physicsApi.grab('${id}'); out.grab = { ok: !!g?.ok, code: g?.refused?.code ?? null }; await new Promise((z) => setTimeout(z, 1500)); out.held = look(); { const me = c.myState.pos, q = o.getWorldPosition(new T.Vector3()); out.heldGap = +(Math.hypot(q.x - me.x, q.z - me.z) - size.x / 2).toFixed(2); }
    const pr = t.physicsApi.put('${id}'); out.trace = []; for (let i = 0; i < 30; i++) { out.trace.push(look()); await new Promise((z) => setTimeout(z, 100)); } await pr; out.after = look(); return out;`);
  console.log(JSON.stringify({ ...r, trace: undefined }));
  console.log("camDist over 3 s after put:", r.trace.map((x: any) => x.camDist).join(" "));
  console.log("ball rel. to me:", r.trace.filter((_: any, i: number) => i % 5 === 0).map((x: any) => x.ball.join("/")).join("  "));
  console.log("body:", r.trace.filter((_: any, i: number) => i % 10 === 0).map((x: any) => x.body.join("/")).join("  "));
} finally { await cleanup(0); }
process.exit(0);
