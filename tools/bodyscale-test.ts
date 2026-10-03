// bodyscale — "this body" (Profile › Avatar, R 2026-09-30): a chosen SIZE and a NAMEPLATE LIFT per body, networked.
// Drives the real functions: shared/presencewire.js (the wire), client/lib/bodyscale.js (the maths), plateanchor.js's
// lift, avatar.js's setUserScale/setPuppetScale/setPlateY/_placePlate on a real THREE rig, remotes.js applyRemoteBody,
// and the server's own pose fence (posecheck.ts sanePose) — in-range fields pass the relay untouched, the rest are clamped.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/bodyscale-test.ts
//
// What must hold:
//   the wire — nothing sent at default (absence = default both ways: an old sender reads as 1 / 0, and a new sender
//     resetting stops sending); clamped on receipt (scale 0.5–2, plateY −0.3…+0.8 m); garbage reads as default; the
//     older readers (presence / voice) are untouched by the new keys; the server clamps them with the same clamps;
//   the lift — added over the crown standing, sitting AND lying (follows posture exactly as auto); 0 is auto exactly;
//   the VR composition — body = u/k on the puppet, rig = u: eyes at the HMD and hands on the controllers at any size,
//     and the device fit k (your real height) never depends on the size you chose;
//   the Avatar — the size lives on vrm.scene (the root stays 1, so plates stay screen-sized), composes with the VR fit,
//     a pooled VRM is reset on construction, and the plate hangs at crown·u + gap + lift·u.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: 'client-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    b.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a: number, b: number, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) <= eps;
const J = (x: any) => JSON.stringify(x, (_k, v) => typeof v === 'number' ? +v.toFixed(4) : v);
// a missing export/method reads as a no-op, so against the parent every check reports its own red
const fn = (m: any, k: string) => (typeof m?.[k] === 'function' ? m[k] : (() => undefined));

const PW: any = await import('../shared/presencewire.js');
const bodyWire = fn(PW, 'bodyWire'), applyBodyWire = fn(PW, 'applyBodyWire');

console.log('the wire:');
{
  check('default body sends nothing', J(bodyWire({ scale: 1, plateY: 0 })) === '{}', J(bodyWire({ scale: 1, plateY: 0 })));
  check('a chosen size and lift ride as two small numbers', J(bodyWire({ scale: 1.5, plateY: 0.3 })) === J({ scale: 1.5, plateY: 0.3 }), J(bodyWire({ scale: 1.5, plateY: 0.3 })));
  check('...rounded (1% / 1 cm)', J(bodyWire({ scale: 1.23456, plateY: 0.30449 })) === J({ scale: 1.23, plateY: 0.3 }), J(bodyWire({ scale: 1.23456, plateY: 0.30449 })));
  check('...and clamped on the way out', J(bodyWire({ scale: 7, plateY: -3 })) === J({ scale: 2, plateY: -0.3 }), J(bodyWire({ scale: 7, plateY: -3 })));
  const t: any = {};
  applyBodyWire(t, { scale: 9, plateY: 5 });
  check('receipt clamps: scale ≤ 2, plateY ≤ +0.8', t.scale === 2 && t.plateY === 0.8, J(t));
  applyBodyWire(t, { scale: 0.01, plateY: -5 });
  check('receipt clamps: scale ≥ 0.5, plateY ≥ −0.3', t.scale === 0.5 && t.plateY === -0.3, J(t));
  applyBodyWire(t, { scale: '2', plateY: null });
  check('a string / null reads as the default, not as a number', t.scale === 1 && t.plateY === 0, J(t));
  applyBodyWire(t, { scale: 1.4, plateY: 0.2 });
  applyBodyWire(t, { p: [0, 0, 0], yaw: 0 });   // an OLD client's packet, or a new one reset to default
  check('absence = default: an old sender (or a reset) reads as 1 / 0', t.scale === 1 && t.plateY === 0, J(t));
  check('applyBodyWire says when nothing changed (idempotent receivers skip the re-apply)', applyBodyWire(t, {}) === false && applyBodyWire(t, { scale: 1.1 }) === true);
  const v: any = {};
  check('the older readers ignore the new keys (presence / voice untouched)', PW.applyVoiceWire(v, { scale: 2, plateY: 0.5 }) === false
    && PW.applyPresenceWire(v, { scale: 2 }) === false && J(v) === '{}', J(v));
  const { sanePose } = await import('../server/posecheck.ts');
  const relayed: any = sanePose({ p: [1, 0, 1], yaw: 0, speed: 0, clip: 'idle', scale: 1.5, plateY: 0.3 });
  check('the server fence relays in-range values as sent (an older server relays the pose object whole, too)', relayed?.scale === 1.5 && relayed?.plateY === 0.3, J(relayed));
  const fenced: any = sanePose({ p: [1, 0, 1], yaw: 0, scale: 7, plateY: 'x' });
  check('...and clamps or drops the rest with the same clamps the receivers use (the server remembers lastPose)', fenced?.scale === 2 && !('plateY' in (fenced ?? {})), J(fenced));
}

