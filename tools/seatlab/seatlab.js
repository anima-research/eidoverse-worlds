// seatlab — #101's measuring instrument, now a tools harness (Phase B
// evidence hygiene: a laboratory bench must not ship as client runtime, so
// it lives here and the client never imports it).
//
// Browser-loaded: import specifiers are ABSOLUTE (/lib/...), so the module
// works served from anywhere — in practice POST /upload?as=script and
// `await import('/library/eidoverse/assets/opt/store/scripts/<hash>.js')`,
// the same receipts pipeline Phase A used. Pure math lives in
// /lib/seatcore.js where bun tests pin it; this file only observes scenes
// and lab instances.
//
// The _v lesson (design-round evidence amendment, conceded): the passive
// instrument used to compute the seat claim through shared scratch
// registers, and the forward-vector reuse clobbered the socket position
// before its Y was read — invisible at y≈0, corrupt everywhere else. The
// seat claim is now seatcore.seatClaim (pure arguments cannot alias), the
// registers below are single-purpose, and the nonzero-Y regression in
// tools/seatcore-test.ts pins the function the instrument leans on.
//
// All quantities in WORLD metres. Signed gaps are (landmark − seat surface):
// positive = the landmark floats above the authored seat.

import { THREE, scene } from '/lib/core.js';
import { remotes } from '/lib/remotes.js';
import { entities, comps, avatarMounts, socketWorldPos, mountTransform } from '/lib/world.js';
import { makeAvatar } from '/lib/avatar.js';
import { seatClaim, SEAT_METHOD, MIN_PATCH_VERTS, MAX_PATCH_SPREAD_Y, nameFromAvatarPath, SEAT_CLIP_FILE } from '/lib/seatcore.js';
import { vrmaShaLoaded } from '/lib/assets.js';

const _sock = new THREE.Vector3();   // socket world position — nothing else
const _work = new THREE.Vector3();   // per-read scratch, never held across reads
const _q = new THREE.Quaternion();
const _box = new THREE.Box3();

/** Measure one mounted rider. `localAvatar` supplies the browser-local
 *  body's avatar wrapper when measuring yourself (remotes only hold the
 *  others). Returns a plain JSON-able record, or {error}. */
export function measureSeat(riderId, { localAvatar = null } = {}) {
  const m = avatarMounts.get(riderId);
  if (!m) return { error: `${riderId} is not mounted` };
  const parent = entities.get(m.to);
  if (!parent) return { error: `mount parent ${m.to} not present` };
  const sock = comps.get(m.to)?.sockets?.[m.slot] ?? null;

  // ---- the seat's claim ----------------------------------------------------
  const seatPos = socketWorldPos(m.to, m.slot, _sock);
  if (!seatPos) return { error: `socket ${m.to}/${m.slot} unresolvable` };
  parent.getWorldQuaternion(_q);
  // pure math on captured values — the register-aliasing class of error is
  // structurally impossible here (and pinned at nonzero Y by the bun test)
  const claim = seatClaim([seatPos.x, seatPos.y, seatPos.z], [_q.x, _q.y, _q.z, _q.w]);
  const seat = { world: seatPos.toArray().map((n) => +n.toFixed(4)) };
  seat.parentYaw = +claim.parentYaw.toFixed(4);
  seat.socketLocal = sock ? { pos: sock.pos ?? null, yaw: sock.yaw ?? 0, pose: sock.pose ?? 'sitchair',
    part: sock.part ?? null, seatAnchor: sock.seatAnchor ?? null } : null;
  seat.mountOverrides = { offset: m.offset ?? null, yaw: m.yaw ?? null };
  const seatY = claim.seatY;

  // ---- the body ------------------------------------------------------------
  const rec = remotes.get(riderId);
  const avatar = rec?.avatar ?? localAvatar;
  if (!avatar) return { error: `${riderId} has no avatar here`, seat };
  const kind = rec ? 'remote' : 'local';
  const vrm = avatar.vrm ?? null;
  const humanoid = !!vrm?.humanoid;

  const root = avatar.root;
  root.updateWorldMatrix(true, true);
  const rootY = root.getWorldPosition(_work).y;

  // every landmark CANDIDATE, none blessed (the Phase A amendment): a hips
  // origin can be rig metadata; bounds are geometry; the truth is for the table
  const candidates = { root: +(rootY - seatY).toFixed(4) };
  let hipsRawY = null, hipsNormY = null;
  if (humanoid) {
    const raw = vrm.humanoid.getRawBoneNode?.('hips');
    const norm = vrm.humanoid.getNormalizedBoneNode?.('hips');
    if (raw) { raw.updateWorldMatrix(true, false); hipsRawY = raw.getWorldPosition(_work).y; candidates.hipsRaw = +(hipsRawY - seatY).toFixed(4); }
    if (norm) { norm.updateWorldMatrix(true, false); hipsNormY = norm.getWorldPosition(_work).y; candidates.hipsNormalized = +(hipsNormY - seatY).toFixed(4); }
  }
  _box.setFromObject(vrm?.scene ?? root);
  candidates.boundsMin = +(_box.min.y - seatY).toFixed(4);
  const bounds = { height: +(_box.max.y - _box.min.y).toFixed(4),
    width: +(_box.max.x - _box.min.x).toFixed(4), depth: +(_box.max.z - _box.min.z).toFixed(4) };

  // the composition's own word for this seat (#101): what mountTransform
  // declared — profiled or approximate-with-reason — measured alongside the
  // geometry so the acceptance table can assert both at once
  const sw = mountTransform(riderId, _work, { path: rec?.avatarPath ?? null, av: avatar });

  return {
    rider: riderId, kind,
    rig: humanoid ? 'vrm-humanoid' : 'unsupported (no humanoid mapping)',
    avatarPath: rec?.avatarPath ?? '(local)',
    activeClip: rec?.lastClip ?? avatar.currentSlot ?? null,
    seatState: sw ? { state: sw.seatState, reason: sw.seatReason } : null,
    seat,
    body: { rootWorldY: +rootY.toFixed(4), hipsRawWorldY: hipsRawY && +hipsRawY.toFixed(4),
      hipsNormWorldY: hipsNormY && +hipsNormY.toFixed(4), bounds },
    /** signed vertical gaps, landmark − authored seat surface (＋ = floats) */
    gap: candidates,
  };
}

