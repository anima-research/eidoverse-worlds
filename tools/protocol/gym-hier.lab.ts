// LAB: R's gym, copied: can every entity be reached in the Hierarchy? (R 10-10 18:56: "a bunch of entities ... I can't get to")
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; const OUT = "/home/claude/eido/logs/hier-shots"; fs.mkdirSync(OUT, { recursive: true });
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymhier", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Marigold&world=gym&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(1500);
  await page(`const t = [...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Hierarchy'); t?.click(); return !!t;`); await sleep(800);
  const geo = await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const chain = []; let e = f.querySelector('.schema-scroll');
    while (e && chain.length < 9) { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); chain.push({ tag: e.tagName + '.' + String(e.className).split(' ')[0], top: Math.round(b.top), h: Math.round(b.height), bottom: Math.round(b.bottom), ov: cs.overflowY, sh: e.scrollHeight }); e = e.parentElement; }
    return chain;`);
  console.log("GEO", JSON.stringify(geo));
  const inner = await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const row = f.querySelector('[data-id="ball-0"]'); const chain = []; let e = row.parentElement;
    while (e && chain.length < 6 && !e.classList.contains('schema-scroll')) { const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); chain.push({ tag: e.tagName + '.' + String(e.className).split(' ')[0], top: Math.round(b.top), h: Math.round(b.height), ov: cs.overflowY, sh: e.scrollHeight, ch: e.clientHeight, maxH: cs.maxHeight }); e = e.parentElement; }
    const sc = chain.findIndex((c) => c.ov === 'auto' || c.ov === 'scroll'); let el = row.parentElement; for (let i = 0; i < sc; i++) el = el.parentElement;
    if (el) { el.scrollTop = 1e6; } await new Promise((z) => setTimeout(z, 200));
    const rows = [...f.querySelectorAll('[data-id]')]; const last = rows.at(-1); const lb = last.getBoundingClientRect(), eb = el?.getBoundingClientRect();
    return { chain, scroller: sc, lastId: last.dataset.id, lastBottom: Math.round(lb.bottom), scrollerBottom: eb ? Math.round(eb.bottom) : null, scrollTop: el?.scrollTop, visibleBottom: Math.round(f.getBoundingClientRect().bottom) };`);
  console.log("INNER", JSON.stringify(inner));
  // scroll to the bottom like a person, wait while things move (spinning pallet, physics), and see what is in view
  await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const sc = [f.querySelector('.sp-tree'), f.querySelector('.schema-scroll')].find((e) => e && e.scrollHeight > e.clientHeight + 4); globalThis.__hsc = sc; if (sc) sc.scrollTop = sc.scrollHeight; return !!sc;`);
  await sleep(3000);
  const after = await page(`const f = document.querySelector('[data-frame="hierarchy"]'); const fb = f.getBoundingClientRect(); const vis = [...f.querySelectorAll('[data-id]')].filter((e) => { const b = e.getBoundingClientRect(); return b.height && b.top >= fb.top && b.bottom <= fb.bottom + 1; }).map((e) => e.dataset.id);
    const sc = [f.querySelector('.sp-tree'), f.querySelector('.schema-scroll')].find((e) => e && e.scrollHeight > e.clientHeight + 4);
    return { scroller: sc?.className, top: sc?.scrollTop, max: sc ? sc.scrollHeight - sc.clientHeight : null, firstVisible: vis[0], lastVisible: vis.at(-1), hasPallet: vis.includes('pallet-spin') };`);
  console.log("AFTER", JSON.stringify(after));
  const base = await page(`const w = await import('/lib/world.js'); const f = document.querySelector('[data-frame="hierarchy"]'); const sc = f.querySelector('.schema-scroll') ?? f.querySelector('.body');
    globalThis.__hs = { seen: new Set(), sc, f }; const fr = f.getBoundingClientRect(), sr = sc?.getBoundingClientRect();
    return { total: w.entities.size, frameH: Math.round(fr.height), scrollH: sc?.scrollHeight, clientH: sc?.clientHeight, scrollBox: sr ? [Math.round(sr.top), Math.round(sr.height)] : null, cls: sc?.className, rows: f.querySelectorAll('[data-id]').length };`);
  console.log("BASE", JSON.stringify(base));
  for (let i = 0; i < 40; i++) { const k = await evalJson(`(() => { const h = globalThis.__hs; h.f.querySelectorAll('[data-id]').forEach((e) => h.seen.add(e.dataset.id)); h.sc.scrollTop += 300; return h.sc.scrollTop; })()`); await sleep(80); }
  const r = await page(`const w = await import('/lib/world.js'); const h = globalThis.__hs; h.f.querySelectorAll('[data-id]').forEach((e) => h.seen.add(e.dataset.id));
    const all = [...w.entities.keys()]; return { seen: h.seen.size, missing: all.filter((id) => !h.seen.has(id)), top: h.sc.scrollTop, sample: [...h.f.querySelectorAll('[data-id]')].slice(0, 2).map((e) => e.outerHTML.slice(0, 160)) };`);
  console.log(JSON.stringify(r, null, 1));
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 520, height: 900, scale: 1 } }); fs.writeFileSync(`${OUT}/hier.png`, Buffer.from(s.data, "base64"));
} finally { await cleanup(); }
