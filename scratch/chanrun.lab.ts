// LAB: the channel box's run scrubs together, and the run can be made from the value boxes (R 10-11 23:13)
// @ts-nocheck
import fs from "node:fs"; import path from "node:path";
import { scratchBench, sleep } from "../tools/harness.ts";
process.env.TRUST_NAMES = "1";
const SRC = "/home/claude/eido/scratch-worlds/garden";
const { evalJson, cleanup, BASE } = await scratchBench("chanrun", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) fs.copyFileSync(path.join(SRC, f), path.join(w, f)); fs.cpSync(path.join(SRC, "gym"), path.join(w, "gym"), { recursive: true }); } });
const page = (js) => evalJson(`(async () => { try { ${js} } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; } })()`);
try {
  await evalJson(`(location.href = ${JSON.stringify(`${BASE}/?name=Marigold&world=gym`)}, true)`).catch(() => {});
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(4000);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 600)); (await import('/lib/scenegraph.js')).sceneSelect('tower-2'); return true;`);
  await sleep(1500);
  const r = await page(`
    const f = document.querySelector('[data-frame="inspector"]'); const rows = [...f.querySelectorAll('.sp-row')];
    const row = (n) => rows.find((r) => r.querySelector('.sp-label')?.textContent.trim() === n);
    const [rx, ry, rz] = ['translate x', 'translate y', 'translate z'].map(row); if (!rx || !ry || !rz) return { err: 'rows', have: rows.map((r) => r.querySelector('.sp-label')?.textContent.trim()).slice(0, 12) };
    const C = (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
    const pe = (el, type, x, y, extra = {}) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra }));
    const val = (r) => +r.querySelector('.sp-num').value;
    window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message).slice(0, 160)));
    const before = [rx, ry, rz].map(val);
    // 1. click the name of x, then Shift-click the VALUE BOX of z: the run x..z
    { const l = rx.querySelector('.sp-label'); const [x, y] = C(l); pe(l, 'pointerdown', x, y); pe(l, 'pointerup', x, y); }
    { const n = rz.querySelector('.sp-num'); const [x, y] = C(n); pe(n, 'pointerdown', x, y, { shiftKey: true }); pe(n, 'pointerup', x, y, { shiftKey: true }); }
    const sel1 = [rx, ry, rz].map((r) => r.classList.contains('chan-sel'));
    const dbg = { st: [rx, ry, rz].map((r) => !!r._st), peerApi: !!rx._st?.peer, peersN: rx._st?.peers?.()?.length, numBound: !!rx._st?.num, sameNum: rx._st?.num === rx.querySelector('.sp-num') };
    const lab = getComputedStyle(rx.querySelector('.sp-label')); const style = { shadow: lab.boxShadow, bg: lab.backgroundColor, pad: lab.padding };
    const peerTry = (() => { try { const v0 = val(ry); ry._st.peer.to(v0 + 1, true); const v1 = val(ry); ry._st.peer.restore(v0); return [v0, v1, val(ry)]; } catch (e) { return 'ERR ' + String(e?.stack ?? e).slice(0, 300); } })();
    window.__to = []; for (const r of [ry, rz]) { const o = r._st.peer.to; r._st.peer.to = (f, l) => { window.__to.push([f, l, r === ry ? 'y' : 'z', document.contains(r)]); return o(f, l); }; }
    const geo = { win: [innerWidth, innerHeight], insp: (() => { const b = document.querySelector('[data-frame="inspector"]').getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round); })(), ry: C(ry.querySelector('.sp-num')).map(Math.round) };
    let calls = 0; const orig = rx._st.peers; rx._st.peers = () => { calls++; const r = orig(); window.__peersLen = r.length; return r; };
    const efp = (() => { const n = ry.querySelector('.sp-num'); const [x, y] = C(n); const [, yz] = C(rz); return [x, y + 8, yz].concat([document.elementFromPoint(x, y + 8), document.elementFromPoint(x, yz)].map((e) => e ? e.tagName + '#' + e.id + '.' + e.className : null)); })();
    // 2. scrub x's value box sideways: every selected channel follows
    { const n = rx.querySelector('.sp-num'); const [x, y] = C(n); pe(n, 'pointerdown', x, y); for (let i = 1; i <= 8; i++) pe(n, 'pointermove', x + i * 10, y); pe(n, 'pointerup', x + 80, y); }
    await new Promise((z) => setTimeout(z, 300));
    const after = [rx, ry, rz].map(val); const d = after.map((v, i) => +(v - before[i]).toFixed(3));
    document.getElementById('splash')?.remove();   // the lab's door overlay lingers over the panel; a real session has none
    // 3. a vertical drag from y's VALUE BOX down to z selects just y..z (and scrubs nothing)
    for (const r of rows) r.classList.remove('chan-sel');
    { const n = ry.querySelector('.sp-num'); const [x, y] = C(n); const [, yz] = C(rz); pe(n, 'pointerdown', x, y); pe(n, 'pointermove', x, y + 8); pe(n, 'pointermove', x, yz); pe(n, 'pointerup', x, yz); }
    await new Promise((z) => setTimeout(z, 50));
    const sel2 = [rx, ry, rz].map((r) => r.classList.contains('chan-sel')); const after2 = [rx, ry, rz].map(val);
    return { before, sel1, dbg, to: window.__to.slice(0, 4), toN: window.__to.length, geo, attached: [rx, ry, rz].map((r) => document.contains(r)), peerTry, calls, peersLen: window.__peersLen, efp, errs: window.__errs, style, after, d, sel2, moved2: after2.map((v, i) => +(v - after[i]).toFixed(3)), ranged: !!ry.querySelector('.sp-num')._ranged };`);
  console.log("RESULT", JSON.stringify(r));
  const pill = await page(`(await import('/lib/scenegraph.js')).sceneSelect('tray-corn-0'); await new Promise((z) => setTimeout(z, 1200));
    const f = document.querySelector('[data-frame="inspector"]'); const heads = [...f.querySelectorAll('.sp-row.sp-group, .sp-group')].map((g) => g.firstElementChild?.outerHTML ?? g.outerHTML).filter((h) => /draft|aterial/i.test(h)).map((h) => h.slice(0, 300));
    const pills = [...f.querySelectorAll('.sp-pill')].map((p) => ({ cls: p.className, text: p.textContent, bg: getComputedStyle(p).backgroundColor, disp: getComputedStyle(p).display }));
    return { heads, pills };`);
  console.log("PILL", JSON.stringify(pill));
  const ok = r.sel1?.every(Boolean) && r.d && Math.abs(r.d[0]) > 0.01 && Math.abs(r.d[1] - r.d[0]) < 1e-6 && Math.abs(r.d[2] - r.d[0]) < 1e-6 && r.sel2?.join() === "false,true,true" && r.moved2?.every((m) => m === 0) && r.style?.shadow === "none";
  console.log(ok ? "CR1 ok: run from the value box, scrubbed together, vertical drag on a box selects, no outline" : "CR1 FAIL");
} finally { await cleanup(); }