console.log('voice on the wire (presencewire voiceWire / applyVoiceWire):');
{
  const voiceWire = fn(PW, 'voiceWire'), applyVoiceWire = fn(PW, 'applyVoiceWire');
  check('booleans ride as sent, false included', J(voiceWire({ mic: true, hear: false })) === J({ mic: true, hear: false }), J(voiceWire({ mic: true, hear: false })));
  check('...anything else is not sent (unknown, never coerced)', J(voiceWire({ mic: 1, hear: 'no' })) === '{}' && J(voiceWire(undefined)) === '{}', J(voiceWire({ mic: 1, hear: 'no' })));
  const r: any = { mic: true, hear: true };
  check('receipt: a non-boolean is dropped and leaves the known value alone', applyVoiceWire(r, { mic: 0, hear: 'false', p: [0, 0, 0] }) === false && r.mic === true && r.hear === true, J(r));
  check('receipt: ABSENT leaves it untouched (an older sender is unknown, not "off")', applyVoiceWire(r, { p: [0, 0, 0] }) === false && r.mic === true && r.hear === true, J(r));
  check('receipt: booleans land, false included', applyVoiceWire(r, { mic: false, hear: false }) === true && r.mic === false && r.hear === false, J(r));
  const fresh: any = {};
  applyVoiceWire(fresh, { mic: null });
  check('receipt: null is not a reading either', !('mic' in fresh), J(fresh));
}

