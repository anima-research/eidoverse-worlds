// nameplate-card-probe — the hover card (and that nothing else is drawn beside a plate) (client/lib/platecard.js), in the REAL client against
// an owned scratch world (probe-harness), with fake peers that are plain sockets joined to the same world and
// streaming pose packets — the wire every body uses, so `mic` / `hear` arrive exactly as a browser's would.
// Clouds are forced OFF before boot (a cloudy sky bakes on the CPU in headless Chromium and has frozen the host).
//
//   bun tools/nameplate-card-probe.mjs [--shots <dir>]
//
// What must hold:
//   the wire — this client's own pose packets carry `mic` and `hear` (booleans), so peers can know;
//   hover only (owner, 10-02) — nothing is drawn beside a plate for voice state: a NEAR peer with hearing off wears no
//     mark, and a live flip of `hear` changes no pixel beside the plate (measured in the render); the card says it;
//   the plate's size — its width and fade are platesize.js's answer for the world distance (tools/platesize-test.ts
//     holds the curve itself);
//   occlusion (MEASURED IN THE RENDER) — plate, mark and typing pill are depth-tested sprites cleared of their own body:
//     a wall between eye and plate hides the name; a box riding ANOTHER avatar hides it; a box riding the plate's OWN
//     body (standing through it, as claude.vrm's crown of tentacles does) does NOT — unless the clearance is zeroed,
//     the naive depth test, which cuts it; speech bubbles stay on top;
//   hold-to-reveal — holding N brings a walled-off plate through, at plateSize(d, 1); release hides it again; N typed
//     into the chat line reveals nothing;
//   the card — a plate a wall hides opens none; resting on a plate opens it only after the delay; it names the person and says mic off / can't hear
//     you; it follows the plate while the pointer rests on it; leaving plate and card closes it; Esc closes it and
//     leaves the panels alone; "message" opens their DM tab;
//   phone (390×844, touch) — a tap on a plate opens the same card inside the viewport; a tap elsewhere closes it.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORLD = 'plates';

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

// ---- fake peers: a socket each, a pose every 66 ms (the client's own cadence) ------------------------------------
const peers = new Map();   // id → { ws, pose }
const seen = new Map();    // id → the last pose the server relayed for it (read off peer sockets' frames)
function peer(id, pose) {
  const ws = new WebSocket(`${world.origin.replace(/^http/, 'ws')}/ws`);
  const p = { ws, pose, timer: null };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', world: WORLD, id, token: world.key }));
    p.timer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pose', pose: p.pose })); }, 66);
  };
  ws.onmessage = (e) => {
    try { const m = JSON.parse(String(e.data)); if (m.type === 'frame') for (const [k, v] of Object.entries(m.poses ?? {})) seen.set(k, v); } catch {}
  };
  peers.set(id, p);
  return p;
}
const endPeers = () => { for (const p of peers.values()) { clearInterval(p.timer); try { p.ws.close(); } catch {} } peers.clear(); };

