// LAB (not in the suite): R's gym, copied: scroll the Hierarchy partway, click a row's eye twice, read the scroll each
// time. R, 10-11 01:00: "if I click on the eye icons in the hierarchy, the scroll jumps up and if I click it again the
// scroll jumps down".   WORLDS_SRC=<dir> bun tools/protocol/gym-eye.lab.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = process.env.WORLDS_SRC; if (!SRC) { console.error("set WORLDS_SRC"); process.exit(2); }
const { cdp, evalJson, cleanup, BASE } = await scratchBench("gymeye", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 820, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=Riannon&world=gym` }); await sleep(1500);
  if (process.env.COMPS) { await evalJson(`(localStorage.setItem('ew.hierarchy.view', JSON.stringify({ comps: true })), localStorage.setItem('ew.hierarchy.opencomps', JSON.stringify(['desk', 'desk-crate-1', 'desk-crate-0', 'domino-3', 'free-crate'])), true)`); await cdp.send("Page.reload", {}); }
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(5000);
  await page(`(await import('/lib/build.js')).setEditMode(true); return true;`); await sleep(1500);
  await page(`const t = [...document.querySelectorAll('button, [role=tab], .edit-tab')].find((b) => b.textContent.trim() === 'Hierarchy'); t?.click(); return !!t;`); await sleep(800);
  const sc = `(() => { const f = document.querySelector('[data-frame="hierarchy"]'); return [f.querySelector('.sp-tree'), f.querySelector('.schema-scroll')].find((e) => e && e.scrollHeight > e.clientHeight + 4); })()`;
  await evalJson(`(${sc}.scrollTop = 400, true)`); await sleep(600);
  const rowAt = await evalJson(`(() => { const s = ${sc}; const sb = s.getBoundingClientRect(); const r = [...s.querySelectorAll('.sp-tree-row[data-id]')].find((e) => { const b = e.getBoundingClientRect(); return b.top > sb.top + 100 && b.bottom < sb.bottom - 20 && !e.dataset.id.startsWith('comp:'); });
    const eye = r?.querySelector('.sp-eye'); if (!eye) return null; eye.style.visibility = 'visible'; const b = eye.getBoundingClientRect(); return { id: r.dataset.id, x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  const read = () => evalJson(`(() => { const s = ${sc}; return { top: s.scrollTop, h: s.scrollHeight, active: document.activeElement?.className ?? null }; })()`);
  const out = [{ before: await read(), row: rowAt, rowTop0: await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="${rowAt.id}"]'); return Math.round(r.getBoundingClientRect().top); })()`) }];
  for (let k = 0; k < 2; k++) {
    const rowBox = await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="${rowAt.id}"]'); const b = r.getBoundingClientRect(); return [b.left + 40, b.top + b.height / 2]; })()`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(rowBox[0]), y: Math.round(rowBox[1]) }); await sleep(250);
    const eb = await evalJson(`(() => { const e = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="${rowAt.id}"] .sp-eye'); const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, getComputedStyle(e).visibility]; })()`);
    rowAt.x = eb[0]; rowAt.y = eb[1];
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(rowAt.x), y: Math.round(rowAt.y) }); await sleep(150);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(rowAt.x), y: Math.round(rowAt.y), button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(rowAt.x), y: Math.round(rowAt.y), button: "left", buttons: 0, clickCount: 1 });
    const trace = []; for (let i = 0; i < 8; i++) { await sleep(100); trace.push((await read()).top); } out.push({ click: k + 1, rowTop: await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="${rowAt.id}"]'); return Math.round(r.getBoundingClientRect().top); })()`), row: await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"] .sp-tree-row[data-id="${rowAt.id}"]'); return { h: Math.round(r.getBoundingClientRect().height), html: r.innerText.slice(0, 120), kids: [...r.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 22).map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().height)).slice(0, 6) }; })()`), hidden: await evalJson(`import('/lib/myview.js').then((m) => m.isMineHidden('${rowAt.id}'))`).catch((e) => String(e)), trace, after: await read() });
  }
  console.log(JSON.stringify(out));
} finally { await cleanup(0); }
process.exit(0);