const BS: any = await import('../client/lib/bodyscale.js').catch((e) => { console.log(`  (bodyscale.js did not load: ${e?.message})`); return {}; });
console.log('the maths:');
{
  const xrScales = fn(BS, 'xrScales'), toRigLocal = fn(BS, 'toRigLocal');
  // the VR composition, with the rig drawn as a real THREE group: a human 1.60 m at the eye in a body authored
  // 1.50 m at the eye (k = 1.5/1.6), a controller 0.55 m out and 1.1 m up in the playspace
  const { THREE } = await import('./core-stub.mjs');
  const H = 1.6, E = 1.5, k = E / H, handLocal = new THREE.Vector3(0.2, 1.1, -0.5);
  // the authored arm that reaches that hand at size 1 (the fit's whole point): its world length at the fit is |handLocal − shoulder|
  // an AUTHORED shoulder (model units) and the authored arm length that — through the size-1 fit (× 1/k) — spans
  // exactly shoulder→controller: the fit's whole promise, which every other size must keep
  const shoulderA = new THREE.Vector3(0.18 * k, 1.3, 0), armA = handLocal.clone().sub(shoulderA.clone().multiplyScalar(1 / k)).length() * k;
  for (const u of [0.7, 1, 1.5]) {
    const sc = xrScales(u, k) ?? {};
    const rig = new THREE.Group(); rig.scale.setScalar(sc.rig ?? 1); rig.position.set(3, 0, -2); rig.updateMatrixWorld(true);
    const hmd = rig.localToWorld(new THREE.Vector3(0, H, 0)), hand = rig.localToWorld(handLocal.clone());
    const eyeW = (sc.body ?? 1) * E;   // the body stands at the rig's origin here (feet at its y)
    const shoulderW = shoulderA.clone().multiplyScalar(sc.body ?? 1).add(rig.position);
    check(`size ${u}: the body's eyes sit at the HMD (body ${J(sc.body)} × authored eye = rig ${J(sc.rig)} × your eye)`, near(hmd.y, eyeW, 1e-9), `hmd ${hmd.y} eye ${eyeW}`);
    const need = hand.distanceTo(shoulderW), arm = armA * (sc.body ?? 1);
    check(`size ${u}: the body's arm (authored × body scale) spans shoulder→controller exactly — hands on the controllers`, near(need, arm, 1e-9), `need ${need} arm ${arm}`);
    check(`size ${u}: the height sample, read back rig-local, is YOUR eye (k never learns the size)`, near(toRigLocal(hmd.y - rig.position.y, rig.scale.y), H, 1e-9), `${toRigLocal(hmd.y, rig.scale.y)}`);
  }
  check('unmeasured fit (k = 1): body = rig = u', J(xrScales(1.3, undefined)) === J({ puppet: 1, body: 1.3, rig: 1.3 }), J(xrScales(1.3, undefined)));
  check('a garbage size composes as 1 (never a zero-scale rig)', xrScales(NaN, 0.9)?.rig === 1, J(xrScales(NaN, 0.9)));
  check('desktop eye: 1.45 m × size', near(fn(BS, 'deskEyeY')(1.5), 1.45 * 1.5) && near(fn(BS, 'deskEyeY')(undefined), 1.45));
  check('stride: speed × size', near(fn(BS, 'scaledSpeed')(1.55, 0.7), 1.55 * 0.7));
  check('collider: radius and height × size', J(fn(BS, 'colliderFor')(0.5)) === J({ r: 0.16, tall: 0.95 }), J(fn(BS, 'colliderFor')(0.5)));
  check('clip cadence: a 2× body walking 2× as fast plays the walk at its natural rate', near(fn(BS, 'clipRate')(3.1, 1.55, 2), 1) && near(fn(BS, 'clipRate')(1.55, 1.55, 1), 1)
    && near(fn(BS, 'clipRate')(1.55, 1.55, 2), 0.6), `${fn(BS, 'clipRate')(3.1, 1.55, 2)}`);
  // the mantle (review 09-30 N1): a ledge is climbable relative to the body — a 50% body (0.95 m) no longer mantles 1.7 m
  const canMantle = fn(BS, 'canMantle');
  check('mantle: a 100% body climbs 0.3–1.7 m ledges', canMantle(1.0, 1) === true && canMantle(1.7, 1) === true && canMantle(1.8, 1) === false && canMantle(0.3, 1) === false);
  check('mantle: a 50% body climbs 0.15–0.85 m, a 200% body 0.6–3.4 m', canMantle(1.2, 0.5) === false && canMantle(0.8, 0.5) === true
    && canMantle(3.0, 2) === true && canMantle(0.5, 2) === false);
  check('mantle: the controller asks canMantle with the body\'s size, and steps on by a scaled 0.6 m',
    /canMantle\(reach, me\.userScale\)/.test(await Bun.file(here('../client/lib/controller.js')).text())
    && /addScaledVector\(_facing, mantleStep\(me\.userScale\)\)/.test(await Bun.file(here('../client/lib/controller.js')).text()));
  check('mantle: the step onto the ledge grows with the body (it must clear a capsule of radius 0.32·u)', near(fn(BS, 'mantleStep')(2), 1.2) && near(fn(BS, 'mantleStep')(undefined), 0.6));
  check('plate lift: authored metres × the live model→world scale, clamped', near(fn(BS, 'plateLift')(0.3, 1.5), 0.45, 1e-12) && near(fn(BS, 'plateLift')(3, 1), 0.8));
  // per body, per browser
  const m = new Map<string, string>(), ls = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v) };
  fn(BS, 'saveBodyPrefs')(ls, 'claude', { plateY: 0.3 });
  fn(BS, 'saveBodyPrefs')(ls, 'claude', { scale: 1.2 });
  fn(BS, 'saveBodyPrefs')(ls, 'tigerbee', { scale: 0.8 });
  check('prefs: saved per body name, merged', J(fn(BS, 'loadBodyPrefs')(ls, 'claude')) === J({ scale: 1.2, plateY: 0.3 }) && J(fn(BS, 'loadBodyPrefs')(ls, 'tigerbee')) === J({ scale: 0.8, plateY: 0 }), m.get('ew-body-prefs'));
  fn(BS, 'saveBodyPrefs')(ls, 'tigerbee', { scale: 1 });
  check('prefs: a body back at default is forgotten, not stored', !JSON.parse(m.get('ew-body-prefs') ?? '{}').tigerbee, m.get('ew-body-prefs'));
  m.set('ew-body-prefs', '{"claude":{"scale":99,"plateY":"x"}}');
  check('prefs: a tampered store clamps / defaults', J(fn(BS, 'loadBodyPrefs')(ls, 'claude')) === J({ scale: 2, plateY: 0 }), J(fn(BS, 'loadBodyPrefs')(ls, 'claude')));
  m.set('ew-body-prefs', 'not json');
  check('prefs: an unreadable store is the default', J(fn(BS, 'loadBodyPrefs')(ls, 'claude')) === J({ scale: 1, plateY: 0 }));
}