async function boot(ctxOpts, name) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD
  await ctx.addInitScript(readers);
  await ctx.addInitScript(() => { globalThis.__plog = []; for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'click'])
    addEventListener(t, (e) => __plog.push(`${t}:${e.pointerType ?? ''}:${e.target?.tagName}:${Math.round(e.clientX)},${Math.round(e.clientY)}:${Math.round(performance.now())}`), true); });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  await pg.goto(`${world.origin}/?world=${WORLD}&name=${name}&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.(),
    null, { timeout: 120000 });
  await sleep(3000);
  return { ctx, pg, errs };
}
const shot = async (pg, file, clip) => { if (shotDir) await pg.screenshot({ path: `${shotDir}/${file}`, ...(clip ? { clip } : {}) }); };

// where I stand and which way the camera looks along the ground — peers are placed in view from these
const frameOf = (pg) => pg.evaluate(() => {
  const p = EW.myState.pos, d = new EW.THREE.Vector3(); EW.camera.getWorldDirection(d); d.y = 0; d.normalize();
  return { p: [p.x, p.y, p.z], f: [d.x, d.z], r: [-d.z, d.x] };
});
const at = (fr, fwd, right) => [fr.p[0] + fr.f[0] * fwd + fr.r[0] * right, fr.p[1], fr.p[2] + fr.f[1] * fwd + fr.r[1] * right];
// a peer's plate (and ear) on screen, projected the way platecard.js does
// in-page readers, installed before boot so one evaluate can read card AND plate from the same frame
const readers = () => {
  globalThis.__plateOf = (id) => {
  const r = EW.remotes.get(id), av = r?.avatar;
  if (!av?.label) return null;
  const T = EW.THREE, cam = EW.camera, cv = EW.renderer.domElement;
  const v = new T.Vector3(); av.label.getWorldPosition(v);
  const depth = -v.clone().applyMatrix4(cam.matrixWorldInverse).z;
  const ppm = (cv.clientHeight / 2) / (Math.tan(T.MathUtils.degToRad(cam.fov) / 2) * depth);
  v.project(cam);
  const b = cv.getBoundingClientRect();
  const x = b.left + (v.x + 1) / 2 * cv.clientWidth, y = b.top + (1 - v.y) / 2 * cv.clientHeight;
  const hw = av.label.scale.x * (av.label.userData.pill ?? 0.5) / 2 * ppm, hh = av.label.scale.x * (av.label.userData.pillH ?? 52 / 512) / 2 * ppm;
  let ear = null;
  if (av.ear) {
    const e = new T.Vector3(); av.ear.getWorldPosition(e); e.project(cam);
    const ex = b.left + (e.x + 1) / 2 * cv.clientWidth, ey = b.top + (1 - e.y) / 2 * cv.clientHeight, ew = av.ear.scale.x * ppm;
    ear = { l: ex - ew / 2, r: ex + ew / 2, t: ey - ew / 2, b: ey + ew / 2, op: +av.ear.material.opacity.toFixed(3), vis: av.ear.visible };
  }
  return { x, y, l: x - hw, r: x + hw, t: y - hh, b: y + hh, ear, hear: r.hear, mic: r.mic, shown: av.label.visible };
};
  globalThis.__card = () => {
  const c = document.getElementById('platecard');
  if (!c) return { exists: false };
  const r = c.getBoundingClientRect();
  return { exists: true, open: !c.hidden, for: c.dataset.for ?? null, side: c.dataset.side ?? null, text: c.textContent.replace(/\s+/g, ' ').trim(),
    l: r.left, t: r.top, r: r.right, b: r.bottom, inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
};
};
const plate = (pg, id) => pg.evaluate((id) => __plateOf(id), id);
const cardState = (pg) => pg.evaluate(() => __card());
const both = (pg, id) => pg.evaluate((id) => ({ k: __card(), a: __plateOf(id) }), id);
const earOff = (pl) => !pl?.ear || !pl.ear.vis || pl.ear.op < 0.05;


try {
  // ------------------------------------------------------------ desktop 1280x720
  const { ctx, pg, errs } = await boot({ viewport: { width: 1280, height: 720 } }, 'platedesk');
  const fr = await frameOf(pg);
  const base = { yaw: 0, speed: 0, clip: 'idle', presence: 'present' };
  const A = peer('nearmute', { ...base, p: at(fr, 3, -1.9), mic: false, hear: false });
  const B = peer('nearhear', { ...base, p: at(fr, 3.5, 1.9), mic: true, hear: true });
  const C = peer('farmute', { ...base, p: at(fr, 26, 0), mic: false, hear: false });
  await pg.waitForFunction(() => ['nearmute', 'nearhear', 'farmute'].every((id) => EW.remotes.get(id)?.avatar?.label
    && typeof EW.remotes.get(id).hear === 'boolean'), null, { timeout: 90000 });
  // settled bodies: a peer's first body can be the capsule floor while its VRM loads (remotes.js retryBody swaps it),
  // and a swapped body starts its ear from nothing — so wait until each body has stayed the same one for 2 s
  await pg.evaluate(async () => {
    const ids = ['nearmute', 'nearhear', 'farmute'];
    let last = ids.map((id) => EW.remotes.get(id)?.avatar), since = performance.now();
    while (performance.now() - since < 2000) {
      await new Promise((r) => setTimeout(r, 100));
      const now = ids.map((id) => EW.remotes.get(id)?.avatar);
      const bad = ids.some((id) => EW.remotes.get(id)?.loading);
      if (bad || now.some((a, i) => a !== last[i])) { last = now; since = performance.now(); }
    }
  });
  console.log('    bodies', await pg.evaluate(() => JSON.stringify(['nearmute', 'nearhear', 'farmute'].map((id) => {
    const r = EW.remotes.get(id); return [id, r?.capsuleFor ? 'capsule' : 'vrm']; }))));
  await sleep(1000);   // the 5 Hz decision + the fade

  // the wire, from the other side: my own packets carry both fields
  const mine = seen.get('platedesk');
  check('the wire: this client’s pose packets carry mic and hear as booleans',
    mine && typeof mine.mic === 'boolean' && typeof mine.hear === 'boolean', JSON.stringify(mine && { mic: mine.mic, hear: mine.hear }));

  let a = await plate(pg, 'nearmute'), b = await plate(pg, 'nearhear'), c = await plate(pg, 'farmute');
  // HOVER ONLY (owner, 10-02): voice state draws nothing beside a plate, near or far, hearing or not
  check('no mark: a NEAR peer with hearing off wears nothing beside the plate', earOff(a) && a?.hear === false
    && await pg.evaluate(() => !EW.remotes.get('nearmute')?.avatar?.ear), JSON.stringify(a));
  // THE SIZE: the plate's width is platesize.js's answer for the world distance this frame (the wiring, not the math)
  const size = await pg.evaluate(async () => {
    const { plateSize } = await import('/lib/platesize.js');
    const av = EW.remotes.get('farmute')?.avatar, e = new EW.THREE.Vector3(); EW.camera.getWorldPosition(e);
    const d = av.root.position.distanceTo(e);
    return { d, lw: av.label.scale.x, want: plateSize(d).lw, op: av.label.material.opacity, wantOp: plateSize(d).vis };
  }).catch((e) => ({ err: String(e).slice(0, 160) }));
  check('plate size: a far peer’s label width and fade are plateSize(world distance)',
    Math.abs(size.lw - size.want) < 0.01 && Math.abs(size.op - size.wantOp) < 0.02 && size.lw > 0.9, JSON.stringify(size));
  // THE BAKE (owner, 10-01: "only a whisper of room between the g's and the edge"): the name's ink, measured in the
  // baked canvas's own pixels, has room above and below inside the pill, the same both ways; a name of descenders and
  // a name of capitals bake to the same height; and the sprite's height follows its canvas (the text keeps its size)
  const plateBake = await pg.evaluate(async () => {
    const av = EW.remotes.get('farmute')?.avatar; if (!av) return null;
    const keep = av._labelName;
    const read = (name) => {
      av._labelName = name; av.repaintLabel();
      const cv = av.label.material.map.image, x = cv.getContext('2d'), d = x.getImageData(0, 0, cv.width, cv.height).data;
      const bg = x.getImageData(0, 0, 1, 1).data;   // the canvas corner: outside the pill
      let pT = -1, pB = -1, tT = -1, tB = -1;
      for (let y = 0; y < cv.height; y++) for (let i = 0; i < cv.width; i++) {
        const k = (y * cv.width + i) * 4; if (d[k + 3] <= bg[3] + 8) continue;
        if (pT < 0) pT = y; pB = y;
        if (d[k + 1] > 150) { if (tT < 0) tT = y; tB = y; }   // name-hued (the name is bright; the pill is a dark ground)
      }
      return { name, h: cv.height, w: cv.width, pill: [pT, pB], ink: [tT, tB], above: tT - pT, below: pB - tB, aspect: av.label.userData.aspect };
    };
    const out = [read('guest-2ggs'), read('HHHH')];
    av._labelName = keep; av.repaintLabel();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // read on a NEAR peer: a far plate past its fade is not re-sized each frame, so its scale says nothing about the bake
    const near = EW.remotes.get('nearhear')?.avatar;
    out.scaleOk = !!near && Math.abs(near.label.scale.y / near.label.scale.x - near.label.userData.aspect) < 1e-6;
    out.near = near && { sx: near.label.scale.x, sy: near.label.scale.y, aspect: near.label.userData.aspect };
    return { rows: out, scaleOk: out.scaleOk, near: out.near };   // an array's own props don't survive page→probe serialisation
  }).catch((e) => ({ err: String(e).slice(0, 160) }));
  console.log(`  · bake: ${JSON.stringify(plateBake)}`);
  const [bg2, bH] = Array.isArray(plateBake?.rows) ? plateBake.rows : [];
  check('bake: "guest-2ggs" has ≥ 9 px of pill below its descenders and above its tallest glyph (it had ~2)',
    bg2 && bg2.below >= 9 && bg2.above >= 9, JSON.stringify(bg2));
  check('bake: …balanced above and below (within 4 px), and a name of capitals bakes to the same height',
    bg2 && bH && Math.abs(bg2.above - bg2.below) <= 4 && bH.h === bg2.h && bH.above >= 9, JSON.stringify({ bg2, bH }));
  check('bake: the sprite\'s height follows its canvas (scale y / x = canvas h / w)', plateBake?.scaleOk === true, JSON.stringify(plateBake?.near));
  check('no mark: none for a near peer who hears, none for a far one with hearing off', earOff(b) && earOff(c) && c?.hear === false,
    JSON.stringify({ b: b?.ear, c: c?.ear }));
  await shot(pg, '70-no-mark-near.png');

  // live: the hearing peer turns voices off → NOTHING appears beside the plate (the card still knows)
  // (headless software GL runs a few frames a second, so these poll up to 4 s rather than trusting one sleep)
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v.ok) return v; await sleep(150); } return v; };
  // MEASURE THE RENDER, not the arithmetic: a region around the hearing peer's plate captured with hearing on and off;
  // no neutral-grey pixel may change beside the pill (the old mark's ink) — absence, measured where it used to draw
  // the peer's idle clip and its hair's springs move pixels too: hold that body still for the two captures
  await pg.evaluate(() => { const av = EW.remotes.get('nearhear').avatar; av.mixer.timeScale = 0; });
  await sleep(1500);   // springs settle
  const b0 = await plate(pg, 'nearhear');
  const clip = { x: Math.floor(b0.l - 30), y: Math.floor(b0.t - 30), width: Math.ceil(b0.r - b0.l + 110), height: Math.ceil(b0.b - b0.t + 60) };
  const capOff = (await pg.screenshot({ clip })).toString('base64');
  B.pose = { ...B.pose, hear: false };
  let fl = await until(async () => { const pl = await plate(pg, 'nearhear'); return { ok: pl?.hear === false, pl }; });
  check('the flip arrived: the client holds hear:false for that peer', fl.ok, JSON.stringify(fl.pl));
  // count RENDERED frames, not ms: headless software GL draws a few a second, and the old mark took 5 Hz + a fade
  await pg.evaluate(() => new Promise((r) => { let n = 0; const f = () => (++n >= 40 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }));
  const capOn = (await pg.screenshot({ clip })).toString('base64');
  if (shotDir) { const { writeFileSync } = await import('node:fs'); writeFileSync(`${shotDir}/70b-hearing-crop.png`, Buffer.from(capOff, 'base64')); writeFileSync(`${shotDir}/70c-not-hearing-crop.png`, Buffer.from(capOn, 'base64')); }
  const px = await pg.evaluate(async ([a, b]) => {
    const load = async (b64) => { const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
    const A = await load(a), B = await load(b);
    // a changed pixel that is NEUTRAL GREY in the 'on' capture (the ear's stroke; the idle hair sway is orange)
    let l = Infinity, r = -1, t = Infinity, bt = -1, n = 0;
    for (let y = 0; y < A.height; y++) for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4, [R, G, Bl] = [B.data[i], B.data[i + 1], B.data[i + 2]];
      const d = Math.abs(R - A.data[i]) + Math.abs(G - A.data[i + 1]) + Math.abs(Bl - A.data[i + 2]);
      if (d > 60 && Math.max(R, G, Bl) - Math.min(R, G, Bl) < 30 && R > 70) { n++; l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); bt = Math.max(bt, y); }
    }
    return { n, l, r, t, b: bt };
  }, [capOff, capOn]);
  const pl = fl.pl, rel = { l: px.l + clip.x, r: px.r + clip.x, t: px.t + clip.y, b: px.b + clip.y };
  check('no mark (render): no grey pixel changes beside the pill when hearing goes off',
    px.n < 6 || !(rel.l >= pl.r - 3 && rel.l - pl.r < 20 && rel.t < pl.b + 2 && rel.b > pl.t - 2), JSON.stringify({ px, rel, plate: { l: pl.l, r: pl.r, t: pl.t, b: pl.b } }));
  await pg.evaluate(() => { EW.remotes.get('nearhear').avatar.mixer.timeScale = 1; });
  B.pose = { ...B.pose, hear: true };

  // ---- OCCLUSION + HOLD-TO-REVEAL, measured in the render ---------------------------------------------------------
  // the materials: body-attached sprites are depth-tested node sprites with the own-body depth pull; bubbles stay on top
  const mats = await pg.evaluate(() => {
    const av = EW.remotes.get('nearmute').avatar;
    av.say?.('hello there');
    const m = (s) => s && { node: !!s.material.isSpriteNodeMaterial, dt: s.material.depthTest, dw: s.material.depthWrite, dn: !!s.material.depthNode, clear: s.userData.plateClear };
    av._typingUntil = performance.now() + 60000; av._typingState = 'mic';   // a live mic stacks ABOVE a bubble (a composing pill would give way to it)
    return { label: m(av.label), bubble: av.bubble ? { dt: av.bubble.material.depthTest } : null };
  });
  await sleep(600);
  const typ = await pg.evaluate(() => { const t = EW.remotes.get('nearmute').avatar.typing; return t && { node: !!t.material.isSpriteNodeMaterial, dt: t.material.depthTest, dn: !!t.material.depthNode, clear: t.userData.plateClear }; });
  check('occlusion: the plate is a depth-tested node sprite carrying the own-body depth pull (no depth writes)',
    mats.label?.node && mats.label.dt === true && mats.label.dw === false && mats.label.dn && mats.label.clear >= 0.3, JSON.stringify(mats));
  check('…the typing pill too (clearance ≥ the plate’s: it sits above it)', typ?.node && typ.dt === true && typ.dn && typ.clear >= mats.label.clear, JSON.stringify(typ));
  check('…speech bubbles stay on top (depthTest off)', mats.bubble?.dt === false, JSON.stringify(mats.bubble));
  await pg.evaluate(() => { const av = EW.remotes.get('nearmute').avatar; av._typingUntil = 0; });

  // name-hued pixels inside a plate's box: THE measurement (#8fe8c8 on the dark pill; the walls here are neutral grey)
  const namePx = async (id) => {
    const p = await plate(pg, id);
    if (!p) return { n: -1 };
    const clip = { x: Math.max(0, Math.floor(p.l)), y: Math.max(0, Math.floor(p.t)), width: Math.ceil(p.r - p.l), height: Math.ceil(p.b - p.t) };
    const b64 = (await pg.screenshot({ clip })).toString('base64');
    const n = await pg.evaluate(async (b64) => {
      const bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0);
      const d = x.getImageData(0, 0, bm.width, bm.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 150 && d[i + 1] - (d[i] + d[i + 2]) / 2 > 35) n++;
      return n;
    }, b64);
    return { n, clip };
  };
  const reveal = () => pg.evaluate(async () => (await import('/lib/namereveal.js')).revealLevel()).catch((e) => `err: ${String(e).slice(0, 80)}`);
  await pg.evaluate(() => { for (const id of ['nearhear', 'nearmute']) EW.remotes.get(id).avatar.mixer.timeScale = 0; });
  await sleep(1200);
  const open0 = await namePx('nearhear');
  check('occlusion: the plate in the open shows its name (baseline)', open0.n >= 30, JSON.stringify(open0));
  // a WALL: an opaque box halfway between the eye and the plate, sized to cover it
  const place = (host, name, t, size) => pg.evaluate(([host, name, t, size]) => {
    const T = EW.THREE, av = EW.remotes.get('nearhear').avatar, e = new T.Vector3(), l = new T.Vector3();
    EW.camera.getWorldPosition(e); av.label.getWorldPosition(l);
    const box = new T.Mesh(new T.BoxGeometry(size, size, size), new T.MeshBasicNodeMaterial({ color: 0x3a3a3a }));
    box.name = name;
    const at = e.clone().lerp(l, t);
    const parent = host === 'scene' ? EW.scene : EW.remotes.get(host).avatar.vrm.scene;
    parent.add(box); parent.updateMatrixWorld(true);
    box.position.copy(parent.worldToLocal(at));
    return at.toArray();
  }, [host, name, t, size]);
  const unplace = (host, name) => pg.evaluate(([host, name]) => {
    const parent = host === 'scene' ? EW.scene : EW.remotes.get(host).avatar.vrm.scene;
    const b = parent.getObjectByName(name); b?.removeFromParent(); b?.geometry.dispose();
  }, [host, name]);
  const pxUntil = async (id, want, ms = 5000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await namePx(id); if (want(v.n)) return v; await sleep(200); } return v; };
  await place('scene', 'probe-wall', 0.5, 1.2);
  const walled = await pxUntil('nearhear', (n) => n < 3);
  check('occlusion: a wall between eye and plate hides it', walled.n < 3, JSON.stringify(walled));
  await shot(pg, 'occl-a-walled.png');
  // …and a walled plate opens no card: the pointer rests where the hidden name is, well past the hover delay. The
  // query's own verdict is read too, so a green here is about an occluded plate, not one the hit test never reached.
  const wp = await plate(pg, 'nearhear');
  await pg.mouse.move(wp.x, wp.y); await sleep(700);
  const wk = await cardState(pg), occ = await pg.evaluate(() => EW.remotes.get('nearhear').avatar.label.userData.occluded);
  check('occlusion: resting on the walled plate opens no card (its draw is occluded)', occ === true && wk.exists && !wk.open, JSON.stringify({ occ, wk }));
  await pg.mouse.move(640, 690); await sleep(300);
  // HOLD N: through the wall, at the held size
  await pg.mouse.move(640, 690);
  await pg.keyboard.down('KeyN');
  const held = await pxUntil('nearhear', (n) => n >= 30);
  const heldSz = await pg.evaluate(async () => {
    const { plateSize } = await import('/lib/platesize.js'); const { revealLevel } = await import('/lib/namereveal.js');
    const av = EW.remotes.get('nearhear').avatar, e = new EW.THREE.Vector3(); EW.camera.getWorldPosition(e);
    const d = av.root.position.distanceTo(e);
    return { k: revealLevel(), lw: av.label.scale.x, want: plateSize(d, 1).lw, clear: av.label.userData.plateClear, d };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
  check('reveal: holding N brings the walled plate through', held.n >= 30, JSON.stringify(held));
  check('…at level 1, the held size (plateSize(d, 1)), depth pulled past the eye', heldSz.k === 1 && Math.abs(heldSz.lw - heldSz.want) < 0.01 && heldSz.clear >= heldSz.d,
    JSON.stringify(heldSz));
  await shot(pg, 'occl-b-walled-held.png');
  await pg.keyboard.up('KeyN');
  const relN = await pxUntil('nearhear', (n) => n < 3);
  check('reveal: releasing N hides it again (level back to 0)', relN.n < 3 && (await reveal()) === 0, JSON.stringify(relN));
  // N typed into the chat line reveals nothing
  await pg.keyboard.press('Enter'); await sleep(300);
  const focused = await pg.evaluate(() => document.activeElement?.id);
  await pg.keyboard.down('KeyN'); await sleep(400);
  const typedK = await reveal();
  await pg.keyboard.up('KeyN');
  const typedTxt = await pg.evaluate(() => document.getElementById('chatline')?.value ?? null);
  check('reveal: N typed in the chat line reveals nothing (and types an n)', focused === 'chatline' && typedK === 0 && /n$/.test(typedTxt ?? ''),
    JSON.stringify({ focused, typedK, typedTxt }));
  await pg.evaluate(() => { const i = document.getElementById('chatline'); if (i) i.value = ''; });
  await pg.keyboard.press('Escape'); await sleep(200);
  await pg.evaluate(() => document.activeElement?.blur?.());
  await unplace('scene', 'probe-wall');
  // ANOTHER avatar's body in the way: the same box, but riding nearmute's body — it hides nearhear's plate
  await place('nearmute', 'probe-other', 0.5, 1.2);
  const other = await pxUntil('nearhear', (n) => n < 3);
  check('occlusion: another avatar’s body in front hides the plate', other.n < 3, JSON.stringify(other));
  await unplace('nearmute', 'probe-other');
  // ITS OWN body through the plate: a 0.5 m box riding nearhear's own body, centred on the plate — re-measured
  await pg.evaluate(() => {
    const T = EW.THREE, av = EW.remotes.get('nearhear').avatar, l = new T.Vector3(); av.label.getWorldPosition(l);
    const box = new T.Mesh(new T.BoxGeometry(0.5, 0.5, 0.5), new T.MeshBasicNodeMaterial({ color: 0x909090 }));
    box.name = 'probe-own'; av.vrm.scene.add(box); av.vrm.scene.updateMatrixWorld(true);
    box.position.copy(av.vrm.scene.worldToLocal(l)); av._ownClear = null;   // re-measure with the box as part of the body
  });
  const own = await pxUntil('nearhear', (n) => n >= 30);
  const ownClear = await pg.evaluate(() => EW.remotes.get('nearhear').avatar._ownClear);
  check('occlusion: its OWN body standing through the plate does not cut it (clearance re-measured past the box)',
    own.n >= 30 && ownClear >= 0.43, JSON.stringify({ own, ownClear }));
  await shot(pg, 'occl-c-own-body.png');
  await pg.evaluate(() => { EW.remotes.get('nearhear').avatar._ownClear = 0; });   // the NAIVE depth test
  const naive = await pxUntil('nearhear', (n) => n < 3);
  check('…while the naive depth test (clearance 0) does cut it — the case the clearance exists for', naive.n < 3, JSON.stringify(naive));
  await pg.evaluate(() => { const av = EW.remotes.get('nearhear').avatar; const b = av.vrm.scene.getObjectByName('probe-own'); b?.removeFromParent(); av._ownClear = null;
    for (const id of ['nearhear', 'nearmute']) EW.remotes.get(id).avatar.mixer.timeScale = 1; });
  await sleep(600);

  // ---- the hover card
  a = await plate(pg, 'nearmute');
  await pg.mouse.move(a.x, a.y); await sleep(150);
  let k = await cardState(pg);
  check('card: not open before the delay (150 ms in)', k.exists && !k.open, JSON.stringify(k));
  await sleep(350);
  k = await cardState(pg);
  check('card: open after the delay, for the person under the pointer', k.open && k.for === 'nearmute', JSON.stringify(k));
  const muteRow = await pg.evaluate(() => document.querySelector('#platecard [data-k="hear"] svg')?.outerHTML ?? '');
  check('…its hearing row wears crossed-out headphones (the HUD glyph + slash)', muteRow.includes('M4.5 14.25v-2.25')
    && muteRow.includes('M5.25 3 18.75 21'), muteRow.slice(0, 200));
  check('…it says who, mic off, headphones off (and not the default "present")', /nearmute/.test(k.text) && /mic off/.test(k.text)
    && /headphones off/.test(k.text) && !/present/.test(k.text), k.text);
  // the visor row (owner, 10-02): the HUD's VR glyph, and a peer that starts streaming a tracked body flips it live
  const xrRow = () => pg.evaluate(() => { const e = document.querySelector('#platecard [data-k="xr"]');
    return e && { on: e.dataset.on, text: e.textContent, glyph: (e.querySelector('svg')?.innerHTML ?? '').includes('M183.05,56H72') }; });
  let xr0 = await xrRow();
  check('…a VR row wearing the visor glyph, "not in VR" for a desktop peer', xr0?.glyph && xr0.on === 'false' && xr0.text === 'not in VR', JSON.stringify(xr0));
  A.pose = { ...A.pose, xr: { h: [0, 0, 0, 1] } };
  const until2 = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v?.ok) return v; await sleep(150); } return v; };
  const xr1 = await until2(async () => { const r = await xrRow(); return { ok: r?.on === 'true', r }; });
  check('…which turns to "in VR" when that peer streams a tracked body', xr1?.ok && xr1.r.text === 'in VR', JSON.stringify(xr1));
  delete A.pose.xr; A.pose = { ...A.pose };
  const xr2 = await until2(async () => { const r = await xrRow(); return { ok: r?.on === 'false', r }; });
  check('…and back when it stops', xr2?.ok, JSON.stringify(xr2));
  check('…beside the plate (right of it), inside the viewport',
    k.side === 'right' && k.l >= a.r && k.l - a.r < 24 && k.inView, JSON.stringify({ k, a }));
  await shot(pg, '71-hover-card.png');

  // rest on the card, then the person steps sideways: the card follows the plate
  await pg.mouse.move((k.l + k.r) / 2, (k.t + k.b) / 2); await sleep(400);
  const { k: k0, a: a0 } = await both(pg, 'nearmute');
  check('card: moving from plate onto the card keeps it open', k0.open && k0.for === 'nearmute', JSON.stringify(k0));
  A.pose = { ...A.pose, p: at(fr, 3, -2.4) };   // a half-metre step: the card moves ~50 px and stays under the resting pointer
  // the body glides to its new place over several (slow, headless) frames: wait for the plate to stop, then read card
  // and plate in ONE evaluate — two calls can straddle a frame and measure a moving plate against a stale card
  { let px = null; for (let i = 0; i < 40; i++) { await sleep(150); const x = (await plate(pg, 'nearmute')).x; if (px !== null && Math.abs(x - px) < 0.5 && Math.abs(x - a0.x) > 20) break; px = x; } }
  const { k: k1, a: a1 } = await both(pg, 'nearmute');
  const dPlate = a1.x - a0.x, dCard = k1.l - k0.l;
  check('card: follows the plate while open', k1.open && Math.abs(dPlate) > 20 && Math.abs(dCard - dPlate) < 6,
    JSON.stringify({ dPlate, dCard, k0, k1, a0, a1 }));

  // leave plate and card: it closes
  await pg.mouse.move(640, 690); await sleep(600);
  k = await cardState(pg);
  check('card: leaving plate and card closes it', !k.open, JSON.stringify(k));

  // Esc closes it and nothing else
  a = await plate(pg, 'nearmute');
  await pg.mouse.move(a.x, a.y); await sleep(600);
  const framesBefore = await pg.evaluate(() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').length);
  k = await cardState(pg);
  await pg.keyboard.press('Escape'); await sleep(200);
  const k2 = await cardState(pg);
  const framesAfter = await pg.evaluate(() => [...document.querySelectorAll('.frame')].filter((f) => getComputedStyle(f).display !== 'none').length);
  check('card: Esc closes it', k.open && !k2.open, JSON.stringify({ k, k2 }));
  check('…and goes no further: the open panels stay', framesBefore > 0 && framesAfter === framesBefore, JSON.stringify({ framesBefore, framesAfter }));

  // the action: "message" opens their DM tab
  B.pose = { ...B.pose, presence: 'busy' };
  await pg.mouse.move(640, 690); await sleep(300);
  a = await plate(pg, 'nearhear');
  await pg.mouse.move(a.x, a.y);
  k = (await until(async () => { const c = await cardState(pg); return { ok: c.open && c.for === 'nearhear', ...c }; }, 3000));
  check('card on a hearing, busy peer: mic on, headphones on, busy', k.open && k.for === 'nearhear' && /mic on/.test(k.text)
    && /headphones on/.test(k.text) && /busy/.test(k.text), k.text);
  const hearRow = { html: await pg.evaluate(() => document.querySelector('#platecard [data-k="hear"] svg')?.outerHTML ?? '') };
  check('…its hearing row wears the HUD’s headphones (no slash while hearing)', hearRow.html.includes('M4.5 14.25v-2.25')
    && !hearRow.html.includes('M5.25 3 18.75 21'), hearRow.html.slice(0, 200));
  await shot(pg, '73-hover-card-hearing-busy.png');
  await pg.mouse.move(k.l + 20, k.b - 12); await sleep(100);
  await pg.click('#platecard button[data-act="dm"]'); await sleep(400);
  const dm = await pg.evaluate(() => ({ card: !document.getElementById('platecard').hidden,
    tab: [...document.querySelectorAll('.chat-frame .chat-tabs button')].map((b) => b.textContent.trim()).find((t) => /nearhear/.test(t)) ?? null,
    focus: document.activeElement?.id }));
  check('card: "message" opens their DM tab and closes the card', !dm.card && dm.tab && dm.focus === 'chatline', JSON.stringify(dm));
  await pg.keyboard.press('Escape'); await sleep(150);

  // a close look for the review: the hard-of-hearing peer a couple of metres from the camera
  if (shotDir) {
    A.pose = { ...A.pose, p: at(fr, -1.4, -1.1) }; await sleep(2500);
    const c1 = await plate(pg, 'nearmute');
    if (c1) await shot(pg, '74-ear-close.png', { x: Math.max(0, c1.l - 60), y: Math.max(0, c1.t - 50), width: 260, height: 140 });
  }
  check('desktop: no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();

  // ------------------------------------------------------------ phone 390x844, touch
  const ph = await boot({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, 'platephone');
  const pf = await frameOf(ph.pg);
  A.pose = { ...A.pose, p: at(pf, 4, 0) };
  B.pose = { ...B.pose, p: at(pf, 30, 3) };
  C.pose = { ...C.pose, p: at(pf, 34, -3) };
  await ph.pg.waitForFunction(() => EW.remotes.get('nearmute')?.avatar?.label && EW.remotes.get('nearmute').hear === false, null, { timeout: 90000 });
  await ph.pg.evaluate(async () => {   // the same settled-body wait as the desktop pass
    let last = EW.remotes.get('nearmute')?.avatar, since = performance.now();
    while (performance.now() - since < 2000) {
      await new Promise((r) => setTimeout(r, 100));
      const now = EW.remotes.get('nearmute')?.avatar;
      if (now !== last || EW.remotes.get('nearmute')?.loading) { last = now; since = performance.now(); }
    }
  });
  await sleep(1000);
  a = await plate(ph.pg, 'nearmute');
  await ph.pg.touchscreen.tap(a.x, a.y); await sleep(400);
  k = await cardState(ph.pg);
  if (!k.open) console.log('    diag phone', JSON.stringify({ a, after: await plate(ph.pg, 'nearmute'),
    plog: await ph.pg.evaluate(() => __plog.slice(-6)),
    top: await ph.pg.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}#${e.id}.${e.className}` : null; }, [a.x, a.y]) }));
  check('phone: a tap on a plate opens its card, inside the viewport', k.open && k.for === 'nearmute' && k.inView, JSON.stringify(k));
  check('…clear of the plate (no overlap)', k.t >= a.b || k.l >= a.r || k.r <= a.l, JSON.stringify({ k, a }));
  await shot(ph.pg, '72-hover-card-phone.png');
  await ph.pg.touchscreen.tap(195, 780); await sleep(300);
  k = await cardState(ph.pg);
  check('phone: a tap elsewhere closes it', !k.open, JSON.stringify(k));
  check('phone: no page errors', ph.errs.length === 0, ph.errs.join(' | '));
  await ph.ctx.close();
} finally {
  endPeers();
  await close().catch(() => {});
  await world.close();
}
done();
