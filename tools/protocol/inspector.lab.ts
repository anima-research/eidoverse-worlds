// LAB: the Inspector on a spinning thing, rendered and measured (R 10-10 18:37 notes).
// @ts-nocheck
import { scratchBench, sleep } from "../harness.ts";
import path from "node:path"; import fs from "node:fs";
process.env.TRUST_NAMES = "1";
const OUT = process.env.SHOT_DIR ?? "/home/claude/eido/logs/insp-shots"; fs.mkdirSync(OUT, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { cdp, evalJson, cleanup, BASE } = await scratchBench("inspector", { prepare: (scratch) => { const w = path.join(scratch, "worlds"); fs.mkdirSync(w, { recursive: true });
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "insp", "--owner", "owner", "--title", "inspector look"], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: w, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }); if (r.exitCode) throw new Error(r.stderr.toString()); } });
const page = (js) => evalJson(`(async () => { ${js} })()`);
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/?name=owner&world=insp&webgl=1` });
  for (let i = 0; i < 160; i++) { if (((await evalJson(`document.querySelectorAll('.sec').length`).catch(() => 0)) ?? 0) >= 4) break; await sleep(500); }
  for (let i = 0; i < 60; i++) { if (await evalJson(`import('/lib/net.js').then((m) => m.replicaActive())`).catch(() => false)) break; await sleep(300); }
  await sleep(3000);
  await page(`const m = await import('/lib/net.js'); const r = await m.sendRequest('create', { id: 'pallet-spin', model: 'eidoverse/assets/models/crate_large_blue.glb', components: { label: 'spinning pallet', physics: { kind: 'dynamic' }, transform: { pos: [2, 0, 2], q: [0,0,0,1], scale: [1,1,1] } } });
    await m.sendRequest('set', { id: 'pallet-spin', component: 'motion', value: { type: 'spin', axis: [0, 1, 0], degPerSec: 45 } }); await m.sendRequest('set', { id: 'pallet-spin', component: 'hesperus/material', value: { color: 0xff6633, roughness: 0.3 } }); return r.ok;`);
  await sleep(1500);
  await page(`(await import('/lib/build.js')).setEditMode(true); await new Promise((z) => setTimeout(z, 600)); (await import('/lib/scenegraph.js')).sceneSelect('pallet-spin'); return true;`);
  await sleep(1500);
  const m = await page(`const f = document.querySelector('[data-frame="inspector"]'); const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; };
    const rows = [...f.querySelectorAll('.sp-row')].slice(0, 60).map((r) => { const l = r.querySelector('.sp-label'); const c = l?.nextElementSibling; return { t: (l?.textContent ?? '').trim().slice(0, 18), label: l ? R(l) : null, ctl: c ? [c.className.split(' ')[0], ...R(c)] : null }; });
    const groups = [...f.querySelectorAll('.sp-group')].map((g) => g.textContent.trim().slice(0, 30));
    const eye = f.querySelector('.sp-bar')?.textContent?.trim() ?? null; const hasHidden = [...f.querySelectorAll('.sp-label')].some((l) => l.textContent.trim() === 'hidden');
    const order = [...f.querySelectorAll('.sp-group, .sp-bar')].map((e) => e.classList.contains('sp-bar') ? '[' + e.textContent.trim().slice(0, 18) + ']' : e.textContent.trim().slice(0, 16)); return { frame: R(f), groups, order, rows, eye, hasHidden };`);
  fs.writeFileSync(`${OUT}/rows.json`, JSON.stringify(m, null, 1));
  if (process.env.SCROLL_END) { await evalJson(`(() => { const s = document.querySelector('[data-frame="inspector"] .schema-scroll'); s.scrollTop = s.scrollHeight; return true; })()`); await sleep(300); }
  const b = await evalJson(`(() => { const r = document.querySelector('[data-frame="inspector"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
  const s = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: b[0], y: b[1], width: b[2], height: Math.min(b[3], 1000 - b[1]), scale: 1 } }); fs.writeFileSync(`${OUT}/inspector.png`, Buffer.from(s.data, "base64"));
  const ed = await page(`const I = await import('/lib/inspect.js'); const out = {};
    for (const [k, v] of [['physics.friction', '0.25'], ['physics.restitution', '0.8'], ['physics.mass', ''], ['physics.restitution', '2'], ['physics.kind', 'static']]) { const r = I.commitEdit('pallet-spin', k, v); out[k + '=' + v] = r?.errors?.length ? r.errors.join('; ') : 'ok'; await new Promise((z) => setTimeout(z, 900)); }
    const w = await import('/lib/world.js'); out.after = w.bagOf('pallet-spin')?.physics; return out;`);
  console.log("EDITS", JSON.stringify(ed));
  await page(`const t = [...document.querySelectorAll('button, [role=tab]')].find((b) => b.textContent.trim() === 'Hierarchy'); t?.click(); return true;`); await sleep(700);
  { const r3 = await evalJson(`(() => { const r = document.querySelector('[data-frame="hierarchy"]').getBoundingClientRect(); return [r.left, r.top, r.width, Math.min(r.height, 300)]; })()`);
    const s3 = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: r3[0], y: r3[1], width: Math.max(1, r3[2]), height: Math.max(1, r3[3]), scale: 1 } }); fs.writeFileSync(`${OUT}/hierarchy.png`, Buffer.from(s3.data, "base64"));
    console.log("HROW", JSON.stringify(await evalJson(`(() => { const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width)]; }; const row = document.querySelector('[data-frame="hierarchy"] [data-id="pallet-spin"]');
      return { frame: R(document.querySelector('[data-frame="hierarchy"]')), tree: R(row?.parentElement), row: R(row), kids: [...(row?.children ?? [])].map((k) => [k.className, ...R(k)]) }; })()`)));
    console.log("HEYE", JSON.stringify(await evalJson(`(() => { const e = document.querySelector('[data-frame="hierarchy"] .sp-eye'); return e ? { svg: !!e.querySelector('svg'), shown: getComputedStyle(e).display, opacity: getComputedStyle(e).opacity } : null; })()`))); }
  await page(`(await import('/lib/base.js')).bus.emit('edit-righttab', 'attributes'); return true;`); await sleep(900);
  { const b2 = await evalJson(`(() => { const r = document.querySelector('[data-frame="attributes"]').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
    const s2 = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: b2[0], y: b2[1], width: Math.max(1, b2[2]), height: Math.max(1, Math.min(b2[3], 1000 - b2[1])), scale: 1 } }); fs.writeFileSync(`${OUT}/attributes.png`, Buffer.from(s2.data, "base64"));
    const at = await page(`const f = document.querySelector('[data-frame="attributes"]'); return { rows: [...f.querySelectorAll('.sp-label')].map((l) => l.textContent.trim()).slice(0, 20), insp: getComputedStyle(document.querySelector('[data-frame="inspector"]')).display };`);
    console.log("ATTR", JSON.stringify(at)); }
  await page(`(await import('/lib/base.js')).bus.emit('edit-righttab', 'inspector'); return true;`); await sleep(600);
  console.log("groups", JSON.stringify(m.groups)); console.log("order", JSON.stringify(m.order)); console.log("EYE", JSON.stringify({ eye: m.eye, hiddenCheckbox: m.hasHidden }));
} finally { await cleanup(); }