console.log('the lift (plateanchor.js):');
{
  const { plateAnchor, crownEstimate } = await import('../client/lib/plateanchor.js');
  const c: any = crownEstimate({ hips: 0.95, head: 1.5, eye: 1.58 });
  const rest = { ...c, restHeadAboveFeet: 1.42 };
  const stand = { hips: [0, 0.95, 0], head: [0, 1.5, 0], feetY: 0.08, rest, s: 1, gap: 0.08 };
  const auto = plateAnchor(stand), lifted = plateAnchor({ ...stand, lift: 0.3 } as any), zero = plateAnchor({ ...stand, lift: 0 } as any);
  check('standing: +lift over auto', near(lifted.p[1] - auto.p[1], 0.3, 1e-12), `${auto.p[1]} → ${lifted.p[1]}`);
  check('lift 0 IS auto (bit for bit)', J(zero) === J(auto));
  const sit = { ...stand, hips: [0, 0.4, 0.1], head: [0, 0.98, 0.1] };
  check('sitting: the lifted plate comes down with the hips, still +lift', near(plateAnchor({ ...sit, lift: 0.3 } as any).p[1] - plateAnchor(sit).p[1], 0.3, 1e-12)
    && plateAnchor({ ...sit, lift: 0.3 } as any).p[1] < lifted.p[1]);
  const lie = { ...stand, hips: [0, 0.15, 0], head: [0.55, 0.15, 0] };
  const la = plateAnchor(lie), ll = plateAnchor({ ...lie, lift: 0.3 } as any);
  check('lying: over the head, still +lift', la.lie === 1 && near(ll.p[1] - la.p[1], 0.3, 1e-12) && near(ll.p[0], 0.55), `${J(la)} → ${J(ll)}`);
  check('a negative lift lowers it (a body whose crown estimate is too tall)', near(plateAnchor({ ...stand, lift: -0.2 } as any).p[1] - auto.p[1], -0.2, 1e-12));
}

