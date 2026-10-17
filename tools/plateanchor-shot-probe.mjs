// plateanchor-shot-probe — the nameplate's vertical anchor (client/lib/plateanchor.js) on REAL bodies, in the real
// client against an owned scratch world: the SAME avatar three times (idle / sitting on the ground / lying — the
// 'sit' and 'lie' clip slots), shot BEFORE (the plate pinned at the old fixed 1.95 above the root) and AFTER (hung from
// the body), plus the measured rest crown / gap / anchor for each. Clouds OFF before boot (a cloudy sky bakes on the
// CPU in headless Chromium). On a small host, run it under a lock and a memory guard:
//
//   bun tools/plateanchor-shot-probe.mjs --shots <dir> [--avatars claude,tigerbee]
//
// "Before" is emulated in-page: each body's _placePlate is swapped for the old line (label at 0, 1.95, 0) for the
// shot, then restored — everything else on the frame is today's code.
//
// SEEN FROM ABOVE (owner, 10-01, a top-down shot with "guest-2ggs" on the face): one standing peer, the camera held at
// eye level, 45°, 80° and 88° down onto its head (pinned in-page just before that body's update, so the plate lifts
// for exactly that eye); the pill's screen rect, projected the way platecard.js does, must clear the head (its crown,
// head bone + rest head span, sits under the rect's bottom edge), and the hover card must open on the lifted plate.
// "Before" = _liftPlateForView stubbed out; at 80°/88° that must overlap, or the check proves nothing.
// FIRST PERSON (owner, 10-01): wheel all the way in — your own plate (and what hangs off it) is not drawn; out again,
// it is. Shots: looking up from first person, with the plate as it is and as it would be (the flag forced off).
//
//   --sections anchor,above,fp   (default: all three)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const { check, done } = checker();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const shotDir = arg('--shots', null);
const avatars = arg('--avatars', 'claude').split(',');
const prefix = Number(arg('--prefix', '90'));
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// k rendered frames (headless can run at a few fps: a sleep is not a frame)
const settle = (pg, k = 4) => pg.evaluate((k) => new Promise((r) => { let i = 0; const t = () => (++i >= k ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }), k);
const WORLD = 'anchors';
const sections = new Set(arg('--sections', 'anchor,above,fp').split(','));

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();
const peers = [];
function peer(id, avatar, pose) {
  const ws = new WebSocket(`${world.origin.replace(/^http/, 'ws')}/ws`);
  const p = { ws, pose, timer: null };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', world: WORLD, id, avatar, token: world.key }));
    p.timer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pose', pose: p.pose })); }, 66);
  };
  peers.push(p);
  return p;
}
const endPeers = () => { for (const p of peers) { clearInterval(p.timer); try { p.ws.close(); } catch {} } peers.length = 0; };

