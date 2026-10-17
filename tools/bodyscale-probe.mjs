// bodyscale-probe — "this body" (Profile › Avatar: size + nameplate lift), end to end in the REAL client, TWO browsers:
// `sizer` changes its own body through the Profile's sliders; `watcher` is the remote that must see it. A plain socket
// peer `ref` stands beside it at 100% in the same body (claude.vrm) as the yardstick — and reads the relayed packets.
// Clouds are forced OFF before boot (a cloudy sky bakes on the CPU in headless Chromium and has frozen the host).
//
//   bun tools/bodyscale-probe.mjs [--shots <dir>]      (SHOT_BASE=130 numbers the shots)
//   (two browsers: on a small host, run it under a lock and a memory guard)
//
// What must hold:
//   the Profile — Avatars shows the worn body's size and nameplate sliders; moving them (input/change, the DOM's own
//     events) resizes the body live and saves per body name (ew-body-prefs);
//   the VR surfaces — the same section rasters into the VR quad (the vendored HTMLMesh domquad uses) and paints on the
//     canvas fallback quad (panels.js renderCanvas over the same fields);
//   the wire — the sizer's packets carry `scale` / `plateY` only when not default (read off a peer socket);
//   the remote — the watcher's copy of the sizer wears the size on vrm.scene (root stays 1), at 70 / 100 / 150 %, and a
//     wire value out of range is clamped (a peer claiming 500% is drawn at 200%);
//   the plate — +30 cm on the sizer's claude hangs 30 cm over ref's auto plate on the watcher's screen (same body, same size);
//   restore — the sizer reloads and wears its saved size again without touching anything.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const { check, done } = checker();
const shotDir = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? process.argv[i + 1] : null; })();
let shotN = Number(process.env.SHOT_BASE ?? 130);
if (shotDir) mkdirSync(shotDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORLD = 'bodies';

const world = await ownedWorld({ env: { SKIP_OPT_SWEEP: '1' } });
const { browser, close } = await launchBrowser();

const seen = new Map();   // id → the last pose the server relayed (read off the ref socket's frames)
function peer(id, pose, avatar) {
  const ws = new WebSocket(`${world.origin.replace(/^http/, 'ws')}/ws`);
  const p = { ws, pose, timer: null };
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', world: WORLD, id, token: world.key, avatar }));
    p.timer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pose', pose: p.pose })); }, 66);
  };
  ws.onmessage = (e) => { try { const m = JSON.parse(String(e.data)); if (m.type === 'frame') for (const [k, v] of Object.entries(m.poses ?? {})) seen.set(k, v); } catch {} };
  return p;
}

async function boot(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch {} });   // THE SKY GUARD
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('dialog', (d) => d.dismiss().catch(() => {}));
  const go = async () => {
    await pg.goto(`${world.origin}/?world=${WORLD}&name=${name}&key=${world.key}&avatar=claude`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!globalThis.EW?.me?.()?.vrm,
      null, { timeout: 180000 });
    await sleep(2500);
  };
  await go();
  return { ctx, pg, errs, go };
}
const shot = async (pg, name, clip) => { if (!shotDir) return; const f = `${shotDir}/${shotN++}-${name}.png`; await pg.screenshot({ path: f, ...(clip ? { clip } : {}) }); console.log(`  · shot ${f}`); };
const saveUrl = (name, url) => { if (!shotDir || !url) return; const f = `${shotDir}/${shotN++}-${name}.png`; writeFileSync(f, Buffer.from(url.split(',')[1], 'base64')); console.log(`  · shot ${f}`); };
const frameOf = (pg) => pg.evaluate(() => {
  const p = EW.myState.pos, d = new EW.THREE.Vector3(); EW.camera.getWorldDirection(d); d.y = 0; d.normalize();
  return { p: [p.x, p.y, p.z], f: [d.x, d.z], r: [-d.z, d.x] };
});
const at = (fr, fwd, right) => [fr.p[0] + fr.f[0] * fwd + fr.r[0] * right, fr.p[1], fr.p[2] + fr.f[1] * fwd + fr.r[1] * right];
// what the watcher sees of someone: body scale, root scale, the plate's world height, the root's world height
const view = (pg, id) => pg.evaluate((id) => {
  const r = EW.remotes.get(id), av = r?.avatar;
  if (!av?.vrm) return null;
  const v = new EW.THREE.Vector3(); av.label.getWorldPosition(v);
  return { scene: +av.vrm.scene.scale.y.toFixed(4), root: +av.root.scale.y.toFixed(4), plateY: +v.y.toFixed(3), rootY: +av.root.position.y.toFixed(3),
    wire: { scale: r.scale, plateY: r.plateY }, capsule: !!r.capsuleFor, lift: av.plateY };
}, id);
// set a Profile slider the way a hand does: the value, an `input` (live), then a `change` (release)
const slide = (pg, k, v) => pg.evaluate(([k, v]) => {
  const rows = [...document.querySelectorAll('.frame[data-frame="profile"] .sp-f-range')];
  const row = rows.find((r) => r.querySelector('.sp-label')?.textContent === k);
  const sl = row?.querySelector('input.sp-range');
  if (!sl) return `no slider "${k}" (have ${rows.map((r) => r.querySelector('.sp-label')?.textContent).join(', ')})`;
  sl.value = String(v); sl.dispatchEvent(new Event('input', { bubbles: true })); sl.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, [k, v]);
const until = async (pred, ms = 20000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await pred(); if (v) return v; await sleep(250); } return v; };

