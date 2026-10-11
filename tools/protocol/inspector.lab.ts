// LAB: the Inspector on a spinning thing, rendered and measured (R 10-10 18:37 notes).
// @ts-nocheck
import { scratchBench, sleep } from "../harness.ts";
import path from "node:path"; import fs from "node:fs";
process.env.TRUST_NAMES = "1";
const OUT = process.env.SHOT_DIR ?? "/home/claude/eido/logs/insp-shots"; fs.mkdirSync(OUT, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { cdp, evalJson, cleanup, BASE } = await scratchBench("inspector", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "insp", "--owner", "owner", "--title", "inspector look"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(r.stderr.toString()); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=insp&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(3000);
  await page(`const m = await import('/lib/net.js'); const r = await m.sendRequest('create', { id: 'pallet-spin', model: 'eidoverse/assets/models/crate_large_blue.glb', components: { label: 'spinning pallet', physics: { kind: 'dynamic' }, transform: { pos: [2, 0, 2], q: [0,0,0,1], scale: [1,1,1] } } });
    await m.sendRequest('set', { id: 'pallet-spin', component: 'motion', value: { type: 'spin', axis: [0, 1, 0], degPerSec: 45 } }); return r.ok;`);
  await sleep(1500);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 600)); (await import('/lib/scenegraph.js')).sceneSelect('pallet-spin'); return true;`);
  await sleep(1500);
  const m = await page(`const f = document.querySelector('[data-frame="inspector"]'); const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
    const rows = [...f.querySelectorAll('.sp-row')].slice(0, 60).map((r) => { const l = r.querySelector('.sp-label'); const c = l?.nextElementSibling; return { t: (l?.textContent ?? '').trim().slice(0, 18), label: l ? R(l) : null, ctl: c ? [c.className.split(' ')[0], ...R(c)] : null }; });
    const groups = [...f.querySelectorAll('.sp-group')].map((g) => g.textContent.trim().slice(0, 30)); return { frame: R(f), groups, rows };`);
  fs.writeFileSync(`${OUT}/rows.json`, JSON.stringify(m, null, 1));
  const b = await evalJson(`(() => { const r = document.querySelector('[data-frame="inspector"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: b[0], y: b[1], width: b[2], height: Math.min(b[3], 1000 - b[1]), scale: 1 } }); fs.writeFileSync(`${OUT}/inspector.png`, Buffer.from(s.data, "base64"));
  console.log("groups", JSON.stringify(m.groups));
} finally { await cleanup(); }