const out = {};
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=${WORLD}&name=anchorcam&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(), null, { timeout: 120000 });
  await sleep(3000);
  const fr = await pg.evaluate(() => {
    const p = EW.myState.pos, d = new EW.THREE.Vector3(); EW.camera.getWorldDirection(d); d.y = 0; d.normalize();
    return { p: [p.x, p.y, p.z], f: [d.x, d.z], r: [-d.z, d.x] };
  });
  const at = (fwd, right) => [fr.p[0] + fr.f[0] * fwd + fr.r[0] * right, fr.p[1], fr.p[2] + fr.f[1] * fwd + fr.r[1] * right];
  const yaw = Math.atan2(-fr.f[0], -fr.f[1]);   // face the camera
  let n = prefix;
  for (const av of sections.has('anchor') ? avatars : []) {
    const ids = ['stand', 'sit', 'lie'].map((c) => `${av}-${c}`);
    const base = { speed: 0, presence: 'present' };
    peer(ids[0], av, { ...base, yaw, clip: 'idle', p: at(4.2, -1.6) });
    peer(ids[1], av, { ...base, yaw, clip: 'sit', p: at(4.2, 0) });
    peer(ids[2], av, { ...base, yaw: yaw + Math.PI / 2, clip: 'lie', p: at(4.2, 1.9) });
    await pg.waitForFunction((ids) => ids.every((id) => { const r = EW.remotes.get(id); return r?.avatar?.label && !r.loading && !r.capsuleFor; }),
      ids, { timeout: 150000 });
    // the posture clips hydrate after the body: wait until each is really playing its own slot, then the crossfade + chase
    await pg.waitForFunction((ids) => {
      const want = { stand: 'idle', sit: 'sit', lie: 'lie' };
      return ids.every((id) => { const a = EW.remotes.get(id).avatar, w = want[id.split('-').pop()]; return a.actions[w] && a.current === a.actions[w]; });
    }, ids, { timeout: 90000 }).catch(() => {});
    await pg.evaluate(() => { const me = EW.me(); if (me?.root) me.root.visible = false; });   // your own body is in the way
    await sleep(3500);
    const m = await pg.evaluate((ids) => ids.map((id) => {
      const a = EW.remotes.get(id).avatar, T = EW.THREE, h = a.vrm.humanoid;
      const w = (n) => { const b = h?.getRawBoneNode?.(n); return b ? b.getWorldPosition(new T.Vector3()) : null; };
      const lw = a.label.getWorldPosition(new T.Vector3()), rw = a.root.getWorldPosition(new T.Vector3());
      const head = w('head'), hips = w('hips');
      const r = a._plateRest ?? {};
      return { id, slot: a.currentSlot, rest: { crown: r.crown, head: r.crown - r.headSpan, hipsToCrown: r.hipsToCrown, boundsTop: r.boundsTop, eye: r.eye, height: r.height },
        scale: a.vrm.scene.getWorldScale(new T.Vector3()).y, lie: a._plateLie,
        plateAboveRoot: lw.y - rw.y, headAboveRoot: head ? head.y - rw.y : null, hipsAboveRoot: hips ? hips.y - rw.y : null,
        plateOverHipsXZ: hips ? Math.hypot(lw.x - hips.x, lw.z - hips.z) : null, plateOverHeadXZ: head ? Math.hypot(lw.x - head.x, lw.z - head.z) : null,
        ownClear: a._ownClear };
    }), ids);
    out[av] = m;
    for (const x of m) console.log('   ', JSON.stringify(x, (_k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
    const [st, si, li] = m;
    check(`${av}: standing plate = crown + gap above the root (rest crown ${st.rest.crown?.toFixed(3)})`, st.slot === 'idle'
      && Math.abs(st.plateAboveRoot - st.rest.crown * st.scale) < 0.2 && st.plateAboveRoot > st.headAboveRoot);
    check(`${av}: sitting plate comes down with the body (under the standing one, above the head)`, si.slot === 'sit'
      && si.plateAboveRoot < st.plateAboveRoot - 0.2 && si.plateAboveRoot > si.headAboveRoot);
    check(`${av}: lying plate over the head, just above it`, li.slot === 'lie' && li.lie > 0.99 && li.plateOverHeadXZ < 0.05
      && li.plateAboveRoot > li.headAboveRoot && li.plateAboveRoot - li.headAboveRoot < 0.6);
    // THE JUMP (owner, 10-01: "big noticeable lag on the nameplate on jumping"): the standing peer streams the jump
    // clip in place; its hips move under the root and the plate, over the root, does not (sampled every frame for 1.5 s)
    peers[0].pose = { ...peers[0].pose, clip: 'jump' };
    await pg.waitForFunction((id) => { const a = EW.remotes.get(id)?.avatar; return a?.actions?.jump && a.current === a.actions.jump; }, ids[0], { timeout: 30000 }).catch(() => {});
    const jump = await pg.evaluate((id) => new Promise((res) => {
      const a = EW.remotes.get(id).avatar, T = EW.THREE, lw = new T.Vector3(), rw = new T.Vector3(), hw = new T.Vector3();
      const hipsB = a.vrm.humanoid.getRawBoneNode('hips'); let pMin = Infinity, pMax = -Infinity, hMin = Infinity, hMax = -Infinity, frames = 0;
      const t0 = performance.now();
      const tick = () => {
        a.label.getWorldPosition(lw); a.root.getWorldPosition(rw); hipsB.getWorldPosition(hw);
        const p = lw.y - rw.y, h = hw.y - rw.y; pMin = Math.min(pMin, p); pMax = Math.max(pMax, p); hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); frames++;
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
        else res({ slot: a.currentSlot, posture: a.postureSlot, frames, plateSwing: pMax - pMin, hipsSwing: hMax - hMin });
      };
      requestAnimationFrame(tick);
    }), ids[0]);
    console.log('    jump:', JSON.stringify(jump, (_k, v) => typeof v === 'number' ? +v.toFixed(4) : v));
    check(`${av}: jumping in place, the hips move under the root and the plate does not (≤ 1 mm)`, jump.slot === 'jump' && jump.frames > 3
      && jump.hipsSwing > 0.03 && jump.plateSwing <= 0.001, JSON.stringify(jump));
    peers[0].pose = { ...peers[0].pose, clip: 'idle' };
    if (shotDir) {
      await pg.screenshot({ path: `${shotDir}/${n}-anchor-${av}-after.png` });
      await pg.evaluate((ids) => { for (const id of ids) { const a = EW.remotes.get(id).avatar;
        a.__place = a._placePlate; a._placePlate = function () { this.label.position.set(0, 1.95, 0); }; } }, ids);
      await sleep(1200);
      await pg.screenshot({ path: `${shotDir}/${n + 1}-anchor-${av}-before.png` });
      await pg.evaluate((ids) => { for (const id of ids) { const a = EW.remotes.get(id).avatar; a._placePlate = a.__place; } }, ids);
      n += 2;
    }
    endPeers();
    await pg.waitForFunction((ids) => ids.every((id) => !EW.remotes.get(id)), ids, { timeout: 30000 }).catch(() => {});
    await sleep(500);
  }

  // ---- seen from above -------------------------------------------------------------------------------------------
  if (sections.has('above')) {
    const id = `${avatars[0].split('/').pop().replace(/\.vrm$/, '')}-above`;   // a library path (eidoverse/assets/vrms/x.vrm) or a bare name
    peer(id, avatars[0], { speed: 0, presence: 'present', yaw, clip: 'idle', p: at(4, 0) });
    await pg.waitForFunction((id) => { const r = EW.remotes.get(id); return r?.avatar?.label && !r.loading && !r.capsuleFor
      && r.avatar.actions?.idle && r.avatar.current === r.avatar.actions.idle; }, id, { timeout: 150000 });
    await pg.evaluate(() => { const me = EW.me(); if (me?.root) me.root.visible = false; });
    // the camera, pinned: the follow camera's writes (position.lerp, lookAt) are switched off for the section and the
    // pose is set directly, so every system and the draw see the same eye (the governor may stride the remotes)
    await pg.evaluate(({ id, f }) => {
      const a = EW.remotes.get(id).avatar, T = EW.THREE, head = a.vrm.humanoid.getRawBoneNode('head'), cam = EW.camera;
      cam.__lookAt = cam.lookAt; cam.lookAt = function () {}; cam.position.__lerp = cam.position.lerp; cam.position.lerp = function () { return this; };
      globalThis.__setCam = (c) => {
        const t = c.around === 'plate' ? hung() : head.getWorldPosition(new T.Vector3()), p = c.pitch * Math.PI / 180, y = (c.yaw ?? 0) * Math.PI / 180;
        const hx = f[0] * Math.cos(y) - f[1] * Math.sin(y), hz = f[0] * Math.sin(y) + f[1] * Math.cos(y);
        cam.position.set(t.x + hx * c.dist * Math.cos(p), t.y + c.dist * Math.sin(p), t.z + hz * c.dist * Math.cos(p));
        cam.__lookAt(t); cam.updateMatrixWorld(true);
      };
      // where the body hangs the plate, before any lift (dt 0: the chase does not move; the drawn plate is put back)
      const hung = () => { const d = a.label.position.clone(); a._placePlate(0); const w = a.root.localToWorld(a.label.position.clone()); a.label.position.copy(d); return w; };
      globalThis.__lift = () => +a.root.localToWorld(a.label.position.clone()).distanceTo(hung()).toFixed(5);
      globalThis.__unpinCam = () => { cam.lookAt = cam.__lookAt; cam.position.lerp = cam.position.__lerp; };
      // the plate rect as platecard.js projects it, the head bone, and the crown (head bone + rest head span)
      globalThis.__above = () => {
        const cam = EW.camera, cv = EW.renderer.domElement, b = cv.getBoundingClientRect();
        const px = (v) => { const q = v.clone().project(cam); return { x: b.left + (q.x + 1) / 2 * cv.clientWidth, y: b.top + (1 - q.y) / 2 * cv.clientHeight }; };
        const lw = a.label.getWorldPosition(new T.Vector3());
        const depth = -lw.clone().applyMatrix4(cam.matrixWorldInverse).z;
        const ppm = (cv.clientHeight / 2) / (Math.tan(T.MathUtils.degToRad(cam.fov) / 2) * depth);
        const c = px(lw), hw = a.label.scale.x * (a.label.userData.pill ?? 0.5) / 2 * ppm, hh = a.label.scale.x * (a.label.userData.pillH ?? 52 / 512) / 2 * ppm;
        const hb = head.getWorldPosition(new T.Vector3()), s = a.vrm.scene.getWorldScale(new T.Vector3()).y;
        const crown = hb.clone(); crown.y += (a._plateRest?.headSpan ?? 0.2) * s;
        const h = px(hb), cr = px(crown);
        const camUp = new T.Vector3(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(new T.Quaternion()));
        return { rect: { l: c.x - hw, r: c.x + hw, t: c.y - hh, b: c.y + hh }, head: h, crown: cr, shown: a.label.visible,
          plateOverHead: lw.clone().sub(hb).toArray().map((x) => +x.toFixed(3)), camUp: camUp.toArray().map((x) => +x.toFixed(3)) };
      };
    }, { id, f: [-fr.f[0], -fr.f[1]] });   // head → camera, horizontally: the peer's face side (it faces the original camera)
    const views = [{ name: 'eye', pitch: 0, dist: 2.2 }, { name: '45', pitch: 45, dist: 2.2 }, { name: '80', pitch: 80, dist: 2.2 }, { name: '88', pitch: 88, dist: 2.2 }];
    const res = {};
    const clipAround = (m) => ({ x: Math.max(0, Math.min(1280 - 480, m.head.x - 240)), y: Math.max(0, Math.min(720 - 360, m.head.y - 220)), width: 480, height: 360 });
    for (const v of views) {
      await pg.evaluate((v) => __setCam(v), v);
      await sleep(300); await settle(pg);
      const m = await pg.evaluate(() => ({ ...__above(), lift: __lift() }));
      const clears = m.shown && m.rect.b <= m.crown.y && !(m.head.x >= m.rect.l && m.head.x <= m.rect.r && m.head.y >= m.rect.t && m.head.y <= m.rect.b);
      res[v.name] = { after: m };
      if (shotDir) await pg.screenshot({ path: `${shotDir}/${n}-above-${v.name}-after.png`, clip: clipAround(m) });
      // before: the lift off
      await pg.evaluate((id) => { const a = EW.remotes.get(id).avatar; a.__lift = a._liftPlateForView; a._liftPlateForView = () => {}; }, id);
      await settle(pg);
      const mb = await pg.evaluate(() => __above());
      res[v.name].before = mb;
      if (shotDir) await pg.screenshot({ path: `${shotDir}/${n + 1}-above-${v.name}-before.png`, clip: clipAround(mb) });
      await pg.evaluate((id) => { const a = EW.remotes.get(id).avatar; a._liftPlateForView = a.__lift; }, id);
      await settle(pg);
      console.log(`    ${v.name}:`, JSON.stringify({ lift: m.lift, rectB: m.rect.b, crownY: m.crown.y, headY: m.head.y, beforeRectB: mb.rect.b, over: m.plateOverHead, beforeOver: mb.plateOverHead },
        (_k, x) => typeof x === 'number' ? +x.toFixed(x < 1 ? 3 : 1) : x));
      check(`seen from ${v.name === 'eye' ? 'eye level' : v.name + '°'}: the pill's bottom edge clears the crown on screen, the head bone is outside it`, clears, JSON.stringify(m));
      if (v.name === 'eye') check('...eye level: the plate is where it always was (lift 0)', Math.abs(m.rect.b - mb.rect.b) < 0.5, `${m.rect.b} vs ${mb.rect.b}`);
      else if (v.pitch >= 80) check(`...and without the lift it would NOT (the check can fail)`, mb.rect.b > mb.crown.y, `before bottom ${mb.rect.b} crown ${mb.crown.y}`);
      n += 2;
    }
    // steady: frame after frame at one eye, and from every side at one pitch (orbiting the plate) — the lift depends on
    // the pitch, not on the idle sway or on which side you stand
    {
      await pg.evaluate(() => __setCam({ pitch: 80, dist: 2.2, around: 'plate' }));
      await settle(pg);
      const frames = await pg.evaluate(() => new Promise((res) => { const o = []; const t = () => { o.push(__lift()); if (o.length < 20) requestAnimationFrame(t); else res(o); }; requestAnimationFrame(t); }));
      check('80°, 20 frames at one eye: the lift holds within 2 mm (no jitter; what moves is the idle hips under a standing plate)', frames[0] > 0.05 && Math.max(...frames) - Math.min(...frames) < 2e-3,
        `min ${Math.min(...frames)} max ${Math.max(...frames)}`);
      const sides = [];
      for (let k = 0; k < 4; k++) {
        await pg.evaluate((k) => __setCam({ pitch: 80, dist: 2.2, yaw: k * 90, around: 'plate' }), k);
        await settle(pg);
        sides.push(await pg.evaluate(() => __lift()));
      }
      check('orbiting the plate at 80° (four sides, 90° apart): the same lift on every side (within 1 mm)',
        sides[0] > 0.05 && Math.max(...sides) - Math.min(...sides) < 1e-3, JSON.stringify(sides));
      res.lift80 = sides[0];
    }
    // hover: the card opens on the lifted plate (platecard.js reads where the plate is)
    {
      await pg.evaluate(() => __setCam({ pitch: 80, dist: 2.2 }));
      await settle(pg);
      const m = await pg.evaluate(() => __above());
      await pg.mouse.move((m.rect.l + m.rect.r) / 2, (m.rect.t + m.rect.b) / 2); await sleep(900);
      const card = await pg.evaluate(({ id, x, y }) => { const c = document.getElementById('platecard'); const a = EW.remotes.get(id).avatar;
        return { open: !!c && !c.hidden, for: c?.dataset.for ?? null, occluded: !!a.label.userData.occluded, under: document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.tagName,
          at: [Math.round(x), Math.round(y)], now: __above().rect }; }, { id, x: (m.rect.l + m.rect.r) / 2, y: (m.rect.t + m.rect.b) / 2 });
      check('80°: resting the pointer on the lifted plate opens its card', card.open && card.for === id, JSON.stringify(card));
      await pg.mouse.move(640, 700); await sleep(500);
      await pg.keyboard.press('Escape'); await sleep(200);
    }
    out.above = res;
    await pg.evaluate(() => __unpinCam());
    endPeers();
    await pg.waitForFunction((id) => !EW.remotes.get(id), id, { timeout: 30000 }).catch(() => {});
  }

  // ---- first person: your own plate --------------------------------------------------------------------------------
  if (sections.has('fp')) {
    await pg.evaluate(() => { const me = EW.me(); if (me?.root) me.root.visible = true; });
    await pg.mouse.move(640, 360);
    const own = () => pg.evaluate(() => { const me = EW.me(); return { shown: me.label.visible, hidden: me.ownPlateHidden, fp: me.firstPersonView, body: me.vrm.scene.visible }; });
    await sleep(800);
    const third = await own();
    check('third person: your own plate is drawn', third.shown && !third.hidden && third.body, JSON.stringify(third));
    for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, -400); await sleep(40); }
    await sleep(800);
    const fp = await own();
    check('wheel all the way in (first person): your own plate is not drawn', fp.fp === true && !fp.shown && fp.hidden && !fp.body, JSON.stringify(fp));
    // look up (right-drag) so the spot over your head is in frame, and shoot it as it is and as it would be
    await pg.mouse.down({ button: 'right' }); await pg.mouse.move(640, 160, { steps: 8 }); await pg.mouse.up({ button: 'right' });
    await sleep(700);
    if (shotDir) await pg.screenshot({ path: `${shotDir}/${n}-fp-up-after.png` });
    await pg.evaluate(() => Object.defineProperty(EW.me(), 'ownPlateHidden', { get: () => false, configurable: true }));
    await sleep(500);
    const forced = await own();
    if (shotDir) await pg.screenshot({ path: `${shotDir}/${n + 1}-fp-up-before.png` });
    await pg.evaluate(() => { delete EW.me().ownPlateHidden; });
    console.log('    fp forced-visible (the before shot):', JSON.stringify(forced));
    for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, 400); await sleep(40); }
    await sleep(900);
    const back = await own();
    check('wheel back out (third person): it is drawn again', back.fp === false && back.shown && !back.hidden, JSON.stringify(back));
    if (shotDir) await pg.screenshot({ path: `${shotDir}/${n + 2}-fp-third-again.png` });
    n += 3;
  }

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  if (shotDir) writeFileSync(`${shotDir}/${prefix}-anchor-measure.json`, JSON.stringify(out, null, 1));
  await ctx.close();
} finally {
  endPeers();
  await close();
  await world.close();
}
done();
