// avatar-thumbnail — a body's roster portrait and perf stamp, made from the VRM already in memory.
// Takes a vrm, not an Avatar: nothing here imports avatar.js.
import { THREE, renderer, backendName } from '../core.js';
import { bus, tee } from '../base.js';
import { clipFor } from '../assets.js';
import { beginWork, enqueue } from '../loadwork.js';
import { renderAside } from '../render.js';

// Contributed roster art: whoever wears a body renders one portrait off the VRM already in memory and posts it
// back (POST /thumb), once per body. The body's perf numbers as loaded (perfscope.js statsOf) ride the same door,
// once per body version per browser (server/routes.ts avatarRoster). The door key rides a header, never the URL.
const thumbAuth = (token) => (token ? { authorization: `Bearer ${token}` } : {});

async function stampAvatarPerf(name, vrm, token, path) {
  const v = /[?&]v=(\d+)/.exec(path ?? '')?.[1];
  if (!v || !vrm?.scene) return;
  const key = `ew-perf1-${name}-${v}`;
  if (localStorage.getItem(key)) return;
  const { statsOf } = await import('../debug/perfscope.js');
  const s = statsOf(vrm.scene, name);
  const q = new URLSearchParams({ name, v, perf: JSON.stringify({ tris: s.tris, draws: s.draws, mats: s.mats, alpha: s.alpha, bones: s.bones, texMB: s.texMB }) });
  const r = await fetch(`/thumb?${q}`, { method: 'POST', headers: thumbAuth(token) });
  // only a server that says it stored the stamp burns the once-per-version flag (an older server drops `perf`)
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (j?.perf === true) { localStorage.setItem(key, '1'); bus.emit('avatar-perf', { name }); }   // the avatar cards repaint
}