/** Every mounted rider at once — the table row generator. */
export function measureAllSeats(opts = {}) {
  return [...avatarMounts.keys()].map((id) => measureSeat(id, opts));
}

// ---- the detached lab (Phase A rev 2, carried whole) ------------------------
// Measurements happen on instances the lab OWNS — constructed, pulled
// off-scene, measured, disposed. No live resident is ever posed, re-clipped
// or moved: the passive measureSeat above only reads, and everything below
// touches only lab-created bodies (Phase A review B1).

/** Measure one avatar instance's sit-pose geometry, with full animation
 *  receipts (Phase A review B2) and a MEASURED contact candidate (review
 *  B3): the lowest skinned vertex among those weighted ≥ minWeight to the
 *  pelvis bone set, under the settled pose — an actual support surface, not
 *  a joint origin. Root is neutralized to the origin, so every Y is
 *  root-local = the signed gap above an authored seat once mounted.
 *
 *  Phase B evidence amendment: the winner is RECORDED (mesh, vertex index,
 *  coordinate) alongside its support patch — the pelvis-set vertices within
 *  radiusXZ of it and within the contact band above it. A healthy underside
 *  is a cluster; a skirt hem or loose accessory is an isolated winner, and
 *  the patch statistics are how validation (seatcore.validateProfile) and a
 *  human reviewer both see the difference. No minimum is auto-promoted. */
export function labAvatar(av, { pose = 'sitchair', settleMs = 1200, steps = 72, radiusXZ = 0.1 } = {}) {
  if (!av?.root) return { error: 'no avatar' };
  const vrm = av.vrm ?? null;
  if (!vrm?.humanoid) {
    // the legible refusal: no humanoid mapping means no seat landmark exists
    // to derive — say so, never guess
    return { rig: 'unsupported', refusal: 'no humanoid mapping — no seat landmark derivable' };
  }
  av.root.position.set(0, 0, 0); av.root.rotation.set(0, 0, 0); av.root.scale.set(1, 1, 1);

  // ---- animation receipts: what ACTUALLY produced this skeleton -----------
  av.setClip(pose);
  const actual = av.currentSlot;
  const action = av.actions[actual] ?? null;
  if (action) { action.time = 0; }               // known phase: start of clip
  const dt = (settleMs / 1000) / steps;
  for (let i = 0; i < steps; i++) av.update(dt, 0);
  vrm.update?.(0);
  av.root.updateWorldMatrix(true, true);
  const anim = {
    requestedPose: pose,
    actualSlot: actual,
    fallback: actual !== pose,
    available: { sitchair: !!av.actions.sitchair, sit: !!av.actions.sit, idle: !!av.actions.idle },
    actionTime: action ? +action.time.toFixed(4) : null,
    actionWeight: action ? +action.getEffectiveWeight().toFixed(4) : null,
  };

  // ---- landmarks (bone origins — context, not contact) --------------------
  const yOf = (n) => { const b = vrm.humanoid.getRawBoneNode?.(n); if (!b) return null; b.updateWorldMatrix(true, false); return +b.getWorldPosition(_work).y.toFixed(4); };
  const landmarks = { root: 0, hips: yOf('hips'), spine: yOf('spine'),
    leftUpperLeg: yOf('leftUpperLeg'), leftFoot: yOf('leftFoot'), head: yOf('head') };

  // ---- the measured contact candidate + its support patch -----------------
  const pelvis = ['hips', 'leftUpperLeg', 'rightUpperLeg']
    .map((n) => vrm.humanoid.getRawBoneNode?.(n)).filter(Boolean);
  const minWeight = 0.5;
  const verts = [];                              // {mesh, i, x, y, z} — pelvis-weighted only
  let meshes = 0;
  vrm.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const boneIdx = new Set(pelvis.map((b) => o.skeleton.bones.indexOf(b)).filter((i) => i >= 0));
    if (!boneIdx.size) return;
    meshes++;
    const si = o.geometry.getAttribute('skinIndex'), sw = o.geometry.getAttribute('skinWeight');
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (boneIdx.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      if (w < minWeight) continue;
      o.getVertexPosition(i, _work).applyMatrix4(o.matrixWorld);   // skinned, root-local (root at origin)
      verts.push({ mesh: o.name || '(unnamed mesh)', i, x: _work.x, y: _work.y, z: _work.z });
    }
  });
  _box.setFromObject(vrm.scene);
  const bounds = { minY: +_box.min.y.toFixed(4), maxY: +_box.max.y.toFixed(4) };
  let contact;
  if (verts.length) {
    const win = verts.reduce((a, b) => (b.y < a.y ? b : a));
    const patch = verts.filter((v) => Math.hypot(v.x - win.x, v.z - win.z) <= radiusXZ && v.y - win.y <= MAX_PATCH_SPREAD_Y);
    const spreadY = patch.length ? Math.max(...patch.map((v) => v.y)) - win.y : 0;
    contact = {
      seatContactY: +win.y.toFixed(4), sampledVerts: verts.length, meshes,
      winner: { mesh: win.mesh, vertexIndex: win.i, rootLocal: [+win.x.toFixed(4), +win.y.toFixed(4), +win.z.toFixed(4)] },
      supportPatch: { count: patch.length, spreadY: +spreadY.toFixed(4), radiusXZ },
      plausible: win.y >= _box.min.y - 0.1 && win.y <= _box.max.y
        && patch.length >= MIN_PATCH_VERTS,      // an isolated winner is a hem/accessory shape — flagged, not proposed
    };
  } else contact = { error: 'no pelvis-weighted vertices found' };

  return { rig: 'vrm-humanoid', anim, landmarks, contact, bounds };
}

