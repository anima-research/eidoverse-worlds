// LAB: Create ▸ (R 10-11: right of Edit; empty, lights, models, blueprints, the environment suite). The menu's items, an
// Empty placed with a click on the world, and Environment ▸ Terrain opening the World's Terrain card.
//   bun tools/protocol/create-menu.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const OUT = "/home/claude/eido/logs/create-shots"; fs.mkdirSync(OUT, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { cdp, evalJson, cleanup, BASE } = await scratchBench("createmenu", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "mk", "--owner", "owner", "--title", "create menu"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(String(r.stderr)); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 400)); if (!ok) fail++; };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=mk&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(3000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return 1;`); await sleep(1200);
  const bar = await page(`return [...document.querySelectorAll('.edit-menus > *')].map((m) => m.textContent.trim().slice(0, 14));`);
  check("CM1 the bar reads Edit, Create, Layout… (Create right of Edit)", bar.findIndex((x) => /^Create/.test(x)) === bar.findIndex((x) => /^Edit/.test(x)) + 1, bar);
  const items = await page(`const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); await new Promise((z) => setTimeout(z, 300));
    return [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].map((x) => x.textContent.trim());`);
  check("CM2 it offers Empty, Light, a model, a blueprint and the Environment (sky, weather, terrain, grass)", ["Empty", "Light", "Sky", "Weather", "Terrain", "Grass"].every((w) => items.some((x) => x.includes(w))), items);
  await page(`[...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === 'Empty')?.click(); return 1;`); await sleep(800);
  const before = await page(`return Object.keys((await import('/lib/state.js')).state.st.entities).length;`);
  const c = await evalJson(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height * 0.7)]; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: c[0], y: c[1], button: "left", clickCount: 1 });
  await sleep(2500);
  const made = await page(`const s = (await import('/lib/state.js')).state.st.entities; return Object.entries(s).filter(([k, e]) => e?.comp?.label === 'empty' && e.lib == null).map(([k]) => k);`);
  check("CM3 Create ▸ Empty, then a click on the world, places a bare entity labelled 'empty'", made.length === 1, { before, made });
  await page(`const b = [...document.querySelectorAll('.edit-menus button, .edit-menus .edit-menu-btn')].find((x) => /^Create/.test(x.textContent.trim())); b?.click(); await new Promise((z) => setTimeout(z, 300));
    [...document.querySelectorAll('.edit-menu-pop .edit-menu-item')].find((x) => x.textContent.trim() === 'Terrain')?.click(); return 1;`); await sleep(1000);
  const insp = await page(`return document.querySelector('[data-frame="inspector"]')?.innerText.slice(0, 400);`);
  check("CM4 Environment ▸ Terrain opens the World in the Inspector with its Terrain card", /Terrain/.test(insp ?? "") && /world/i.test(insp ?? ""), insp);
} catch (e) { console.log("ERR", e?.message ?? e); fail++; }
finally { await cleanup(0); }
console.log(`[create-menu] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);