console.log('avatar.js:');
{
  const { THREE } = await import('./core-stub.mjs');
  const { Avatar } = await import('../client/lib/avatar.js');
  const call = (o: any, m: string, ...a: any[]) => (typeof o[m] === 'function' ? o[m](...a) : undefined);
  const rig = () => {
    const root = new THREE.Group(), scene = new THREE.Group();
    root.add(scene);
    const B = (y: number, parent: any) => { const b = new THREE.Bone(); b.position.y = y; parent.add(b); return b; };
    const hips = B(0.95, scene), spine = B(0.3, hips), head = B(0.25, spine);
    const le = B(0.08, head), re = B(0.08, head); le.position.x = 0.03; re.position.x = -0.03;
    const lf = B(-0.87, hips), rf = B(-0.87, hips);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.3)); box.position.y = 1.7; scene.add(box);
    const bones: any = { hips, head, leftEye: le, rightEye: re, leftFoot: lf, rightFoot: rf };
    const humanoid = { getRawBoneNode: (n: string) => bones[n] ?? null, getNormalizedBoneNode: () => null };
    const label = new THREE.Sprite(); label.position.y = 1.95;
    const self: any = Object.assign(Object.create(Avatar.prototype), { vrm: { scene, humanoid }, root, label, _plateOff: null,
      userScale: 1, plateY: 0, _puppet: 1 });
    self._plateRest = call(self, '_measurePlateRest');
    return { self, root, scene, hips };
  };
  const { self, root, scene, hips } = rig();
  const crown = self._plateRest.crown, height = self._plateRest.height;
  check('setUserScale: the body (vrm.scene) wears it; the root stays 1 — plates stay screen-sized', call(self, 'setUserScale', 1.5) === true
    && near(scene.scale.y, 1.5) && near(root.scale.y, 1), `scene ${scene.scale.y} root ${root.scale.y}`);
  check('...clamped', (call(self, 'setUserScale', 9), near(scene.scale.y, 2)) && (call(self, 'setUserScale', 0.1), near(scene.scale.y, 0.5)), `${scene.scale.y}`);
  call(self, 'setUserScale', 1.5);
  call(self, 'setPuppetScale', 1 / 1.1);
  check('the VR fit composes under the size: vrm.scene = u / k', near(scene.scale.y, 1.5 / 1.1, 1e-12) && near(call(self, 'bodyScale'), 1.5 / 1.1, 1e-12), `${scene.scale.y}`);
  call(self, 'setPuppetScale', 1);
  check('...and leaving VR (fit back to 1) keeps the size', near(scene.scale.y, 1.5), `${scene.scale.y}`);
  self._plateOff = null; call(self, '_placePlate', 1 / 60);
  const { plateGap } = await import('../client/lib/plateanchor.js');
  check('150%: the plate hangs at crown × 1.5 + gap(height × 1.5)', near(self.label.position.y, crown * 1.5 + plateGap(height * 1.5), 1e-6), `${self.label.position.y} vs ${crown * 1.5 + plateGap(height * 1.5)}`);
  call(self, 'setPlateY', 0.3);
  self._plateOff = null; call(self, '_placePlate', 1 / 60);
  check('...raised 30 cm (authored) = 45 cm at 150%', near(self.label.position.y, crown * 1.5 + plateGap(height * 1.5) + 0.45, 1e-6), `${self.label.position.y}`);
  check('setPlateY clamps (+0.8 m)', (call(self, 'setPlateY', 5), self.plateY === 0.8), `${self.plateY}`);
  call(self, 'setPlateY', 0.3);
  // lying, still lifted: the whole body flat along +x
  hips.position.set(0, 0.15, 0); hips.rotation.z = -Math.PI / 2;
  self._plateOff = null; call(self, '_placePlate', 1 / 60);
  const headW = new THREE.Vector3(); self.vrm.humanoid.getRawBoneNode('head').getWorldPosition(headW);
  check('lying at 150%, lifted: over the head at head + span·1.5 + gap + 0.45', near(self.label.position.x, headW.x, 1e-6)
    && near(self.label.position.y, headW.y + self._plateRest.headSpan * 1.5 + plateGap(height * 1.5) + 0.45, 1e-6), `${J(self.label.position)} head ${J(headW)}`);
  // the own-body clearance (review 09-30 S6): a slider drag and every remote's size/lift change invalidate it; the skinned
  // sample must be taken once per body, not on each change, at ≤ 4000 vertices a mesh — and stay exact at the new size
  {
    const { self: b, scene: sc } = rig();
    const dense = new THREE.Mesh(new THREE.BufferGeometry()); dense.position.y = 1.2; sc.add(dense);
    const n = 4001, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = Math.cos(i) * 0.25; arr[i * 3 + 1] = (i / n) * 0.5; arr[i * 3 + 2] = Math.sin(i) * 0.25; }
    dense.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    let reads = 0; const gvp = dense.getVertexPosition.bind(dense); dense.getVertexPosition = (i: number, t: any) => { reads++; return gvp(i, t); };
    const placeAndMeasure = () => { b._plateOff = null; call(b, '_placePlate', 1 / 60); b._ownClear = null; return call(b, '_measureOwnClear'); };
    placeAndMeasure();
    check('the skinned sample is capped at 4000 vertices a mesh (4001 → ≤ 4000 reads)', reads > 0 && reads <= 4000, `${reads}`);
    reads = 0;
    const atScale: number[] = [];
    for (const u of [1.1, 1.2, 1.3, 1.4, 1.5]) { call(b, 'setUserScale', u); atScale.push(placeAndMeasure()); }
    // the reference, computed here by brute force (every vertex, so it differs from the ≤4000 sample by under 1 mm here): each skinned into the root's frame, around the plate's column
    const { reachAbove, ownClearance, CLEAR_MIN, CLEAR_MAX } = await import('../client/lib/platesize.js');
    const brute = () => {
      const inv = new THREE.Matrix4().copy(b.root.matrixWorld).invert(), v = new THREE.Vector3(), xyz: number[] = [];
      b.vrm.scene.traverse((o: any) => { const pos = o.isMesh ? o.geometry?.attributes?.position : null; if (!pos) return;
        for (let i = 0; i < pos.count; i++) { THREE.Mesh.prototype.getVertexPosition.call(o, i, v).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
          xyz.push(v.x - b.label.position.x, v.y, v.z - b.label.position.z); } });
      return ownClearance(reachAbove(xyz, b.label.position.y));
    };
    const at15 = brute();
    call(b, 'setPlateY', -0.2); const lowered = placeAndMeasure(), atLift = brute();
    check('slider ticks and lift changes re-measure without re-skinning the body', reads === 0, `${reads} vertex reads over 6 changes`);
    const inside = (c: number) => c > CLEAR_MIN + 1e-3 && c < CLEAR_MAX - 1e-3;
    check('...and the re-projected clearance equals a brute-force one, at 150% and with a lift', near(atScale[4], at15, 1e-3) && near(lowered, atLift, 1e-3),
      `${atScale[4]} vs ${at15}; ${lowered} vs ${atLift}`);
    check('...on clearances the clamps did not decide (the comparison has a subject)', inside(at15) && inside(atLift), `${at15} ${atLift}`);
    check('...which the size actually moved (the comparison has a subject)', !near(atScale[0], atScale[4], 1e-3), J(atScale));
  }
  // A held reach's limb lengths are measured in the ROOT frame (reachbone.js measureChain), where vrm.scene's size
  // shows: a live resize — the size slider, or the VR fit changing on entering VR — must re-measure them, or the
  // solver keeps bending the old arm (and disagrees with the text tier, whose stand-in re-measures: physics.ts).
  {
    const { rigMath } = await import('../shared/rig.js');
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const P: any = { hips: V(0, 1, 0), spine: V(0, 1.2, 0), chest: V(0, 1.4, 0), neck: V(0, 1.5, 0), head: V(0, 1.7, 0) };
    for (const [s, x] of [['left', 1], ['right', -1]] as const) {
      Object.assign(P, { [s + 'UpperArm']: V(.2 * x, 1.5, 0), [s + 'LowerArm']: V(.5 * x, 1.5, 0), [s + 'Hand']: V(.8 * x, 1.5, 0),
        [s + 'UpperLeg']: V(.1 * x, .9, 0), [s + 'LowerLeg']: V(.1 * x, .5, 0), [s + 'Foot']: V(.1 * x, .1, .1) });
    }
    const stand: any = rigMath(THREE).makeAvatar(P);
    const body: any = Object.assign(Object.create(Avatar.prototype), { root: stand.root, userScale: 1, _puppet: 1,
      vrm: { scene: stand.pivot, humanoid: { ...stand.vrm.humanoid, update() {} } } });
    const arm = () => { const c = call(body, '_measureChain', 'rightHand'); return c ? c.L1 + c.L2 : NaN; };
    const a1 = arm();
    call(body, 'setUserScale', 2); const a2 = arm();
    call(body, 'setPuppetScale', 0.5); const a3 = arm();
    call(body, 'setUserScale', 1); call(body, 'setPuppetScale', 1); const a4 = arm();
    check('a held reach re-measures its arm when the body is resized (0.6 → 1.2 at 200% → 0.6 under a ½ VR fit → 0.6)',
      near(a1, .6, 1e-9) && near(a2, 1.2, 1e-9) && near(a3, .6, 1e-9) && near(a4, .6, 1e-9), J({ a1, a2, a3, a4 }));
  }
  // a pooled VRM that comes back still wearing its last owner's size is reset by the constructor
  const src = String(Avatar.prototype.constructor);
  check('the constructor writes a fresh size before measuring (a pooled VRM carries no stale scale)', /vrm\.scene\.scale\.setScalar\(1\)[\s\S]*_measurePlateRest\(\)/.test(src));
}

