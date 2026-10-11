// LAB: the Settings panel's tabs and the edit-mode dock, rendered to look at (R 10-11 14:41/14:46: the dock's spacing in
// edit mode; "the Settings panel aren't aligned like stuff in the Edit mode menus… label text right-justified and the
// interactables left-justified against the same invisible line"). Measures each row's label right edge and control left
// edge per tab: one line means one value each.   bun tools/protocol/settings-look.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const OUT = "/home/claude/eido/logs/settings-shots"; fs.mkdirSync(OUT, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { cdp, evalJson, cleanup, BASE } = await scratchBench("settingslook", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "look", "--owner", "owner", "--title", "settings look"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(String(r.stderr)); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 500)); if (!ok) fail++; };
const clip = async (sel, name) => { const b = await evalJson(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? [r.left, r.top, r.width, r.height] : null; })()`); if (!b) return;
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: b[0], y: b[1], width: b[2], height: Math.min(b[3], 1000 - b[1]), scale: 1 } }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, "base64")); };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=look&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  await sleep(3000);
  await page(`document.querySelector('#dock button[data-toggles="settings"]')?.click(); return 1;`); await sleep(800);
  const tabs = await page(`return [...document.querySelectorAll('[data-frame="settings"] .pf-tab')].map((t) => t.textContent.trim());`);
  for (const [i, t] of tabs.entries()) {
    await page(`[...document.querySelectorAll('[data-frame="settings"] .pf-tab')][${i}].click(); return 1;`); await sleep(600);
    const m = await page(`const f = document.querySelector('[data-frame="settings"]'); const rows = [...f.querySelectorAll('.row.wide')].filter((r) => r.offsetParent);
      return rows.map((r) => { const n = r.querySelector(':scope > .nm'), c = r.querySelector(':scope > .ctl, :scope > select, :scope > input'); return n && c ? [Math.round(n.getBoundingClientRect().right), Math.round(c.getBoundingClientRect().left), n.textContent.trim().slice(0, 18)] : null; }).filter(Boolean);`);
    const rights = new Set(m.map((x) => x[0])), lefts = new Set(m.map((x) => x[1]));
    check(`SL ${t}: ${m.length} rows, labels end on one line, controls start on one line`, m.length === 0 || (rights.size === 1 && lefts.size === 1), { rights: [...rights], lefts: [...lefts], odd: m.filter((x) => x[0] !== m[0][0] || x[1] !== m[0][1]).slice(0, 4) });
    await clip('[data-frame="settings"]', `settings-${i}-${t.replace(/\W+/g, "")}.png`);
  }
  await page(`(await import('/lib/build.js')).setEditMode(true); return 1;`); await sleep(1500);
  const pitch = await page(`const bs = [...document.querySelectorAll('#dock button:not(.dock-grip)')].filter((b) => b.offsetParent).map((b) => Math.round(b.getBoundingClientRect().top)); return bs.slice(1).map((y, i) => y - bs[i]);`);
  check("DK the edit dock's buttons step like the normal dock's (34 + 2 px)", pitch.every((d) => d <= 37), pitch);
  await clip('#dock', 'edit-dock.png');
} catch (e) { console.log("ERR", e?.message ?? e); fail++; }
finally { await cleanup(0); }
console.log(`[settings-look] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);
