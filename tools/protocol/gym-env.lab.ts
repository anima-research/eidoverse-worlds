// LAB: R's gym, copied. R 10-11 12:57: "I still have no idea how to get rid of the sky and the ground once they're created.
// We really need those components or entities to appear under the world entity in the Hierarchy". Are the environment
// rows there, does ✕ remove each one, does the ground go back to the stage floor, does Ctrl+Z bring it back? Screenshots.
//   WORLDS_SRC=/home/claude/eido/scratch-worlds/v4-garden bun tools/protocol/gym-env.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; const OUT = "/home/claude/eido/logs/env-shots"; fs.mkdirSync(OUT, { recursive: true });
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymenv", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true });
  // the gym as it stood before R removed its sky and terrain herself (10-11 ~21:04Z)
  const f = path.join(w, "gym/world.jsonl"), T = Date.parse(process.env.CUT ?? "2026-10-11T21:00:00Z"); const ls = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const k = ls.findIndex((l) => JSON.parse(l).ts >= T); if (k > 0) fs.writeFileSync(f, ls.slice(0, k).join("\n") + "\n"); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
const shot = async (name) => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); };
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 300)); if (!ok) fail++; };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Rab&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(1500);
  await page(`const t = [...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Hierarchy'); t?.click(); return !!t;`); await sleep(800);
  const rows = () => page(`return [...document.querySelectorAll('[data-frame="hierarchy"] .sp-item-sub-row')].map((e) => e.dataset.id);`);
  const st = () => page(`const s = (await import('/lib/state.js')).state.st; const t = await import('/lib/terrain.js'); return { sky: s.sky != null, terrain: s.terrain != null, weather: s.sky?.weather ?? null, mesh: t.hasTerrain() };`);
  const r0 = await rows(), s0 = await st(); check("EN1 the World row has its environment under it", r0.includes("env:sky") && r0.includes("env:terrain"), { r0, s0 });
  await shot("env-0-rows.png");
  const del = async (key) => { await page(`const row = document.querySelector('[data-frame="hierarchy"] [data-id="env:${key}"]'); row?.querySelector('.sp-mini')?.click(); return !!row;`); await sleep(2500); };
  await del("terrain"); const s1 = await st(), r1 = await rows();
  check("EN2 ✕ on Terrain removes it: the component and the mesh, and its row", !s1.terrain && !s1.mesh && !r1.includes("env:terrain"), { s1, r1 });
  await shot("env-1-no-terrain.png");
  await del("sky"); const s2 = await st(), r2 = await rows();
  check("EN3 ✕ on Sky removes it (and its weather row)", !s2.sky && !r2.includes("env:sky") && !r2.includes("env:weather"), { s2, r2 });
  await shot("env-2-no-sky.png");
  const u = await page(`const r = await (await import('/lib/editwrites.js')).undo(); return { ok: r.ok, refused: r.refused };`); await sleep(2500);
  const s3 = await st(); check("EN4 undo brings the last one back", s3.sky, { u, s3 });
  await shot("env-3-undo.png");
  const err = await page(`return (globalThis.__pageErrors ?? []).slice(0, 3);`); check("errors: none on the page", !err?.length, err);
} finally { await cleanup(0); }
console.log(`[gym-env] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);