console.log('remotes.js (the receiver):');
{
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
  if (!(globalThis as any).document) GlobalRegistrator.register();
  const stubs = await import('./remotes-stubs.mjs');
  const { mock } = await import('bun:test');
  for (const m of ['core', 'assets', 'world', 'chat', 'fp_view', 'boot', 'ui', 'avatar', 'xrbody']) mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
  const R: any = await import('../client/lib/remotes.js');
  const got: any[] = [];
  const av = { setUserScale: (u: number) => got.push(['scale', u]), setPlateY: (y: number) => got.push(['plateY', y]) };
  const r: any = { avatar: av };
  fn(R, 'applyRemoteBody')(r, { p: [0, 0, 0], scale: 5, plateY: 0.3 });
  check('a remote sample lands on their Avatar, clamped', J(got) === J([['scale', 2], ['plateY', 0.3]]), J(got));
  got.length = 0;
  fn(R, 'applyRemoteBody')(r, { p: [0, 0, 0] });
  check('...and a sample without the fields puts them back to 1 / 0', J(got) === J([['scale', 1], ['plateY', 0]]), J(got));
  const src = await Bun.file(here('../client/lib/remotes.js')).text();
  check('both presence paths apply it (the walking one and the seated one)', (src.match(/applyRemoteBody\(r, s\)/g) ?? []).length >= 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
