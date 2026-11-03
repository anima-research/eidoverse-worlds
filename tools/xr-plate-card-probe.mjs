// xr-plate-card-probe — VR's hover (owner, 10-02: "VR has no hover — … you can still laser-point at someone's label").
// The real client presenting under IWER; a fake peer joined as a plain socket (the nameplate-card probe's peers); the
// emulated CONTROLLERS are posed so their target rays point where the probe wants, and everything after that is the
// product's own frame: xr.js's per-hand laser loop → platecard.platePick → the hover timer → the card's quad.
//
//   bun tools/xr-plate-card-probe.mjs      (run it through code/scripts/eido-probe.sh: one Chrome at a time)
//
// What must hold:
//   the laser resting on a remote's plate opens that person's card, only after HOVER_MS, and draws out to the plate at
//     full strength; the card is the real #platecard DOM on a quad (panel colour handling), beside the plate at its
//     depth, right of the pill, upright and facing the eye, at the panels' angular size; it shows the rows (name, mic,
//     hearing, VR) and not the desktop-only "message" button;
//   aiming away closes it; the LEFT hand opens it too; the head under the plate counts as the plate;
//   a panel in front of the plate claims the laser and opens nothing — and with that panel hidden, the same aim opens
//     the card (so the red is about the panel, not a missed aim);
//   leaving VR drops the quad and puts the desktop card back as it was.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { readFileSync } from 'node:fs';

