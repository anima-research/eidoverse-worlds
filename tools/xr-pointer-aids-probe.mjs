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
  await ev(pg, async () => { await __h.calibrate('right'); await __h.calibrate('left'); __h.down('right'); __h.down('left'); await __h.frames(4); });
  // buttons are trusted 700 ms after the input sources appear (xr.js): wait it out on the product's own flag
  await ev(pg, () => new Promise((r) => setTimeout(r, 1200)));

  // ---- the settings quad, alone, with its VR tab chosen by a real trigger ----------------------------------------------
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
    __h.kind = () => __h.dbg().dot.kind; __h.tip = async () => (await import('./lib/xrtip.js')).xrTipState(); });
  // a point on the settings quad with no control near it, a zone named, from frame px
  const geo = await ev(pg, async () => {
    const H = __h, dq = H.dq, dom = dq.domQuadTexture('settings').dom, fr = dom.getBoundingClientRect();
    const zoneOf = (x, y) => dq.zoneAt(dom, x, y), ctl = (x, y) => H.ctlAt('settings', x, y);
    // first point in a zone with no control under it, scanning a list of candidates
    const pick = (pts) => pts.find(([x, y]) => !ctl(x, y));
    const W = fr.width, Hh = fr.height;
    const se = pick([[W - 5, Hh - 5], [W - 8, Hh - 3], [W - 3, Hh - 8]]), e = pick([[W - 4, Hh / 2], [W - 4, Hh / 2 + 20], [W - 4, Hh / 2 - 20]]);
    const s = pick([[W / 2, Hh - 4], [W / 2 + 30, Hh - 4], [W / 2 - 30, Hh - 4]]);
    let move = null; for (let x = 30; x < W - 30 && !move; x += 6) for (const y of [6, 12, 18]) if (!move && zoneOf(x, y) === 'move' && !ctl(x, y)) move = [x, y];
    const head = dom.querySelector(':scope > .fr-head'), hr = head?.getBoundingClientRect();
    return { W, H: Hh, se, e, s, move, zones: { se: se && zoneOf(...se), e: e && zoneOf(...e), s: s && zoneOf(...s), move: move && zoneOf(...move) },
      head: hr ? { h: hr.height, display: getComputedStyle(head).display } : null, resizable: !!H.frames_.frameResizeInfo(dom) };
  });
  console.log('  · zones', J(geo));
  await ev(pg, (g) => { __h.geo = g; }, geo);
  check('zones: the settings panel has a move strip at its top and resize corner/edges (no control under them)',
    geo.resizable && geo.zones.se === 'resize-se' && geo.zones.e === 'resize-e' && geo.zones.s === 'resize-s' && geo.zones.move === 'move', J(geo.zones));

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
    H.aimAt('right', 'settings', ...[H.geo.move[0], H.geo.move[1]]); await H.frames(6);
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
    out.move = await at(...g.move); out.se = await at(...g.se); out.e = await at(...g.e); out.s = await at(...g.s);
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
  check('icon: click on a control, move on the title strip', icons.control === 'click' && icons.move === 'move', J(icons));
  check('…an icon, constant in angle (0.014 rad across), and none with no target', icons.iconOn && Math.abs(icons.iconRad - 0.014) < 0.0008 && icons.none === false, J(icons));
  check('…resize on a corner (diagonal), the right edge (horizontal), the bottom edge (vertical)', icons.se === 'resize-nwse' && icons.e === 'resize-ew' && icons.s === 'resize-ns', J(icons));
  check('…scroll over an area that scrolls, type over a text field', icons2.scroll === 'scroll' && icons2.type === 'type', J(icons2));

  // ---- 7. handles revealed on dwell; grip on a corner resizes and commits the frame's layout ---------------------------
  const hd = await ev(pg, async () => {
    const H = __h, T = H.T, dq = H.dq, out = {}, g = H.geo, D = H.xr.xrDwell('right');
    // not before the dwell: the delay stretched, as for the tooltip
    D.ms = 4000; H.aimAt('right', 'settings', ...g.move); await H.frames(4); out.moveEarly = dq.domQuadAids('settings');
    D.ms = H.dwell.DWELL_MS; await H.frames(3); out.moveRipe = dq.domQuadAids('settings');
    H.aimAt('right', 'settings', ...g.se); await H.frames(6); out.seRipe = dq.domQuadAids('settings');
    H.up('right'); await H.frames(4); out.away = dq.domQuadAids('settings');
    // resize: grip on the SE corner, the laser 60 px right and 40 px down of it (on the panel's plane), release
    const api = H.frames_.getFrame('settings'), w0 = api.state.w, h0 = api.state.h, mesh0 = H.meshOf('settings'), mpp0 = H.mPerPx('settings');
    const fr = dq.domQuadTexture('settings').dom.getBoundingClientRect();
    const nw0 = H.worldAt('settings', 0, 0);
    H.aimAt('right', 'settings', ...g.se); await H.frames(6);
    H.btn('right', 'squeeze', 1); await H.frames(3); out.began = H.xr.xrDebug().resizing;
    H.aimAt('right', 'settings', g.se[0] + 60, g.se[1] + 40); await H.frames(5);
    out.during = { ...H.xr.xrDebug().resizing, seen: dq.domQuadAids('settings'), outline: !!mesh0.children.find((c) => c.name === 'xr-resize-outline' && c.visible !== false) };
    H.btn('right', 'squeeze', 0); await H.frames(6);
    const mesh1 = H.meshOf('settings'), fr1 = dq.domQuadTexture('settings').dom.getBoundingClientRect();
    let saved = null; try { saved = JSON.parse(localStorage.getItem('ew-frame-settings') || 'null'); } catch {}
    out.after = { w: api.state.w, h: api.state.h, dw: api.state.w - w0, dh: api.state.h - h0, css: [fr.width, fr.height, fr1.width, fr1.height].map(Math.round),
      savedW: saved?.w, savedH: saved?.h, rebuilt: mesh1 !== mesh0, mppRatio: +(H.mPerPx('settings') / mpp0).toFixed(4),
      nwMoved: +H.worldAt('settings', 0, 0).distanceTo(nw0).toFixed(4), resizing: H.xr.xrDebug().resizing, place: JSON.parse(localStorage.getItem('ew-xr-quads') || '{}').settings };
    // a resize can't go under the frame's floor: drag the corner far inward
    const g2 = [fr1.width - 5, fr1.height - 5];
    H.aimAt('right', 'settings', ...g2); await H.frames(6);
    out.zone2 = dq.zoneAt(dq.domQuadTexture('settings').dom, ...g2);
    H.btn('right', 'squeeze', 1); await H.frames(3); H.aimAt('right', 'settings', 20, 20); await H.frames(5); H.btn('right', 'squeeze', 0); await H.frames(6);
    out.floor = { w: api.state.w, minW: H.frames_.frameResizeInfo(dq.domQuadTexture('settings').dom)?.minW, h: api.state.h, minH: H.frames_.frameResizeInfo(dq.domQuadTexture('settings').dom)?.minH };
    // grip on the move strip still MOVES the panel (a grab, not a resize)
    const g3 = H.geo.move;
    H.aimAt('right', 'settings', ...g3); await H.frames(6); H.btn('right', 'squeeze', 1); await H.frames(4);
    out.moveGrab = { held: H.xr.xrDebug().held, resizing: H.xr.xrDebug().resizing }; H.btn('right', 'squeeze', 0); await H.frames(4);
    H.up('right'); await H.frames(3);
    return out;
  }, null, 90000).catch((e) => ({ err: String(e) }));
  console.log('  · handles', J(hd));
  check('handles: the move strip\'s handle is hidden before the dwell is ripe and shows after it', J(hd.moveEarly) === '[]' && J(hd.moveRipe) === '["move"]', J(hd));
  check('…a corner\'s resize handle shows on dwell there; leaving hides them', J(hd.seRipe) === '["resize-se"]' && J(hd.away) === '[]', J(hd));
  check('grip on the SE corner resizes (not a grab): the outline follows the laser, the handle stays shown', hd.began?.zone === 'se' && hd.during?.outline && J(hd.during.seen) === '["resize-se"]'
    && Math.abs(hd.during.w - hd.after.css[0] - 60) <= 3, J(hd.during));
  check('…released, the size is committed to the frame\'s layout (as a desktop resize: state and its save)',
    Math.abs(hd.after?.dw - 60) <= 3 && Math.abs(hd.after.dh - 40) <= 3 && hd.after.savedW === hd.after.w && hd.after.savedH === hd.after.h && !hd.after.resizing, J(hd.after));
  check('…the quad is rebuilt at the new size at the SAME pixel density, its opposite corner where it was', hd.after?.rebuilt && Math.abs(hd.after.mppRatio - 1) < 0.01 && hd.after.nwMoved < 0.005
    && Math.abs(hd.after.css[2] - hd.after.css[0] - 60) <= 3, J(hd.after));
  check('…and never under the frame\'s own floor', hd.zone2 === 'resize-se' && hd.floor?.w === hd.floor.minW && hd.floor.h === hd.floor.minH, J(hd.floor));
  check('grip on the move strip moves the panel (a grab, not a resize)', hd.moveGrab?.held === 'settings' && !hd.moveGrab.resizing, J(hd.moveGrab));

  // ---- 9. push/pull on the holding hand; the player stays put ----------------------------------------------------------
  const pp = await ev(pg, async () => {
    const H = __h, T = H.T, out = {}, g = H.geo;
    const dist = (side) => { const a = H.xr.xrHands()[side].aim, o = new T.Vector3().setFromMatrixPosition(a.matrixWorld), d = new T.Vector3(0, 0, -1).transformDirection(a.matrixWorld);
      return +H.meshOf('settings').getWorldPosition(new T.Vector3()).sub(o).dot(d).toFixed(3); };
    const pose = () => ({ pos: EW.myState.pos.toArray().map((v) => +v.toFixed(3)), yaw: +H.xr.xrDebug().rigYaw.toFixed(3) });
    for (const side of ['right', 'left']) {
      const r = {};
      H.aimAt(side, 'settings', ...g.move); await H.frames(6); H.btn(side, 'squeeze', 1); await H.frames(4);
      r.held = H.xr.xrDebug().held; r.d0 = dist(side); const p0 = pose();
      H.ctl(side).updateAxes('thumbstick', 0.9, -1); await H.frames(4); r.d1 = dist(side);   // forward (and sideways: no walk, no turn)
      for (let i = 0; i < 6 && dist(side) < 2.99; i++) await H.frames(4); r.dMax = dist(side);
      r.still = JSON.stringify(pose()) === JSON.stringify(p0); r.pose = [p0, pose()];
      H.ctl(side).updateAxes('thumbstick', 0, 1); await H.frames(4); r.d2 = dist(side);
      for (let i = 0; i < 10 && dist(side) > 0.26; i++) await H.frames(4); r.dMin = dist(side);
      H.ctl(side).updateAxes('thumbstick', 0, 0); await H.frames(2);
      H.btn(side, 'squeeze', 0); await H.frames(4); r.released = H.xr.xrDebug().held;
      out[side] = r;
    }
    return out;
  }, null, 120000).catch((e) => ({ err: String(e) }));
  console.log('  · pushpull', J(pp));
  for (const side of ['right', 'left']) {
    const r = pp[side] ?? {};
    check(`push/pull (${side} hand): stick forward sends the held panel away, to at most 3 m`, r.held === 'settings' && r.d1 > r.d0 + 0.02 && Math.abs(r.dMax - 3) < 0.01, J(r));
    check(`…back reels it in, to no nearer than 0.25 m`, r.d2 < r.dMax - 0.02 && Math.abs(r.dMin - 0.25) < 0.01, J(r));
    check(`…and the player did not move or turn meanwhile (the stick is the panel's)`, r.still && r.released === null, J(r.pose));
  }

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
