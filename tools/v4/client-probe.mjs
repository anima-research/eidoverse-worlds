// tools/v4/client-probe.mjs — TODAY's client (headless Chromium) visiting a v4 world (protocol/v4 slice 2).
// usage (one Chrome, under the guard):  perf-guard.sh -t 240 -- bun tools/v4/client-probe.mjs
// What it shows, each as a stage line printed green or red:
//   boot      the client boots into a v4 world (founded by tools/v4/world.ts in a scratch WORLDS_DIR) and finishes
//   see       a thing created through the door BEFORE the visit is realized (the snapshot's projection)
//   live      a thing another person creates through the door WHILE it watches is realized (projected v1 verbs)
//   spot      a spot light set through the door lights a spot slot with its cone, shining down the thing's -Z
//   rocket    a socket's whole rotation: sitting in a seat lying on its back lays the body down; standing rights it
//   throw     a thing Bob throws through the door FLIES on Ann's screen (its position changes frame to frame) and comes
//             to rest bit for bit where the door logs the rest (her client folds the launch with the door's engine)
//   carry     Ann picks a thing up (her page's own grab: the door tracks her body), it follows her hand as she walks,
//             and her throw flies and rests where the door says
//   punt      Ann punts a ball at her feet (the C key's act): it flies, and rests where the door logs it
//   remote    a thing Bob holds is drawn in Bob's hand on Ann's screen, and follows him when he moves
//   reach     a hand target on a moving part moves the hand with the part
//   blend     a pose blended by a signal (param.lean, written through the door) follows it, in the mixer's own weights
//   anchor    hips (a seat) lands the hips joint on the socket; feet (a standing place) lands the soles on it
//   swing     a phase-locked pose: the clip's time follows the pendulum's phase; the sitter tilts with the plank
//   leaveBy   script: W and X don't get you off, the world does (the socket taken away); without it, W does
//   remote    another person's input (throttle) riding their presence blends their seated body in this client
//   enter     an approach point and an enter clip: the clip plays with its time locked to the carry onto the seat
//   grab      grabbable: a thing held by its grip sits with the grip in the palm (Ann's own hand), her fingers wear the
//             grip's preset and her desktop body the hold pose; a thing Bob holds in his LEFT hand by its handle is drawn
//             there on Ann's screen, from his remote body's own bones; a two-handed thing aims from hand to hand; a
//             far grab eases into the hand
//   xr        (PROBE_ONLY=xr: its own boot, under IWER with ?xr=1) a VR hand's grip takes a thing near it (held where
//             grabbed: an offset), letting go throws it with the hand's velocity × its grabbable.throw, the trigger while
//             holding is use (down, up), the laser reaches a thing out to its range, and a second hand takes a
//             two-handed thing in both
//   errors    no page error and no console.error from the v4 path
// PROBE_ONLY=grab runs boot, see, live and the grab stages only (the rest is skipped, said so). PROBE_ONLY=xr the same
// with the VR stages.
// The owned server runs with SKIP_OPT_SWEEP=1 and a scratch WORLDS_DIR; the world has no sky (the headless-sky
// rule: no cloud bake in SwiftShader). Teardown (browser, server, scratch) is in finally.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, ownedWorld } from '../probe-harness.mjs';
import { foundV4 } from '../../server/v4/world.ts';
import { openLive } from '../../server/v4/live.ts';
import { request } from '../../shared/v4/door.js';
import { readLog } from '../../shared/v4/fold.js';
import { enc } from '../../shared/v4/names.js';
import { ENGINE_CATALOGUE, warm } from '../../server/v4/catalogue.ts';
import { directoryFor } from '../../server/v4/directory.ts';
import { restsOf } from '../../shared/v4/simlayer.js';
import { cycleOf } from '../../client/lib/socksignals.js';
import { swingGlb } from './probe-swing-glb.mjs';
import { OPT_DIR } from '../../server/config.ts';
import { fingerPose, armPose } from '../../shared/grab.js';
// IWER (the VR stages only): installed before any client code, with its device loop pinned to the native clock (memory:
// reference_iwer_headless_probe; tools/xr-lifecycle-probe.mjs says why)
const IWER_RAW = readFileSync(new URL('../../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8');
const DEVICE_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
const ONLY = (process.env.PROBE_ONLY ?? '').split(',').filter(Boolean);

const MODEL = 'eidoverse/assets/models/crate_large_red.glb';
const SMALL = 0.3;   // the crate at 0.3 scale (0.75 × 0.6 × 0.45 m): something to carry (its GLB is already loaded and compiled)
// a swing whose plank is its own part named the way a component key can name it (motion:plank): the probe's own
// model, written beside the optimised assets for this run only (removed in finally)
const SWING = `eidoverse/assets/models/v4probe-swing-${process.pid}.glb`;
const SWING_FILE = join(OPT_DIR, SWING);
const KEY = 'v4probe';
const worlds = mkdtempSync(join(tmpdir(), 'v4-client-'));
const stage = (name, okv, detail) => console.log(`${okv ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
let failed = 0; const check = (n, v, d) => { if (!v) failed++; stage(n, v, d); return v; };
let world = null, b = null, ANN = null, BOB = null;
try {
  // the world: founded by Ann, a crate already standing in it, Bob a builder
  foundV4(join(worlds, 'garden'), 'garden', 'Ann', 'a v4 garden');
  mkdirSync(join(SWING_FILE, '..'), { recursive: true }); writeFileSync(SWING_FILE, swingGlb());
  await warm([MODEL, SWING]);
  { const w = openLive(join(worlds, 'garden'), 'garden', { catalogue: ENGINE_CATALOGUE });
    // actors are the door directory's opaque ids (one per account, R 10-06): Ann founded it as local:ann; Bob will join
    // this local door by name, so his account is local:bob
    const dir = directoryFor(worlds); ANN = dir.idOfSub('local:ann'); BOB = dir.resolve({ sub: 'local:bob', name: 'Bob' });
    const r1 = request(w, ANN, 'create', { id: 'crate-before', model: MODEL, components: { transform: { pos: [0, 0, 3] } } });
    const r2 = request(w, ANN, 'set', { id: '@world', component: `roles:${BOB}`, value: { role: 'builder' } });
    const r3 = request(w, ANN, 'set', { id: '@world', component: 'sim', value: { engine: 'eidosim@0.5.0' } }); // the world runs physics
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error(`setup: ${JSON.stringify([r1, r2, r3])}`); }
  world = await ownedWorld({ key: KEY, env: { WORLDS_DIR: worlds, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TRUST_NAMES: '1' } });
  b = await launchBrowser();
  const pg = await b.page();
  const errors = [], logs = [];
  pg.on('pageerror', (e) => errors.push(String(e)));
  pg.on('console', (m) => { const t = m.text(); logs.push(t); if (m.type() === 'error') errors.push(t); });
  const http4xx = []; pg.on('response', (r) => { if (r.status() >= 400) http4xx.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  const XR = ONLY.includes('xr');
  if (XR) {
    if (IWER_RAW.split(DEVICE_LOOP).length !== 2) throw new Error(`iwer build changed: expected exactly one '${DEVICE_LOOP}'`);
    await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // the sky guard
    await pg.addInitScript(`globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n` + IWER_RAW.replace(DEVICE_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)'));
    await pg.addInitScript(() => {
      if (window.__probe) return;
      const { XRDevice, metaQuest3 } = window.IWER ?? {};
      if (!XRDevice) { window.__probe = { fatal: 'IWER did not load' }; return; }
      const device = new XRDevice(metaQuest3); device.installRuntime({ forceInstall: true });   // forceInstall: headless Chromium ships a stub
      window.__iwerDevice = device; try { delete window.IWER; } catch { window.IWER = undefined; }
      window.__probe = { grants: 0, sessionFrames: 0 };
      const real = navigator.xr.requestSession.bind(navigator.xr);
      navigator.xr.requestSession = async (...a) => { const s = await real(...a); window.__probe.grants++;
        const sRaf = s.requestAnimationFrame.bind(s); s.requestAnimationFrame = (cb) => sRaf((t, fr) => { window.__probe.sessionFrames++; return cb(t, fr); }); return s; };
    });
  }
  await pg.goto(`${world.origin}/?world=garden&name=Ann&key=${KEY}${process.env.PROBE_AVATAR ? `&avatar=${process.env.PROBE_AVATAR}` : ''}${XR ? '&xr=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const race = (p, ms = 20000) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`evaluate stalled ${ms} ms`)), ms))]);
  const ents = () => race(pg.evaluate(() => [...(globalThis.EW?.entities?.keys?.() ?? [])]));
  // boot: the client's own ready line, and the splash gone
  let ready = null; const t0 = Date.now();
  while (Date.now() - t0 < 90000) { ready = logs.find((l) => /^\[boot\] ready in \d+ms/.test(l)) ?? null;
    const gone = await race(pg.evaluate(() => { const sp = document.getElementById('splash'); return !sp || sp.classList.contains('gone'); })).catch(() => false);
    if (ready && gone) break; await new Promise((r) => setTimeout(r, 250)); }
  const net = await race(pg.evaluate(() => ({ joined: !!globalThis.EW?.net?.joined, you: globalThis.EW?.net?.myId, role: globalThis.EW?.net?.myRights?.role })));
  if (!check('boot: the client finishes booting into the v4 world, as its owner', !!ready && net.joined && net.role === 'owner', { ready, net, errors: errors.slice(0, 3), tail: logs.slice(-5) })) throw new Error('boot gate failed');
  // see
  let seen = false; for (let i = 0; i < 40 && !seen; i++) { seen = (await ents()).includes('crate-before'); if (!seen) await new Promise((r) => setTimeout(r, 250)); }
  check('see: the crate created through the door before the visit is realized', seen, await ents());
  // live: Bob, through the door, over his own socket
  const ws = new WebSocket(world.origin.replace('http', 'ws') + '/ws');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const inbox = []; ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  // Bob wears a body with finger bones (the default claude.vrm has none), so the grab stages can read a grip's finger preset
  ws.send(JSON.stringify({ type: 'join', world: 'garden', id: 'Bob', avatar: process.env.PROBE_BOB_AVATAR ?? 'tigerbee', token: KEY, v4fold: true }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'snapshot'); i++) await new Promise((r) => setTimeout(r, 100));
  ws.send(JSON.stringify({ type: 'v4', id: 1, tool: 'create', args: { id: 'crate-live', model: MODEL, place: { near: 'crate-before' } } }));
  for (let i = 0; i < 40 && !inbox.some((m) => m.type === 'v4-result'); i++) await new Promise((r) => setTimeout(r, 100));
  const res = inbox.find((m) => m.type === 'v4-result');
  let live = false; for (let i = 0; i < 40 && !live; i++) { live = (await ents()).includes('crate-live'); if (!live) await new Promise((r) => setTimeout(r, 250)); }
  if (!res?.ok) stage('live: Bob\'s replies', false, inbox.filter((m) => m.type !== 'presence').slice(0, 4).map((m) => [m.type, m.you ?? m.reply ?? m.error]));
  check('live: a crate Bob creates through the door while Ann watches is realized in her client', res?.ok && live, { reply: res?.reply?.ok ?? res?.reply?.refused, ents: await ents() });

  // ===================================================================== grabbable (shared/grab.js; v4phys drawHeld)
  // Bob builds through the door; Ann grabs with her own page (the T key's act). What's drawn is read off the live scene:
  // the thing's grip point in the world against the palm frame v4phys computes from the hand's own raw bones, the
  // fingers and arms on the normalized rig. Angles in degrees, distances in metres.
  if (XR) stage('grab: (the desktop grab stages are skipped in an XR boot)', true);
  if ((!ONLY.length || ONLY.includes('grab')) && !XR) {
    let gid = 500; const gdoor = async (tool, args) => { const id = ++gid; ws.send(JSON.stringify({ type: 'v4', id, tool, args }));
      for (let i = 0; i < 80; i++) { const m = inbox.find((x) => x.type === 'v4-result' && x.id === id); if (m) return m.reply ?? m; await new Promise((r) => setTimeout(r, 100)); }
      return { ok: false, refused: { reason: 'no answer' } }; };
    const gsleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const gev = (fn, arg) => race(pg.evaluate(fn, arg), 20000);
    const gwait = async (fn, arg, ms = 30000) => { const t = Date.now(); let v = null; while (Date.now() - t < ms) { v = await gev(fn, arg).catch(() => null); if (v) return v; await gsleep(250); } return v; };
    const SHOTS = process.env.PROBE_SHOTS;
    const gshoot = async (name, who, offset) => { if (!SHOTS) return;
      await gev(({ who, o }) => { const EW = globalThis.EW; const av = who ? EW.remotes.get(who)?.avatar : EW.me(); const h = av.vrm.humanoid.getRawBoneNode('chest').getWorldPosition(new EW.THREE.Vector3());
        EW.__shot = { at: h.toArray(), from: [h.x + o[0], h.y + o[1], h.z + o[2]] };
        if (!EW.__shotLoop) { EW.__shotLoop = true; const f = () => { const s = EW.__shot; if (s) { const c = EW.camera; c.up.set(0, 1, 0); c.position.set(...s.from); c.lookAt(...s.at); c.updateMatrixWorld(); try { EW.renderer.render(EW.scene, c); } catch {} } requestAnimationFrame(f); }; requestAnimationFrame(f); } }, { who, o: offset });
      await gsleep(2500); await pg.screenshot({ path: `${SHOTS}/${name}.png` }); await gev(() => { globalThis.EW.__shot = null; }); };
    // where a thing's named grip is in the world, its frame (thing q × grip q), and the holder's palm frame, on this page
    const gripVsPalm = (id, grip, who, side) => gev(({ id, grip, who, side }) => { const EW = globalThis.EW, T = EW.THREE; const o = EW.entities.get(id); if (!o) return null;
      const c = EW.physics.grabbable(id)?.grips?.[grip]; if (!c) return { noGrip: true };
      o.updateWorldMatrix(true, false); const p = new T.Vector3(...c.pos).applyMatrix4(o.matrixWorld);
      const q = o.getWorldQuaternion(new T.Quaternion()).multiply(new T.Quaternion(...(c.q ?? [0, 0, 0, 1])));
      const palm = EW.physics.palm(who, side); if (!palm) return { noPalm: true };
      const pq = new T.Quaternion(...palm.q); const ang = 2 * Math.acos(Math.min(1, Math.abs(pq.dot(q)))) * 180 / Math.PI;
      return { d: +p.distanceTo(new T.Vector3(...palm.p)).toFixed(4), ang: +ang.toFixed(2), grip: p.toArray().map((v) => +v.toFixed(3)), palm: palm.p.map((v) => +v.toFixed(3)), ...(globalThis.__diag ? { held: EW.physics.heldAt(id) } : {}) }; }, { id, grip, who, side });
    // a normalized bone's local rotation against what the shared preset says (the angle between them)
    const boneVs = (who, bone, want) => gev(({ who, bone, want }) => { const EW = globalThis.EW; const av = who ? EW.remotes.get(who)?.avatar : EW.me(); const n = av?.vrm?.humanoid?.getNormalizedBoneNode(bone); if (!n) return null;
      const q = n.quaternion; const d = Math.abs(q.x * want[0] + q.y * want[1] + q.z * want[2] + q.w * want[3]); return { ang: +(2 * Math.acos(Math.min(1, d)) * 180 / Math.PI).toFixed(2), q: q.toArray().map((v) => +v.toFixed(3)) }; }, { who, bone, want });
    const me = await gev(() => globalThis.EW.me().root.position.toArray());
    // each held thing goes down at a spot of its own in front of her (a put the door refuses is a harness defect: said)
    const gput = async (id, dx, dz) => { const at = await gev(() => globalThis.EW.me().root.position.toArray());
      const r = await race(pg.evaluate(({ id, pos }) => globalThis.EW.physics.request('put', { id, pos }), { id, pos: [+(at[0] + dx).toFixed(3), 0, +(at[2] + dz).toFixed(3)] }), 20000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
      if (!r?.ok) stage(`grab: cleanup put of ${id}`, false, r?.refused); };
    if (process.env.PROBE_DIAG) await gev(() => { globalThis.__diag = true; });
    const ANNID = await gev(() => globalThis.EW.net.v4you);
    if (process.env.PROBE_DIAG) stage('grab: diag (rigs)', true, await gev(() => { const EW = globalThis.EW, T = EW.THREE; const out = {};
      for (const [k, av] of [['ann', EW.me()], ...[...EW.remotes.entries()].map(([id, r]) => [id, r.avatar])]) { const H = av?.vrm?.humanoid; if (!H) { out[k] = null; continue; }
        const raw = H.getRawBoneNode('rightHand'), nrm = H.getNormalizedBoneNode('rightHand');
        out[k] = { path: av.path ?? av.avatarPath ?? null, meta: av.vrm.meta?.metaVersion, fingers: ['rightIndexProximal', 'rightThumbProximal', 'leftIndexProximal'].map((b) => !!H.getRawBoneNode(b)),
          rawVsNorm: raw && nrm ? +raw.getWorldPosition(new T.Vector3()).distanceTo(nrm.getWorldPosition(new T.Vector3())).toFixed(3) : null }; }
      return out; }));
    // Bob steps aside first (he joined where Ann stands: the pictures would show his back)
    { const away = [me[0] + 2.5, 0, me[2] + 1]; await gdoor('move', { to: away }); for (let i = 0; i < 6; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: away, yaw: 0, speed: 0, clip: 'idle' } })); await gsleep(100); } }
    // (1) a small sword held by its hilt, in Ann's right hand (size under 0.5 m: the one-hand pose)
    const HILT_Q = [0, 0, 0, 1];
    const mk = await gdoor('create', { id: 'sword', model: MODEL, components: { transform: { pos: [me[0] + 0.5, 0, me[2]], scale: [0.04, 0.15, 0.04] },
      grabbable: { who: 'visitor', grips: { hilt: { pos: [0, 0.4, 0], q: HILT_Q, fingers: 'fist' } } } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'sword');
    const gr = await race(pg.evaluate(() => globalThis.EW.physics.grab('sword')), 20000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    const rec = await gwait(() => { const h = globalThis.EW.physics.holds().sword; return h?.grip ? h : null; });
    if (process.env.PROBE_DIAG) stage('grab: diag (comps)', true, await gev(() => ({ comps: Object.keys(globalThis.EW.comps.get('sword') ?? {}), keys: [...globalThis.EW.comps.keys()].slice(0, 8) })));
    await gsleep(1500);   // the pull ease and the pose's own ease
    const gp = await gripVsPalm('sword', 'hilt', ANNID, 'right');
    check('grab: Ann\'s grab of a thing with a grip comes back as the hold record (right hand, its hilt)', gr?.ok && rec?.hand === 'right' && rec?.grip === 'hilt', { gr: gr?.ok ?? gr?.refused, mk: mk?.ok ?? mk?.refused, rec });
    check('grab: …and it is drawn with the hilt in her palm (the grip point on the palm\'s origin, its frame the palm\'s)', gp && gp.d < 0.01 && gp.ang < 2, gp);
    const fist = fingerPose('fist', 'right'); const f1 = await boneVs(null, 'rightIndexProximal', fist.rightIndexProximal), f2 = await boneVs(null, 'rightMiddleIntermediate', fist.rightMiddleIntermediate);
    if (!f1 && !f2) stage('grab: …her fingers: skipped, her body has no finger bones (claude.vrm; PROBE_AVATAR=aletheia checks them; Bob\'s below are checked)', true);
    else check('grab: …her fingers close round it (the grip\'s fist preset on the normalized fingers)', f1 && f2 && f1.ang < 1.5 && f2.ang < 1.5, { f1, f2 });
    const arm = armPose('hand', 'right'); const a1 = await boneVs(null, 'rightUpperArm', arm.rightUpperArm), a2 = await boneVs(null, 'rightLowerArm', arm.rightLowerArm);
    check('grab: …and her desktop body holds it (the one-hand pose: no tracked hands, a thing under 0.5 m)', a1 && a2 && a1.ang < 1.5 && a2.ang < 1.5, { a1, a2 });
    await gshoot('grab-grip-ann', null, [0.9, 0.1, 1.2]);
    await gput('sword', -0.7, 0.8);
    // (2) Bob holds a lantern by its handle in his LEFT hand: Ann's page draws it at his remote body's left palm
    const BP = [me[0] + 2.5, 0, me[2] + 1];
    await gdoor('move', { to: BP }); for (let i = 0; i < 6; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: BP, yaw: 0, speed: 0, clip: 'idle' } })); await gsleep(100); }
    const mk2 = await gdoor('create', { id: 'lantern', model: MODEL, components: { transform: { pos: [BP[0], 0, BP[2] + 0.5], scale: [0.06, 0.12, 0.06] },
      grabbable: { who: 'visitor', grips: { handle: { pos: [0, 1.8, 0], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2], fingers: 'pinch' } } } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'lantern');
    const bg = await gdoor('grab', { id: 'lantern', hand: 'left' });
    await gwait(() => globalThis.EW.physics.holds().lantern?.hand === 'left'); await gsleep(2000);
    const lp = await gripVsPalm('lantern', 'handle', BOB, 'left');
    check('grab: a lantern Bob holds in his LEFT hand by its handle is drawn there on Ann\'s screen (his remote body\'s own bones)', bg?.ok && lp && lp.d < 0.01 && lp.ang < 2, { bg: bg?.ok ?? bg?.refused, mk2: mk2?.ok ?? mk2?.refused, lp });
    const pinch = fingerPose('pinch', 'left'); const bf = await boneVs('Bob', 'leftIndexProximal', pinch.leftIndexProximal);
    const barm = armPose('hand', 'left'); const ba = await boneVs('Bob', 'leftUpperArm', barm.leftUpperArm);
    check('grab: …his left fingers pinch it and his left arm holds it, on Ann\'s page (the same presets, from the hold record)', bf && ba && bf.ang < 1.5 && ba.ang < 1.5, { bf, ba });
    await gshoot('grab-remote-left', 'Bob', [-0.6, 0.1, 1.3]);
    // (3) two hands: a rifle held at its stock (right), the left hand on the fore grip steers it
    const me3 = await gev(() => globalThis.EW.me().root.position.toArray());
    const mk3 = await gdoor('create', { id: 'rifle', model: MODEL, components: { transform: { pos: [me3[0] - 0.5, 0, me3[2]], scale: [0.03, 0.03, 0.4] },
      grabbable: { who: 'visitor', twoHanded: true, grips: { stock: { pos: [0, 1, -0.4], hand: 'right', fingers: 'trigger' }, fore: { pos: [0, 1, 0.5], role: 'secondary', fingers: 'fist' } } } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'rifle');
    const r1 = await race(pg.evaluate(() => globalThis.EW.physics.grab('rifle')), 20000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    const r2 = await race(pg.evaluate(() => globalThis.EW.physics.request('grab', { id: 'rifle', hand: 'left' })), 20000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    await gwait(() => !!globalThis.EW.physics.holds().rifle?.second); await gsleep(1500);
    const aim = await gev((who) => { const EW = globalThis.EW, T = EW.THREE; const o = EW.entities.get('rifle'); const G = EW.physics.grabbable('rifle').grips; o.updateWorldMatrix(true, false);
      const s = new T.Vector3(...G.stock.pos).applyMatrix4(o.matrixWorld), f = new T.Vector3(...G.fore.pos).applyMatrix4(o.matrixWorld);
      const R = EW.physics.palm(who, 'right'), L = EW.physics.palm(who, 'left'); if (!R || !L) return null;
      const a = f.clone().sub(s).normalize(), b = new T.Vector3(...L.p).sub(new T.Vector3(...R.p)).normalize();
      return { ang: +(Math.acos(Math.min(1, a.dot(b))) * 180 / Math.PI).toFixed(2), stockToPalm: +s.distanceTo(new T.Vector3(...R.p)).toFixed(4) }; }, ANNID);
    const two = armPose('two-hand', 'right'); const t1 = await boneVs(null, 'leftUpperArm', two.leftUpperArm);
    check('grab: two hands: the stock in her right palm, the line to the fore grip points at her left hand, and both arms take the two-hand pose', r1?.ok && r2?.ok && aim && aim.stockToPalm < 0.01 && aim.ang < 2 && t1 && t1.ang < 1.5, { r1: r1?.ok || r1?.refused || r1, r2: r2?.ok || r2?.refused || r2, me3, body: await gev(() => globalThis.EW.physics.body()).catch(() => null), mk3: mk3?.ok ?? mk3?.refused, aim, t1 });
    await gshoot('grab-two-hands', null, [1.1, 0.2, 1.1]);
    await gput('rifle', 0, 1);
    // (4) a far grab (range 4) eases into the hand: sampled per frame right after the grab
    const me4 = await gev(() => globalThis.EW.me().root.position.toArray());
    const mk4 = await gdoor('create', { id: 'apple', model: MODEL, components: { transform: { pos: [me4[0] + 2.6, 0, me4[2]], scale: [0.05, 0.05, 0.05] }, grabbable: { who: 'visitor', range: 4 } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'apple');
    const pull = await race(pg.evaluate(async () => { const EW = globalThis.EW, T = EW.THREE; const r = await EW.physics.grab('apple'); const out = [];
      const t0 = performance.now(); while (!EW.physics.holds().apple && performance.now() - t0 < 15000) await new Promise((f) => setTimeout(f, 30));
      const t1 = performance.now(); for (let i = 0; i < 40; i++) { const o = EW.entities.get('apple'); const h = EW.me().vrm.humanoid.getRawBoneNode('rightHand').getWorldPosition(new T.Vector3());
        out.push([Math.round(performance.now() - t1), +new T.Box3().setFromObject(o).getCenter(new T.Vector3()).distanceTo(h).toFixed(3)]); await new Promise((f) => requestAnimationFrame(f)); if (performance.now() - t1 > 1200) break; }
      return { ok: r?.ok, pulled: r?.notes?.some((n) => n.pulled), out }; }), 40000).catch((e) => ({ err: String(e) }));
    const ds = pull?.out?.map((x) => x[1]) ?? [];
    check('grab: a far grab (range 4) flies to her hand: it starts where it stood and eases in (presence: every client draws the same ease)', pull?.ok && pull.pulled && ds.length >= 3 && ds[0] > 1 && ds.at(-1) < 0.2, { mk4: mk4?.ok ?? mk4?.refused, pull: { ...pull, out: pull?.out?.slice(0, 12) } });
    await gput('apple', 0.7, 0.8);
    // (5) use while held: Ann's hose (use {down: spray, up: stop}) through the left mouse button on the canvas, the door
    //     changing its state on each press and release, and its fx (presence) drawn while she presses
    const FX = { particles: { preset: 'magic', count: 60, size: 4 }, at: [0, 2, 0] };   // (an emitter rides its thing's scale: 0.05 here)
    const me5 = await gev(() => globalThis.EW.me().root.position.toArray());
    const mk5 = await gdoor('create', { id: 'hose', model: MODEL, components: { transform: { pos: [me5[0] + 0.5, 0, me5[2]], scale: [0.05, 0.05, 0.05] },
      grabbable: { who: 'visitor', use: { down: 'spray', up: 'stop' }, fx: FX },
      reactions: { spray: { kind: 'set', component: 'flowing', value: true }, stop: { kind: 'set', component: 'flowing', value: false } } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'hose');
    const h5 = await race(pg.evaluate(() => globalThis.EW.physics.grab('hose')), 20000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    await gwait(() => !!globalThis.EW.physics.holds().hose);
    const press = (type) => gev((type) => { const c = globalThis.EW.renderer.domElement; c.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true, clientX: 640, clientY: 360 })); return true; }, type);
    await press('mousedown');
    const down = await gwait(() => (globalThis.EW.comps.get('hose')?.flowing === true && globalThis.EW.physics.fx().includes('hose')) ? { flowing: true, fx: globalThis.EW.physics.fx(), use: globalThis.EW.myState.useHeld } : null, null, 20000);
    await gshoot('grab-use-fx', null, [0.9, 0.2, 1.3]);
    await press('mouseup');
    const up = await gwait(() => (globalThis.EW.comps.get('hose')?.flowing === false && !globalThis.EW.physics.fx().includes('hose')) ? { flowing: false, fx: globalThis.EW.physics.fx(), use: globalThis.EW.myState.useHeld ?? null } : null, null, 20000);
    const acts5 = readLog(readFileSync(join(worlds, 'garden', 'v4.jsonl'))).filter((e) => e.kind === 'act' && e.verb === 'use' && e.body?.request?.id === 'hose').map((e) => `${e.body.held?.phase}:${e.body.action}`);
    check('grab: use while held: the left button on her hose is use.down (the door sets it flowing; its fx draws while pressed), letting go is use.up (one act each)', h5?.ok && down && up && JSON.stringify(acts5) === '["down:spray","up:stop"]', { mk5: mk5?.ok ?? mk5?.refused, h5: h5?.ok ?? h5?.refused, down, up, acts5 });
    await gput('hose', 0.7, -0.8);
    // (6) the presence tier from someone else: Bob presses use on the nozzle he holds (his pose carries use; nothing is
    //     logged), and Ann's page draws its fx until his pose stops carrying it
    const BP6 = [me5[0] + 2.5, 0, me5[2] + 1];
    await gdoor('create', { id: 'nozzle', model: MODEL, components: { transform: { pos: [BP6[0], 0, BP6[2] + 0.5], scale: [0.05, 0.05, 0.05] }, grabbable: { who: 'visitor', fx: FX } } });
    await gwait((i) => !!globalThis.EW.entities.get(i), 'nozzle');
    const b6 = await gdoor('grab', { id: 'nozzle' }); await gwait(() => !!globalThis.EW.physics.holds().nozzle);
    const n6 = readLog(readFileSync(join(worlds, 'garden', 'v4.jsonl'))).length;
    let on6 = null; for (let i = 0; i < 60 && !on6; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: BP6, yaw: 0, speed: 0, clip: 'idle', use: { id: 'nozzle', hand: 'right' } } })); await gsleep(150);
      on6 = await gev(() => globalThis.EW.physics.fx().includes('nozzle')).catch(() => false); }
    let off6 = null; for (let i = 0; i < 60 && !off6; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: BP6, yaw: 0, speed: 0, clip: 'idle' } })); await gsleep(150);
      off6 = await gev(() => !globalThis.EW.physics.fx().includes('nozzle')).catch(() => false); }
    const logged6 = readLog(readFileSync(join(worlds, 'garden', 'v4.jsonl'))).length - n6;
    check('grab: …and Bob pressing use on the nozzle he holds draws its fx on Ann\'s page, from his presence alone (nothing logged), until he lets go', b6?.ok && on6 && off6 && logged6 === 0, { b6: b6?.ok ?? b6?.refused, on6, off6, logged6 });
    await gdoor('put', { id: 'nozzle' });
  }

  // ===================================================================== VR hands (v4phys xrHand, driven by xr.js)
  // The real visor is clicked; IWER's controllers are moved and squeezed. A controller's pose is in the XR reference
  // space, which the rig carries into the world: a target world point is put through the rig's inverse, then the hand's
  // grip is read back in the world and the error corrected (twice), so the probe never assumes the mapping. Headless XR
  // ticks slowly (SwiftShader, both eyes): every step waits on session frames, never on the clock.
  if (XR) {
    let xid = 800; const xdoor = async (tool, args) => { const id = ++xid; ws.send(JSON.stringify({ type: 'v4', id, tool, args }));
      for (let i = 0; i < 80; i++) { const m = inbox.find((x) => x.type === 'v4-result' && x.id === id); if (m) return m.reply ?? m; await new Promise((r) => setTimeout(r, 100)); }
      return { ok: false, refused: { reason: 'no answer' } }; };
    const xsleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const xev = (fn, arg) => race(pg.evaluate(fn, arg), 30000);
    const frames = async (n) => { const f0 = await xev(() => window.__probe.sessionFrames); const t = Date.now(); while (Date.now() - t < 120000) { const f = await xev(() => window.__probe.sessionFrames).catch(() => f0); if (f - f0 >= n) return f - f0; await xsleep(250); } return null; };
    const xwait = async (fn, arg, ms = 90000) => { const t = Date.now(); let v = null; while (Date.now() - t < ms) { v = await xev(fn, arg).catch(() => null); if (v) return v; await xsleep(300); } return v; };
    const LOGX = () => readLog(readFileSync(join(worlds, 'garden', 'v4.jsonl')));
    await pg.waitForFunction(() => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none'; }, null, { timeout: 90000 }).catch(() => {});
    const gate = await xev(() => ({ xrbtn: !!document.querySelector('#xrbtn'), probe: !!window.__probe && !window.__probe.fatal, fatal: window.__probe?.fatal ?? null }));
    if (!check('xr: the visor shows under IWER (a synthetic headset, installed before boot)', gate.xrbtn && gate.probe, gate)) throw new Error('xr gate failed');
    await xev(() => document.querySelector('#xrbtn').click());
    await pg.waitForFunction(() => { if (window.__probe.grants > 0) return true; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Not now' && x.offsetParent); if (b) b.click(); return false; }, null, { timeout: 60000, polling: 500 }).catch(() => {});
    const ticked = await frames(6);
    const pres = await xev(async () => ({ presenting: (await import('./lib/xr.js')).isPresenting(), frames: window.__probe.sessionFrames }));
    if (!check('xr: the session is granted and ticks (session frames counted, not assumed)', pres.presenting && ticked >= 6, { ...pres, ticked })) throw new Error('xr session gate failed');
    // put a controller's grip at a world point (and aim its ray at another), squeeze/trigger as given
    const hand = (side, at, { squeeze = 0, trigger = 0, aim = null } = {}) => xev(async ({ side, at, squeeze, trigger, aim }) => {
      const T = globalThis.EW.THREE; const X = await import('./lib/xr.js'); const rig = X.xrRig(); const c = window.__iwerDevice.controllers[side];
      window.__ctl ??= {}; const corr = window.__ctl[side] ??= [0, 0, 0];
      rig.updateWorldMatrix(true, false); const inv = rig.matrixWorld.clone().invert();
      const p = new T.Vector3(at[0] + corr[0], at[1] + corr[1], at[2] + corr[2]).applyMatrix4(inv); c.position.set(p.x, p.y, p.z);
      if (aim) { const from = new T.Vector3(...at), to = new T.Vector3(...aim); const d = to.sub(from).normalize(); const rq = rig.getWorldQuaternion(new T.Quaternion()).invert(); d.applyQuaternion(rq);
        const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, -1), d); c.quaternion.set(q.x, q.y, q.z, q.w); }
      c.updateButtonValue('squeeze', squeeze); c.updateButtonValue('trigger', trigger); return true; }, { side, at, squeeze, trigger, aim });
    // read where the hand's grip IS in the world, and correct the next placements by the error (the mapping is measured)
    const settle = async (side, at, opts) => { for (let k = 0; k < 3; k++) { await hand(side, at, opts); await frames(2);
      const err = await xev(async ({ side, at }) => { const X = await import('./lib/xr.js'); const g = X.xrHands()[side]?.grip; if (!g) return null; const w = g.getWorldPosition(new globalThis.EW.THREE.Vector3());
        const e = [at[0] - w.x, at[1] - w.y, at[2] - w.z]; const c = (window.__ctl[side] ??= [0, 0, 0]); c[0] += e[0]; c[1] += e[1]; c[2] += e[2]; return Math.hypot(...e); }, { side, at });
      if (err != null && err < 0.01) return err; } return null; };
    const centre = (id) => xev((id) => { const o = globalThis.EW.entities.get(id); if (!o) return null; return new globalThis.EW.THREE.Box3().setFromObject(o).getCenter(new globalThis.EW.THREE.Vector3()).toArray(); }, id);
    const mePos = await xev(() => globalThis.EW.me().root.position.toArray());
    await xsleep(1200);   // xr.js trusts the buttons ~0.7 s after the controllers wake
    // (X1, X2) a cup in front of her: the right grip takes it near, held where it was grabbed; a flick lets it fly ×2
    await xdoor('create', { id: 'cup', model: MODEL, components: { transform: { pos: [mePos[0], 0.9, mePos[2] + 0.45], scale: [0.04, 0.04, 0.04] }, physics: { kind: 'dynamic' }, grabbable: { who: 'visitor', throw: 2 } } });
    await xwait((i) => !!globalThis.EW.entities.get(i), 'cup');
    const c0 = await centre('cup');
    const e1 = await settle('right', c0, { squeeze: 0 });
    await hand('right', c0, { squeeze: 1 }); await frames(2);
    const held1 = await xwait(() => { const h = globalThis.EW.physics.holds().cup; return h ? h : null; });
    check('xr: the right grip near a cup takes it: the door\'s record says right hand, held where it was grabbed (an offset)', held1?.hand === 'right' && Array.isArray(held1?.offset?.pos), { e1, held1, c0 });
    const stay = await centre('cup'); await frames(3); const drift = await centre('cup');
    check('xr: …and it stays where the hand took it (drawn at the offset: no jump into the palm)', stay && drift && Math.hypot(drift[0] - c0[0], drift[1] - c0[1], drift[2] - c0[2]) < 0.05, { c0, drift });
    const n2 = LOGX().length;
    await hand('right', [c0[0], c0[1] + 0.1, c0[2] + 0.5], { squeeze: 1 }); await frames(1);
    await hand('right', [c0[0], c0[1] + 0.2, c0[2] + 1.0], { squeeze: 0 }); await frames(2);
    const thrown = await xwait(() => !globalThis.EW.physics.holds().cup);
    const L2 = LOGX().slice(n2); const tact = L2.find((e) => e.kind === 'act' && (e.verb === 'throw' || e.verb === 'drop') && e.body?.request?.id === 'cup'); const tl = L2.find((e) => e.kind === 'sim' && e.verb === 'launch' && e.body?.id === 'cup');
    const sent = tact?.body?.request?.v ?? null; const flew = tl?.body?.v ?? null;
    check('xr: letting the grip go mid-flick throws it with the hand\'s velocity (forward, up), and the door scales it by its grabbable.throw (×2)', thrown && tact?.verb === 'throw' && sent && sent[2] > 0.05 && flew && flew.every((x, i) => Math.abs(x - 2 * sent[i]) < 1e-6), { verb: tact?.verb, sent, flew });
    // (X3) the trigger while holding is use: the left hand takes a lamp, the trigger lights it, letting go of the trigger darkens it
    const me3 = await xev(() => globalThis.EW.me().root.position.toArray());
    await xdoor('create', { id: 'lamp', model: MODEL, components: { transform: { pos: [me3[0] - 0.35, 0.9, me3[2] + 0.4], scale: [0.04, 0.04, 0.04] }, grabbable: { who: 'visitor', use: { down: 'on', up: 'off' } },
      reactions: { on: { kind: 'set', component: 'shining', value: true }, off: { kind: 'set', component: 'shining', value: false } } } });
    await xwait((i) => !!globalThis.EW.entities.get(i), 'lamp');
    const l0 = await centre('lamp'); await settle('left', l0);
    await hand('left', l0, { squeeze: 1 }); const lh = await xwait(() => globalThis.EW.physics.holds().lamp?.hand === 'left');
    await hand('left', l0, { squeeze: 1, trigger: 1 }); const on = await xwait(() => globalThis.EW.comps.get('lamp')?.shining === true);
    await hand('left', l0, { squeeze: 1, trigger: 0 }); const off = await xwait(() => globalThis.EW.comps.get('lamp')?.shining === false);
    const uses = LOGX().filter((e) => e.kind === 'act' && e.verb === 'use' && e.body?.request?.id === 'lamp').map((e) => `${e.body.held?.hand}:${e.body.held?.phase}:${e.body.action}`);
    check('xr: the trigger while the left hand holds a lamp is use: down lights it, up darkens it (one act each, held in the left hand)', lh && on && off && JSON.stringify(uses) === '["left:down:on","left:up:off"]', { lh, on, off, uses });
    await hand('left', l0, { squeeze: 0 }); await xwait(() => !globalThis.EW.physics.holds().lamp);
    // (X4) the laser: a thing 2.5 m off with range 4; the right hand aims at it and grips: it flies to the hand
    const me4 = await xev(() => globalThis.EW.me().root.position.toArray());
    await xdoor('create', { id: 'far', model: MODEL, components: { transform: { pos: [me4[0] + 0.3, 0, me4[2] + 2.6], scale: [0.06, 0.06, 0.06] }, grabbable: { who: 'visitor', range: 4 } } });
    await xwait((i) => !!globalThis.EW.entities.get(i), 'far');
    const f0 = await centre('far'); const H4 = [me4[0] + 0.25, 1.1, me4[2] + 0.3];
    await settle('right', H4, { aim: f0 }); await hand('right', H4, { aim: f0, squeeze: 1 });
    const fh = await xwait(() => globalThis.EW.physics.holds().far ?? null); await frames(3);
    const fc = await centre('far'); const gw = await xev(async () => { const X = await import('./lib/xr.js'); return X.xrHands().right.grip.getWorldPosition(new globalThis.EW.THREE.Vector3()).toArray(); });
    check('xr: the laser reaches a thing 2.6 m off (its range is 4): it is taken, and flies to the hand', fh?.hand === 'right' && !fh?.offset && fc && Math.hypot(fc[0] - gw[0], fc[1] - gw[1], fc[2] - gw[2]) < 0.3, { fh, fc, grip: gw, f0 });
    await hand('right', H4, { squeeze: 0 }); await xwait(() => !globalThis.EW.physics.holds().far);
    // (X5) two hands: the right grips the rifle's stock, the left its fore grip: in both; the left lets go, the right keeps it
    const me5 = await xev(() => globalThis.EW.me().root.position.toArray());
    await xdoor('create', { id: 'rifle', model: MODEL, components: { transform: { pos: [me5[0], 0.95, me5[2] + 0.45], scale: [0.03, 0.03, 0.4] },
      grabbable: { who: 'visitor', twoHanded: true, grips: { stock: { pos: [0, 1, -0.6], hand: 'right' }, fore: { pos: [0, 1, 0.6], role: 'secondary' } } } } });
    await xwait((i) => !!globalThis.EW.entities.get(i), 'rifle');
    const G5 = await xev(() => { const o = globalThis.EW.entities.get('rifle'); const G = globalThis.EW.physics.grabbable('rifle').grips; o.updateWorldMatrix(true, false);
      return { s: new globalThis.EW.THREE.Vector3(...G.stock.pos).applyMatrix4(o.matrixWorld).toArray(), f: new globalThis.EW.THREE.Vector3(...G.fore.pos).applyMatrix4(o.matrixWorld).toArray() }; });
    await settle('right', G5.s); await hand('right', G5.s, { squeeze: 1 }); await xwait(() => globalThis.EW.physics.holds().rifle?.hand === 'right');
    await settle('left', G5.f, { squeeze: 0 }); await hand('left', G5.f, { squeeze: 1 });
    const both = await xwait(() => { const h = globalThis.EW.physics.holds().rifle; return h?.second?.hand === 'left' ? h : null; });
    const n5 = LOGX().length; await hand('left', G5.f, { squeeze: 0 });
    const one = await xwait(() => { const h = globalThis.EW.physics.holds().rifle; return h && !h.second ? h : null; });
    const logged5 = LOGX().slice(n5).filter((e) => e.kind !== 'sim' || e.verb !== 'digest').length;
    check('xr: a second hand on a two-handed rifle takes it in both (its fore grip); letting that hand go leaves it in the right (presence: nothing logged)', both?.grip === 'stock' && both?.second?.grip === 'fore' && one?.hand === 'right' && logged5 === 0, { both, one, logged5 });
    if (process.env.PROBE_SHOTS) { await frames(2); await pg.screenshot({ path: `${process.env.PROBE_SHOTS}/xr-two-hands.png` }); }
    await hand('right', G5.s, { squeeze: 0 }); await xwait(() => !globalThis.EW.physics.holds().rifle);
    await xev(() => window.__iwerDevice.activeSession?.end()).catch(() => {});
  }
  const SKIP_REST = ONLY.length > 0 && !ONLY.includes('phys');
  if (SKIP_REST) stage('rest of the probe skipped (PROBE_ONLY)', true, ONLY);
  if (!SKIP_REST) {
  // (the old 'edit'/'refuse' stages sent v1 verbs from the page; v4 refuses those by design. The page's door-request
  //  path is covered headlessly by editcommit/hierarchy-commit.)
  // spot: a spot light set through the door (glTF/Godot shape: half-angle cone, shining along -Z) lights a SPOT slot in
  // Ann's client with that cone, pointing where the thing's -Z points (here: pitched to face straight down)
  const down = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];   // -90° about X: local -Z → world -Y
  ws.send(JSON.stringify({ type: 'v4', id: 3, tool: 'batch', args: { ops: [
    { tool: 'set', args: { id: 'crate-before', component: 'transform', value: { pos: [0, 2, 3], q: down, scale: [1, 1, 1] } } },
    { tool: 'set', args: { id: 'crate-before', component: 'light', value: { kind: 'spot', angle: 0.4, inner: 0.1, intensity: 30, range: 9, keep: true } } }] } }));
  let spot = null; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250));
    spot = await race(pg.evaluate(() => globalThis.EW.lightrig().spots.find((x) => x.intensity > 0) ?? null)).catch(() => null); if (spot) break; }
  if (!spot) stage('spot: debug', false, await race(pg.evaluate(() => { const d = globalThis.EW.lightrig(); const e = globalThis.EW.state?.st?.entities?.['crate-before'];
    return { spots: d.spots, reqs: (d.requests ?? []).filter((r) => /crate/.test(r.key)), comp: e?.comp, kind: e?.kind }; })).catch((x) => String(x)));
  check('spot: a spot light set through the door lights a spot slot with its cone (angle 0.4, penumbra (0.4-0.1)/0.4)',
    !!spot && Math.abs(spot.angle - 0.4) < 1e-3 && Math.abs(spot.penumbra - 0.75) < 1e-3, { spot, reply: inbox.find((m) => m.type === 'v4-result' && m.id === 3)?.reply });
  check('spot: …shining down the thing\'s -Z (here straight down)', !!spot && spot.dir[1] < -0.99, spot);
  // rocket: a socket's WHOLE rotation (not just yaw). Bob builds a seat lying on its back beside Ann; Ann sits (the
  // page's own sit: nearest body socket in reach) and her body lies down with it; standing makes her upright again
  const at = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray()));
  ws.send(JSON.stringify({ type: 'v4', id: 4, tool: 'create', args: { id: 'rocket', model: MODEL, components: { transform: { pos: [at[0] + 1, 0, at[2]] },
    sockets: { seat: { pos: [0, 0.6, 0], q: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2], body: { action: 'ride', pose: 'sit' } } } } } }));
  let upY = null; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250));
    if (!(await ents()).includes('rocket')) continue;
    upY = await race(pg.evaluate(() => { globalThis.EW.bus.emit('xr:sit'); const r = globalThis.EW.me().root; r.updateMatrixWorld(); const e = r.matrixWorld.elements; return +e[5].toFixed(3); })).catch(() => null);
    await new Promise((r) => setTimeout(r, 400));
    upY = await race(pg.evaluate(() => { const e = globalThis.EW.me().root.matrixWorld.elements; return +e[5].toFixed(3); })).catch(() => null);
    if (upY != null && upY < 0.2) break; }
  check('rocket: sitting on a socket lying on its back lays the body down with it (body up ≈ horizontal)', upY != null && Math.abs(upY) < 0.05, { upY, reply: inbox.find((m) => m.type === 'v4-result' && m.id === 4)?.reply?.ok });
  if (process.env.PROBE_SHOTS) await pg.screenshot({ path: `${process.env.PROBE_SHOTS}/rocket-seated.png` });
  const stood = await race(pg.evaluate(async () => { globalThis.EW.bus.emit('xr:stand'); await new Promise((r) => setTimeout(r, 400)); const r = globalThis.EW.me().root; r.updateMatrixWorld(); return +r.matrixWorld.elements[5].toFixed(3); })).catch(() => null);
  check('rocket: …and standing up makes the body upright again', stood != null && stood > 0.999, stood);
  stage('physics: frame cost of v4phys so far (reported)', true, await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null));
  // ---- physics (design 20 on the client) ----
  { let n = 1000; const bobReq = (tool, args) => new Promise((res) => { const id = ++n; const t = setTimeout(() => res({ ok: false, refused: { code: 'timeout' } }), 8000);
      const h = (ev) => { const m = JSON.parse(String(ev.data)); if (m.type === 'v4-result' && m.id === id) { clearTimeout(t); ws.removeEventListener('message', h); res(m.reply); } };
      ws.addEventListener('message', h); ws.send(JSON.stringify({ type: 'v4', id, tool, args })); });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const LOGF = join(worlds, 'garden', 'v4.jsonl'); const rests = () => restsOf(readLog(readFileSync(LOGF)));
    const shots = process.env.PROBE_SHOTS;
    // record a thing's drawn world position (and the displayed engine body) every frame, for ms
    // A flight is sampled at exact display times: the page's own per-frame applier (v4phys frame) is run at the launch's
    // ts + k·33 ms and the drawn position read back after each. (A headless page on a loaded host draws under a frame a
    // second and its timers starve; sampling by the clock the applier is given is simworld's bench rule.) The launch's
    // ts is the door's, read from the log; the page samples once its own fold has the launch.
    const LAUNCH = (id) => { const L = readLog(readFileSync(LOGF)); for (let i = L.length - 1; i >= 0; i--) if (L[i]?.kind === 'sim' && L[i].verb === 'launch' && L[i].body?.id === id) return L[i].ts; return null; };
    let recOut = null;
    const record = (id) => { recOut = null; return true; };
    const sample = async (id) => { const ts = LAUNCH(id);
      recOut = await race(pg.evaluate(async ({ id, ts }) => { const EW = globalThis.EW; const t0 = performance.now();
        while (EW.physics.launched()[id] === undefined && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        const out = []; const V = EW.THREE.Vector3;
        for (let k = 0; k <= 150; k++) { EW.physics.frame(ts + k * 33); const o = EW.entities.get(id); if (!o) continue; const v = o.getWorldPosition(new V()); const b = EW.simShown()?.bodies?.[id];
          out.push([k * 33, +v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4), b ? b.resting : null, b ? JSON.stringify(b.p) : null]); }
        return out; }, { id, ts }), 45000).catch((e) => [[0, 0, 0, 0, null, String(e)]]); return recOut; };
    const recd = async () => recOut ?? [];
    // distinct: drawn positions that differ frame to frame; apex: how far above where it came to rest it flew
    const flew = (rec) => { const ys = rec.map((r) => r[2]); const distinct = new Set(rec.map((r) => `${r[1]},${r[2]},${r[3]}`)).size; return { frames: rec.length, distinct, rise: +(Math.max(...ys) - ys[ys.length - 1]).toFixed(3) }; };
    // realized: the model is loaded and drawn (the map holds a null while a new GLB loads and compiles; slow headless)
    const realized = async (id, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await race(pg.evaluate((id) => !!globalThis.EW.entities.get(id), id)).catch(() => false)) return true; await sleep(300); } return false; };
    const worldPos = (id) => race(pg.evaluate((id) => { const o = globalThis.EW.entities.get(id); return o ? o.getWorldPosition(new globalThis.EW.THREE.Vector3()).toArray() : null; }, id));
    const restCheck = (name, rec, id) => { const r = rests().filter((x) => x.id === id).at(-1); const shown = [...rec].reverse().find((x) => x[4] === true)?.[5] ?? null;
      check(`${name}: …and it rests on her screen bit for bit where the door logs the rest`, !!r && shown === JSON.stringify(r.at), { shown, logged: r?.at }); return r; };
    const ann = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    // pull the camera back (the wheel zooms out to 16 m) so a screenshot shows the play, not a close-up of Ann
    if (shots) await race(pg.evaluate(() => { globalThis.EW.renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true, cancelable: true })); return true; })).catch(() => null);
    const fps = await race(pg.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); }; requestAnimationFrame(f); })), 15000).catch(() => null);
    stage('physics: the page\'s frame rate here (reported)', true, { fps, body: await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null) });
    // throw: Bob, beside Ann, throws a crate through the door
    const P = [ann[0] + 2.5, 0, ann[2]];
    const arrive = await bobReq('move', { to: P }); ws.send(JSON.stringify({ type: 'pose', pose: { p: P, yaw: 0 } }));
    const mk = await bobReq('create', { id: 'toy', model: MODEL, components: { physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [P[0], P[2] + 0.6] } });
    let seenToy = false; for (let i = 0; i < 40 && !seenToy; i++) { seenToy = (await ents()).includes('toy'); if (!seenToy) await sleep(250); }
    const g = await bobReq('grab', { id: 'toy' });
    await sleep(600);
    await record('toy', 7000);
    const th = await bobReq('throw', { id: 'toy', v: [0, 7, 2.5] });   // ~1.5 s in the air
    await sample('toy');   // at once: any later request (Ann's own body track included) lets the door log the rest
    const rec = await recd(); const fw = flew(rec);
    if (!th?.ok) stage('throw: Bob\'s replies', false, { arrive, mk: mk?.ok ?? mk?.refused, g: g?.ok ?? g?.refused, th: th?.refused });
    check('throw: a crate Bob throws through the door flies on Ann\'s screen (its position changes frame to frame, it rises)', th?.ok && fw.distinct >= 8 && fw.rise > 0.8, fw);
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    const r1 = restCheck('throw', rec, 'toy');
    const drawn = await worldPos('toy');
    check('throw: …and once the rest is logged it stands exactly there (the fold\'s word)', r1 && drawn && drawn.every((v, i) => Math.abs(v - r1.at[i]) < 1e-6), { drawn, logged: r1?.at });
    if (shots) await pg.screenshot({ path: `${shots}/phys-throw-rest.png` });
    // carry: Ann picks a crate up with her own page (the door tracks her body), walks, and it follows her hand
    const ann2 = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    const mk2 = await bobReq('create', { id: 'toy2', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [ann2[0] + 0.7, ann2[2]] } });
    const seen2 = await realized('toy2');
    const from2 = await worldPos('toy2');
    const ag = await race(pg.evaluate(() => globalThis.EW.physics.grab('toy2')), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    await sleep(800);
    const hand = () => race(pg.evaluate(() => { const av = globalThis.EW.me(); const b = av?.vrm?.humanoid?.getRawBoneNode('rightHand'); const V = globalThis.EW.THREE.Vector3;
      return (b ? b.getWorldPosition(new V()) : av.root.getWorldPosition(new V())).toArray(); }));
    const centre = (id) => race(pg.evaluate((id) => { const o = globalThis.EW.entities.get(id); if (!o) return null; const bb = new globalThis.EW.THREE.Box3().setFromObject(o); return bb.getCenter(new globalThis.EW.THREE.Vector3()).toArray(); }, id));
    const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (!mk2?.ok || !seen2) stage('carry: Bob\'s create of the ball', false, { mk2: mk2?.refused ?? mk2?.ok, seen2 });
    const h0 = await hand(), c0 = await centre('toy2');
    check('carry: Ann\'s own grab goes through the door (her body arrives, then grab)', ag?.ok, mk2?.ok ? { ag, body: await race(pg.evaluate(() => globalThis.EW.physics.body())).catch(() => null), ann: await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray())).catch(() => null) } : mk2);
    check('carry: …and the box is drawn in her hand', ag?.ok && c0 && from2 && d3(h0, c0) < 0.25 && d3(c0, from2) > 0.3, { hand: h0, centre: c0, logged: from2 });
    if (shots) await pg.screenshot({ path: `${shots}/phys-held.png` });
    // walk 2 m along +x the way the controller does (its own state moves the body)
    for (let i = 0; i < 4; i++) { await race(pg.evaluate(() => { globalThis.EW.myState.pos.x += 0.5; return true; }), 10000); await sleep(500); }
    await sleep(900);
    const h1 = await hand(), c1 = await centre('toy2');
    const insp = await bobReq('inspect', { id: 'toy2' });
    check('carry: …it follows her hand as she walks (2 m)', c1 && c0 && d3(h1, c1) < 0.25 && c1[0] - c0[0] > 1.6, { hand: h1, centre: c1, moved: +(c1[0] - c0[0]).toFixed(3) });
    check('carry: …and the door\'s own track carried it with her (inspect: heldAt moved too)', insp?.heldAt && insp.heldAt[0] - ann2[0] > 1.6, { heldBy: insp?.heldBy, heldAt: insp?.heldAt });
    await record('toy2', 7000);
    const at2 = await race(pg.evaluate(() => globalThis.EW.physics.throw()), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    if (at2?.ok) await sample('toy2');
    const rec2 = await recd(); const fw2 = flew(rec2);
    check('carry: her throw flies on her screen', at2?.ok && fw2.distinct >= 8 && fw2.rise > 0.2, { reply: at2?.ok ?? at2?.refused, ...fw2 });
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    restCheck('carry', rec2, 'toy2');
    // punt: Ann kicks a ball at her feet (the C key's act, /punt): it flies on her screen and rests where the door says
    const ann3 = await race(pg.evaluate(() => globalThis.EW.me().root.position.toArray().map((v) => +v.toFixed(3))));
    const mk4 = await bobReq('create', { id: 'toy4', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [ann3[0] + 0.6, ann3[2]] } });
    const seen4 = await realized('toy4');
    await record('toy4', 7000);
    const ap = await race(pg.evaluate(() => globalThis.EW.physics.punt('toy4 7')), 15000).catch((e) => ({ ok: false, refused: { reason: String(e) } }));
    if (ap?.ok) await sample('toy4');
    const rec4 = await recd(); const fw4 = flew(rec4);
    check('punt: Ann punts the box at her feet through the door, and it flies on her screen', ap?.ok && fw4.distinct >= 8 && fw4.rise > 0.2, { reply: ap?.ok ?? ap?.refused, mk4: mk4?.ok ?? mk4?.refused, seen4, ...fw4 });
    await sleep(4000); await bobReq('wait', {}); await sleep(800);   // (sampling ran ahead of the clock: let the door's flight end)
    restCheck('punt', rec4, 'toy4');
    // remote: Bob holds a crate; Ann sees it in Bob's hand, following him
    const mk3 = await bobReq('create', { id: 'toy3', model: MODEL, components: { transform: { scale: SMALL }, physics: { kind: 'dynamic', who: 'visitor' } }, place: { at: [P[0] + 0.6, P[2]] } });
    const seen3 = await realized('toy3');
    const g3 = await bobReq('grab', { id: 'toy3' });
    for (let i = 0; i < 30; i++) { await sleep(500); if (await race(pg.evaluate(() => !!globalThis.EW.physics.holds().toy3)).catch(() => false)) break; } await sleep(800);
    const bobRoot = () => race(pg.evaluate(() => { const av = globalThis.EW.remotes.get('Bob')?.avatar; const b = av?.vrm?.humanoid?.getRawBoneNode('rightHand') ?? av?.root;
      return b ? b.getWorldPosition(new globalThis.EW.THREE.Vector3()).toArray() : null; }));
    if (!mk3?.ok || !seen3) stage('remote: Bob\'s create of the ball', false, { mk3: mk3?.refused ?? mk3?.ok, seen3 });
    const b0 = await bobRoot(), t0 = await centre('toy3');
    const Q = [P[0], 0, P[2] + 2];
    await bobReq('move', { to: Q }); for (let i = 0; i < 12; i++) { ws.send(JSON.stringify({ type: 'pose', pose: { p: [P[0], 0, P[2] + (i + 1) / 6], yaw: 0 } })); await sleep(80); }
    for (let i = 0; i < 30; i++) { await sleep(500); const b = await bobRoot(); if (b && b[2] - P[2] > 1.8) break; }   // his poses landing on a slow page
    await sleep(800);
    const b1 = await bobRoot(), t1 = await centre('toy3');
    check('remote: a box Bob holds is drawn in Bob\'s hand, on Ann\'s screen', g3?.ok && b0 && t0 && Math.hypot(t0[0] - b0[0], t0[1] - b0[1], t0[2] - b0[2]) < 0.25, { g3: g3?.ok ?? g3?.refused ?? mk3?.refused, bob: b0, crate: t0 });
    check('remote: …and follows his hand when he moves (2 m)', b1 && t1 && t0 && Math.hypot(t1[0] - b1[0], t1[1] - b1[1], t1[2] - b1[2]) < 0.25 && t1[2] - t0[2] > 1.6, { bob: b1, crate: t1 });
    if (shots) await pg.screenshot({ path: `${shots}/phys-remote-held.png` });
    // a picture of a flight (no check rides on it): Bob throws the box he holds, and the page is drawn 0.5 s into it
    if (shots) { await bobReq('throw', { id: 'toy3', v: [2, 6, 0] });
      await race(pg.evaluate(async (ts) => { const t0 = performance.now(); while (globalThis.EW.physics.launched().toy3 === undefined && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
        globalThis.EW.physics.frame(ts + 500); }, LAUNCH('toy3')), 40000).catch(() => null);
      await pg.screenshot({ path: `${shots}/phys-throw-midair.png` }); }
  }

  // ===================================================================== the body at a socket (shared/sockbody.js)
  // Each stage: Bob builds a small thing through the door (a crate at a fifth of its size, so the body isn't hidden
  // inside it), Ann sits on it with her own /sit, and what her body does is read off the live skeleton and mixer.
  const SHOTS = process.env.PROBE_SHOTS;
  let rid = 10;
  const door = async (tool, args) => { const id = ++rid; ws.send(JSON.stringify({ type: 'v4', id, tool, args }));
    for (let i = 0; i < 60; i++) { const m = inbox.find((x) => x.type === 'v4-result' && x.id === id); if (m) return m.reply ?? m; await new Promise((r) => setTimeout(r, 100)); }
    return { ok: false, refused: { reason: 'no answer' } }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ev = (fn, arg) => race(pg.evaluate(fn, arg), 20000);
  const waitFor = async (fn, arg, ms = 12000) => { const t = Date.now(); let v = null; while (Date.now() - t < ms) { v = await ev(fn, arg).catch(() => null); if (v) return v; await sleep(200); } return v; };
  const seated = () => ev(() => { const m = globalThis.EW.avatarMounts.get(globalThis.EW.net.myId ?? 'Ann') ?? [...globalThis.EW.avatarMounts.entries()].find(([k]) => k === 'Ann')?.[1]; return m ? `${m.to}/${m.slot}` : null; });
  const sit = async (arg, want) => { await ev((a) => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: a }), arg); return waitFor(async (w) => { const m = [...globalThis.EW.avatarMounts.entries()].find(([k]) => k === 'Ann')?.[1]; return m && `${m.to}/${m.slot}` === w; }, want, 30000); };
  const stand = async () => { await ev(() => globalThis.EW.bus.emit('xr:stand')); await sleep(500); };
  const here = await ev(() => globalThis.EW.me().root.position.toArray());
  const thing = (id, dx, dz, comps, y = 0) => door('create', { id, model: MODEL, components: { transform: { pos: [here[0] + dx, y, here[2] + dz], scale: [0.2, 0.2, 0.2] }, ...comps } });
  const realized = (id) => waitFor((i) => !!globalThis.EW.entities.get(i), id);
  // the screenshots: the follow camera pulls in against the little crates and ends up in the hair, so a shot re-renders
  // the scene from a camera of the probe's own, after the app's frame (a rAF callback behind the app's), then restores
  // nothing — the app sets its camera again on its next frame. Pictures only; nothing is asserted from them.
  const shoot = async (name, offset = [1.3, 0.5, 1.1]) => { if (!SHOTS) return;
    await ev((o) => { const EW = globalThis.EW; const me = EW.me(); const h = me.vrm.humanoid.getRawBoneNode('hips').getWorldPosition(new EW.THREE.Vector3());
      EW.__shot = { at: h.toArray(), from: [h.x + o[0], h.y + o[1], h.z + o[2]] };
      if (!EW.__shotLoop) { EW.__shotLoop = true; const f = () => { const s = EW.__shot; if (s) { const c = EW.camera; c.up.set(0, 1, 0); c.position.set(...s.from); c.lookAt(...s.at); c.updateMatrixWorld();
        try { EW.renderer.render(EW.scene, c); } catch {} } requestAnimationFrame(f); }; requestAnimationFrame(f); } }, offset);
    await sleep(2500);
    await pg.screenshot({ path: `${SHOTS}/${name}.png` });
    await ev(() => { globalThis.EW.__shot = null; }); };

  // (a) reach: a hand target on a moving PART moves the hand with the part. The probe's swing model: its plank (node
  //     'plank') swings on a part pendulum (motion:plank); the seat stands still behind it and the left hand's target is
  //     the plank's near-left corner, riding the plank. Expected target: that corner carried by the plank's own live
  //     transform (three's localToWorld), independent of the client's reach code. Sampled per rendered FRAME (the seat's
  //     clock), over more than a whole swing, so a slow headless frame rate can't shrink what it sees.
  {
    const AT = [0.25, 0.525, -0.175];
    const r = await door('create', { id: 'lever', model: SWING, components: { transform: { pos: [here[0] + 1.8, 0.4, here[2]] },
      'motion:plank': { type: 'pendulum', axis: [0, 0, 1], amp: 0.45, period: 2.4, pivot: [0, 0.3, 0] },
      sockets: { seat: { pos: [0, 0.2, -0.6], body: { reach: { leftHand: { at: AT, part: 'plank' } } } } } } });
    if (!r.ok) stage('reach: setup', false, r.refused);
    await realized('lever');
    const sat = await sit('lever', 'lever/seat');
    await waitFor(() => (globalThis.EW.me().reachStatus().leftHand?.weight ?? 0) > 0.98, null, 30000);
    const samples = []; let last = null; const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const x = await ev((at) => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); let part = null;
        EW.entities.get('lever').traverse((o) => { if (!part && o.name === 'plank') part = o; });
        const b = part?.userData.mbase; if (!part || !b) return { why: 'no part / not animated', part: !!part };
        const exp = part.localToWorld(new T.Vector3(at[0] - b.pos[0], at[1] - b.pos[1], at[2] - b.pos[2]));
        const hand = me.vrm.humanoid.getRawBoneNode('leftHand').getWorldPosition(new T.Vector3());
        return { now: me._seatState?.now, exp: exp.toArray(), hand: hand.toArray(), restQ: b.quat }; }, AT).catch((e) => ({ why: String(e) }));
      if (x.exp && x.now !== last) { samples.push(x); last = x.now; }
      if (samples.length >= 10 && samples[samples.length - 1].now - samples[0].now > 2600) break;
      await sleep(120);
    }
    const err = samples.map((x) => Math.hypot(x.hand[0] - x.exp[0], x.hand[1] - x.exp[1], x.hand[2] - x.exp[2]));
    const xs = samples.map((x) => x.exp[0]);
    check('reach: seated behind the swing, a hand target on its swinging plank', !!sat && samples.length >= 6, { sat, n: samples.length });
    check('reach: …the part really moves (the target travels > 15 cm over a swing)', Math.max(...xs) - Math.min(...xs) > 0.15, { range: Math.max(...xs) - Math.min(...xs), n: samples.length });
    check('reach: …and the hand stays on it through the swing (every frame within 6 cm)', err.length > 0 && Math.max(...err) < 0.06, { err: err.map((e) => +e.toFixed(3)) });
    await shoot('reach-on-part', [1.1, 0.5, 0.2]);
    await stand();
  }

  // (b) a blended pose follows its signal: pose {by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']]}; Bob writes the
  //     thing's params component through the door, and the mixer's own weights follow
  {
    const r = await thing('stool', -1.8, 0, { params: { lean: 0 }, sockets: { seat: { pos: [0, 2.6, 0], body: { anchor: 'hips', pose: { by: 'param.lean', clips: [[0, 'sitchair'], [1, 'sit']] } } } } });
    if (!r.ok) stage('blend: setup', false, r.refused);
    await realized('stool');
    const sat = await sit('stool', 'stool/seat');
    const weights = () => ev(() => { const a = globalThis.EW.me().actions; return { sitchair: +(a.sitchair?.getEffectiveWeight() ?? -1).toFixed(3), sit: +(a.sit?.getEffectiveWeight() ?? -1).toFixed(3) }; });
    const settle = async (want) => { let w = null; for (let i = 0; i < 30; i++) { await sleep(150); w = await weights(); if (Math.abs(w.sit - want) < 0.03 && Math.abs(w.sitchair - (1 - want)) < 0.03) break; } return w; };
    const w0 = await settle(0);
    await door('set', { id: 'stool', component: 'params', value: { lean: 0.25 } });
    const w1 = await settle(0.25);
    await door('set', { id: 'stool', component: 'params', value: { lean: 1 } });
    const w2 = await settle(1);
    check('blend: lean 0 → all sitchair', !!sat && Math.abs(w0.sitchair - 1) < 0.03 && Math.abs(w0.sit) < 0.03, { sat, w0 });
    check('blend: lean 0.25 (written through the door) → three quarters sitchair, a quarter sit', Math.abs(w1.sitchair - 0.75) < 0.03 && Math.abs(w1.sit - 0.25) < 0.03, w1);
    check('blend: lean 1 → all sit', Math.abs(w2.sit - 1) < 0.03 && Math.abs(w2.sitchair) < 0.03, w2);
    // (e2) anchor hips: the hips joint lands on the socket, wherever the clip puts them
    const hips = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const s = EW.entities.get('stool'); s.updateWorldMatrix(true, false);
      return { hips: me.vrm.humanoid.getRawBoneNode('hips').getWorldPosition(new T.Vector3()).toArray(), sock: new T.Vector3(0, 2.6, 0).applyMatrix4(s.matrixWorld).toArray(), root: me.root.position.toArray() }; });
    check('anchor: hips puts the hips joint on the socket (within 2 cm), not the root', Math.hypot(...hips.hips.map((v, i) => v - hips.sock[i])) < 0.02 && Math.abs(hips.root[1] - hips.sock[1]) > 0.03, hips);
    await stand();
  }

  // (c) a phase-locked swing pose follows the pendulum: the swing's plank is a PART swinging on its own part motion
  //     (motion:plank, the door stamping its t0 so every client agrees on its phase); the seat rides the plank and its
  //     pose is {clip: 'walk', time: 'phase'}. The clip's time, as a fraction of its length, must equal the pendulum's
  //     phase at the clock the seat read — computed here from the motion component with the shared closed form
  {
    const r = await door('create', { id: 'swing', model: SWING, components: { transform: { pos: [here[0], 0, here[2] + 2.2] },
      'motion:plank': { type: 'pendulum', axis: [1, 0, 0], amp: 0.5, period: 3, pivot: [0, 1.5, 0] },
      sockets: { seat: { pos: [0, 0.6, 0], part: 'plank', body: { pose: { clip: 'walk', time: 'phase' } } } } } });
    if (!r.ok) stage('swing: setup', false, r.refused);
    await realized('swing');
    const sat = await sit('swing', 'swing/seat');
    await sleep(1200);
    const rows = [];
    for (let i = 0; i < 8; i++) {
      // the page's clip time and the clock the seat read this frame's pose at (under load a headless frame can be a
      // second away from this call); the expected phase from the motion component the page holds, through the shared
      // closed form here (the probe's own import, not the page's code)
      const x = await ev(() => { const EW = globalThis.EW; const m = EW.comps.get('swing')?.['motion:plank'];
        const a = EW.me().actions.walk; const r = EW.me().root; r.updateMatrixWorld();
        return { m, now: EW.me()._seatState?.now ?? null, clip: a ? a.time / a.getClip().duration : null, w: a?.getEffectiveWeight() ?? null, upZ: +r.matrixWorld.elements[6].toFixed(3) }; });
      rows.push({ t0: x.m?.t0, now: x.now, clip: x.clip, w: x.w, upZ: x.upZ, want: x.m ? cycleOf(x.m, x.now).phase : null });
      await sleep(260);
    }
    const d = rows.map((x) => { const e = Math.abs(x.clip - x.want); return Math.min(e, 1 - e); });
    const ups = rows.map((x) => x.upZ);
    check('swing: the plank\'s part motion carries the door\'s t0 (every client on one clock)', Number.isFinite(rows[0]?.t0), rows[0]);
    check('swing: seated on the swinging plank, the walk clip holds the body (weight ≈ 1)', !!sat && rows.every((x) => x.w > 0.97), { sat, rows: rows.slice(0, 2) });
    check('swing: …its time follows the pendulum\'s phase (within 0.03 of a cycle, every sample)', d.every((x) => x < 0.03) && new Set(rows.map((x) => x.want?.toFixed(2))).size > 4, { d: d.map((x) => +x.toFixed(3)), rows });
    check('swing: …and the sitter tilts with the plank (body up leans fore and aft)', Math.max(...ups) - Math.min(...ups) > 0.2, ups);
    await shoot('swing-phase', [-1.5, 0.5, 0.6]);
    await stand();
  }

  // (d) leaveBy: script — WASD and X don't get you off; the world does (Bob takes the socket away). The control: the
  //     same seat without leaveBy lets W take you off, so the block isn't a dead key.
  {
    const SEAT = { pos: [0, 2.6, 0], body: { leaveBy: 'script' } };
    const r = await thing('pod', 1.8, 2.2, { sockets: { seat: SEAT } });
    if (!r.ok) stage('leaveBy: setup', false, r.refused);
    await realized('pod');
    const sat = await sit('pod', 'pod/seat');
    await pg.bringToFront(); await ev(() => document.activeElement?.blur?.());
    await pg.keyboard.down('KeyW'); await sleep(700); await pg.keyboard.up('KeyW');
    const afterW = await seated();
    await pg.keyboard.press('KeyX'); await sleep(500);
    const afterX = await seated();
    check('leaveBy script: W held and X pressed, still seated', !!sat && afterW === 'pod/seat' && afterX === 'pod/seat', { sat, afterW, afterX });
    await door('set', { id: 'pod', component: 'sockets', value: {} });
    const freed = await waitFor(async () => ![...globalThis.EW.avatarMounts.keys()].includes('Ann') || null, null, 5000);
    check('leaveBy script: …the world lets go (the socket taken away), and the body is off', !!freed, await seated());
    await door('set', { id: 'pod', component: 'sockets', value: { seat: { pos: [0, 2.6, 0], body: {} } } });
    await waitFor(() => !!globalThis.EW.comps.get('pod')?.sockets?.seat, null, 20000);   // the seat is back in her client
    const again = await sit('pod', 'pod/seat');
    await sleep(500);
    await pg.keyboard.down('KeyW'); await sleep(400); await pg.keyboard.up('KeyW'); await sleep(300);
    const said = await ev(() => document.body.innerText.split('\n').filter((l) => /pod|seat|refused|sit/i.test(l)).slice(-6)).catch(() => null);
    check('leaveBy (control): the same seat without leaveBy, W takes you off', !!again && (await seated()) === null, { again, now: await seated(), said, sock: await ev(() => globalThis.EW.comps.get('pod')?.sockets ?? null) });
  }

  // (e) anchor: feet — a standing place on a plinth puts a standing body's soles on the socket. The sole height is
  //     measured here from Ann standing on the ground first (foot joints above her root), not from the client's anchor code
  {
    await sleep(800);
    const rest = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const h = me.vrm.humanoid;
      const y = (h.getRawBoneNode('leftFoot').getWorldPosition(new T.Vector3()).y + h.getRawBoneNode('rightFoot').getWorldPosition(new T.Vector3()).y) / 2; return y - me.root.position.y; });
    const r = await thing('plinth', -1.8, 2.2, { sockets: { top: { pos: [0, 2.0, 0], body: { action: 'stand', anchor: 'feet' } } } });
    if (!r.ok) stage('anchor: setup', false, r.refused);
    await realized('plinth');
    const sat = await sit('plinth', 'plinth/top');
    await sleep(1200);
    const at = await ev(() => { const EW = globalThis.EW, T = EW.THREE; const me = EW.me(); const h = me.vrm.humanoid; const s = EW.entities.get('plinth'); s.updateWorldMatrix(true, false);
      const l = h.getRawBoneNode('leftFoot').getWorldPosition(new T.Vector3()), rr = h.getRawBoneNode('rightFoot').getWorldPosition(new T.Vector3());
      return { feet: [(l.x + rr.x) / 2, (l.y + rr.y) / 2, (l.z + rr.z) / 2], sock: new T.Vector3(0, 2.0, 0).applyMatrix4(s.matrixWorld).toArray(), clip: EW.myState.clip }; });
    const said = sat ? null : await ev(() => document.body.innerText.split('\n').filter((l) => /plinth|seat|refused|sit|stand/i.test(l)).slice(-5)).catch(() => null);
    check('anchor: feet — the soles on the socket: foot joints at socket + their standing height (within 2 cm)',
      !!sat && Math.abs(at.feet[1] - at.sock[1] - rest) < 0.02 && Math.hypot(at.feet[0] - at.sock[0], at.feet[2] - at.sock[2]) < 0.12, { sat, rest, at, said, sock: sat ? undefined : await ev(() => globalThis.EW.comps.get('plinth')?.sockets ?? null) });
    await shoot('stand-on-plinth', [1.4, 0.2, 1.6]);
    await stand();
  }
  // (f) another person's seat, driven by their input riding presence: Bob's frames say he sits on the cart's seat with
  //     throttle 0.5 (input.move walk routes it); the seat blends sitchair → sit by throttle. Ann's client runs the same
  //     driver for him (remotes.js → seatbody.js), so his body there is half and half.
  {
    const r = await thing('cart', 0, -2.2, { sockets: { seat: { pos: [0, 2.6, 0], body: { input: { move: 'walk' }, pose: { by: 'throttle', clips: [[0, 'sitchair'], [1, 'sit']] } } } } });
    if (!r.ok) stage('remote: setup', false, r.refused);
    await realized('cart');
    const p = [here[0], 0, here[2] - 2.2];
    let stop = false;
    const frames = (async () => { while (!stop) { ws.send(JSON.stringify({ type: 'pose', pose: { p, yaw: 0, speed: 0, clip: 'idle', seat: { to: 'cart', slot: 'seat', in: { throttle: 0.5, steer: 0 } } } })); await sleep(66); } })();
    const seen = await waitFor(() => { const EW = globalThis.EW; const r = [...EW.remotes.values()].find((x) => x.id === 'Bob');
      const a = r?.avatar?.actions; const m = EW.avatarMounts.get('Bob');
      if (!m || !a?.sit || !a?.sitchair) return null;
      const w = { sit: +a.sit.getEffectiveWeight().toFixed(3), sitchair: +a.sitchair.getEffectiveWeight().toFixed(3), throttle: m.in?.throttle };
      return Math.abs(w.sit - 0.5) < 0.03 ? w : null; }, null, 15000);
    const last = seen ?? await ev(() => { const r = [...globalThis.EW.remotes.values()].find((x) => x.id === 'Bob'); const a = r?.avatar?.actions;
      return { mount: globalThis.EW.avatarMounts.get('Bob') ?? null, sit: a?.sit?.getEffectiveWeight() ?? null, sitchair: a?.sitchair?.getEffectiveWeight() ?? null, kind: r?.avatar?.constructor?.name }; });
    check('remote: Bob\'s throttle, riding his presence, blends his seated body in Ann\'s client (half sit, half sitchair)', !!seen && Math.abs(seen.sitchair - 0.5) < 0.03 && seen.throttle === 0.5, last);
    stop = true; await frames;
    ws.send(JSON.stringify({ type: 'pose', pose: { p, yaw: 0, speed: 0, clip: 'idle' } }));
  }

  // (g) getting on, warped: a seat with an approach point and an enter clip. Ann is carried to the approach point, then
  //     the enter clip (stand_to_sit) plays with its time locked to the carry onto the seat, then the seat's pose holds
  {
    const now = await ev(() => globalThis.EW.me().root.position.toArray());   // where she stood up last: the bench goes beside her, an ordinary walk away
    const r = await door('create', { id: 'bench', model: MODEL, components: { transform: { pos: [now[0] + 1.2, 0, now[2] - 1.2], scale: [0.2, 0.2, 0.2] }, sockets: { seat: { pos: [0, 2.6, 0], body: { approach: [0, 0, 0.6, 0], enter: 'stand_to_sit', leave: 'sit_to_stand' } } } } });
    if (!r.ok) stage('enter: setup', false, r.refused);
    await realized('bench');
    await ev(() => globalThis.EW.bus.emit('command', { cmd: 'sit', arg: 'bench seat' }));
    const trace = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const x = await ev(() => { const EW = globalThis.EW, me = EW.me(); const st = me._seatState; const a = me.actions.stand_to_sit;
        // u: how far the carry is at this frame's seat clock (when the enter began, how long it lasts), read off the seat
        const t = st ? (st.now - st.t0) / 1000 : null; const u = st?.enterAt != null ? (t - st.enterAt) / st.de : null;
        return st ? { stage: st.stage, t, u: u != null ? +u.toFixed(3) : null, enter: a ? +a.getEffectiveWeight().toFixed(3) : null, et: a ? +(a.time / a.getClip().duration).toFixed(3) : null, root: me.root.position.toArray().map((v) => +v.toFixed(3)), clip: EW.myState.clip } : null; }).catch(() => null);
      if (x) trace.push(x);
      if (x && x.stage === 'seated' && trace.some((y) => y.stage === 'enter')) break;   // on, after the enter
      await sleep(120);
    }
    // every frame in the carry: the enter clip holds the body and its time IS the carry's progress (a slow headless
    // frame rate may land only a frame or two inside the clip's 2.2 s; each one is checked)
    const mid = trace.filter((x) => x.clip === 'stand_to_sit');
    check('enter: the enter clip plays while she is carried on (stand_to_sit holds the body, its time locked to the carry)',
      mid.length >= 1 && mid.every((x) => x.enter > 0.9 && x.u != null && Math.abs(x.et - x.u) < 0.02), trace.slice(0, 14));
    const order = trace.map((x) => x.stage).filter((v, i, a) => v !== a[i - 1]);
    check('enter: …in order: brought to the approach point, carried on, seated', JSON.stringify(order) === '["approach","enter","seated"]', order);
    const end = trace[trace.length - 1];
    check('enter: …and it ends seated, the seat\'s own pose holding', end?.clip === 'sitchair', end);
    await stand();
  }
  }   // !SKIP_REST
  ws.close();
  const v4Errors = errors.filter((e) => /v4|legacy|projection|fold/i.test(e));
  stage('http: responses ≥ 400 the page saw (reported, not asserted)', true, http4xx);
  check('errors: no page error, and no console.error mentioning the v4 path', !errors.some((e) => /pageerror|TypeError|ReferenceError/.test(e)) && !v4Errors.length, errors.slice(0, 6));
} catch (e) {
  failed++; stage('probe', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  try { await b?.close(); } catch {}
  try { await world?.close(); } catch {}
  rmSync(worlds, { recursive: true, force: true });
  rmSync(SWING_FILE, { force: true });
}
console.log(failed ? `client-probe: ${failed} failed` : 'client-probe: today\'s client boots into a v4 world, sees it, edits it through the door, and hears refusals');
process.exit(failed ? 1 : 0);