const { check, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORLD = 'plates';
// IWER, with its device loop on a NATIVE rAF (memory: reference_iwer_headless_probe.md §2; same patch as xr-panel-drag-probe)
const IWER_RAW = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
if (IWER_RAW.split(LOOP).length !== 2) throw new Error('IWER loop pattern did not match exactly once: the patch would silently not apply');
const IWER = `globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
let browser = null;
const peers = [];
const errs = [], conErrs = [];
// every evaluate races a clock: a pinned main thread must print a line, not hang the run (hygiene item 7)
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

  await pg.goto(`${world.origin}/?world=${WORLD}&name=vrplate&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none' && !!globalThis.EW?.me?.(); }, null, { timeout: 120000 });
  // the peer joins before entry, parked; it is moved in front of the headset once the head pose exists
  const P = peer('vrmute', { yaw: 0, speed: 0, clip: 'idle', presence: 'present', p: [0, 0, 6], mic: false, hear: false });
  await ev(pg, () => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout: 30000, polling: 250 });

  // in-page helpers: frames, the head, the hands, controller aiming (one calibration per hand: ray world = R · pose)
  await ev(pg, async () => {
    const xr = await import('./lib/xr.js'), pc = await import('./lib/platecard.js'), dq = await import('./lib/domquad.js');
    const T = EW.THREE, dev = window.__iwerDevice;
    const H = globalThis.__h = { xr, pc, dq, T, R: {} };
    H.frames = (n) => new Promise((res) => { const f0 = globalThis.__perf.frameNo; const t0 = performance.now();
      const iv = setInterval(() => { if (globalThis.__perf.frameNo - f0 >= n || performance.now() - t0 > 20000) { clearInterval(iv); res(globalThis.__perf.frameNo - f0); } }, 20); });
    H.head = () => { const m = EW.renderer.xr.getCamera().matrixWorld; const p = new T.Vector3().setFromMatrixPosition(m);
      const f = new T.Vector3(-m.elements[8], 0, -m.elements[10]).normalize(); return { p, f, r: new T.Vector3(-f.z, 0, f.x) }; };
    H.ctl = (side) => dev.controllers[side];
    H.poseMat = (side) => { const c = H.ctl(side); return new T.Matrix4().compose(new T.Vector3(c.position.x, c.position.y, c.position.z),
      new T.Quaternion(c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w), new T.Vector3(1, 1, 1)); };
    H.calibrate = async (side) => { await H.frames(3); const W = xr.xrHands()[side].ray.matrixWorld.clone();
      H.R[side] = W.multiply(H.poseMat(side).invert()); };
    // point `side`'s target ray from world point `from` at world point `to`
    H.aim = (side, from, to) => {
      const dir = new T.Vector3().subVectors(to, from).normalize();
      const Wd = new T.Matrix4().compose(from, new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), dir), new T.Vector3(1, 1, 1));
      const Pm = H.R[side].clone().invert().multiply(Wd);
      const p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3(); Pm.decompose(p, q, s);
      const c = H.ctl(side); c.position.set(p.x, p.y, p.z); c.quaternion.set(q.x, q.y, q.z, q.w);
    };
    H.handFrom = (side) => { const h = H.head(); return h.p.clone().addScaledVector(h.r, side === 'right' ? 0.2 : -0.2).addScaledVector(h.f, 0.25).add(new T.Vector3(0, -0.35, 0)); };
    H.down = (side) => { const from = H.handFrom(side); H.aim(side, from, from.clone().add(new T.Vector3(0, -1, 0.05))); };   // at the floor, away from everything
    H.plateOf = (id) => { const av = EW.remotes.get(id)?.avatar; return av?.label ? av.label.getWorldPosition(new T.Vector3()) : null; };
    H.state = () => pc.plateCardState();
  });
  await pg.waitForFunction(() => globalThis.__perf.frameNo > 0, null, { timeout: 30000 });
  await ev(pg, async () => { await __h.calibrate('right'); await __h.calibrate('left'); __h.down('right'); __h.down('left'); await __h.frames(4); });

  // the peer, 3 m in front of the headset on my floor
  const spot = await ev(pg, () => { const h = __h.head(), me = EW.myState.pos; const p = h.p.clone().addScaledVector(h.f, 3);
    return [p.x, me.y, p.z]; });
  P.pose = { ...P.pose, p: spot };
  await pg.waitForFunction(() => { const r = EW.remotes.get('vrmute'); return r?.avatar?.label && r.hear === false && !r.loading; }, null, { timeout: 90000 });
  await ev(pg, async () => {   // a settled body: the same avatar object for 2 s, at its place
    let last = EW.remotes.get('vrmute')?.avatar, since = performance.now();
    while (performance.now() - since < 2000) { await new Promise((r) => setTimeout(r, 100));
      const now = EW.remotes.get('vrmute')?.avatar; if (now !== last || EW.remotes.get('vrmute')?.loading) { last = now; since = performance.now(); } }
    await __h.frames(4);
  }, null, 60000);
  const stage = await ev(pg, () => { const lab = EW.remotes.get('vrmute').avatar.label, hands = __h.xr.xrHands();
    return { presenting: EW.renderer.xr.isPresenting, sources: [...EW.renderer.xr.getSession().inputSources].map((s) => s.handedness).join(','),
      hands: !!hands.left?.ray && !!hands.right?.ray, labelVis: lab.visible, op: +lab.material.opacity.toFixed(2), occluded: lab.userData.occluded,
      plateDist: +__h.plateOf('vrmute').distanceTo(__h.head().p).toFixed(2), vr: __h.state().vr, frameNo: globalThis.__perf.frameNo }; });
  console.log('  · stage', JSON.stringify(stage));
  if (!(stage.presenting && stage.hands && stage.labelVis && stage.vr)) throw new Error(`readiness gate failed: ${JSON.stringify(stage)}`);
  check('stage: presenting, both hands filed, the peer\'s plate drawn and not occluded', stage.sources.includes('right') && stage.sources.includes('left')
    && stage.op >= 0.1 && stage.occluded !== true, JSON.stringify(stage));

  // poll the card state until `want` (or the clock), keeping every sample: the first hover sample says whether it was
  // open BEFORE the delay ran out
  const watch = (want, ms = 8000) => ev(pg, async ([want, ms]) => {
    const f = new Function('s', `return (${want})(s)`); const t0 = performance.now(), seen = [];
    while (performance.now() - t0 < ms) { const s = __h.state(); seen.push({ open: s.open, for: s.for, hover: s.hoverId }); if (f(s)) return { ok: true, s, seen: seen.slice(0, 6), n: seen.length };
      await new Promise((r) => setTimeout(r, 25)); }
    return { ok: false, s: __h.state(), seen: seen.slice(-6), n: seen.length };
  }, [want.toString(), ms], ms + 5000);

  // ---- 1. the right laser rests on the plate ------------------------------------------------------------------------
  await ev(pg, () => { __h.aim('right', __h.handFrom('right'), __h.plateOf('vrmute')); });
  const o1 = await watch((s) => s.open && s.for === 'vrmute');
  const firstHover = o1.seen.find((x) => x.hover === 'vrmute');
  check('right laser on the plate: the card opens, for that person, by hover', o1.ok && o1.s.by === 'hover', JSON.stringify(o1.s));
  // the product's own clock decides this: a 25 ms poll cannot see inside one slow software-GL frame (the hover can begin
  // and the card open between two samples), so whether a closed-while-hovering sample was caught is printed, not asserted
  check('…only after the delay: opened ≥ HOVER_MS (300 ms) after the hover on that plate began',
    o1.ok && o1.s.hoverId === 'vrmute' && o1.s.openedAt - o1.s.hoverSince >= 300 - 1,
    JSON.stringify({ firstHover, waited: o1.ok && +(o1.s.openedAt - o1.s.hoverSince).toFixed(0) }));
  await ev(pg, () => __h.frames(3));
  const geo = await ev(pg, () => {
    const T = __h.T, m = __h.pc.plateCardMesh(), card = document.getElementById('platecard'), lab = EW.remotes.get('vrmute').avatar.label;
    const eye = EW.camera.getWorldPosition(new T.Vector3()), P = lab.getWorldPosition(new T.Vector3());
    const f = P.clone().sub(eye), dist = f.length(); const r = f.clone().cross(new T.Vector3(0, 1, 0)).normalize(); f.normalize();
    const mp = m.getWorldPosition(new T.Vector3()), off = mp.clone().sub(P);
    const ls = lab.getWorldScale(new T.Vector3()), hw = ls.x * (lab.userData.pill ?? 0.5) / 2;
    const w = card.offsetWidth, h = card.offsetHeight, s = m.scale.x / 1000;
    const meshW = m.geometry.parameters.width * m.scale.x;
    const nz = new T.Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new T.Quaternion()));
    const toEye = eye.clone().sub(mp).normalize();
    const rightOfPill = off.dot(r) - meshW / 2 - hw;      // gap between the pill's right edge and the card's left edge, m
    const tex = m.material.map, cv = tex.image, x = cv.getContext('2d'), px = x.getImageData(0, 0, cv.width, cv.height).data;
    let solid = 0, bright = 0; for (let i = 0; i < px.length; i += 4) { if (px[i + 3] > 200) solid++; if (px[i + 3] > 200 && Math.max(px[i], px[i + 1], px[i + 2]) > 150) bright++; }
    const hand = __h.xr.xrHands().right;
    const ray0 = new T.Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    return { inScene: m.parent === EW.scene, visible: m.visible, node: !!m.material.isNodeMaterial && !!m.material.outputNode,
      dist: +dist.toFixed(3), depthCard: +mp.clone().sub(eye).dot(f).toFixed(3), depthPlate: +P.clone().sub(eye).dot(f).toFixed(3),
      along: +off.dot(r).toFixed(3), want: +(hw + (10 + w / 2) * s).toFixed(3), up: +off.y.toFixed(3), rightOfPill: +rightOfPill.toFixed(3),
      facing: +nz.dot(toEye).toFixed(4), upright: +Math.abs(new T.Vector3(1, 0, 0).applyQuaternion(m.getWorldQuaternion(new T.Quaternion())).y).toFixed(4),
      radPerPx: +(meshW / w / dist).toFixed(5), raster: +(cv.width / w).toFixed(2), rasterH: +(cv.height / h).toFixed(2), cssW: w, cssH: h,
      fontPx: parseFloat(getComputedStyle(card).fontSize), solid: +(solid / (cv.width * cv.height)).toFixed(3), bright,
      xr: card.dataset.xr !== undefined, btns: getComputedStyle(card.querySelector('.pc-btns')).display, text: card.textContent.replace(/\s+/g, ' ').trim(),
      offDesk: card.getBoundingClientRect().right < 0,
      laser: { vis: hand.laser.visible, len: +hand.laser.scale.z.toFixed(3), op: hand.laser.userData.opacity.value, want: +ray0.distanceTo(P).toFixed(3) } };
  });
  console.log('  · card', JSON.stringify(geo));
  check('…the laser draws out to the plate at full strength', geo.laser.vis && Math.abs(geo.laser.len - geo.laser.want) < 0.1 && geo.laser.op >= 0.85, JSON.stringify(geo.laser));
  check('card quad: the real #platecard on a quad in the scene, with the panels\' colour material', geo.inScene && geo.visible && geo.node, JSON.stringify(geo));
  check('…beside the plate: right of the pill by the gap, level with it, at the plate\'s depth',
    Math.abs(geo.along - geo.want) < 0.01 && geo.rightOfPill > 0 && Math.abs(geo.up) < 0.01 && Math.abs(geo.depthCard - geo.depthPlate) < 0.01, JSON.stringify(geo));
  check('…facing the eye, upright (no roll)', geo.facing > 0.995 && geo.upright < 0.01, JSON.stringify({ facing: geo.facing, upright: geo.upright }));
  check('…at the panels\' angular size (0.002 rad per CSS px), rasterised at 2.5 px per CSS px', Math.abs(geo.radPerPx - 0.002) < 0.0001 && Math.abs(geo.raster - 2.5) < 0.05,
    JSON.stringify({ radPerPx: geo.radPerPx, raster: geo.raster, fontPx: geo.fontPx, textDeg: +(geo.fontPx * 0.002 * 57.3).toFixed(2) }));
  check('…drawn: an opaque card with ink on it (not an empty or faded raster)', geo.solid > 0.8 && geo.bright > 200, JSON.stringify({ solid: geo.solid, bright: geo.bright }));
  check('rows: name, mic off, headphones off, not in VR', /vrmute/.test(geo.text) && /mic off/.test(geo.text) && /headphones off/.test(geo.text) && /not in VR/.test(geo.text), geo.text);
  check('…and no "message" button in VR (a desktop surface); the DOM card is off the desktop mirror', geo.xr && geo.btns === 'none' && geo.offDesk, JSON.stringify({ xr: geo.xr, btns: geo.btns, offDesk: geo.offDesk }));

  // ---- 2. aim away: it closes ---------------------------------------------------------------------------------------
  await ev(pg, () => __h.down('right'));
  const c1 = await watch((s) => !s.open);
  const m1 = await ev(pg, () => __h.pc.plateCardMesh()?.visible ?? null);
  check('aiming away closes the card (and hides its quad)', c1.ok && m1 === false, JSON.stringify({ s: c1.s, mesh: m1 }));

  // ---- 2b. on the sprite but off the pill (its clear canvas margin, past the slack): nothing -----------------------
  await ev(pg, () => __h.frames(4));   // past the dismissal's grace
  const miss = await ev(pg, async () => {
    const T = __h.T, lab = EW.remotes.get('vrmute').avatar.label, P = lab.getWorldPosition(new T.Vector3());
    const eye = EW.camera.getWorldPosition(new T.Vector3()), r = P.clone().sub(eye).cross(new T.Vector3(0, 1, 0)).normalize();
    const ls = lab.getWorldScale(new T.Vector3()), hw = ls.x * (lab.userData.pill ?? 0.5) / 2;
    const to = P.clone().addScaledVector(r, hw + 0.07), onSprite = hw + 0.07 < ls.x / 2;
    __h.aim('right', __h.handFrom('right'), to);
    const f0 = globalThis.__perf.frameNo, t0 = performance.now(); let hovered = false;
    while (globalThis.__perf.frameNo - f0 < 10 || performance.now() - t0 < 1000) { if (__h.state().hoverId) hovered = true; if (performance.now() - t0 > 20000) break; await new Promise((res) => setTimeout(res, 25)); }
    __h.down('right');
    return { onSprite, hovered, spriteHalf: +(ls.x / 2).toFixed(3), pillHalf: +hw.toFixed(3) };
  });
  check('on the sprite but 7 cm past the pill\'s end: no hover (the plate is the pill, not its canvas)', miss.onSprite && !miss.hovered, JSON.stringify(miss));

  // ---- 3. the left hand; the head under the plate ------------------------------------------------------------------
  await ev(pg, () => __h.frames(4));
  await ev(pg, () => { __h.aim('left', __h.handFrom('left'), __h.plateOf('vrmute')); });
  const o3 = await watch((s) => s.open && s.for === 'vrmute');
  check('the LEFT hand\'s laser opens it too', o3.ok, JSON.stringify(o3.s));
  await ev(pg, () => __h.down('left'));
  const c3 = await watch((s) => !s.open);
  await ev(pg, () => __h.frames(4));
  await ev(pg, () => { const hd = EW.remotes.get('vrmute').avatar.head.getWorldPosition(new __h.T.Vector3()); __h.aim('right', __h.handFrom('right'), hd); });
  const o4 = await watch((s) => s.open && s.for === 'vrmute');
  check('the head under the plate counts as the plate', c3.ok && o4.ok, JSON.stringify({ closedLeft: c3.ok, s: o4.s }));
  await ev(pg, () => __h.down('right'));
  await watch((s) => !s.open);
  await ev(pg, () => __h.frames(4));

  // ---- 4. a panel in front claims the laser -------------------------------------------------------------------------
  const pan = await ev(pg, async () => {
    const T = __h.T, dq = __h.dq, id = dq.domQuadIds().includes('settings') ? 'settings' : dq.domQuadIds()[0];
    dq.domQuadShow(id, true); await new Promise((r) => setTimeout(r, 600));
    const mesh = dq.domQuadMesh(id), from = __h.handFrom('right'), to = __h.plateOf('vrmute');
    // a SMALL panel 0.3 m down the hand's laser: it blocks the laser but not the eye's line to the plate, so the plate's
    // occlusion query stays clear and a red here is about the claim (a full-size panel also hid the plate from the eye,
    // and the occlusion test alone kept the card shut — a mutation bypassing the claim stayed green that way)
    const at = from.clone().lerp(to, 0.3 / from.distanceTo(to));
    const parent = mesh.parent; parent.updateMatrixWorld(true);
    const keepScale = mesh.scale.clone(); mesh.scale.multiplyScalar(0.25);
    mesh.position.copy(parent.worldToLocal(at.clone())); mesh.lookAt(from); mesh.updateMatrixWorld(true);
    __h.aim('right', from, to);
    const f0 = globalThis.__perf.frameNo, t0 = performance.now();
    let opened = false, hovered = false, occ = false;
    while (globalThis.__perf.frameNo - f0 < 12 || performance.now() - t0 < 1500) { const s = __h.state(); if (s.open) opened = true; if (s.hoverId) hovered = true;
      if (EW.remotes.get('vrmute').avatar.label.userData.occluded) occ = true;
      if (performance.now() - t0 > 20000) break; await new Promise((r) => setTimeout(r, 25)); }
    const hand = __h.xr.xrHands().right;
    const out = { id, frames: globalThis.__perf.frameNo - f0, ms: Math.round(performance.now() - t0), opened, hovered, occ,
      laser: +hand.laser.scale.z.toFixed(3) };
    // the control: the same aim with the panel hidden opens the card
    dq.domQuadShow(id, false); mesh.scale.copy(keepScale);
    return out;
  }, null, 40000);
  const o5 = await watch((s) => s.open && s.for === 'vrmute');
  check('a panel on the laser in front of the plate claims it: no hover, no card (≥ 12 frames, ≥ 1.5 s), the plate in plain view all along',
    !pan.opened && !pan.hovered && pan.frames >= 12 && !pan.occ, JSON.stringify(pan));
  check('…the laser stops at the panel', Math.abs(pan.laser - 0.3) < 0.05, JSON.stringify(pan));
  check('…and with the panel hidden, the same aim opens the card (the control)', o5.ok, JSON.stringify(o5.s));
  await ev(pg, () => __h.down('right'));
  await watch((s) => !s.open);

  // ---- 4b. a wall between the EYE and the plate: the plate's occlusion query (the desktop's rule) holds in VR -------
  // a plain mesh, not a world entity: the laser is not stopped by it, so only the occlusion verdict can keep the card shut
  await ev(pg, () => __h.frames(4));
  const wall = await ev(pg, async () => {
    const T = __h.T, eye = EW.camera.getWorldPosition(new T.Vector3()), P = __h.plateOf('vrmute');
    const box = new T.Mesh(new T.BoxGeometry(1.2, 1.2, 1.2), new T.MeshBasicNodeMaterial({ color: 0x3a3a3a }));
    box.name = 'probe-wall'; box.position.copy(eye.clone().lerp(P, 0.5)); EW.scene.add(box);
    // the verdict is a query resolved a frame or two late; at headless XR's few frames a second that is longer than the
    // hover delay, so the wall goes up FIRST and the laser arrives once the plate reads occluded (as a wall is there
    // before you point, in life). Per frame from then on: '#' occluded, '.' not.
    const lab = EW.remotes.get('vrmute').avatar.label, seq = [];
    let settle = 0, f = globalThis.__perf.frameNo; const fs = f;
    while (settle < 3 && globalThis.__perf.frameNo - fs < 40) { await new Promise((r) => setTimeout(r, 20)); if (globalThis.__perf.frameNo !== f) { f = globalThis.__perf.frameNo; settle = lab.userData.occluded ? settle + 1 : 0; } }
    const settled = settle >= 3, settleFrames = globalThis.__perf.frameNo - fs;
    __h.aim('right', __h.handFrom('right'), P);
    const f0 = globalThis.__perf.frameNo, t0 = performance.now(); let opened = false, hovered = false; f = f0;
    while (globalThis.__perf.frameNo - f0 < 12 || performance.now() - t0 < 1500) { const s = __h.state(); if (s.open) opened = true; if (s.hoverId) hovered = true;
      if (globalThis.__perf.frameNo !== f) { f = globalThis.__perf.frameNo; seq.push(lab.userData.occluded ? '#' : '.'); }
      if (performance.now() - t0 > 20000) break; await new Promise((r) => setTimeout(r, 20)); }
    box.removeFromParent(); box.geometry.dispose();
    return { settled, settleFrames, frames: globalThis.__perf.frameNo - f0, opened, hovered, perFrame: seq.join('') };
  }, null, 40000);
  const o6 = await watch((s) => s.open && s.for === 'vrmute');
  check('a wall between the eye and the plate: occluded every frame, no hover, no card (the laser itself passes)',
    wall.settled && !wall.opened && !wall.hovered && wall.perFrame.length >= 5 && !wall.perFrame.includes('.'), JSON.stringify(wall));
  check('…and with the wall gone, the same aim opens the card (the control)', o6.ok, JSON.stringify(o6.s));
  await ev(pg, () => __h.down('right'));
  await watch((s) => !s.open);

  // ---- 5. leave VR: the desktop card is as it was ------------------------------------------------------------------
  await ev(pg, () => { __h.aim('right', __h.handFrom('right'), __h.plateOf('vrmute')); });
  await watch((s) => s.open);
  await ev(pg, () => __h.xr.leaveVR('probe'));
  await pg.waitForFunction(() => !EW.renderer.xr.isPresenting, null, { timeout: 30000, polling: 250 });
  await pg.waitForFunction((f0) => globalThis.__perf.frameNo > f0 + 3, await ev(pg, () => globalThis.__perf.frameNo), { timeout: 30000, polling: 100 });
  const after = await ev(pg, () => { const c = document.getElementById('platecard'); let inScene = false; EW.scene.traverse((o) => { if (o.name === 'platecard') inScene = true; });
    return { s: __h.state(), hidden: c.hidden, xr: c.dataset.xr !== undefined, mesh: __h.pc.plateCardMesh(), inScene }; });
  check('leaving VR closes the card, drops its quad, and clears the VR styling', !after.s.open && !after.s.vr && after.hidden && !after.xr && after.mesh === null && !after.inScene,
    JSON.stringify(after));

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  const known = (t) => /Invalid value used as weak map key/.test(t);   // IWER's null XRWebGLLayer.framebuffer (memory §4): an emulator artifact
  const other = conErrs.filter((t) => !known(t) && !/401|whoami/.test(t));
  console.log(`  · console.error: ${conErrs.length} (${conErrs.filter(known).length} the IWER null-framebuffer artifact)${other.length ? ` other: ${other.slice(0, 3).join(' | ')}` : ''}`);
  check('no console errors beyond the disclosed emulator artifact', other.length === 0, other.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e?.stack?.split('\n').slice(0, 3).join(' ') ?? String(e)); }
finally {
  for (const p of peers) { clearInterval(p.timer); try { p.ws.close(); } catch {} }
  try { await browser?.close(); } catch {}
  try { await world.close(); } catch {}
}
done();
