// xr-pointer-probe — the VR pointer pass (owner, 10-02, after comparing with Resonite): the "pointer visibility" setting,
// the ray's low-pass, stickiness on panel controls and nameplates, grip-alone panel grab (never on a control), and the
// surface dot. The real client presenting under IWER; the emulated CONTROLLERS are posed and their buttons pressed, and
// everything after that is the product's own frame (xr.js's per-hand loop). A fake peer joins as a plain socket for
// the nameplate checks (the xr-plate-card probe's peer).
//
//   bash code/scripts/eido-probe.sh -C <worktree> -t 900 tools/xr-pointer-probe.mjs      (one Chrome at a time)
//
// xrpointer-test.mjs is the policy half (the numbers); this is the wiring, in a browser, through real buttons.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
const WORLD = 'pointer';
// IWER, its device loop on a NATIVE rAF (memory: reference_iwer_headless_probe.md §2; the xr-plate-card probe's patch)
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(LOOP).length !== 2) throw new Error('IWER loop pattern did not match exactly once: the patch would silently not apply');
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ worlds: [WORLD], env: { SKIP_OPT_SWEEP: '1' } });
let browser = null;
const peers = [];
const errs = [], conErrs = [];
const ev = (pg, fn, arg, ms = 30000) => Promise.race([pg.evaluate(fn, arg),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out after ${ms} ms`)), ms))]);
function peer(id, pose) {
  const ws = new WebSocket(`${world.origin.replace(/^http/, 'ws')}/ws`);
  const p = { ws, pose, timer: null };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', world: WORLD, id, token: world.key, replica: true }));
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

  const url = `${world.origin}/?world=${WORLD}&name=vrpointer&key=${world.key}&xr=1`;
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

  // ---- 1. the setting's row, in the VR quad --------------------------------------------------------------------------
  const row = await ev(pg, async () => {
    const sel = document.getElementById('vr-pointer-visibility'), btn = sel?.nextElementSibling;
    if (!sel || !btn?.classList.contains('dd')) return { sel: !!sel, btn: btn?.className };
    btn.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 400)); await __h.frames(3);
    const tex = __h.dq.domQuadTexture('settings'), r = __h.rectIn('settings', btn), fr = tex.dom.getBoundingClientRect();
    const at = tex.elementAt(r.cx / fr.width, r.cy / fr.height);
    // ink: the raster under the button is not one flat colour (the label and caret are drawn)
    const cv = tex.image, sx = cv.width / fr.width, sy = cv.height / fr.height;
    const px = cv.getContext('2d').getImageData(Math.round(r.l * sx), Math.round(r.t * sy), Math.max(1, Math.round((r.r - r.l) * sx)), Math.max(1, Math.round((r.b - r.t) * sy))).data;
    let lo = 255, hi = 0; for (let i = 0; i < px.length; i += 4) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); }
    const atIsBtn = !!at && (at === btn || btn.contains(at)), atTag = at && `${at.tagName.toLowerCase()}.${String(at.className).split(' ')[0]}`;   // now: the label repaints (a new span) once the choice lands
    const label = btn.textContent.trim(), nativeHidden = getComputedStyle(sel).opacity === '0' || getComputedStyle(sel).display === 'none';
    const rowLabel = sel.closest('.row')?.querySelector('.nm')?.textContent;
    // choose 'never' the way a person does: trigger on the button, then on the option in the list (inside the quad)
    __h.aimAt('right', 'settings', r.cx, r.cy); await __h.frames(8); await __h.pull('right'); await new Promise((r) => setTimeout(r, 400));
    const pop = tex.dom.querySelector('.dd-pop'), opt = pop && [...pop.querySelectorAll('.dd-opt')].find((o) => /^never/.test(o.textContent));
    let chose = null;
    if (opt) { const o = __h.rectIn('settings', opt); __h.aimAt('right', 'settings', o.cx, o.cy); await __h.frames(8); await __h.pull('right'); await new Promise((r) => setTimeout(r, 300)); chose = __h.xr.xrPrefs.pointerVisibility; }
    let stored = null; try { stored = JSON.parse(localStorage.getItem('ew-xr-prefs') || '{}').pointerVisibility; } catch {}
    return { rowLabel, label, opts: [...sel.options].map((o) => o.value), atIsBtn, at: atTag, nativeHidden, ink: hi - lo, popInQuad: !!pop, chose, stored, after: btn.textContent.trim() };
  });
  console.log('  · row', J(row));
  check('Settings › VR has a "pointer visibility" row: always / never / contextual, showing contextual by default',
    row.rowLabel === 'pointer visibility' && J(row.opts) === J(['always', 'never', 'contextual']) && /^contextual/.test(row.label), J(row));
  check('…it renders in the VR quad: the house dropdown button is what the laser finds there, drawn with ink; the native select is hidden', row.atIsBtn && row.ink > 60 && row.nativeHidden, J(row));
  check('…and a laser + trigger opens its list inside the quad and picks "never": the pref and its storage follow', row.popInQuad && row.chose === 'never' && row.stored === 'never' && /^never/.test(row.after), J(row));

  const drow = await ev(pg, async () => {
    const sel = document.getElementById('vr-dot-visibility'), btn = sel?.nextElementSibling, pv = document.getElementById('vr-pointer-visibility');
    if (!sel) return { none: true };
    const tex = __h.dq.domQuadTexture('settings'), fr = tex.dom.getBoundingClientRect(); btn.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 300));
    const r = __h.rectIn('settings', btn), at = tex.elementAt(r.cx / fr.width, r.cy / fr.height);
    return { label: sel.closest('.row')?.querySelector('.nm')?.textContent, opts: [...sel.options].map((o) => o.value), value: sel.value, inQuad: !!at && (at === btn || btn.contains(at)),
      nextToPointer: pv?.closest('.row')?.nextElementSibling === sel.closest('.row'), pref: __h.xr.xrPrefs.dotVisibility };
  });
  console.log('  · dot row', J(drow));
  check('Settings › VR has a "surface dot visibility" row right after pointer visibility: always / never / contextual, contextual by default, in the VR quad',
    drow.label === 'surface dot visibility' && J(drow.opts) === J(['always', 'never', 'contextual']) && drow.value === 'contextual' && drow.pref === 'contextual' && drow.inQuad && drow.nextToPointer, J(drow));

  // ---- spots on the settings quad: a background point (no control) and a control with room around it ----------------
  const spots = await ev(pg, async () => {
    const H = __h, dom = H.dq.domQuadTexture('settings').dom, fr = dom.getBoundingClientRect();
    const sec = document.getElementById('sec-vr'); sec.querySelector('.body')?.scrollIntoView?.({ block: 'start' }); await new Promise((r) => setTimeout(r, 300));
    const from = H.handFrom('right'), mpp = H.mPerPx('settings');
    const pxFor = (x, y, rad) => from.distanceTo(H.worldAt('settings', x, y)) * Math.tan(rad) / mpp;
    const STAY = H.xp.STICK_STAY_RAD;
    // background: a non-control point with NO control within twice the stay margin (else the laser, coming off a
    // control nearby, would rightly still hold it): the title strip first, then a grid
    const clear = (x, y) => { const k = pxFor(x, y, 2 * STAY); if (x < k || y < k || x > fr.width - k || y > fr.height - k) return false;
      for (let a = 0; a < 16; a++) for (const f of [0, 0.5, 1]) if (H.ctlAt('settings', x + Math.cos(a * Math.PI / 8) * k * f, y + Math.sin(a * Math.PI / 8) * k * f)) return false; return true; };
    let bg = null; const head = dom.querySelector('.fr-head');
    if (head) { const r = H.rectIn('settings', head); for (let x = r.l + 10; x < r.r - 10 && !bg; x += 4) if (clear(x, r.cy)) bg = { x, y: r.cy, where: 'title' }; }
    for (let y = 20; y < fr.height - 10 && !bg; y += 6) for (let x = 10; x < fr.width - 10 && !bg; x += 6) if (clear(x, y)) bg = { x, y, where: 'grid' };
    // stickiness: a visible control, a direction from its edge where the laser leaves it onto BACKGROUND that stays
    // background well past the stay margin. Distances are angles at the hand (px ← metres ← angle × distance).
    const ctls = [...dom.querySelectorAll('button, .dd, input, label')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.height > 8 && r.top >= fr.top + 2 && r.bottom <= fr.bottom - 2 && r.left >= fr.left && r.right <= fr.right; });
    let stick = null;
    for (const el of ctls) {
      const r = H.rectIn('settings', el), c = H.ctlAt('settings', r.cx, r.cy); if (!c || !(c === el || el.contains(c) || c.contains(el))) continue;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const ex = dx ? (dx > 0 ? r.r : r.l) : r.cx, ey = dy ? (dy > 0 ? r.b : r.t) : r.cy;
        const inside = { x: ex - dx * 2, y: ey - dy * 2 };
        const k = pxFor(ex, ey, STAY);
        const near = { x: ex + dx * 0.5 * k, y: ey + dy * 0.5 * k }, far = { x: ex + dx * 1.7 * k, y: ey + dy * 1.7 * k };
        const ok = (p) => p.x > 4 && p.y > 4 && p.x < fr.width - 4 && p.y < fr.height - 4;
        if (!ok(near) || !ok(far)) continue;
        // every sample on the way out is background (so this is the stay case, not the yield case)
        let clear = true; for (let f = 0.15; f <= 1.75; f += 0.1) if (H.ctlAt('settings', ex + dx * f * k, ey + dy * f * k)) { clear = false; break; }
        if (!clear) continue;
        stick = { tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : ''), text: el.textContent.trim().slice(0, 20), inside, near, far, kPx: +k.toFixed(1), dir: [dx, dy] };
        H.stickEl = el; break;
      }
      if (stick) break;
    }
    // yield: two neighbouring tabs in the strip; the seam point just inside B, within the yield margin of A's last point
    let yieldT = null; const tabs = [...dom.querySelectorAll('.pf-tab')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 8 && r.left >= fr.left && r.right <= fr.right; });
    for (let i = 0; i + 1 < tabs.length && !yieldT; i++) {
      const a = H.rectIn('settings', tabs[i]), b = H.rectIn('settings', tabs[i + 1]); if (Math.abs(a.cy - b.cy) > 2) continue;
      const y = a.cy; let ain = null, bin = null;
      for (let x = a.r - 0.5; x > a.l; x -= 0.5) if (H.ctlAt('settings', x, y) === tabs[i]) { ain = x; break; }
      for (let x = a.r; x < b.r; x += 0.5) if (H.ctlAt('settings', x, y) === tabs[i + 1]) { bin = x + 0.5; break; }
      if (ain == null || bin == null) continue;
      const ang = H.xp.angleTo(from, H.worldAt('settings', ain, y).sub(from).normalize(), H.worldAt('settings', bin, y));
      yieldT = { a: { x: ain, y }, b: { x: bin, y }, bc: { x: b.cx, y }, seamRad: +ang.toFixed(4), A: tabs[i].id, B: tabs[i + 1].id };
      H.yieldEls = [tabs[i], tabs[i + 1]];
    }
    return { bg, stick, yieldT, nCtl: ctls.length };
  });
  console.log('  · spots', J(spots));
  if (!spots.bg) throw new Error(`no background spot on the settings quad: ${J(spots)}`);

  // ---- 2. the laser modes -------------------------------------------------------------------------------------------
  const modes = await ev(pg, async ({ bg }) => {
    const H = __h, out = {};
    for (const m of ['contextual', 'always', 'never']) {
      H.xr.setXrPref('pointerVisibility', m);
      const row = {};
      H.up('right'); await H.frames(6); row.nothing = H.dbg().laser.visible; row.nothingLen = H.dbg().laser.len; row.nothingOp = H.dbg().laser.opacity;
      H.aimAt('right', 'settings', bg.x, bg.y); await H.frames(6); row.panel = H.dbg().laser.visible; row.panelLen = H.dbg().laser.len;
      row.panelWant = +H.xr.xrHands().right.aim.getWorldPosition(new H.T.Vector3()).distanceTo(H.worldAt('settings', bg.x, bg.y)).toFixed(4);
      H.up('right'); await H.frames(4); H.btn('right', 'squeeze', 1); await H.frames(4); row.grip = H.dbg().laser.visible; H.btn('right', 'squeeze', 0); await H.frames(3);
      H.btn('right', 'trigger', 1); await H.frames(4); row.trig = H.dbg().laser.visible; H.btn('right', 'trigger', 0); await H.frames(3);
      out[m] = row;
    }
    return out;
  }, { bg: spots.bg }, 90000);
  console.log('  · modes', J(modes));
  const vis = (r) => [r.nothing, r.panel, r.grip, r.trig].map((v) => +v).join('');
  check('contextual: no beam on nothing; a beam on a panel, with grip held (the faint search beam), with trigger held', vis(modes.contextual) === '0111', vis(modes.contextual));
  check('always: the beam on nothing too — short (1.8 m) and faint', vis(modes.always) === '1111' && Math.abs(modes.always.nothingLen - 1.8) < 0.01 && modes.always.nothingOp <= 0.45, J(modes.always));
  check('…and drawn out to the hit on a panel', Math.abs(modes.always.panelLen - modes.always.panelWant) < 0.02, J(modes.always));
  check('never: no beam anywhere, buttons or not', vis(modes.never) === '0000', vis(modes.never));

  // never: pointing still works — a trigger on a control clicks it, the laser holds it, and the stick scrolls
  const never = await ev(pg, async () => {
    const H = __h; H.xr.setXrPref('pointerVisibility', 'never');
    const tab = H.yieldEls?.[0] ?? document.getElementById('sec-vr-tab'); const r = H.rectIn('settings', tab);
    const c0 = H.clicksOn(tab);
    H.aimAt('right', 'settings', r.cx, r.cy); await H.frames(8);
    const held = H.dbg().held, visible = H.dbg().laser.visible;
    await H.pull('right'); await new Promise((res) => setTimeout(res, 300));
    return { clicked: H.clicksOn(tab) - c0, held, visible, tab: tab.id };
  });
  check('never: a trigger on a control still clicks it, and the laser still holds it — with no beam drawn', never.clicked === 1 && never.held?.kind === 'panel' && !never.visible, J(never));

  // ---- the surface dot -------------------------------------------------------------------------------------------------
  const dot = await ev(pg, async ({ bg }) => {
    const H = __h, T = H.T, out = {};
    const eyeP = () => EW.renderer.xr.getCamera().getWorldPosition(new T.Vector3());
    const read = () => { const d = H.dbg().dot; return { ...d, p: new T.Vector3().fromArray(d.pos), n: new T.Vector3().fromArray(d.normal) }; };
    for (const m of ['contextual', 'never']) {
      H.xr.setXrPref('pointerVisibility', m);
      H.aimAt('right', 'settings', bg.x, bg.y); await H.frames(8);
      const d = read(), want = H.worldAt('settings', bg.x, bg.y), mesh = H.meshOf('settings');
      const qn = new T.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new T.Quaternion())), e = eyeP();
      const off = d.p.clone().sub(want);
      out[m] = { visible: d.visible, beam: H.dbg().laser.visible, inScene: d.inScene, bent: H.dbg().bent,
        along: +off.dot(qn).toFixed(4), across: +off.clone().addScaledVector(qn, -off.dot(qn)).length().toFixed(4),   // lift off the surface; slide along it
        facing: +d.n.dot(qn).toFixed(4), angDiam: +(d.diam / e.distanceTo(d.p)).toFixed(5) };
    }
    H.xr.setXrPref('pointerVisibility', 'contextual');
    H.up('right'); await H.frames(6); out.none = read().visible;
    // world entities: a box registered in the world's entity table for the check (then removed) — PLAIN first (no
    // components: a wall), then INTERACTABLE (a sockets component, as a chair has)
    const world = await import('./lib/world.js'); const { replica } = await import('./lib/net.js');
    const from = H.handFrom('right'), h = H.head(), at = from.clone().addScaledVector(h.f, 2.2).add(new T.Vector3(0, 0.2, 0));
    const box = new T.Mesh(new T.BoxGeometry(0.6, 0.6, 0.6), new T.MeshBasicNodeMaterial({ color: 0x556677 }));
    box.position.copy(at); box.lookAt(from.x, at.y, from.z); box.userData.entityId = 'probe-box'; EW.scene.add(box); box.updateMatrixWorld(true);
    world.entities.set('probe-box', box);
    const want = +from.distanceTo(at.clone().addScaledVector(from.clone().sub(at).normalize(), 0.3)).toFixed(2);
    const beam = () => ({ vis: H.dbg().laser.visible, len: +H.dbg().laser.len.toFixed(2), op: H.dbg().laser.opacity });
    try {
      H.aim('right', from, at); await H.frames(5);
      out.plainIdle = { dot: read().visible, beam: beam(), ent: H.dbg().ent };
      H.btn('right', 'squeeze', 1); await H.frames(5);
      out.plainGrip = { dot: read().visible, beam: beam() };
      H.btn('right', 'squeeze', 0); await H.frames(3);
      H.xr.setXrPref('dotVisibility', 'always'); await H.frames(4);
      out.plainAlways = { dot: read().visible, kind: H.dbg().dot.kind };
      H.xr.setXrPref('dotVisibility', 'contextual');
      // the record every reader holds is the fold's (world.js bagOf reads replica.st, C7c): the probe's fake entity gets a fake record there
      replica.st.entities['probe-box'] = { born: 0, c: { transform: {}, sockets: { seat: { pose: 'sitchair' } } } }; await H.frames(5);
      const d = read(), fn = from.clone().sub(at).setY(0).normalize();   // the face toward the hand: its plane is 0.3 m out along fn
      const toRay = d.p.clone().sub(from).cross(at.clone().sub(from).normalize()).length();
      out.ent = { visible: d.visible, kind: H.dbg().dot.kind, beam: beam(), want, ent: H.dbg().ent, lift: +(d.p.clone().sub(at).dot(fn) - 0.3).toFixed(4), onRay: +toRay.toFixed(4), facing: +d.n.dot(fn).toFixed(4), angDiam: +(d.diam / eyeP().distanceTo(d.p)).toFixed(5) };
      // pointer visibility 'never' hides only the beam: the dot keeps its own setting; dot 'never' hides the dot
      H.xr.setXrPref('pointerVisibility', 'never'); await H.frames(3); out.entNeverBeam = { dot: read().visible, beam: H.dbg().laser.visible };
      H.xr.setXrPref('pointerVisibility', 'contextual'); H.xr.setXrPref('dotVisibility', 'never'); await H.frames(3); out.entNeverDot = { dot: read().visible, beam: H.dbg().laser.visible };
      H.xr.setXrPref('dotVisibility', 'contextual');
    } finally { world.entities.delete('probe-box'); delete replica.st.entities['probe-box']; box.removeFromParent(); }
    return out;
  }, { bg: spots.bg }, 60000);
  console.log('  · dot', J(dot));
  const DOT = 0.007;
  check('the dot sits on the panel where the laser meets it (a hair off the surface, on the hit point), facing out', dot.contextual.visible && dot.contextual.inScene
    && dot.contextual.along > 0 && dot.contextual.along < 0.004 && dot.contextual.across < 0.003 && dot.contextual.facing > 0.999, J(dot.contextual));
  check('…constant in angle (≈0.007 rad across, at any distance)', Math.abs(dot.contextual.angDiam - DOT) < 0.0005 && Math.abs(dot.ent?.angDiam - DOT) < 0.0005, J([dot.contextual.angDiam, dot.ent?.angDiam]));
  check('…shown in never mode too, with no beam: it is the only mark', dot.never.visible && !dot.never.beam && dot.never.across < 0.003, J(dot.never));
  check('…hidden with no target', dot.none === false, J(dot.none));
  check('a PLAIN entity (a wall), contextual: an idle hand shows no beam and no dot', dot.plainIdle?.ent?.id === 'probe-box' && !dot.plainIdle.ent.interactable && !dot.plainIdle.dot && !dot.plainIdle.beam.vis, J(dot.plainIdle));
  check('…grip held: the search beam reaches it (full length), but no dot (contextual dot = the beam\'s targets only)', dot.plainGrip?.beam.vis && Math.abs(dot.plainGrip.beam.len - dot.ent?.want) < 0.05 && !dot.plainGrip.dot, J({ g: dot.plainGrip, want: dot.ent?.want }));
  check('…dot visibility "always": the dot marks it, as a plain dot (nothing to do there)', dot.plainAlways?.dot && dot.plainAlways.kind === 'dot', J(dot.plainAlways));
  check('an INTERACTABLE entity (sockets), idle hand: the contextual beam reaches it at full strength and the dot sits on its face as a click icon',
    dot.ent?.ent?.interactable && dot.ent.visible && dot.ent.kind === 'click' && dot.ent.beam.vis && Math.abs(dot.ent.beam.len - dot.ent.want) < 0.05 && dot.ent.beam.op >= 0.85
    && dot.ent.lift >= 0 && dot.ent.lift < 0.01 && dot.ent.onRay < 0.01 && dot.ent.facing > 0.99, J(dot.ent));
  check('pointer visibility "never" hides only the beam (the dot keeps its own setting); dot visibility "never" hides only the dot',
    dot.entNeverBeam?.dot && !dot.entNeverBeam.beam && !dot.entNeverDot?.dot && dot.entNeverDot.beam, J([dot.entNeverBeam, dot.entNeverDot]));

  // ---- 3. smoothing, as wired: the aim is the controller's ray low-passed by the frame's own dt ----------------------
  const sm = await ev(pg, async ({ bg }) => {
    const H = __h, T = H.T; H.xr.setXrPref('pointerVisibility', 'always');
    H.aimAt('right', 'settings', bg.x, bg.y); await H.frames(10);
    const hand = H.xr.xrHands().right;
    const ang = () => hand.aim.getWorldQuaternion(new T.Quaternion()).angleTo(hand.ray.getWorldQuaternion(new T.Quaternion()));
    const settled = ang();
    // a 0.15 rad step (under the snap angle): sample the lag every frame for 6 frames with the frame's dt
    const from = H.handFrom('right'), to = H.worldAt('settings', bg.x, bg.y);
    const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), 0.15);
    H.aim('right', from, from.clone().add(to.clone().sub(from).applyQuaternion(q)));
    const rows = []; let f = globalThis.__perf.frameNo, t = performance.now(); const t0 = t;
    while (rows.length < 6 && performance.now() - t0 < 15000) { await new Promise((r) => setTimeout(r, 5));
      if (globalThis.__perf.frameNo !== f) { const now = performance.now(); const lq = hand.laser.getWorldQuaternion(new T.Quaternion());
        // the beam's angle to the aim and to the raw controller ray, on the same frame (they differ only while it lags)
        rows.push({ lag: +ang().toFixed(5), dtMs: +(now - t).toFixed(1), beamToAim: +lq.angleTo(hand.aim.getWorldQuaternion(new T.Quaternion())).toFixed(6), beamToRaw: +lq.angleTo(hand.ray.getWorldQuaternion(new T.Quaternion())).toFixed(6) });
        f = globalThis.__perf.frameNo; t = now; } }
    return { settled: +settled.toFixed(6), rows, tau: H.xp.POINTER_TAU };
  }, { bg: spots.bg }, 40000);
  console.log('  · smoothing', J(sm));
  // in headless software GL a frame is tens to hundreds of ms, so the lag closes in a frame or two; what must hold:
  // right after the step the aim trails the controller (it is filtered), and it closes to nothing (it is not stuck)
  const firstLag = sm.rows.find((r) => r.lag > 5e-5);   // frame.js caps dt at 0.1 s: two frames after the step at least 0.15·e^(−2·0.1/τ) ≈ 2e-4 rad is left
  check('smoothing is wired: after a 0.15 rad step the aim trails the controller, then closes on it', !!firstLag && sm.rows.at(-1).lag < 0.002 && sm.settled < 0.002, J(sm));
  check('…the beam is drawn along the smoothed aim, not the raw controller ray (on the frame it lags)', !!firstLag && firstLag.beamToAim < 1e-5 && firstLag.beamToRaw > 5e-5, J(firstLag));

  // ---- 4. stickiness on a panel control ---------------------------------------------------------------------------------
  if (!spots.stick) check('stickiness: found a control with background around it on the settings quad', false, J(spots));
  else {
    const stk = await ev(pg, async (s) => {
      const H = __h, el = H.stickEl, rows = {};
      const go = async (p, n = 8) => { H.aimAt('right', 'settings', p.x, p.y); await H.frames(n); const d = H.dbg(), u = H.ctlUnderDot('settings');
        return { held: d.held, el: d.heldEl === el || (d.heldEl && el.contains(d.heldEl)), bent: d.bent, len: d.laser.len, dotOn: !!u && (u === el || el.contains(u)) }; };
      rows.inside = await go(s.inside);
      rows.near = await go(s.near);
      rows.far = await go(s.far);
      // again, and this time a trigger at the drifted point (a press drops the hold: it is checked last)
      await go(s.inside); await go(s.near);
      const c0 = H.clicksOn(el); await H.pull('right'); rows.nearClick = H.clicksOn(el) - c0;
      // the raw ray at `near` is on background: confirm it, so 'held' above is the stickiness and not a miss
      rows.rawNear = H.ctlAt('settings', s.near.x, s.near.y)?.tagName ?? null;
      return rows;
    }, spots.stick, 60000);
    console.log('  · stick', J(stk));
    check('stickiness: the laser on a control holds it', stk.inside.el && !stk.inside.bent, J(stk.inside));
    check('…drifting half the stay margin onto background, it still holds it: the ray bends onto it (the dot is on the control)', stk.rawNear === null && stk.near.el && stk.near.bent && stk.near.dotOn, J({ near: stk.near, raw: stk.rawNear }));
    check('…and a trigger there clicks that control', stk.nearClick === 1, J(stk));
    check('…past the margin (1.7×) it lets go', !stk.far.held && !stk.far.bent, J(stk.far));
  }
  if (!spots.yieldT) console.log('  · yield: no neighbouring tabs with a shared seam (not testable on this layout)');
  else {
    const yl = await ev(pg, async (s) => {
      const H = __h, [A, B] = H.yieldEls;
      const go = async (p, n = 8) => { H.aimAt('right', 'settings', p.x, p.y); await H.frames(n); const d = H.dbg(), u = H.ctlUnderDot('settings'); return { A: d.heldEl === A, B: d.heldEl === B, bent: d.bent, dotA: u === A, dotB: u === B }; };
      return { a: await go(s.a), seam: await go(s.b), deep: await go(s.bc), rawSeamIsB: H.ctlAt('settings', s.b.x, s.b.y) === B };
    }, spots.yieldT, 60000);
    console.log('  · yield', J(yl), 'seam', spots.yieldT.seamRad, 'rad');
    check('yield: across the seam onto the next tab, within the yield margin, the first tab still holds (no flicker)',
      spots.yieldT.seamRad < 0.008 && yl.a.A && yl.rawSeamIsB && yl.seam.A && yl.seam.bent && yl.seam.dotA, J(yl));
    check('…well into the next tab, it takes over', yl.deep.B && !yl.deep.bent && yl.deep.dotB, J(yl.deep));
  }

  // ---- 5. grab: grip alone, never on a control; no chord ---------------------------------------------------------------
  const grab = await ev(pg, async ({ bg }) => {
    const H = __h, out = {}, ctl = H.stickEl ?? document.getElementById('sec-vr-tab'), r = H.rectIn('settings', ctl);
    H.xr.setXrPref('pointerVisibility', 'contextual');
    // a) grip over a control: nothing
    H.aimAt('right', 'settings', r.cx, r.cy); await H.frames(8);
    H.btn('right', 'squeeze', 1); await H.frames(5); out.onCtl = H.held(); H.btn('right', 'squeeze', 0); await H.frames(4);
    // b) grip + trigger together over a control: the trigger clicks, nothing is grabbed (no chord)
    const c0 = H.clicksOn(ctl);
    H.btn('right', 'squeeze', 1); H.btn('right', 'trigger', 1); await H.frames(5); out.chordCtl = H.held();
    H.btn('right', 'trigger', 0); await H.frames(3); H.btn('right', 'squeeze', 0); await H.frames(4); out.chordCtlClicks = H.clicksOn(ctl) - c0;
    // c) the old chord's shape: grip held FIRST over nothing, the laser swept onto the background, then the trigger
    H.up('right'); await H.frames(4); H.btn('right', 'squeeze', 1); await H.frames(4);
    H.aimAt('right', 'settings', bg.x, bg.y); await H.frames(6); H.btn('right', 'trigger', 1); await H.frames(5); out.sweptChord = H.held();
    H.btn('right', 'trigger', 0); await H.frames(3); H.btn('right', 'squeeze', 0); await H.frames(4);
    // d) grip alone on the background (or title): it grabs; the panel rides the hand
    H.aimAt('right', 'settings', bg.x, bg.y); await H.frames(8);
    const mesh = H.meshOf('settings');
    H.btn('right', 'squeeze', 1); await H.frames(5); out.onBg = H.held(); out.inGrip = mesh.parent === H.xr.xrHands().right.grip;
    // e) the trigger while holding: nothing happens (no click anywhere, still held)
    const n0 = H.clickLog.length; H.btn('right', 'trigger', 1); await H.frames(4); H.btn('right', 'trigger', 0); await H.frames(4);
    out.trigWhileHeld = { clicks: H.clickLog.length - n0, held: H.held() };
    // f) grip released: placed, back on the rig
    H.btn('right', 'squeeze', 0); await H.frames(5); out.released = H.held(); out.backOnRig = mesh.parent === H.xr.xrRig();
    return out;
  }, { bg: spots.bg }, 90000);
  console.log('  · grab', J(grab));
  check('grip over a control does NOT grab the panel', grab.onCtl === null, J(grab));
  check('grip + trigger over a control: the trigger clicks it, the panel is not grabbed (no chord)', grab.chordCtl === null && grab.chordCtlClicks === 1, J(grab));
  check('grip held first, laser swept onto the background, then trigger: not a grab (the old chord is gone; grip grabs on its press only)', grab.sweptChord === null, J(grab));
  check('grip alone on the panel\'s background grabs it: it rides the hand', grab.onBg === 'settings' && grab.inGrip, J(grab));
  check('…the trigger while holding does nothing (no click, still held)', grab.trigWhileHeld.clicks === 0 && grab.trigWhileHeld.held === 'settings', J(grab.trigWhileHeld));
  check('…released with the grip, back on the rig', grab.released === null && grab.backOnRig, J(grab));

  // ---- 6. nameplates: hover, stickiness through a drift, let go past the margin --------------------------------------------
  await ev(pg, async () => { __h.dq.domQuadShow('settings', false); __h.xr.setXrPref('pointerVisibility', 'contextual'); __h.down('right'); await __h.frames(4); });
  const spot = await ev(pg, () => { const h = __h.head(), me = EW.myState.pos; const p = h.p.clone().addScaledVector(h.f, 3); return [p.x, me.y, p.z]; });
  P.pose = { ...P.pose, p: spot };
  await pg.waitForFunction(() => { const r = EW.remotes.get('vrpeer'); return r?.avatar?.label && !r.loading; }, null, { timeout: 90000 });
  await ev(pg, async () => { let last = EW.remotes.get('vrpeer')?.avatar, since = performance.now();
    while (performance.now() - since < 2000) { await new Promise((r) => setTimeout(r, 100)); const now = EW.remotes.get('vrpeer')?.avatar; if (now !== last || EW.remotes.get('vrpeer')?.loading) { last = now; since = performance.now(); } }
    await __h.frames(4); }, null, 60000);
  const plate = await ev(pg, async () => {
    const H = __h, T = H.T, lab = EW.remotes.get('vrpeer').avatar.label;
    const from = H.handFrom('right'), P0 = lab.getWorldPosition(new T.Vector3());
    // drift to the LEFT: the card opens on the plate's right, and the laser on the card counts as on the plate (by design)
    const eye = EW.camera.getWorldPosition(new T.Vector3()), r = P0.clone().sub(eye).cross(new T.Vector3(0, 1, 0)).normalize().negate();
    const hw = lab.getWorldScale(new T.Vector3()).x * (lab.userData.pill ?? 0.5) / 2;
    const D = from.distanceTo(P0), slack = H.xp.PLATE_GETON_RAD * D, STAY = H.xp.STICK_STAY_RAD;
    const at = (m) => P0.clone().addScaledVector(r, m);
    const sample = async (p, n = 8) => { H.aim('right', from, p); await H.frames(n); const d = H.dbg(), s = H.state(); return { held: d.held?.key ?? null, bent: d.bent, hover: s.hoverId, open: s.open }; };
    const out = { D: +D.toFixed(2), hw: +hw.toFixed(3), slack: +slack.toFixed(3), occluded: !!lab.userData.occluded };
    out.centre = await sample(at(0), 10);
    { const d = H.dbg().dot, p = new T.Vector3().fromArray(d.pos), n = new T.Vector3().fromArray(d.normal), e = EW.renderer.xr.getCamera().getWorldPosition(new T.Vector3());
      const rayDir = P0.clone().sub(from).normalize(), onRay = p.clone().sub(from).cross(rayDir).length();
      out.dot = { visible: d.visible, toPlate: +Math.abs(p.clone().sub(P0).dot(e.clone().sub(P0).normalize())).toFixed(3), onRay: +onRay.toFixed(4), facingEye: +n.dot(e.clone().sub(p).normalize()).toFixed(4) }; }
    out.edge = await sample(at(hw - 0.005), 8);
    // off the pill AND past its get-on slack, but within the stay margin of the last point on it (the edge)
    out.nearOff = await sample(at(hw + slack + 0.3 * STAY * D), 8);
    out.nearOffRaw = H.pc.platePick({ matrixWorld: new T.Matrix4().compose(from, new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), at(hw + slack + 0.3 * STAY * D).sub(from).normalize()), new T.Vector3(1, 1, 1)) }, EW.renderer.xr.getCamera())?.id ?? null;
    out.far = await sample(at(hw + slack + 1.6 * STAY * D), 8);
    // the card is up after the hover delay while the laser held on; aim away and it goes
    H.down('right'); await H.frames(6);
    return out;
  }, null, 60000);
  console.log('  · plate', J(plate));
  check('nameplate: the laser on the pill holds the plate and hovers it', plate.centre.held === 'plate:vrpeer' && plate.centre.hover === 'vrpeer' && !plate.occluded, J(plate));
  check('the dot on a nameplate: on the laser at the plate\'s depth, facing the eye', plate.dot.visible && plate.dot.onRay < 0.01 && plate.dot.toPlate < 0.05 && plate.dot.facingEye > 0.999, J(plate.dot));
  check('…drifting off the pill past its get-on slack (the raw ray finds nothing), within the stay margin: still held, still hovered', plate.nearOffRaw === null && plate.nearOff.held === 'plate:vrpeer' && plate.nearOff.bent && plate.nearOff.hover === 'vrpeer', J(plate));
  check('…past the stay margin: let go, no hover', plate.far.held === null && plate.far.hover !== 'vrpeer', J(plate.far));

  // ---- 7. leave VR; the setting survives a reload --------------------------------------------------------------------
  await ev(pg, () => { __h.xr.setXrPref('pointerVisibility', 'always'); __h.xr.leaveVR('probe'); });
  await pg.waitForFunction(() => !EW.renderer.xr.isPresenting, null, { timeout: 30000, polling: 250 });
  const gone = await ev(pg, () => { const hs = __h.xr.xrHands(); return { beams: ['left', 'right'].map((k) => !!hs[k]?.laser.parent), held: __h.xr.xrDebug().held }; });
  check('leaving VR takes the beams out of the scene', !gone.beams.some(Boolean) && gone.held === null, J(gone));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  const known = (t) => /Invalid value used as weak map key/.test(t);   // IWER's null XRWebGLLayer.framebuffer (memory §4): an emulator artifact
  const other = conErrs.filter((t) => !known(t) && !/401|whoami/.test(t));
  console.log(`  · console.error: ${conErrs.length} (${conErrs.filter(known).length} the IWER null-framebuffer artifact)${other.length ? ` other: ${other.slice(0, 3).join(' | ')}` : ''}`);
  check('no console errors beyond the disclosed emulator artifact', other.length === 0, other.slice(0, 3).join(' | '));
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => !!globalThis.EW?.me?.(), null, { timeout: 120000 });
  const re = await ev(pg, async () => { const xr = await import('./lib/xr.js'); return { pref: xr.xrPrefs.pointerVisibility, sel: document.getElementById('vr-pointer-visibility')?.value ?? '(row not built until the section opens)' }; });
  check('the setting persists across a reload (the other VR prefs\' storage)', re.pref === 'always', J(re));
} catch (e) { check('probe ran', false, e?.stack?.split('\n').slice(0, 3).join(' ') ?? String(e)); }
finally {
  for (const p of peers) { clearInterval(p.timer); try { p.ws.close(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
