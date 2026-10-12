// LAB: World Settings' tabs and Settings' safety tab, rendered, for a look (R 10-10: "a bunch of stuff that looks a bit broken in every tab").
// @ts-nocheck
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const OUT = process.env.SHOT_DIR ?? "/home/claude/eido/logs/ws-shots";
(await import("node:fs")).mkdirSync(OUT, { recursive: true });
import path from "node:path"; import fs from "node:fs";
const ENGINE = path.resolve(import.meta.dir, "../..");
const { cdp, evalJson, cleanup, BASE } = await scratchBench("wsettings", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "wset", "--owner", "owner", "--title", "settings look"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(r.stderr.toString()); } });
const shot = async (name, el) => { const r = await evalJson(`(() => { const b = document.querySelector('${el}')?.getBoundingClientRect(); return b ? [b.left, b.top, b.width, b.height] : null; })()`);
  if (!r) return console.log("no", el); const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: r[0], y: r[1], width: Math.max(1, r[2]), height: Math.max(1, r[3]), scale: 1 } });
  await Bun.write(`${OUT}/${name}.png`, Buffer.from(s.data, "base64")); };
try {
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=wset&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  for (const tab of ["ws-roles", "ws-access", "ws-card", "ws-places"]) {
    await evalJson(`(async () => { const ui = await import('/lib/ui.js'); const f = ui.worldSettingsFrame?.() ?? null; document.getElementById('sec-${tab}-tab')?.click(); const fr = (await import('/lib/windows.js')).getFrame('world-settings'); fr?.show(); document.getElementById('sec-${tab}-tab')?.click(); return true; })()`);
    await sleep(700); await shot(tab, `[data-frame="world-settings"]`); }
  await evalJson(`(async () => { (await import('/lib/windows.js')).getFrame('world-settings')?.hide(); const fr = (await import('/lib/windows.js')).getFrame('settings'); fr?.show(); document.getElementById('sec-safety-tab')?.click(); return true; })()`);
  await sleep(700); await shot("safety", `[data-frame="settings"]`);
  await evalJson(`(async () => { (await import('/lib/windows.js')).getFrame('settings')?.hide(); (await import('/lib/ui.js')).toggleEMenu(true); return true; })()`); await sleep(500);
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 300, height: 340, scale: 1 } }); await Bun.write(`${OUT}/emenu.png`, Buffer.from(s.data, "base64"));
  console.log("ok");
} finally { await cleanup(); }
