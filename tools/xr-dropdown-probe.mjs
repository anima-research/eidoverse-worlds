// xr-dropdown-probe — a house dropdown in a VR panel opens INSIDE the quad and a trigger picks an option.
// The list used to be appended to <body>, outside the staged frame HTMLMesh rasterises: the click landed and
// nothing appeared (a headset session, 2026-09-26). Real client + IWER; the clicks go through domQuadsPick, the
// same laser path the trigger uses. Empty world (no sky: headless draws on the CPU).
//   bun tools/xr-dropdown-probe.mjs
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';
const { check, done } = checker();
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await pg.addInitScript(IWER);
await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
  window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=ddprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(async () => {
    const dq = await import('./lib/domquad.js'); const THREE = await import('three');
    dq.domQuadsSetShown(true); await new Promise((res) => setTimeout(res, 1500));
    // aim a laser at a DOM point inside quad `id`, pull the trigger: the real pick → mousedown/up/click path
    const meshOf = (id) => { const tex = dq.domQuadTexture(id); let m = null; globalThis.EW.scene.traverse((o) => { if (tex && o.material?.map === tex) m = o; }); return m; };
    const pull = (id, el) => {
      const mesh = meshOf(id), dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect(), er = el.getBoundingClientRect();
      const u = (er.left + er.width / 2 - fr.left) / fr.width, v = (er.top + er.height / 2 - fr.top) / fr.height;
      const { width: W, height: H } = mesh.geometry.parameters;
      mesh.updateMatrixWorld(true);
      const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
      const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      const ray = { matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) };
      return dq.domQuadsPick(ray, true);
    };
    // open the world panel's sky section the way a person does (a trigger on its heading), then find its dropdown
    const wdom = dq.domQuadTexture('world')?.dom;
    const skyHead = [...(wdom?.querySelectorAll('button.head') ?? [])].find((b) => /sky/i.test(b.textContent));
    if (skyHead) { pull('world', skyHead); await new Promise((res) => setTimeout(res, 800)); }
    let id = null, btn = null;
    for (const qid of dq.domQuadIds()) { const dom = dq.domQuadTexture(qid)?.dom; const b = dom?.querySelector('button.dd:not([disabled])'); if (b && b.getBoundingClientRect().height > 0) { id = qid; btn = b; break; } }
    if (!btn) return { none: dq.domQuadIds() };
    const sel = btn.previousElementSibling; const before = sel.value;
    const hit1 = pull(id, btn);
    await new Promise((res) => setTimeout(res, 300));
    const dom = dq.domQuadTexture(id).dom, pop = document.querySelector('.dd-pop');
    const inQuad = !!pop && dom.contains(pop);
    const pr = pop?.getBoundingClientRect(), fr = dom.getBoundingClientRect();
    const inside = !!pr && pr.top >= fr.top - 1 && pr.bottom <= fr.bottom + 1 && pr.left >= fr.left - 1 && pr.right <= fr.right + 1;
    const target = [...(pop?.querySelectorAll('.dd-opt:not(.on):not([disabled])') ?? [])][0];
    const hit2 = target ? pull(id, target) : null;
    await new Promise((res) => setTimeout(res, 300));
    // the same pick path on a checkbox: exactly ONE toggle (the old every-element walk could hit label AND input)
    const ddom = dq.domQuadTexture('debug')?.dom;
    const cb = [...(ddom?.querySelectorAll('input[type=checkbox]') ?? [])].find((c) => c.getBoundingClientRect().height > 0);
    let cbFlip = null;
    if (cb) { const was = cb.checked; pull('debug', cb); await new Promise((res) => setTimeout(res, 200)); cbFlip = cb.checked !== was; if (cbFlip) cb.click(); }
    const box = (q) => q && [q.left, q.top, q.right, q.bottom].map(Math.round);
    const boxes = { pop: box(pr), frame: box(fr), btn: box(btn.getBoundingClientRect()) };
    return { boxes, id, hit1, inQuad, inside, hit2, before, after: sel.value, want: target?.textContent, closed: !document.querySelector('.dd-pop'), cb: !!cb, cbFlip };
  });
  console.log('  ·', JSON.stringify(r));
  check('a VR panel has a house dropdown to test', !r.none, JSON.stringify(r.none));
  check('the trigger on the dropdown opens its list INSIDE the quad (drawn with the panel)', r.hit1 != null && r.inQuad, JSON.stringify(r));
  check('…within the panel\'s bounds (nothing clipped off the texture)', r.inside);
  check('a trigger on an option row picks it', r.hit2 != null && r.after !== r.before, `${r.before} → ${r.after} (wanted ${r.want})`);
  check('…and the list closes', r.closed);
  check('a trigger on a checkbox toggles it exactly once', r.cb && r.cbFlip === true, JSON.stringify({ cb: r.cb, cbFlip: r.cbFlip }));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