try {
  const W = await boot('watcher', { width: 1280, height: 720 });
  const fr = await frameOf(W.pg);
  // the watcher's own body stands between its follow camera and the subjects: out of the shots (root, not vrm.scene —
  // the follow camera re-shows vrm.scene every frame)
  await W.pg.evaluate(() => { EW.me().root.visible = false; });
  const S = await boot('sizer', { width: 1100, height: 760 });
  // stand the sizer and ref 3.4 m in front of the watcher, side by side, facing it
  const face = (p) => Math.atan2(fr.p[0] - p[0], fr.p[2] - p[2]);
  const sp = at(fr, 3.4, 0.55), rp = at(fr, 3.4, -0.55);
  await S.pg.evaluate(([p, yaw]) => { EW.myState.pos.set(p[0], p[1], p[2]); EW.myState.yaw = yaw; }, [sp, face(sp)]);
  const ref = peer('ref', { p: rp, yaw: face(rp), speed: 0, clip: 'idle' }, 'claude');
  await until(() => W.pg.evaluate(() => ['sizer', 'ref'].every((id) => EW.remotes.get(id)?.avatar?.vrm && !EW.remotes.get(id)?.loading && !EW.remotes.get(id)?.capsuleFor)), 120000);
  await sleep(2500);
  const bodies = await W.pg.evaluate(() => ['sizer', 'ref'].map((id) => [id, EW.remotes.get(id)?.avatarPath, !!EW.remotes.get(id)?.capsuleFor]));
  console.log('    bodies', JSON.stringify(bodies));
  check('both bodies are claude.vrm on the watcher (the yardstick is the same body)', bodies.every(([, p, cap]) => /claude/.test(p ?? '') && !cap), JSON.stringify(bodies));

  // ---------------------------------------------------------------- the Profile on the sizer
  await S.pg.evaluate(async () => {
    const F = await import('/lib/frames.js');
    for (const f of F.allFrames()) if (f.visible && f.id !== 'profile') f.hide();
    F.getFrame('profile').show();
    document.querySelector('.frame[data-frame="profile"] .pf-tab[data-tab="avatars"]')?.click();
  });
  await sleep(800);
  const sec = await S.pg.evaluate(() => [...document.querySelectorAll('.frame[data-frame="profile"] .sp-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()).slice(0, 8));
  console.log('    profile rows', JSON.stringify(sec));
  check('Profile › Avatars: the worn body has size and nameplate sliders', sec.some((t) => /^size/.test(t)) && sec.some((t) => /^nameplate/.test(t)), JSON.stringify(sec));

  const r150 = await slide(S.pg, 'size', 150);
  await sleep(600);
  const me150 = await S.pg.evaluate(() => ({ scene: EW.me().vrm.scene.scale.y, root: EW.me().root.scale.y, store: localStorage.getItem('ew-body-prefs') }));
  check('the size slider resizes my body live (vrm.scene 1.5, root 1)', r150 === true && Math.abs(me150.scene - 1.5) < 1e-6 && me150.root === 1, JSON.stringify({ r150, me150 }));
  check('...and saves it under the worn body\'s name', /"claude":\{"scale":1\.5/.test(me150.store ?? ''), me150.store);
  const rows150 = await S.pg.evaluate(() => [...document.querySelectorAll('.frame[data-frame="profile"] .sp-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
  check('...the height readout caught up on release (× 1.5) and a reset appeared', rows150.some((t) => /^height.*at 100%/.test(t)) && rows150.some((t) => /size: back to 100%/.test(t)), JSON.stringify(rows150));
  const box = await S.pg.evaluate(() => { const r = document.querySelector('.frame[data-frame="profile"]').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
  await shot(S.pg, 'profile-this-body-desktop', box);
  // the VR surfaces: the vendored HTMLMesh over the same frame (the domquad path), and the canvas fallback quad
  const vr = await S.pg.evaluate(async () => {
    const out = {};
    try {
      const { HTMLMesh } = await import('/lib/vendor/htmlmesh.js');
      const m = new HTMLMesh(document.querySelector('.frame[data-frame="profile"]'), { scale: 1 }); m.material.map.pause?.();
      await new Promise((r) => setTimeout(r, 300));
      out.html = m.material.map.image.toDataURL('image/png');
    } catch (e) { out.htmlErr = String(e).slice(0, 200); }
    try {
      const { renderCanvas } = await import('/lib/panels.js');
      const { bodiesFields } = await import('/lib/bodies.js');
      const cv = document.createElement('canvas');
      const f = bodiesFields();
      const regions = renderCanvas(cv, f, { title: 'profile' });
      out.canvas = cv.toDataURL('image/png');
      out.sliders = regions.filter((r) => r.slider).map((r) => r.action);
    } catch (e) { out.canvasErr = String(e).slice(0, 200); }
    return out;
  });
  saveUrl('profile-this-body-vr-htmlmesh', vr.html);
  saveUrl('profile-this-body-vr-canvasquad', vr.canvas);
  check('VR: the same section rasters through HTMLMesh (the domquad path)', !!vr.html && vr.html.length > 5000, vr.htmlErr ?? `${vr.html?.length}`);
  check('VR: the canvas fallback quad paints both sliders as laser-clickable tracks', JSON.stringify(vr.sliders) === JSON.stringify(['body-scale', 'plate-y']), vr.canvasErr ?? JSON.stringify(vr.sliders));

  // ---------------------------------------------------------------- the wire and the remote
  const w150 = await until(() => seen.get('sizer')?.scale === 1.5 && seen.get('sizer'));
  check('the wire: my packets carry scale 1.5 (and no plateY while it is auto)', w150?.scale === 1.5 && !('plateY' in (w150 ?? {})), JSON.stringify(w150 && { scale: w150.scale, plateY: w150.plateY }));
  const v150 = await until(async () => { const v = await view(W.pg, 'sizer'); return v && Math.abs(v.scene - 1.5) < 1e-3 && v; });
  check('the watcher draws the sizer at 150 % (vrm.scene; its root stays 1)', !!v150 && v150.root === 1, JSON.stringify(v150));
  const hide = (pg) => pg.evaluate(async () => { const F = await import('/lib/frames.js'); for (const f of F.allFrames()) if (f.visible) f.hide(); });
  await hide(W.pg);
  await sleep(1500);
  await shot(W.pg, 'remote-sizer-150-beside-ref-100');
  for (const [pctV, want] of [[70, 0.7], [100, 1]]) {
    await slide(S.pg, 'size', pctV);
    const v = await until(async () => { const v = await view(W.pg, 'sizer'); return v && Math.abs(v.scene - want) < 1e-3 && v; });
    check(`the watcher draws the sizer at ${pctV} %`, !!v, JSON.stringify(await view(W.pg, 'sizer')));
    if (want === 1) check('...and at 100 % the wire carries NO scale (absence = default)', !('scale' in (seen.get('sizer') ?? {})), JSON.stringify(seen.get('sizer')?.scale));
    await sleep(1500);
    await shot(W.pg, `remote-sizer-${pctV}-beside-ref-100`);
  }
  // don't trust the wire: ref claims 500 %
  ref.pose = { ...ref.pose, scale: 5 };
  const vr5 = await until(async () => { const v = await view(W.pg, 'ref'); return v && v.scene > 1.5 && v; });
  check('a wire claim of 500 % is drawn clamped at 200 %', !!vr5 && Math.abs(vr5.scene - 2) < 1e-6, JSON.stringify(vr5));
  delete ref.pose.scale;
  const vr1 = await until(async () => { const v = await view(W.pg, 'ref'); return v && Math.abs(v.scene - 1) < 1e-6 && v; });
  check('...and when the field stops coming, it is 100 % again (absence = default, live)', !!vr1, JSON.stringify(await view(W.pg, 'ref')));

  // ---------------------------------------------------------------- the plate: auto vs +30 cm on the same body
  // A plate rides the LIVE hips through a 2 cm dead zone (plateanchor.js smoothY), so it rests up to 2 cm short of its
  // target on whichever side it came from. Measured (8 readings over 3 s, steady to 1 mm): sizer 1.862, ref 1.901 —
  // the sizer had just come UP from 70 %, ref DOWN from its 200 % clamp test: −2 cm and +2 cm, 4 cm apart, as designed.
  // So the auto-vs-auto check allows two dead zones, and the honest measure of the lift is the sizer against ITSELF.
  const over = async (id) => { let n = 0, sum = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) { const v = await view(W.pg, id); if (v) { const h = v.plateY - v.rootY; sum += h; n++; lo = Math.min(lo, h); hi = Math.max(hi, h); } await sleep(400); }
    return { mean: n ? sum / n : NaN, lo, hi, n }; };
  await sleep(2000);
  const autoS = await over('sizer'), autoR = await over('ref');
  console.log('    auto plate over root (m): sizer', JSON.stringify(autoS), 'ref', JSON.stringify(autoR));
  check('same body, same size, both auto: the plates hang level within the two 2 cm dead zones (±4.5 cm)', Math.abs(autoS.mean - autoR.mean) < 0.045, JSON.stringify({ autoS, autoR }));
  await shot(W.pg, 'claude-plate-auto-both');
  await slide(S.pg, 'nameplate', 30);
  const w30 = await until(() => seen.get('sizer')?.plateY === 0.3 && seen.get('sizer'));
  check('the wire: plateY 0.3 rides the pose', w30?.plateY === 0.3, JSON.stringify(w30 && { plateY: w30.plateY }));
  await sleep(3000);   // the plate's Y chase (τ 0.12 s) at a headless frame rate
  const upS = await over('sizer');
  const d = upS.mean - autoS.mean;
  check('+30 cm: on the watcher, the sizer\'s plate rose 30 cm over its own auto (±3 cm)', Math.abs(d - 0.3) < 0.03, `Δ ${d.toFixed(3)} ${JSON.stringify({ autoS, upS })}`);
  await shot(W.pg, 'claude-plate-ref-auto-left-sizer-raised30-right');

  // ---------------------------------------------------------------- restore on wear (a reload)
  await slide(S.pg, 'size', 130);
  await sleep(500);
  await S.go();
  await S.pg.evaluate(([p, yaw]) => { EW.myState.pos.set(p[0], p[1], p[2]); EW.myState.yaw = yaw; }, [sp, face(sp)]);
  const back = await S.pg.evaluate(() => ({ scene: EW.me().vrm.scene.scale.y, plateY: EW.me().plateY }));
  check('reloaded: the sizer wears its saved 130 % and +30 cm again, untouched', Math.abs(back.scene - 1.3) < 1e-6 && back.plateY === 0.3, JSON.stringify(back));
  const vBack = await until(async () => { const v = await view(W.pg, 'sizer'); return v && Math.abs(v.scene - 1.3) < 1e-3 && v; }, 60000);
  check('...and the watcher sees it without the sizer touching anything', !!vBack, JSON.stringify(await view(W.pg, 'sizer')));

  check('no page errors (watcher)', W.errs.length === 0, W.errs.slice(0, 3).join(' | '));
  check('no page errors (sizer)', S.errs.length === 0, S.errs.slice(0, 3).join(' | '));
  clearInterval(ref.timer); try { ref.ws.close(); } catch {}
} finally {
  await close().catch(() => {});
  await world.close().catch(() => {});
}
done();
