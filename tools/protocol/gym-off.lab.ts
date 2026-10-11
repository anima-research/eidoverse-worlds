// LAB: R's gym, copied. Switch a thing off from the Inspector's name line (R 10-11: "a 'disabled' option - present in the
// world as links, but not downloaded, interopable, or visible until someone re-enables it"), with its children, and back on.
//   WORLDS_SRC=/home/claude/eido/scratch-worlds/v4-garden bun tools/protocol/gym-off.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; const OUT = "/home/claude/eido/logs/off-shots"; fs.mkdirSync(OUT, { recursive: true });
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymoff", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true });
  const f = path.join(w, "gym/world.jsonl"), T = Date.parse(process.env.CUT ?? "2026-10-11T21:15:00Z"); const ls = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  const k = ls.findIndex((l) => JSON.parse(l).ts >= T); if (k > 0) fs.writeFileSync(f, ls.slice(0, k).join("\n") + "\n"); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 400)); if (!ok) fail++; };
const shot = async (name) => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64")); };
const until = async (js, ms = 10000) => { for (let i = 0; i < ms / 250; i++) { if (await evalJson(js).catch(() => false)) return true; await sleep(250); } return false; };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Rab&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  const kids = await page(`const s = (await import('/lib/state.js')).state.st.entities; return Object.keys(s).filter((k) => s[k]?.parent?.to === 'desk');`);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 600)); (await import('/lib/scenegraph.js')).sceneSelect('desk'); return 1;`); await sleep(1200);
  const before = await page(`const w = await import('/lib/world.js'); return { desk: !!w.entities.get('desk'), kids: ${JSON.stringify(kids)}.map((k) => !!w.entities.get(k)) };`);
  await page(`[...document.querySelectorAll('[data-frame="inspector"] .sp-iconbtn .sp-btn')][2]?.click(); return 1;`);
  const gone = await until(`import('/lib/world.js').then((w) => !w.entities.has('desk'))`);
  await sleep(800);
  const off = await page(`const w = await import('/lib/world.js'); const f = document.querySelector('[data-frame="inspector"]'); const h = document.querySelector('[data-frame="hierarchy"]');
    const row = h?.querySelector('[data-id="desk"]'); return { desk: w.entities.has('desk'), kids: ${JSON.stringify(kids)}.map((k) => w.entities.has(k)), insp: f?.innerText.slice(0, 200), row: row ? { cls: row.className, text: row.innerText.slice(0, 60) } : null };`);
  check("OF1 the power button switches the desk off: it and the things on it are no longer realized", gone && !off.desk && off.kids.every((x) => !x) && before.desk, { kids, before, off });
  check("OF2 the Inspector says so and offers to switch it back on", /switched off/.test(off.insp ?? "") && /switch it back on/.test(off.insp ?? ""), off.insp);
  await shot("off-1.png");
  await page(`const b = [...document.querySelectorAll('[data-frame="inspector"] button')].find((x) => /switch it back on/.test(x.textContent)); b?.click(); return !!b;`);
  const back = await until(`import('/lib/world.js').then((w) => !!w.entities.get('desk'))`, 20000); await sleep(3000);
  const on = await page(`const w = await import('/lib/world.js'); return { desk: !!w.entities.get('desk'), kids: ${JSON.stringify(kids)}.map((k) => { const o = w.entities.get(k); return o ? (o.parent?.userData?.entityId ?? 'scene') : null; }) };`);
  check("OF3 switched back on: the desk loads again, and what was on it rides it again", back && on.desk && on.kids.every((p) => p === "desk"), on);
  await shot("off-2.png");
} catch (e) { console.log("ERR", e?.message ?? e); fail++; }
finally { await cleanup(0); }
console.log(`[gym-off] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);
