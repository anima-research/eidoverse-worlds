// xr-pointer-aids-probe — the second VR pointer pass (owner, 10-02): ONE dwell (per hand, keyed on what the laser
// holds, honouring stickiness) that the nameplate card, VR tooltips and panel handles share; tooltips in VR panels;
// handles and resizers revealed on dwell, grip on a corner/edge resizing and committing the frame's layout; the dot as
// a contextual icon; stick push/pull on the hand holding a panel. The real client under IWER, the emulated controllers
// posed, pressed and pushed; the product's own per-hand loop does the rest (the xr-pointer probe's setup, copied).
//
//   bash code/scripts/eido-probe.sh -C <worktree> -t 900 tools/xr-pointer-aids-probe.mjs      (one Chrome at a time)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
const WORLD = 'aids';
// IWER, its device loop on a NATIVE rAF (memory: reference_iwer_headless_probe.md §2; the xr-plate-card probe's patch)
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(LOOP).length !== 2) throw new Error('IWER loop pattern did not match exactly once: the patch would silently not apply');
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
let browser = null;
const peers = [];
const errs = [], conErrs = [];
const ev = (pg, fn, arg, ms = 30000) => Promise.race([pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out after ${ms} ms`)), ms))]);
function peer(id, pose) {
  const ws = new WebSocket(`${world.origin.replace(/^http/, 'ws')}/ws`);
  const p = { ws, pose, timer: null };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', world: WORLD, id, token: world.key }));
    p.timer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pose', pose: p.pose })); }, 66);
  };
  peers.push(p);
  return p;
}
const J = (x) => JSON.stringify(x);

try {
  const L = await launchBrowser(); browser = L.browser;
  const pg = await L.page();
  await pg.addInitScript(() => { if (window.__probeInit) return; window.__probeInit = true; try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD
  await pg.addInitScript(IWER);
  await pg.addInitScript(() => { const { XRDevice, metaQuest3 } = window.IWER ?? {}; const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
    window.__iwerDevice = d; try { delete window.IWER; } catch { window.IWER = undefined; } });
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') conErrs.push(m.text().slice(0, 200)); });
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));

  const url = `${world.origin}/?world=${WORLD}&name=vraids&key=${world.key}&xr=1`;
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none' && !!globalThis.EW?.me?.(); }, null, { timeout: 120000 });
  const P = peer('vrpeer', { yaw: 0, speed: 0, clip: 'idle', presence: 'present', p: [0, 0, 6], mic: true, hear: true });
  await ev(pg, () => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  console.log('  · stage presenting', J(await ev(pg, () => ({ frame: globalThis.__perf?.frameNo, presenting: !!EW.renderer?.xr?.isPresenting }), null, 10000).catch((e) => String(e))));

  // ---- in-page helpers ----------------------------------------------------------------------------------------------
  await ev(pg, async () => {
    const xr = await import('./lib/xr.js'), pc = await import('./lib/platecard.js'), dq = await import('./lib/domquad.js'), xp = await import('./lib/xrpointer.js');
    const T = EW.THREE, dev = window.__iwerDevice;
    const H = globalThis.__h = { xr, pc, dq, xp, T, R: {}, clicks: 0 };
    H.frames = (n) => new Promise((res) => { const f0 = globalThis.__perf.frameNo; const t0 = performance.now();
      const iv = setInterval(() => { if (globalThis.__perf.frameNo - f0 >= n || performance.now() - t0 > 20000) { clearInterval(iv); res(globalThis.__perf.frameNo - f0); } }, 15); });
    H.head = () => { const m = EW.renderer.xr.getCamera().matrixWorld; const p = new T.Vector3().setFromMatrixPosition(m);
      const f = new T.Vector3(-m.elements[8], 0, -m.elements[10]).normalize(); return { p, f, r: new T.Vector3(-f.z, 0, f.x) }; };
    H.ctl = (side) => dev.controllers[side];
    H.poseMat = (side) => { const c = H.ctl(side); return new T.Matrix4().compose(new T.Vector3(c.position.x, c.position.y, c.position.z),
      new T.Quaternion(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w), new T.Vector3(1, 1, 1)); };
    // the RAW ray (three's controller object), not the smoothed aim: calibration maps the device pose to it
    H.calibrate = async (side) => { await H.frames(3); const W = xr.xrHands()[side].ray.matrixWorld.clone(); H.R[side] = W.multiply(H.poseMat(side).invert()); };
    H.aim = (side, from, to) => {
      const dir = new T.Vector3().subVectors(to, from).normalize();
      const Wd = new T.Matrix4().compose(from, new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), dir), new T.Vector3(1, 1, 1));
      const Pm = H.R[side].clone().invert().multiply(Wd);
      const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(); Pm.decompose(p, q, s);
      const c = H.ctl(side); c.position.set(p.x, p.y, p.z); c.quaternion.set(q.x, q.y, q.z, q.w);
    };
    H.handFrom = (side) => { const h = H.head(); return h.p.clone().addScaledVector(h.r, side === 'right' ? 0.15 : -0.15).addScaledVector(h.f, 0.15).add(new T.Vector3(0, -0.3, 0)); };
    H.down = (side) => { const from = H.handFrom(side); H.aim(side, from, from.clone().add(new T.Vector3(0, -1, 0.05))); };
    H.up = (side) => { const from = H.handFrom(side); H.aim(side, from, from.clone().add(new T.Vector3(0.02, 1, 0))); };   // the open sky: nothing to point at
    H.btn = (side, name, v) => H.ctl(side).updateButtonValue(name, v);   // 'trigger' | 'squeeze'
    H.dbg = (side = 'right') => xr.xrPointerDebug()[side];
    // a quad's world point at CSS px (px, py) from its frame's top-left
    H.meshOf = (id) => dq.domQuadMesh(id);
    H.worldAt = (id, px, py) => { const mesh = H.meshOf(id), fr = dq.domQuadTexture(id).dom.getBoundingClientRect();
      const { width: W, height: Hh } = mesh.geometry.parameters; mesh.updateMatrixWorld(true);
      return mesh.localToWorld(new T.Vector3((px / fr.width - 0.5) * W, (0.5 - py / fr.height) * Hh, 0)); };
    H.mPerPx = (id) => { const mesh = H.meshOf(id), fr = dq.domQuadTexture(id).dom.getBoundingClientRect(); const s = mesh.getWorldScale(new T.Vector3()); return mesh.geometry.parameters.width * s.x / fr.width; };
    H.rectIn = (id, el) => { const fr = dq.domQuadTexture(id).dom.getBoundingClientRect(), r = el.getBoundingClientRect(); return { l: r.left - fr.left, t: r.top - fr.top, r: r.right - fr.left, b: r.bottom - fr.top, cx: (r.left + r.right) / 2 - fr.left, cy: (r.top + r.bottom) / 2 - fr.top }; };
    H.ctlAt = (id, px, py) => { const fr = dq.domQuadTexture(id).dom.getBoundingClientRect(); return dq.controlAt(dq.domQuadTexture(id), px / fr.width, py / fr.height); };
    H.aimAt = (side, id, px, py) => H.aim(side, H.handFrom(side), H.worldAt(id, px, py));
    H.state = () => pc.plateCardState();
    // the control under the hand's DOT (which sits where the actual pick ray lands): what a trigger would press
    H.ctlUnderDot = (id, side = 'right') => { const d = xr.xrPointerDebug()[side].dot; if (!d.visible) return null; const mesh = H.meshOf(id), p = mesh.worldToLocal(new T.Vector3().fromArray(d.pos));
      const { width: W, height: Hh } = mesh.geometry.parameters; return dq.controlAt(dq.domQuadTexture(id), p.x / W + 0.5, 0.5 - p.y / Hh); };
    H.held = () => xr.xrDebug().held;
    // clicks on the settings frame, by target
    H.clickLog = [];
    H.watch = (dom) => { if (dom.__probeWatch) return; dom.__probeWatch = true; dom.addEventListener('click', (e) => H.clickLog.push(e.target), true); };
    H.clicksOn = (el) => H.clickLog.filter((t) => el === t || el.contains(t)).length;
    H.pull = async (side, opts = {}) => { H.btn(side, 'trigger', 1); await H.frames(opts.hold ?? 3); H.btn(side, 'trigger', 0); await H.frames(3); };
  });
  await pg.waitForFunction(() => globalThis.__perf.frameNo > 0, null, { timeout: 30000 });
  console.log('  · stage helpers in', J(await ev(pg, () => ({ frame: globalThis.__perf?.frameNo, presenting: !!EW.renderer?.xr?.isPresenting }), null, 10000).catch((e) => String(e))));
  await ev(pg, async () => { await __h.calibrate('right'); await __h.calibrate('left'); __h.down('right'); __h.down('left'); await __h.frames(4); });
  console.log('  · stage calibrated', J(await ev(pg, () => ({ frame: globalThis.__perf?.frameNo, presenting: !!EW.renderer?.xr?.isPresenting }), null, 10000).catch((e) => String(e))));
  // buttons are trusted 700 ms after the input sources appear (xr.js): wait it out on the product's own flag
  await ev(pg, () => new Promise((r) => setTimeout(r, 1200)));

  // ---- the settings quad, alone, with its VR tab chosen by a real trigger ----------------------------------------------
  console.log('  · stage trusted', J(await ev(pg, () => ({ frame: globalThis.__perf?.frameNo, presenting: !!EW.renderer?.xr?.isPresenting }), null, 10000).catch((e) => String(e))));
  const st0 = await ev(pg, async () => {
    const dq = __h.dq;
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'settings');
    await new Promise((r) => setTimeout(r, 800)); await __h.frames(3);
    const dom = dq.domQuadTexture('settings')?.dom; if (!dom) return { noSettings: dq.domQuadIds() };
    __h.watch(dom);
    const tab = document.getElementById('sec-vr-tab'); tab.scrollIntoView({ block: 'nearest', inline: 'center' }); await new Promise((r) => setTimeout(r, 300));
    const r = __h.rectIn('settings', tab);
    __h.aimAt('right', 'settings', r.cx, r.cy); await __h.frames(8);
    const heldBefore = __h.dbg().held;
    await __h.pull('right');
    await new Promise((r) => setTimeout(r, 400));
    return { heldBefore, clicked: __h.clicksOn(tab), open: document.getElementById('sec-vr')?.classList.contains('open'), visible: dq.domQuadOpen('settings') };
  });
  console.log('  · settings', J(st0));
  if (!st0.visible || !st0.open) throw new Error(`readiness gate: the settings quad's VR tab did not open: ${J(st0)}`);
  check('stage: a real trigger on the settings quad\'s VR tab chose it (the laser held the tab first)', st0.clicked === 1 && st0.heldBefore?.kind === 'panel', J(st0));
  // the frame's own api and a fresh copy of its saved layout, for the resize checks
  await ev(pg, async () => { const fr = await import('./lib/frames.js'); __h.frames_ = fr; __h.dwell = await import('./lib/dwell.js');
    __h.kind = () => __h.dbg().dot.kind; __h.tip = async () => (await import('./lib/xrtip.js')).xrTipState();
    // aim a hand at the centre of a panel's handle bar (under the panel)
    __h.handleAt = (id) => __h.dq.domQuadHandle(id)?.getWorldPosition(new __h.T.Vector3());
    __h.aimHandle = (side, id) => __h.aim(side, __h.handFrom(side), __h.handleAt(id)); });
  // a point on the settings quad with no control near it, a zone named, from frame px
  const geo = await ev(pg, async () => {
    const H = __h, dq = H.dq, dom = dq.domQuadTexture('settings').dom, fr = dom.getBoundingClientRect();
    const zoneOf = (x, y) => dq.zoneAt(dom, x, y), ctl = (x, y) => H.ctlAt('settings', x, y);
    // first point in a zone with no control under it, scanning a list of candidates
    const pick = (pts) => pts.find(([x, y]) => !ctl(x, y));
    const W = fr.width, Hh = fr.height;
    const se = pick([[W - 5, Hh - 5], [W - 8, Hh - 3], [W - 3, Hh - 8]]), e = pick([[W - 4, Hh / 2], [W - 4, Hh / 2 + 20], [W - 4, Hh / 2 - 20]]);
    const s = pick([[W / 2, Hh - 4], [W / 2 + 30, Hh - 4], [W / 2 - 30, Hh - 4]]);
    let top = null; for (let x = 30; x < W - 30 && !top; x += 6) for (const y of [6, 12, 18]) if (!top && !ctl(x, y)) top = [x, y];   // the old move strip
    // the handle bar: under the panel, centred, in the panel's own units
    const hb = H.dq.domQuadHandle('settings'), mesh = H.meshOf('settings');
    const hbl = hb && { x: +(hb.position.x / 0.001).toFixed(1), below: +((-hb.position.y - mesh.geometry.parameters.height / 2) / 0.001).toFixed(1), w: +(hb.geometry.parameters.width / 0.001).toFixed(1), op: hb.material.opacity, visible: hb.visible, parent: hb.parent === mesh };
    const head = dom.querySelector(':scope > .fr-head'), hr = head?.getBoundingClientRect();
    return { W, H: Hh, se, e, s, top, handle: hbl, zones: { se: se && zoneOf(...se), e: e && zoneOf(...e), s: s && zoneOf(...s), top: top && zoneOf(...top) },
      head: hr ? { h: hr.height, display: getComputedStyle(head).display } : null, resizable: !!H.frames_.frameResizeInfo(dom) };
  });
  console.log('  · zones', J(geo));
  await ev(pg, (g) => { __h.geo = g; }, geo);
  check('zones: resize corner/edges on the settings panel; its top is plain body now (no move strip)',
    geo.resizable && geo.zones.se === 'resize-se' && geo.zones.e === 'resize-e' && geo.zones.s === 'resize-s' && geo.zones.top === 'body', J(geo.zones));
  check('the handle bar: a child of the panel, centred under it (10 px gap), 120 px wide, faintly there before any dwell',
    geo.handle?.parent && geo.handle.visible && Math.abs(geo.handle.x) < 0.5 && Math.abs(geo.handle.below - 17) < 0.5 && geo.handle.w === 120 && Math.abs(geo.handle.op - 0.35) < 0.01, J(geo.handle));

  // ---- 5. ONE dwell: per hand, keyed on what the laser holds, through the stickiness ----------------------------------
  const dw = await ev(pg, async () => {
    const H = __h, D = () => H.xr.xrDwell('right'), out = {};
    const tabs = [...H.dq.domQuadTexture('settings').dom.querySelectorAll('.pf-tab')].filter((t) => t.getBoundingClientRect().width > 8);
    const A = tabs[0], B = tabs[2] ?? tabs[1], ra = H.rectIn('settings', A), rb = H.rectIn('settings', B);
    H.up('right'); await H.frames(3);
    const t0 = performance.now(); H.aimAt('right', 'settings', ra.cx, ra.cy); await H.frames(6);
    out.onA = { el: D().key === A, sinceAfterAim: D().since >= t0, ripe: D().ripe() };
    // drift: to just inside a tab edge that has BACKGROUND beyond it, then off onto that background, within half the
    // stay margin of the last point on the tab: the laser still holds it (the ray bends), and the dwell keeps counting
    const from = H.handFrom('right'), mpp = H.mPerPx('settings'), k = from.distanceTo(H.worldAt('settings', ra.cx, ra.cy)) * Math.tan(H.xp.STICK_STAY_RAD) / mpp;
    let drift = null;
    for (const t of tabs) { const r = H.rectIn('settings', t);
      for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
        const ex = dx ? (dx > 0 ? r.r : r.l) : r.cx, ey = dy ? (dy > 0 ? r.b : r.t) : r.cy;
        let clear = true; for (let f = 0.1; f <= 0.6; f += 0.1) if (H.ctlAt('settings', ex + dx * f * k, ey + dy * f * k)) { clear = false; break; }
        if (clear && H.ctlAt('settings', ex - dx * 2, ey - dy * 2) === t) { drift = { t, inside: [ex - dx * 2, ey - dy * 2], off: [ex + dx * 0.4 * k, ey + dy * 0.4 * k] }; break; } }
      if (drift) break; }
    if (drift) {
      H.aimAt('right', 'settings', drift.inside[0], drift.inside[1]); await H.frames(6);
      const sinceIn = D().since, onIt = D().key === drift.t;
      H.aimAt('right', 'settings', drift.off[0], drift.off[1]); await H.frames(6);
      out.drift = { onIt, el: D().key === drift.t, sameSince: D().since === sinceIn, bent: H.dbg().bent, rawOff: H.ctlAt('settings', drift.off[0], drift.off[1]) === null };
    } else out.drift = { none: true };
    // on to another tab: a new dwell
    const t1 = performance.now(); H.aimAt('right', 'settings', rb.cx, rb.cy); await H.frames(6);
    out.onB = { el: D().key === B, restarted: D().since >= t1 };
    // the panel's background: keyed on the panel and its zone
    H.aimHandle('right', 'settings'); await H.frames(6);
    out.zoneKey = D().key;
    H.up('right'); await H.frames(4); out.none = D().key;
    out.ms = H.dwell.DWELL_MS;
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  console.log('  · dwell', J(dw));
  check('dwell: the laser on a control starts that hand\'s dwell, keyed on the control (it ripens after 300 ms)', dw.onA?.el && dw.onA.sinceAfterAim && dw.onA.ripe && dw.ms === 300, J(dw.onA));
  check('…a drift within the stay margin keeps the same dwell counting (stickiness honoured)', dw.drift?.onIt && dw.drift.rawOff && dw.drift.el && dw.drift.sameSince && dw.drift.bent, J(dw.drift));
  check('…another control starts a new one; on a panel\'s handle it is keyed on the panel and its zone; on nothing, nothing',
    dw.onB?.el && dw.onB.restarted && dw.zoneKey === 'panel:settings:move' && dw.none === null, J(dw));

  // ---- 6. tooltips: a control's desktop title, shown on dwell, in the panel; gone when the laser leaves -----------------
  const tip = await ev(pg, async () => {
    const H = __h, T = H.T, out = {};
    const sel = document.getElementById('vr-pointer-visibility'), row = sel.closest('.row'), btn = sel.nextElementSibling;
    btn.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300)); await H.frames(2);
    const r = H.rectIn('settings', btn);
    // not before the dwell is ripe: stretch this hand's delay so a slow headless frame cannot outrun it, then restore
    const D = H.xr.xrDwell('right'); D.ms = 4000;
    H.aimAt('right', 'settings', r.cx, r.cy); await H.frames(4);
    out.early = (await H.tip()).shown;
    D.ms = H.dwell.DWELL_MS; await H.frames(3);
    const s = await H.tip(), quad = H.meshOf('settings');
    out.shown = s.shown; out.text = s.text; out.want = row.title; out.inPanel = s.mesh?.parent === quad;
    if (s.mesh) {
      // where, in the panel's px: under the control, centred on it (or clamped inside the panel)
      const fr = H.dq.domQuadTexture('settings').dom.getBoundingClientRect();
      const p = s.mesh.position, tipH = s.el.offsetHeight, tipW = s.el.offsetWidth;
      const yTopPx = fr.height / 2 - p.y / 0.001 - tipH / 2, xPx = p.x / 0.001 + fr.width / 2;
      out.place = { below: yTopPx >= r.b - 1, gap: +(yTopPx - r.b).toFixed(1), dx: +(xPx - r.cx).toFixed(1), inside: xPx - tipW / 2 >= -1 && xPx + tipW / 2 <= fr.width + 1, z: +p.z.toFixed(4) };
      // the panel's own pixel size: the tip's metres per CSS px equal the quad's
      const tipM = s.mesh.geometry.parameters.width * s.mesh.getWorldScale(new T.Vector3()).x / tipW, quadM = H.mPerPx('settings');
      out.density = +(tipM / quadM).toFixed(3); out.raster = +(s.mesh.material.map.image.width / tipW).toFixed(2);
    }
    // away: it goes
    H.up('right'); await H.frames(4); out.after = (await H.tip()).shown;
    // a GREYED control says why: the recentre button, disabled, with its own (desktop) title
    const rc = [...row.parentElement.querySelectorAll('button')].find((b) => /recentre now/.test(b.textContent));
    if (rc) { rc.scrollIntoView({ block: 'center' }); rc.disabled = true; await new Promise((r) => setTimeout(r, 300)); await H.frames(2);
      const q = H.rectIn('settings', rc); H.aimAt('right', 'settings', q.cx, q.cy); await H.frames(8);
      const g = await H.tip(); out.grey = { shown: g.shown, text: g.text, want: rc.title }; rc.disabled = false; H.up('right'); await H.frames(3); }
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  console.log('  · tip', J(tip));
  check('tooltip: not shown before the dwell is ripe', tip.early === false, J(tip));
  check('…then the control\'s own desktop tooltip text, shown in its panel', tip.shown && tip.text === tip.want && tip.text.length > 10 && tip.inPanel, J({ text: tip.text, want: tip.want, inPanel: tip.inPanel }));
  check('…under the control, centred on it, inside the panel, a hair in front', tip.place?.below && tip.place.gap < 12 && (Math.abs(tip.place.dx) < 2 || tip.place.inside) && tip.place.inside && tip.place.z > 0, J(tip.place));
  check('…legible: drawn at the panel\'s own pixel size, rasterised at 2.5×', Math.abs(tip.density - 1) < 0.02 && Math.abs(tip.raster - 2.5) < 0.1, J({ density: tip.density, raster: tip.raster }));
  check('…gone when the laser leaves', tip.after === false, J(tip.after));
  check('a greyed (disabled) control shows its why the same way', tip.grey?.shown && tip.grey.text === tip.grey.want && !!tip.grey.want, J(tip.grey));

  // ---- 8 (first, while the panel is as built). the contextual icon -----------------------------------------------------
  const icons = await ev(pg, async () => {
    const H = __h, out = {}, g = H.geo;
    const at = async (x, y) => { H.aimAt('right', 'settings', x, y); await H.frames(5); return H.kind(); };
    const tab = H.rectIn('settings', document.getElementById('sec-vr-tab'));
    out.control = await at(tab.cx, tab.cy);
    H.aimHandle('right', 'settings'); await H.frames(5); out.move = H.kind(); out.top = await at(...g.top); out.se = await at(...g.se); out.e = await at(...g.e); out.s = await at(...g.s);
    // the icon's size as an angle at the eye (on the control: an icon is showing)
    await at(tab.cx, tab.cy);
    { const T = H.T, icon = H.xr.xrHands().right.dot.userData.parts.icon, e = EW.renderer.xr.getCamera().getWorldPosition(new T.Vector3());
      out.iconOn = icon.visible; out.iconRad = +(icon.geometry.parameters.width * icon.getWorldScale(new T.Vector3()).x / e.distanceTo(icon.getWorldPosition(new T.Vector3()))).toFixed(4); }
    H.up('right'); await H.frames(3); out.none = H.dbg().dot.visible;
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  // scroll and type need a scrolling area and a text field: the debug panel scrolls; chat has a text field
  const icons2 = await ev(pg, async () => {
    const H = __h, dq = H.dq, out = {};
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'debug'); await new Promise((r) => setTimeout(r, 800)); await H.frames(3);
    { const dom = dq.domQuadTexture('debug')?.dom, fr = dom?.getBoundingClientRect(); let spot = null;
      for (let y = 60; dom && y < fr.height - 20 && !spot; y += 6) for (let x = 20; x < fr.width - 20 && !spot; x += 8) { const c = H.ctlAt('debug', x, y); if (!c && dq.zoneAt(dom, x, y) === 'body' && dq.scrollableAt(dq.domQuadTexture('debug'), x / fr.width, y / fr.height)) spot = [x, y]; }
      if (spot) { H.aimAt('right', 'debug', ...spot); await H.frames(5); out.scroll = H.kind(); } else out.scroll = 'no scrollable spot'; }
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'chat'); await new Promise((r) => setTimeout(r, 800)); await H.frames(3);
    { const dom = dq.domQuadTexture('chat')?.dom, f = dom && [...dom.querySelectorAll(dq.TEXT_SEL)].find((e) => e.getBoundingClientRect().height > 8);
      if (f) { const r = H.rectIn('chat', f); H.aimAt('right', 'chat', r.cx, r.cy); await H.frames(5); out.type = H.kind(); } else out.type = 'no text field'; }
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'settings'); await new Promise((r) => setTimeout(r, 800)); await H.frames(3);
    H.up('right'); await H.frames(3);
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  console.log('  · icons', J({ ...icons, ...icons2 }));
  check('icon: click on a control, move on the handle bar (and on plain panel background)', icons.control === 'click' && icons.move === 'move' && icons.top === 'move', J(icons));
  check('…an icon, constant in angle (0.014 rad across), and none with no target', icons.iconOn && Math.abs(icons.iconRad - 0.014) < 0.0008 && icons.none === false, J(icons));
  check('…resize on a corner (diagonal), the right edge (horizontal), the bottom edge (vertical)', icons.se === 'resize-nwse' && icons.e === 'resize-ew' && icons.s === 'resize-ns', J(icons));
  check('…scroll over an area that scrolls, type over a text field', icons2.scroll === 'scroll' && icons2.type === 'type', J(icons2));

  // ---- 7. handles revealed on dwell; grip on a corner resizes and commits the frame's layout ---------------------------
  const hd = await ev(pg, async () => {
    const H = __h, T = H.T, dq = H.dq, out = {}, g = H.geo, D = H.xr.xrDwell('right');
    // not before the dwell: the delay stretched, as for the tooltip
    D.ms = 4000; H.aimHandle('right', 'settings'); await H.frames(4); out.moveEarly = dq.domQuadAids('settings');
    D.ms = H.dwell.DWELL_MS; await H.frames(3); out.moveRipe = dq.domQuadAids('settings');
    H.aimAt('right', 'settings', ...g.se); await H.frames(6); out.seRipe = dq.domQuadAids('settings');
    H.up('right'); await H.frames(4); out.away = dq.domQuadAids('settings');
    // resize: grip on the SE corner, the laser 60 px right and 40 px down of it (on the panel's plane), release
    const api = H.frames_.getFrame('settings'), w0 = api.state.w, h0 = api.state.h, mesh0 = H.meshOf('settings'), mpp0 = H.mPerPx('settings');
    try { H.deskSaved0 = JSON.parse(localStorage.getItem('ew-frame-settings') || 'null'); } catch {}
    const fr = dq.domQuadTexture('settings').dom.getBoundingClientRect();
    const nw0 = H.worldAt('settings', 0, 0);
    H.aimAt('right', 'settings', ...g.se); await H.frames(6);
    H.btn('right', 'squeeze', 1); await H.frames(3); out.began = H.xr.xrDebug().resizing;
    H.aimAt('right', 'settings', g.se[0] + 60, g.se[1] + 40); await H.frames(5);
    out.during = { ...H.xr.xrDebug().resizing, seen: dq.domQuadAids('settings'), outline: !!mesh0.children.find((c) => c.name === 'xr-resize-outline' && c.visible !== false) };
    H.btn('right', 'squeeze', 0); await H.frames(6);
    const mesh1 = H.meshOf('settings'), fr1 = dq.domQuadTexture('settings').dom.getBoundingClientRect();
    let saved = null; try { saved = JSON.parse(localStorage.getItem('ew-frame-settings') || 'null'); } catch {}
    const vr = JSON.parse(localStorage.getItem('ew-xr-quads') || '{}').settings ?? {};
    out.after = { desk: { w: api.state.w, h: api.state.h, w0, h0, savedW: saved?.w ?? null, savedW0: H.deskSaved0?.w ?? null }, vr: { w: vr.w, bh: vr.bh, size: api._vrSize },
      css: [fr.width, fr.height, fr1.width, fr1.height].map(Math.round), rebuilt: mesh1 !== mesh0, mppRatio: +(H.mPerPx('settings') / mpp0).toFixed(4),
      nwMoved: +H.worldAt('settings', 0, 0).distanceTo(nw0).toFixed(4), resizing: H.xr.xrDebug().resizing, place: JSON.parse(localStorage.getItem('ew-xr-quads') || '{}').settings };
    // a resize can't go under the frame's floor: drag the corner far inward
    const g2 = [fr1.width - 5, fr1.height - 5];
    H.aimAt('right', 'settings', ...g2); await H.frames(6);
    out.zone2 = dq.zoneAt(dq.domQuadTexture('settings').dom, ...g2);
    H.btn('right', 'squeeze', 1); await H.frames(3); H.aimAt('right', 'settings', 20, 20); await H.frames(5); H.btn('right', 'squeeze', 0); await H.frames(6);
    out.floor = { w: api._vrSize?.w, minW: H.frames_.frameResizeInfo(dq.domQuadTexture('settings').dom)?.minW, h: api._vrSize?.h, minH: H.frames_.frameResizeInfo(dq.domQuadTexture('settings').dom)?.minH, deskW: api.state.w, w0 };
    // grip on the handle bar MOVES the panel (a grab), and the bar is at full while carried; a trigger on it selects nothing
    H.aimHandle('right', 'settings'); await H.frames(6);
    // an entity right BEHIND the bar on the same laser, so a trigger that fell through would select it
    const world = await import('./lib/world.js'), from = H.handFrom('right'), hp = H.handleAt('settings'), dir = hp.clone().sub(from).normalize();
    const box = new T.Mesh(new T.BoxGeometry(0.4, 0.4, 0.4), new T.MeshBasicNodeMaterial({ color: 0x445566 }));
    box.position.copy(hp).addScaledVector(dir, 0.8); box.userData.entityId = 'probe-behind'; EW.scene.add(box); box.updateMatrixWorld(true); world.entities.set('probe-behind', box);
    const selects = []; const bus = (await import('./lib/base.js')).bus; const off = bus.on('xr:select', (id) => selects.push(id));
    try { H.btn('right', 'trigger', 1); await H.frames(3); H.btn('right', 'trigger', 0); await H.frames(3); }
    finally { off?.(); world.entities.delete('probe-behind'); box.removeFromParent(); }
    // the control: the same trigger with the bar's panel hidden selects it (so the 0 above is the bar's doing)
    out.control = await (async () => { dq.domQuadShow('settings', false); EW.scene.add(box); world.entities.set('probe-behind', box); const sel = []; const o2 = bus.on('xr:select', (id) => sel.push(id));
      try { H.aim('right', from, box.position); await H.frames(4); H.btn('right', 'trigger', 1); await H.frames(3); H.btn('right', 'trigger', 0); await H.frames(3); }
      finally { o2?.(); world.entities.delete('probe-behind'); box.removeFromParent(); dq.domQuadShow('settings', true); await new Promise((r) => setTimeout(r, 300)); }
      return sel; })();
    H.aimHandle('right', 'settings'); await H.frames(6);
    H.btn('right', 'squeeze', 1); await H.frames(4);
    out.moveGrab = { held: H.xr.xrDebug().held, resizing: H.xr.xrDebug().resizing, bar: dq.domQuadAids('settings').includes('move'), selects, bus: typeof off === 'function' }; H.btn('right', 'squeeze', 0); await H.frames(4);
    H.up('right'); await H.frames(3);
    return out;
  }, null, 90000).catch((e) => ({ err: String(e) }));
  console.log('  · handles', J(hd));
  check('handles: the handle bar stays faint before the dwell is ripe and comes up to full after it', J(hd.moveEarly) === '[]' && J(hd.moveRipe) === '["move"]', J(hd));
  check('…a corner\'s resize handle shows on dwell there; leaving hides them', J(hd.seRipe) === '["resize-se"]' && J(hd.away) === '[]', J(hd));
  check('grip on the SE corner resizes (not a grab): the outline follows the laser, the handle stays shown', hd.began?.zone === 'se' && hd.during?.outline && J(hd.during.seen) === '["resize-se"]'
    && Math.abs(hd.during.w - hd.after.css[0] - 60) <= 3, J(hd.during));
  check('…released, the size is VR\'s own: saved with the VR place (w, bh), on the staged frame', Math.abs(hd.after?.vr.w - hd.after.css[0] - 60) <= 3 && hd.after.vr.size?.w === hd.after.vr.w && hd.after.vr.size?.h === hd.after.vr.bh && !hd.after.resizing, J(hd.after));
  check('…and the DESKTOP layout is untouched: its state and its saved size are what they were', hd.after?.desk.w === hd.after.desk.w0 && hd.after.desk.h === hd.after.desk.h0 && hd.after.desk.savedW === hd.after.desk.savedW0, J(hd.after?.desk));
  check('…the quad is rebuilt at the new size at the SAME pixel density, its opposite corner where it was', hd.after?.rebuilt && Math.abs(hd.after.mppRatio - 1) < 0.01 && hd.after.nwMoved < 0.005
    && Math.abs(hd.after.css[2] - hd.after.css[0] - 60) <= 3, J(hd.after));
  check('…and never under the frame\'s own floor (the desktop size still untouched)', hd.zone2 === 'resize-se' && hd.floor?.w === hd.floor.minW && hd.floor.h === hd.floor.minH && hd.floor.deskW === hd.floor.w0, J(hd.floor));
  check('grip on the handle bar moves the panel (a grab, not a resize), its bar at full while carried; a trigger on the bar selects nothing behind it',
    hd.moveGrab?.held === 'settings' && !hd.moveGrab.resizing && hd.moveGrab.bar && hd.moveGrab.bus && hd.moveGrab.selects.length === 0 && J(hd.control) === '["probe-behind"]', J({ g: hd.moveGrab, control: hd.control }));

  // ---- 9. push/pull = trigger + stick on the holding hand; without the trigger the stick walks and turns as ever -------
  const pp = await ev(pg, async () => {
    const H = __h, T = H.T, out = {};
    const dist = (side) => { const a = H.xr.xrHands()[side].aim, o = new T.Vector3().setFromMatrixPosition(a.matrixWorld), d = new T.Vector3(0, 0, -1).transformDirection(a.matrixWorld);
      return +H.meshOf('settings').getWorldPosition(new T.Vector3()).sub(o).dot(d).toFixed(3); };
    const pose = () => ({ pos: EW.myState.pos.toArray().map((v) => +v.toFixed(3)), yaw: +H.xr.xrDebug().rigYaw.toFixed(3) });
    const m0 = H.meshOf('settings'), keep = { pos: m0.position.clone(), q: m0.quaternion.clone() };   // each hand starts from the same place
    for (const side of ['right', 'left']) {
      const r = {};
      { const m = H.meshOf('settings'); m.position.copy(keep.pos); m.quaternion.copy(keep.q); m.updateMatrixWorld(true); }
      H.aimHandle(side, 'settings'); await H.frames(6); H.btn(side, 'squeeze', 1); await H.frames(4);
      r.held = H.xr.xrDebug().held;
      // the stick alone, while holding: the player runs (left) or turns (right) as ever, and the panel is not reeled
      const a0 = pose(), d00 = dist(side);
      H.ctl(side).updateAxes('thumbstick', side === 'right' ? 0.9 : 0, side === 'right' ? 0 : -1); await H.frames(5);
      const a1 = pose(); H.ctl(side).updateAxes('thumbstick', 0, 0); await H.frames(3);
      await H.calibrate('right'); await H.calibrate('left');   // the rig turned or walked: the device→world mapping moved with it
      r.free = { moved: +Math.hypot(a1.pos[0] - a0.pos[0], a1.pos[2] - a0.pos[2]).toFixed(3), turned: +Math.abs(a1.yaw - a0.yaw).toFixed(3), reel: +Math.abs(dist(side) - d00).toFixed(3), stillHeld: H.xr.xrDebug().held };
      // trigger + stick: the reel; the left stick's forward does not walk meanwhile
      H.btn(side, 'trigger', 1); await H.frames(2);
      r.d0 = dist(side); const p0 = pose();
      H.ctl(side).updateAxes('thumbstick', 0, -1); await H.frames(4); r.d1 = dist(side);
      for (let i = 0; i < 6 && dist(side) < 2.99; i++) await H.frames(4); r.dMax = dist(side);
      r.still = JSON.stringify(pose().pos) === JSON.stringify(p0.pos); r.pose = [p0, pose()];
      H.ctl(side).updateAxes('thumbstick', 0, 1); await H.frames(4); r.d2 = dist(side);
      for (let i = 0; i < 10 && dist(side) > 0.26; i++) await H.frames(4); r.dMin = dist(side);
      H.ctl(side).updateAxes('thumbstick', 0, 0); await H.frames(2);
      H.btn(side, 'trigger', 0); await H.frames(2);
      H.btn(side, 'squeeze', 0); await H.frames(4); r.released = H.xr.xrDebug().held;
      out[side] = r;
    }
    return out;
  }, null, 150000).catch((e) => ({ err: String(e) }));
  console.log('  · pushpull', J(pp));
  check('carrying a panel, the left stick still runs and the right stick still turns; the stick alone does not reel the panel',
    pp.left?.free.moved > 0.05 && pp.right?.free.turned > 0.05 && pp.left.free.reel < 0.005 && pp.right.free.reel < 0.005 && pp.left.free.stillHeld === 'settings' && pp.right.free.stillHeld === 'settings', J([pp.left?.free, pp.right?.free]));
  for (const side of ['right', 'left']) {
    const r = pp[side] ?? {};
    check(`push/pull (${side} hand): trigger + stick forward sends the held panel away, to at most 3 m`, r.held === 'settings' && r.d1 > r.d0 + 0.02 && Math.abs(r.dMax - 3) < 0.01, J(r));
    check(`…trigger + stick back reels it in, to no nearer than 0.25 m; the reel is not a step (no walking meanwhile)`, r.d2 < r.dMax - 0.02 && Math.abs(r.dMin - 0.25) < 0.01 && r.still && r.released === null, J(r));
  }

  // ---- the face buttons, VRChat's convention: B/Y = the panels' quick hide; left A/X = the mic; right A = jump ----------
  const qh = await ev(pg, async () => {
    const H = __h, dq = H.dq, out = {};
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'settings' || q === 'chat'); await new Promise((r) => setTimeout(r, 600)); await H.frames(3);
    const where = () => Object.fromEntries(['settings', 'chat'].map((id) => [id, H.meshOf(id)?.getWorldPosition(new H.T.Vector3()).toArray().map((v) => +v.toFixed(4))]));
    const vis = () => dq.domQuadIds().filter((id) => H.meshOf(id)?.visible).sort();
    const NR = await import('./lib/namereveal.js');
    out.before = vis(); const w0 = where();
    const press = async (side, btn) => { H.btn(side, btn, 1); await H.frames(3); out.ringOpen = out.ringOpen || H.xr.xrDebug().radialOpen; out.revealed = out.revealed || NR.revealHeld(); H.btn(side, btn, 0); await H.frames(3); };
    await press('left', 'y-button'); out.hidden = { vis: vis(), flag: H.xr.xrDebug().panelsHidden };
    await press('right', 'b-button'); out.back = { vis: vis(), flag: H.xr.xrDebug().panelsHidden, same: JSON.stringify(where()) === JSON.stringify(w0) };
    // hidden, then a panel opened (the ring's way) brings the hidden ones back first
    await press('right', 'b-button'); dq.domQuadShow('debug', true); await new Promise((r) => setTimeout(r, 300)); out.ringOpenWhileHidden = vis();
    for (const q of dq.domQuadIds()) dq.domQuadShow(q, q === 'settings'); await H.frames(2);
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  console.log('  · quickhide', J(qh));
  check('B/Y (VRChat\'s menu button) puts every open panel away — not closing them; no names revealed, no ring', J(qh.before) === '["chat","settings"]' && J(qh.hidden?.vis) === '[]' && qh.hidden.flag && !qh.ringOpen && !qh.revealed, J(qh));
  check('…the next B/Y (either hand) brings exactly those back, where they were', J(qh.back?.vis) === '["chat","settings"]' && !qh.back.flag && qh.back.same, J(qh.back));
  check('…opening a panel while they are hidden brings the hidden ones back too', J(qh.ringOpenWhileHidden) === '["chat","debug","settings"]', J(qh.ringOpenWhileHidden));

  const mic = await ev(pg, async () => {
    const H = __h, out = {}, { bus } = await import('./lib/base.js'), VC = await import('./lib/voiceconsent.js'), MS = await import('./lib/micstate.js');
    const C = await import('./lib/controller.js'), MI = await import('./lib/xrmicicon.js');
    const ptt0 = VC.pttMode(), keepOn = window.__sfuMicOn, keepLvl = window.__sfuMyLevel;
    let mics = 0; const off = bus.on('xr:mic', () => { mics++; });
    // the real 'xr:mic' handler would ask for a microphone; this probe only counts the request (it is the ring's path)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // the HUD's mic state and the icon each tick on a 125 ms timer, late under a slow headless frame: wait on the state
    const until = async (st, ms = 4000) => { const t0 = performance.now(); while (MI.xrMicIconState().state !== st && performance.now() - t0 < ms) await wait(50); await wait(150); };
    try {
      out.icon0 = MI.xrMicIconState();
      VC.setPttMode(false);
      H.btn('left', 'x-button', 1); await H.frames(3); out.jumpX = C.xrIntent.jump; H.btn('left', 'x-button', 0); await H.frames(3);
      out.toggles = mics;
      H.btn('right', 'a-button', 1); await H.frames(3); out.jumpA = C.xrIntent.jump; out.togglesA = mics; H.btn('right', 'a-button', 0); await H.frames(3);
      // a live mic (the indicator reads the HUD's getters), quiet, then speaking
      window.__sfuMicOn = () => true; window.__sfuMyLevel = () => 0; await until('on'); out.iconOn = MI.xrMicIconState();
      window.__sfuMyLevel = () => 0.5; await until('hot'); out.iconHot = MI.xrMicIconState();
      // push-to-talk: the left A/X is HOLD to speak (V's rule), not a toggle; transmitting only while held
      VC.setPttMode(true); await until('on'); out.iconPttIdle = MI.xrMicIconState().state;
      const m0 = mics; H.btn('left', 'x-button', 1); await H.frames(3); await until('hot');
      out.pttHeld = MS.pttHeld(); out.iconPttHeld = MI.xrMicIconState().state;
      H.btn('left', 'x-button', 0); await H.frames(3); out.pttReleased = MS.pttHeld(); out.pttToggles = mics - m0;
      window.__sfuMicOn = () => false; await until('off'); out.iconOff = MI.xrMicIconState();
    } finally { off?.(); VC.setPttMode(ptt0); window.__sfuMicOn = keepOn; window.__sfuMyLevel = keepLvl; MS.setPttHeld(false); }
    return out;
  }, null, 60000).catch((e) => ({ err: String(e) }));
  console.log('  · mic', J(mic));
  check('left A/X (VRChat\'s mute) toggles the mic through the ring\'s path; it no longer jumps — the right A does', mic.toggles === 1 && mic.jumpX === false && mic.jumpA === true && mic.togglesA === 1, J(mic));
  check('…under push-to-talk it is HOLD to speak (as V): held → transmitting, released → not, and no toggle', mic.pttHeld === true && mic.pttReleased === false && mic.pttToggles === 0 && mic.iconPttHeld === 'hot' && mic.iconPttIdle === 'on', J(mic));
  check('the in-view mic icon: head-locked low in the left of the view while presenting, the HUD\'s off glyph when muted',
    mic.icon0?.shown && mic.icon0.onCamera && mic.icon0.state === 'off' && mic.icon0.pos[0] < -0.1 && mic.icon0.pos[1] < -0.1 && mic.icon0.pos[2] < 0 && mic.icon0.opacity >= 0.9, J(mic.icon0));
  check('…faint and smaller while open and quiet, full while transmitting, back to off when muted',
    mic.iconOn?.state === 'on' && mic.iconOn.opacity < 0.5 && mic.iconOn.scale < 1 && mic.iconHot?.state === 'hot' && mic.iconHot.opacity === 1 && mic.iconOff?.state === 'off', J(mic));

  const nm = await ev(pg, async () => {
    document.getElementById('sec-style-tab')?.click(); await new Promise((r) => setTimeout(r, 300));   // the style section builds when first opened
    const NR = await import('./lib/namereveal.js'), row = document.getElementById('style-always-names'), cb = row?.querySelector('input');
    const out = { row: !!row, label: row?.textContent.trim(), checked0: cb?.checked, level0: NR.revealHeld() };
    if (cb) { cb.click(); await new Promise((r) => setTimeout(r, 100)); out.on = { held: NR.revealHeld(), always: NR.alwaysNames(), stored: localStorage.getItem(NR.ALWAYS_LS) }; cb.click(); out.off = { held: NR.revealHeld(), stored: localStorage.getItem(NR.ALWAYS_LS) }; }
    return out;
  }).catch((e) => ({ err: String(e) }));
  console.log('  · names', J(nm));
  check('names leave the controller: Settings › style › "always show names", off by default, a reveal source of its own, stored', nm.row && nm.label === 'always show names' && nm.checked0 === false && !nm.level0
    && nm.on?.held && nm.on.always && nm.on.stored === '1' && !nm.off?.held && nm.off.stored === '0', J(nm));

  // ---- 5 again: the nameplate card rides the same dwell clock ------------------------------------------------------------
  await ev(pg, async () => { __h.dq.domQuadShow('settings', false); __h.down('right'); await __h.frames(4); });
  const spot = await ev(pg, () => { const h = __h.head(), me = EW.myState.pos; const p = h.p.clone().addScaledVector(h.f, 3); return [p.x, me.y, p.z]; });
  P.pose = { ...P.pose, p: spot };
  await pg.waitForFunction(() => { const r = EW.remotes.get('vrpeer'); return r?.avatar?.label && !r.loading; }, null, { timeout: 90000 });
  await ev(pg, async () => { let last = EW.remotes.get('vrpeer')?.avatar, since = performance.now();
    while (performance.now() - since < 2000) { await new Promise((r) => setTimeout(r, 100)); const now = EW.remotes.get('vrpeer')?.avatar; if (now !== last || EW.remotes.get('vrpeer')?.loading) { last = now; since = performance.now(); } }
    await __h.frames(4); }, null, 60000);
  const pd = await ev(pg, async () => {
    const H = __h, lab = EW.remotes.get('vrpeer').avatar.label, P0 = lab.getWorldPosition(new H.T.Vector3());
    H.aim('right', H.handFrom('right'), P0);
    const t0 = performance.now(); let s = H.state();
    while (!s.open && performance.now() - t0 < 15000) { await new Promise((r) => setTimeout(r, 25)); s = H.state(); }
    const d = H.xr.xrDwell('right');
    const out = { open: s.open, by: s.by, key: d.key, sameClock: s.hoverSince === d.since, waited: +(s.openedAt - s.hoverSince).toFixed(0) };
    H.down('right'); await H.frames(4);
    return out;
  }, null, 40000).catch((e) => ({ err: String(e) }));
  console.log('  · plate dwell', J(pd));
  check('the nameplate card opens on the same dwell: keyed on the plate, its clock the hand\'s, after 300 ms', pd.open && pd.by === 'hover' && pd.key === 'plate:vrpeer' && pd.sameClock && pd.waited >= 299, J(pd));

  // ---- 5. separate layouts across a session: leave VR (the desktop size is back), enter again (the VR size is back) ----
  // the mic checks pressed the real ring path, which may have queued the flat-page mic question for this exit: answer it
  // ahead ('later'), so the re-entry below goes straight in
  await ev(pg, async () => { const V = await import('./lib/vrmic_policy.js'); localStorage.setItem(V.MIC_CHOICE_KEY, 'later'); localStorage.removeItem(V.MIC_PENDING_KEY); });
  await ev(pg, () => __h.xr.leaveVR('probe'));
  await pg.waitForFunction(() => !EW.renderer.xr.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForFunction((f0) => globalThis.__perf.frameNo > f0 + 3, await ev(pg, () => globalThis.__perf.frameNo), { timeout: 30000, polling: 100 });
  const desk = await ev(pg, () => { const api = __h.frames_.getFrame('settings'), vr = JSON.parse(localStorage.getItem('ew-xr-quads') || '{}').settings ?? {};
    return { styleW: api.el.style.width, bodyH: api.body.style.height, state: [api.state.w, api.state.h], vrSize: api._vrSize, onDesktop: !api.el.closest('#xr-stage'), vr: [vr.w, vr.bh] }; });
  await ev(pg, () => new Promise((r) => setTimeout(r, 2000)));   // the visor refuses a re-entry for 1.5 s after a leave
  await ev(pg, () => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });
  const again = await ev(pg, async () => { const dq = __h.dq; await new Promise((r) => setTimeout(r, 1000)); dq.domQuadShow('settings', true); await new Promise((r) => setTimeout(r, 600));
    const api = __h.frames_.getFrame('settings'); return { w: api.el.offsetWidth, vrSize: api._vrSize, staged: !!api.el.closest('#xr-stage'), meshW: +(dq.domQuadMesh('settings')?.geometry.parameters.width / 0.001).toFixed(0) }; }, null, 40000).catch((e) => ({ err: String(e) }));
  console.log('  · layouts', J({ desk, again }));
  check('separate layouts: leaving VR gives the desktop frame its own size back (and its state was never changed)',
    desk.onDesktop && desk.vrSize === null && desk.styleW === `${desk.state[0]}px` && desk.bodyH === `${desk.state[1]}px` && desk.vr[0] !== desk.state[0], J(desk));
  check('…entering again puts the VR size back on the staged panel (saved with its VR place)', again.staged && again.vrSize?.w === desk.vr[0] && again.vrSize?.h === desk.vr[1] && again.w === desk.vr[0] && Math.abs(again.meshW - desk.vr[0]) <= 2, J(again));

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  const known = (t) => /Invalid value used as weak map key/.test(t);
  const other = conErrs.filter((t) => !known(t) && !/401|whoami/.test(t));
  console.log(`  · console.error: ${conErrs.length}${other.length ? ` other: ${other.slice(0, 3).join(' | ')}` : ''}`);
  check('no console errors beyond the disclosed emulator artifact', other.length === 0, other.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e?.stack?.split('\n').slice(0, 3).join(' ') ?? String(e)); }
finally {
  for (const p of peers) { clearInterval(p.timer); try { p.ws.close(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