/** Construct a DETACHED instance of an avatar, measure it `runs` times for
 *  determinism, dispose it. Never touches the scene or any resident. */
export async function labRig(avatarPath, { pose = 'sitchair', runs = 3 } = {}) {
  const av = await makeAvatar(`seatlab-${Math.random().toString(36).slice(2, 8)}`, avatarPath, { urgent: true });
  try {
    scene.remove(av.root);
    if (av.gaze) scene.remove(av.gaze);
    await av.hydrateClips();                       // never measure a fallback unknowingly
    const results = [];
    for (let r = 0; r < runs; r++) results.push(labAvatar(av, { pose }));
    const keys = results.map((x) => JSON.stringify(x));
    return { avatarPath, runs, deterministic: keys.every((k) => k === keys[0]), result: results[0],
      ...(keys.every((k) => k === keys[0]) ? {} : { allRuns: results }) };
  } finally { av.dispose(); }
}

// ---- derivation: from a lab scan to a POSTable proposal ---------------------

async function sha256hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Run the lab on an avatar and assemble the full seat-profile record the
 *  server's door accepts — content-bound to the exact bytes this page holds,
 *  review.status "proposed" (the only status the door will take; the tool
 *  proposes, a human countersigns). Returns {profile} or {error, scan}. */
export async function deriveSeatProfile(avatarPath, { pose = 'sitchair', runs = 3 } = {}) {
  const scan = await labRig(avatarPath, { pose, runs });
  const name = nameFromAvatarPath(avatarPath);
  // the same bytes loadVRM downloads: library route, overlay included
  const avatarSha256 = await sha256hex(await (await fetch(`/library/${avatarPath.replace(/^\/?(library\/)?/, '')}`)).arrayBuffer());
  if (scan.result?.rig === 'unsupported') {
    return { profile: { avatar: name, avatarSha256, pose, unsupported: { refusal: scan.result.refusal }, review: { status: 'proposed' } } };
  }
  const c = scan.result?.contact;
  if (!c || c.error) return { error: c?.error ?? 'no contact candidate', scan };
  if (!scan.deterministic) return { error: 'derivation not deterministic across runs — not proposable', scan };
  if (!c.plausible) return { error: 'winner failed plausibility (isolated below its support patch, or outside bounds) — a human must look', scan };
  const clipSha256 = vrmaShaLoaded(SEAT_CLIP_FILE);
  if (!clipSha256) return { error: 'chair clip not loaded — hydrate first', scan };
  return { profile: {
    avatar: name, avatarSha256, pose, clipSha256,
    seatContactY: c.seatContactY,
    derivation: { toolVersion: 'seatlab-4', method: SEAT_METHOD,
      winner: c.winner, supportPatch: c.supportPatch, runs, deterministic: true },
    review: { status: 'proposed' },
  }, scan };
}
