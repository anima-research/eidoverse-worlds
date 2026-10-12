// LAB: R's gym, copied; the Inspector on tower-2 ("tower crate 3", her long description), locked. R 10-11 14:08-14:14:
// the eye/padlock blue when on and centred; 'reads as' whole on hover/click; scale's numbers on the same right edge as
// translate/rotate; 'Add Component…' / 'Add Script…' alike. Measured, then a screenshot to look at.
//   WORLDS_SRC=<the scratch worlds dir holding gym/> bun tools/protocol/gym-insp.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; const OUT = "/home/claude/eido/logs/insp-shots"; fs.mkdirSync(OUT, { recursive: true });
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gyminsp", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true });
  const f = path.join(w, "gym/world.jsonl"), T = Date.parse(process.env.CUT ?? "2026-10-11T21:15:00Z"); const ls = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);   // her gym as it stood for her 14:08-14:14 notes
  const k = ls.findIndex((l) => JSON.parse(l).ts >= T); if (k > 0) fs.writeFileSync(f, ls.slice(0, k).join("\n") + "\n"); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
let fail = 0; const check = (k, ok, info) => { console.log(`${ok ? "✓" : "✗"} ${k}`, JSON.stringify(info ?? "").slice(0, 400)); if (!ok) fail++; };
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Rab&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(3000);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 600)); (await import('/lib/scenegraph.js')).sceneSelect('tower-2'); return true;`);
  await sleep(1200);
  await page(`const bs = document.querySelectorAll('[data-frame="inspector"] .sp-iconbtn .sp-btn'); bs[1]?.click(); return bs.length;`);
  for (let i = 0; i < 40; i++) { if (await evalJson(`!!document.querySelector('[data-frame="inspector"] .sp-iconbtn .sp-btn.on')`)) break; await sleep(250); }   // the lock's round trip, then its repaint
  await sleep(400);
  const m = await page(`const f = document.querySelector('[data-frame="inspector"]'); const C = (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
    const btns = [...f.querySelectorAll('.sp-iconbtn .sp-btn')].map((b) => { const s = b.querySelector('svg'); const [bx, by] = C(b), [sx, sy] = C(s); return { title: b.title.slice(0, 20), on: b.classList.contains('on'), color: getComputedStyle(b).color, off: [+(sx - bx).toFixed(1), +(sy - by).toFixed(1)] }; });
    const accent = getComputedStyle(f).getPropertyValue('--e-accent').trim();
    const rows = [...f.querySelectorAll('.sp-row')]; const reads = rows.find((r) => r.querySelector('.sp-label')?.textContent.trim() === 'reads as')?.querySelector('.sp-info');
    const nums = rows.filter((r) => /^(translate|rotate|scale) [xyz]$/.test(r.querySelector('.sp-label')?.textContent.trim() ?? '')).map((r) => { const i = r.querySelector('.sp-num'); const st = getComputedStyle(i); return [r.querySelector('.sp-label').textContent.trim(), Math.round(i.getBoundingClientRect().right - parseFloat(st.paddingRight))]; });
    const adds = [...f.querySelectorAll('.sp-add button')].map((b) => b.textContent.trim());
    return { btns, accent, reads: reads ? { title: reads.title.length, long: reads.classList.contains('sp-info-long') } : null, nums, adds };`);
  const lockB = m.btns.find((b) => b.on);
  check("IN1 the switched-on padlock is the accent colour", !!lockB && lockB.color !== m.btns.find((b) => !b.on)?.color, m.btns);
  check("IN2 both icons sit centred in their buttons (within 1 px)", m.btns.every((b) => Math.abs(b.off[0]) <= 1 && Math.abs(b.off[1]) <= 1), m.btns.map((b) => b.off));
  check("IN3 'reads as' carries its whole text as a tooltip and unfolds", m.reads?.long && m.reads.title > 40, m.reads);
  const edges = new Set(m.nums.map(([, x]) => x)); check("IN4 translate, rotate and scale numbers end on one right edge", edges.size === 1, m.nums);
  check("IN5 the add buttons read 'Add Component…' and 'Add Script…'", m.adds.join("|") === "Add Component…|Add Script…", m.adds);
  const b = await evalJson(`(() => { const r = document.querySelector('[data-frame="inspector"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: b[0], y: b[1], width: b[2], height: Math.min(b[3], 1000 - b[1]), scale: 1 } }); fs.writeFileSync(`${OUT}/gym-insp.png`, Buffer.from(s.data, "base64"));
} catch (e) { console.log("ERR", e?.message ?? e); fail++; }
finally { await cleanup(0); }
console.log(`[gym-insp] ${fail ? fail + " failed" : "all passed"}`);
process.exit(fail ? 1 : 0);
