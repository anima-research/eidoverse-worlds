// LAB: the ONE status bar (DESIGN-status-bar.md): selection line claims it, a refusal outranks it, the pill yields and returns
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = "/home/claude/eido/scratch-worlds/garden";
const { evalJson, cleanup, BASE } = await scratchBench("statusbar", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { try { ${js} } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; } })()`);
try {
  await evalJson(`(location.href = ${JSON.stringify(`${BASE}/?name=Marigold&world=gym`)}, true)`).catch(() => {});
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(3000);
  const r = await page(`
    const ui = await import('/lib/ui.js'); const b = await import('/lib/build.js');
    const bar = () => { const h = document.getElementById('hintbar'), p = document.getElementById('lantern-pill'); return { gone: h.classList.contains('gone'), attn: h.classList.contains('attn'), node: h.classList.contains('has-node'), sel: !!h.querySelector('.edit-selbar'), lock: !!h.querySelector('[data-bact="lock"]'), text: h.textContent.slice(0, 60), pillYield: !!p?.classList.contains('yield'), shown: ui.statusShown(), bars: document.querySelectorAll('.edit-selbar').length }; };
    const s0 = bar();
    b.setEditMode(true); await new Promise((z) => setTimeout(z, 3200)); b.select('tower-2'); await new Promise((z) => setTimeout(z, 600));   // past the 'builder mode' flash (priority 3 outranks the selection, by design)
    const s1 = bar();
    ui.flashHint("couldn't get to tower-2: something is in the way", 1200, 'attn'); await new Promise((z) => setTimeout(z, 200));
    const s2 = bar();
    await new Promise((z) => setTimeout(z, 1500));
    const s3 = bar();
    b.deselect(); await new Promise((z) => setTimeout(z, 400));
    const s4 = bar();
    return { s0, s1, s2, s3, s4 };`);
  console.log("RESULT", JSON.stringify(r));
  const ok = r.s1?.node && r.s1.sel && r.s1.lock && r.s1.pillYield && r.s1.shown === 'selection' && r.s2?.attn && /in the way/.test(r.s2.text) && r.s2.shown === 'flash' && r.s3?.shown === 'selection' && r.s3.sel && !r.s3.attn && r.s4?.gone && !r.s4.pillYield && r.s3.bars === 1;
  console.log(ok ? "SB1 ok: one bar — selection claims it, a refusal outranks and hands back, the pill yields and returns" : "SB1 FAIL");
} finally { await cleanup(); }
