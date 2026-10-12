// LAB (not in the suite): a picture of the free-camera working pose, from in front.   bun tools/protocol/pose.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
const ENGINE = path.resolve(import.meta.dir, "../.."); const OUT = process.env.SHOT_DIR ?? "/home/claude/eido/logs/insp-shots"; fs.mkdirSync(OUT, { recursive: true });
const { cdp, evalJson, cleanup, BASE } = await scratchBench("pose", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "pose", "--owner", "owner", "--title", "pose look"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(r.stderr.toString()); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=pose&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  // the pose without the free camera: the bus event localbody listens to; then turn the body to face the chase camera
  await page(`const b = await import('/lib/base.js'), c = await import('/lib/controller.js'); b.bus.emit('edit-freecam', true); c.myState.yaw += Math.PI; return true;`);
  await sleep(2500);
  for (const [name, turn] of [["pose-front", 0], ["pose-side", Math.PI / 2]]) {
    if (turn) { await page(`const c = await import('/lib/controller.js'); c.myState.yaw += ${turn}; return true;`); await sleep(1500); }
    const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 300, y: 150, width: 600, height: 650, scale: 1 } }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, "base64")); }
  console.log("ok", OUT);
} finally { await cleanup(); }
