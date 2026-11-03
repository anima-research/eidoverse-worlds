// xr-panel-drag-probe — a trigger on EMPTY panel space is a press: drag it and the panel scrolls with the laser, release
// without dragging and it clicks; a checkbox too clicks on release (a drag started on it scrolls, review P2). The owner
// couldn't scroll the debug panel in a headset (09-27): the stick scrolled only while a button held the laser up.
// Real client + IWER; the rays go through the same domQuadsPress/Drag/Release path xr.js drives from the trigger.
//   bun tools/xr-panel-drag-probe.mjs
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
  await pg.goto(`${world.origin}/?world=staging&name=dragprobe&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 });
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(async () => {
    const dq = await import('./lib/domquad.js'); const THREE = await import('three');
    dq.domQuadsSetShown(true); await new Promise((res) => setTimeout(res, 1500));
    const meshOf = (id) => { const tex = dq.domQuadTexture(id); let m = null; globalThis.EW.scene.traverse((o) => { if (tex && o.material?.map === tex) m = o; }); return m; };
    // a laser aimed at DOM point (px, py) of quad `id` (CSS px from the frame's top-left)
    const rayAt = (id, px, py) => {
      const mesh = meshOf(id), fr = dq.domQuadTexture(id).dom.getBoundingClientRect();
      const u = px / fr.width, v = py / fr.height;
      const { width: W, height: H } = mesh.geometry.parameters;
      mesh.updateMatrixWorld(true);
      const p = mesh.localToWorld(new THREE.Vector3((u - 0.5) * W, (0.5 - v) * H, 0));
      const q = new THREE.Quaternion(); mesh.getWorldQuaternion(q);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      return { matrixWorld: new THREE.Matrix4().compose(p.clone().addScaledVector(n, 0.5), q, new THREE.Vector3(1, 1, 1)) };
    };
    // the first quad with a scrollable box that has room to scroll
    let id = null, box = null;
    for (const qid of dq.domQuadIds()) {
      const dom = dq.domQuadTexture(qid)?.dom; if (!dom) continue;
      const cands = [dom, ...dom.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.getBoundingClientRect().height > 60);
      if (cands.length) { id = qid; box = cands[0]; break; }
    }
    if (!box) return { none: dq.domQuadIds() };
    // only the panel under test: shown together, the quads overlap in this layout and the front one rightly takes the ray
    for (const q of dq.domQuadIds()) if (q !== id) dq.domQuadShow(q, false);
    dq.domQuadShow(id, true); await new Promise((res) => setTimeout(res, 300));
    const dom = dq.domQuadTexture(id).dom, fr = dom.getBoundingClientRect(), br = box.getBoundingClientRect();
    // an empty spot inside the box: walk a column until elementAt lands on a non-interactive element
    const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role=button],[role=checkbox],[role=slider],[onclick]';
    const tex = dq.domQuadTexture(id);
    let spot = null;
    for (let y = br.top + br.height * 0.3; y < br.bottom - 10 && !spot; y += 6)
      for (let x = br.left + 8; x < br.right - 8; x += 12) {
        const el = tex.elementAt((x - fr.left) / fr.width, (y - fr.top) / fr.height);
        if (el && box.contains(el) && !el.closest(INTERACTIVE)) { spot = { x: x - fr.left, y: y - fr.top }; break; }
      }
    if (!spot) return { nospot: id };
    const dbg = { boxIsDom: box === dom, boxTag: box.tagName + '.' + box.className, st0: box.scrollTop };
    { const u = spot.x / fr.width, v = spot.y / fr.height; const el = tex.elementAt(u, v); dbg.el = el?.tagName + '.' + el?.className;
      const got = tex.scrollAt(u, v, 50); dbg.scrollAtReturned = got ? got.tagName + '.' + got.className : null; dbg.st1 = box.scrollTop; box.scrollTop = 0;
      dbg.meshParent = !!meshOf(id).parent; dbg.domParent = dom.parentElement?.tagName; }
    globalThis.__dbg = dbg;
    let clicks = 0; const onClick = () => clicks++; dom.addEventListener('click', onClick, true);
    // 1. press on empty space, drag the laser UP 60 px in 6 steps: the box scrolls DOWN about that much, and no click
    box.scrollTop = 0; const s0 = box.scrollTop;
    { const m = meshOf(id); const rc = new THREE.Raycaster(); const ray = rayAt(id, spot.x, spot.y);
      rc.ray.origin.setFromMatrixPosition(ray.matrixWorld); rc.ray.direction.set(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(ray.matrixWorld));
      globalThis.__dbg.vis = m?.visible; globalThis.__dbg.inScene = !!m?.parent; globalThis.__dbg.rawHit = rc.intersectObject(m, false).length;
      globalThis.__dbg.visibleIds = dq.domQuadIds().filter((q) => meshOf(q)?.visible); }
    const pr = dq.domQuadsPress(rayAt(id, spot.x, spot.y));
    globalThis.__dbg.pressMeshIsTarget = pr?.press?.mesh === meshOf(id);
    globalThis.__dbg.pressQuad = dq.domQuadIds().find((q) => meshOf(q) === pr?.press?.mesh);
    globalThis.__dbg.pressData = pr?.press?.data;
    if (!pr?.press) { const u = spot.x / fr.width, v = spot.y / fr.height, el = tex.elementAt(u, v);
      return { dbg: { ...globalThis.__dbg, pr: pr && { dist: pr.dist }, spotEl: el && (el.tagName + '.' + el.className + ' ' + (el.textContent || '').slice(0, 30)),
        frNow: dq.domQuadTexture(id).dom.getBoundingClientRect().height, frThen: fr.height } }; }
    for (let i = 1; i <= 6; i++) dq.domQuadsDrag(rayAt(id, spot.x, spot.y - i * 10), pr.press);
    dq.domQuadsRelease(pr.press);
    const s1 = box.scrollTop, clicksAfterDrag = clicks;
    // 2. a tap (press + release, no movement) on the same spot: a click, no scroll (scrolled back first: the drag moved
    // other content under the spot)
    box.scrollTop = 0; await new Promise((res) => setTimeout(res, 50));
    const sTap = box.scrollTop;
    const pr2 = dq.domQuadsPress(rayAt(id, spot.x, spot.y));
    // hand tremor: 30 frames wandering ±6 px around the press point (summed per frame that's ~180 px of travel)
    for (let i = 0; i < 30; i++) dq.domQuadsDrag(rayAt(id, spot.x, spot.y + (i % 2 ? 6 : -6)), pr2.press);
    dq.domQuadsRelease(pr2.press);
    const s2 = box.scrollTop - sTap, clicksAfterTap = clicks;
    // 3. a grab that takes over a press cancels it: no click
    box.scrollTop = 0; await new Promise((res) => setTimeout(res, 50));
    const pr3 = dq.domQuadsPress(rayAt(id, spot.x, spot.y));
    dq.domQuadsRelease(pr3.press, true);
    const clicksAfterCancel = clicks;
    dom.removeEventListener('click', onClick, true);
    // 4. a checkbox is a press like anything else (review P2): it toggles on RELEASE, exactly once, and a drag that
    //    starts on it scrolls instead of toggling (the debug panel is mostly checkbox rows)
    let cbMoved = null, cb = null, cbFlip = null, cbPress = 'n/a', cbEarly = null, cbDragFlip = null, cbDragging = null;
    for (const qid of dq.domQuadIds()) { const d = dq.domQuadTexture(qid)?.dom; const c = [...(d?.querySelectorAll('input[type=checkbox]') ?? [])].find((e) => e.getBoundingClientRect().height > 0); if (c) { cb = { qid, c }; break; } }
    if (cb) {
      for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === cb.qid); await new Promise((res) => setTimeout(res, 300));
      const f = dq.domQuadTexture(cb.qid).dom.getBoundingClientRect(), r = cb.c.getBoundingClientRect(), was = cb.c.checked;
      const cx = r.left + r.width / 2 - f.left, cy = r.top + r.height / 2 - f.top;
      const p4 = dq.domQuadsPress(rayAt(cb.qid, cx, cy));
      await new Promise((res) => setTimeout(res, 100));
      cbEarly = cb.c.checked !== was; cbPress = p4?.press ?? null;
      if (p4?.press) dq.domQuadsRelease(p4.press);
      await new Promise((res) => setTimeout(res, 200));
      cbFlip = cb.c.checked !== was;
      if (cbFlip) cb.c.click();
      const was2 = cb.c.checked;
      const p5 = dq.domQuadsPress(rayAt(cb.qid, cx, cy));
      if (p5?.press) for (let i = 1; i <= 6; i++) dq.domQuadsDrag(rayAt(cb.qid, cx, cy - i * 10), p5.press);
      cbDragging = !!p5?.press?.dragging;
      if (p5?.press) dq.domQuadsRelease(p5.press);
      await new Promise((res) => setTimeout(res, 200));
      cbDragFlip = cb.c.checked !== was2;
      if (cbDragFlip) cb.c.click();
      // content that moves under a held press (a chat line arriving) must not turn the release into a click on
      // whatever is there now (Greptile #206): press the checkbox, shift it 60 px down, release: no click anywhere
      const d6 = dq.domQuadTexture(cb.qid).dom; let moved = 0; const onMoved = () => moved++;
      d6.addEventListener('click', onMoved, true);
      const was3 = cb.c.checked, p6 = dq.domQuadsPress(rayAt(cb.qid, cx, cy));
      const mv = p6?.press?.el ?? cb.c;   // move what the press actually hit, not what we aimed at
      const keepPos = mv.style.position, keepTop = mv.style.top;
      mv.style.position = 'relative'; mv.style.top = '60px';
      const nowEl = p6?.press ? dq.domQuadTexture(cb.qid).elementAt?.(p6.press.data.x, p6.press.data.y) : null;
      if (p6?.press) dq.domQuadsRelease(p6.press);
      await new Promise((res) => setTimeout(res, 200));
      mv.style.position = keepPos; mv.style.top = keepTop;
      d6.removeEventListener('click', onMoved, true);
      const tagOf = (e) => e ? e.tagName + '.' + (e.className || '') : null;
      cbMoved = { pressed: !!p6?.press, clicks: moved, flipped: cb.c.checked !== was3, pressedEl: tagOf(p6?.press?.el), nowEl: tagOf(nowEl), same: nowEl === p6?.press?.el };
      if (cbMoved.flipped) cb.c.click();
    }
    // rounded corners: the raster leaves a frame's border-radius corners clear, and the material cuts them out
    let corner = null;
    { const t = dq.domQuadTexture(id), c = t.image; try { corner = { a: c.getContext('2d').getImageData(1, 1, 1, 1).data[3], test: meshOf(id).material.alphaTest, radius: getComputedStyle(t.dom).borderTopLeftRadius }; } catch (e) { corner = { err: String(e) }; } }
    return { corner, dbg: globalThis.__dbg, id, spot, s0, s1, s2, clicksAfterDrag, clicksAfterTap, clicksAfterCancel, cbMoved, cb: !!cb, cbFlip, cbEarly, cbPending: cbPress !== null && cbPress !== 'n/a', cbDragFlip, cbDragging, dragging: pr.press?.dragging };
  });
  console.log('  ·', JSON.stringify(r));
  check('a VR panel has a scrollable box to test', !r.none && !r.nospot, JSON.stringify(r));
  check('trigger-drag on empty space scrolls the box with the laser (≈50 px for a 60 px drag, after the 8 px threshold)', r.s1 - r.s0 >= 40 && r.s1 - r.s0 <= 70, `${r.s0} → ${r.s1}`);
  check('…and that drag is not a click', r.clicksAfterDrag === 0, r.clicksAfterDrag);
  check('a tap (jitter under the threshold) is a click, and does not scroll', r.clicksAfterTap === 1 && r.s2 === 0, JSON.stringify({ clicks: r.clicksAfterTap, moved: r.s2 }));
  check('a grab that takes over a press cancels its click', r.clicksAfterCancel === 1, r.clicksAfterCancel);
  check('a trigger on a checkbox toggles it on release, exactly once (not on the press)', r.cb && r.cbEarly === false && r.cbPending && r.cbFlip === true, JSON.stringify({ cb: r.cb, early: r.cbEarly, pending: r.cbPending, flip: r.cbFlip }));
  check('a drag that starts on a checkbox scrolls and never toggles it', r.cb && r.cbDragging && r.cbDragFlip === false, JSON.stringify({ dragging: r.cbDragging, flipped: r.cbDragFlip }));
  check('content moving under a held press cancels the click (the release lands on what was pressed, or nothing)', r.cbMoved?.pressed && r.cbMoved.clicks === 0 && !r.cbMoved.flipped, JSON.stringify(r.cbMoved));
  check('rounded corners: the corner texel is clear and the material cuts it out (not black)', r.corner?.a === 0 && r.corner?.test > 0, JSON.stringify(r.corner));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