/** @returns {Promise<boolean>} true when the server holds a portrait after this call (found, or posted); false when it skipped (#225) */
export async function contributeThumbnail(name, vrm, token = '', { force = false, path = null } = {}) {
  try {
    if (!name) return false;
    try { await stampAvatarPerf(name, vrm, token, path); } catch (e) { console.warn('avatar perf stamp skipped', e); }
    if (!force && localStorage.getItem(`ew-thumb2-${name}`)) return false;   // we already tried
    if (!force) {
      const head = await fetch(`/thumb/${encodeURIComponent(name)}.png`, { method: 'HEAD' });
      if (head.ok) { localStorage.setItem(`ew-thumb2-${name}`, '1'); return true; }
    }

    const size = 256;
    const rt = new THREE.RenderTarget(size, size);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 12);
    const sub = new THREE.Scene();
    // a render target gets no tone mapping, so the lights are linear-safe levels, not the world's
    sub.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1.4, 2.2, 2.4);
    sub.add(key);

    // pose it first, before the precompile (pose and render in the compile's frame draw the compile-time pose):
    // one frame of the idle clip, since a VRM at rest is a T-pose
    let poseMixer = null;
    try {
      const clip = await clipFor(vrm, 'idle');
      poseMixer = new THREE.AnimationMixer(vrm.scene);
      const act = poseMixer.clipAction(clip);
      act.play();
      poseMixer.update(0.6);        // a little way in, past the settling frames
      vrm.update(0.6);
      const arm = vrm.humanoid.getRawBoneNode('leftUpperArm');
      const deg = arm ? Math.round(arm.quaternion.angleTo(new THREE.Quaternion()) * 180 / Math.PI) : -1;
      tee(`[thumb] ${name}: posed (${clip.tracks.length} tracks, raw arm ${deg}°, autoUpdate ${vrm.humanoid.autoUpdateHumanBones})`);
    } catch (e) { tee(`[thumb] ${name}: pose failed — ${e?.message ?? e}`); /* T-pose is survivable; a missing portrait is worse */ }

    // precompile the portrait's pipelines before borrowing the body (a new pipeline context; compiling inside the
    // synchronous render() is a seconds-long stall). compileAsync captures its render context synchronously.
    {
      const work = beginWork(`thumb ${name}`);
      try {
        work.phase('queued');
        await enqueue(() => {
          work.phase('compile');
          const prev = renderer.getRenderTarget();
          renderer.setRenderTarget(rt);
          const compiled = renderer.compileAsync(vrm.scene, cam, sub);
          renderer.setRenderTarget(prev);
          return compiled.catch(() => {});
        }, { lane: 'gpu', priority: 0 }); // a portrait never outranks a person
      } finally { work.end(); }
    }

    // deep-cloning a VRM is not safe (MToon node materials, spring/lookAt proxies), so the real body is borrowed
    // for one frame and put straight back
    const home = vrm.scene.parent;
    const homeIndex = home ? home.children.indexOf(vrm.scene) : -1;
    const keptPos = vrm.scene.position.clone();
    const keptRot = vrm.scene.rotation.clone();

    // frame the whole figure, identically for every body
    const bbox = new THREE.Box3().setFromObject(vrm.scene);
    const dims = new THREE.Vector3();     // not `size`: that is the pixel size
    bbox.getSize(dims);
    // stature from the skeleton, not the bounding box (hair, capes and particle shells inflate it); also reported,
    // so catalogs draw the roster to a common scale
    let height = dims.y;
    try {
      const rootY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
      const headY = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3()).y;
      const stature = headY - rootY + 0.13; // crown ≈ head joint + a forehead
      // unless the mesh really does go higher: the bbox may raise the top by up to 60% of stature
      if (stature > 0.2) height = Math.min(Math.max(stature, dims.y), stature * 1.6);
    } catch { /* bbox fallback */ }
    const fov = 30;
    // fit the taller of (height, width) into a square frame, with headroom
    const extent = Math.max(height, dims.x, 0.4) * 0.55;
    const dist = (extent / Math.tan((fov * Math.PI / 180) / 2)) * 1.0;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.position.set(dist * 0.16, height * 0.56, dist);
    cam.lookAt(0, height * 0.5, 0);

    const prevTarget = renderer.getRenderTarget();
    try {
      sub.add(vrm.scene);
      vrm.scene.position.set(0, 0, 0);
      // keep the loader's VRM0 normalization (rotation.y = π), or every VRM0 body is photographed from behind
      vrm.scene.rotation.set(0, vrm.meta?.metaVersion === '0' ? Math.PI : 0, 0);
      renderAside(sub, cam, rt);   // never through renderer.render while presenting: a parentless camera rewrites the stereo eyes (render.js)
    } finally {
      renderer.setRenderTarget(prevTarget);
      poseMixer?.stopAllAction();
      vrm.scene.position.copy(keptPos);
      vrm.scene.rotation.copy(keptRot);
      if (home) {
        home.add(vrm.scene);
        // restore draw order
        if (homeIndex >= 0 && homeIndex < home.children.length - 1) {
          home.children.splice(home.children.indexOf(vrm.scene), 1);
          home.children.splice(homeIndex, 0, vrm.scene);
        }
      }
    }

    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
    // a blank readback must never become a portrait: below 2% opaque, skip the POST
    { let opaque = 0; for (let i = 3; i < size * size * 4; i += 16) if (buf[i] > 10) opaque++;
      const frac = opaque / (size * size / 4);
      if (frac < 0.02) { tee(`[thumb] blank readback (${backendName()}) for ${name} — not posted`); rt.dispose(); return false; } }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    // WebGPU hands rows back top-down, WebGL bottom-up
    if (backendName() === 'webgl') {
      const row = size * 4;
      for (let y = 0; y < size; y++) img.data.set(buf.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    } else {
      img.data.set(buf.subarray(0, size * size * 4));
    }
    // the target holds linear light and a PNG is shown as sRGB: encode, or the portraits read dark
    { const d = img.data; const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) { const l = i / 255; lut[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)); }
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; } }
    ctx.putImageData(img, 0, 0);
    rt.dispose();

    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return false;
    const q = new URLSearchParams({ name, height: height.toFixed(2) });
    if (force) q.set('force', '1'); // a re-mint pass really does replace
    const res = await fetch(`/thumb?${q}`, { method: 'POST', body: blob, headers: thumbAuth(token) });
    localStorage.setItem(`ew-thumb2-${name}`, '1');
    if (!res.ok) tee(`[thumb] ${name} refused (${res.status})`);
    return res.ok;
  } catch (e) {
    console.warn('thumbnail contribution skipped', e);
    return false;
  }
}
