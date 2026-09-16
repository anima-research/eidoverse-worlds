// WHO MAY CLAIM THE ONE CASTING SLOT (client/lib/lightrig.js attachLamps).
//
// Mica's contract, from the #193 review:
//   - emissive AVATARS may request slot 0, and their body gets cast/receive;
//   - emissive placed models/props remain ordinary inferred lights and do NOT
//     request the shadow slot.
//
// attachLamps is the GENERIC emissive seam -- realize/models.js calls it for
// every placed glowing prop, and avatar.js calls it for a body. It used to set
// `shadows: true` unconditionally, with a comment about a lamp inside a body
// that described only one of its two callers. So a lantern on the ground
// requested the casting slot exactly as hard as an avatar did.
//
// That was latent while the claim only took a FREE slot. Then 4f55321 made it a
// swap -- wanting shadows outranks not wanting it, which is what finally let
// Mythos's lamp cast at all -- and the same change let a nearer glowing PROP
// take slot 0 off the body standing next to it. This test is the red one Mica
// asked for: a closer, higher-ranked glowing prop must not be able to steal the
// slot, and must stay lit.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });
const { THREE, camera } = await import('./core-stub.mjs');
const rig = await import('../client/lib/lightrig.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

// An emissive thing attachLamps will find: glow must clear its 0.5 threshold.
function glowing(name, pos, glow = 3) {
  const g = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0.02,0,0, 0,0.02,0], 3));
  const m = new THREE.MeshBasicMaterial();
  m.emissive = new THREE.Color(1, 0.85, 0.6);
  m.emissiveIntensity = glow;
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = name;
  g.add(mesh); g.position.set(...pos); g.updateMatrixWorld(true);
  return g;
}

// The camera decides ranking (nearest wins within a tier), so put the PROP
// closer than the avatar: it outranks the body on distance and is therefore
// the hardest case for the policy.
camera.position.set(0, 1.6, 0);
const avatarObj = glowing('lampglass', [0, 1.47, -3.0]);   // a body, 3m away
const propObj   = glowing('lantern',   [0, 1.00, -0.6]);   // a prop, 0.6m away

// realize/models.js: the generic seam, no opts -- this is the live call shape
const propLamps = rig.attachLamps(propObj, 'entity:lantern-1');
// avatar.js: the only caller that claims the slot
const avatarLamps = rig.attachLamps(avatarObj, 'body:mythos:1', { shadows: true });

check('both objects produced a lamp request', propLamps.length > 0 && avatarLamps.length > 0,
  `prop ${propLamps.length}, avatar ${avatarLamps.length}`);

for (const t of [1000, 2000, 3000, 9000]) rig.updateRig(t);
const d = rig.rigDebug();
const req = (k) => d.requests.find((r) => r.key === k) || {};
const propKey = propLamps[0].key, avatarKey = avatarLamps[0].key;
const slotOf = (k) => req(k).slot;
const CAST = d.shadows.castingSlot;

console.log('SLOT POLICY — a closer glowing PROP versus an avatar');
// THE POLICY: only the avatar asked, so only the avatar may hold slot 0 --
// even though the prop is five times closer and would outrank it on distance.
check('the avatar holds the casting slot', slotOf(avatarKey) === CAST,
  `avatar on slot ${slotOf(avatarKey)}, casting slot ${CAST}`);
check('the closer prop does NOT hold it', slotOf(propKey) !== CAST,
  `prop on slot ${slotOf(propKey)} — it stole the casting slot`);
// ...and the prop is not punished for losing: it is still an ordinary light.
check('the prop is still assigned a slot', slotOf(propKey) >= 0,
  `prop slot ${slotOf(propKey)}`);
check('the prop is still LIT', (d.slotState[slotOf(propKey)] || {}).intensity > 0,
  `slot ${slotOf(propKey)} intensity ${(d.slotState[slotOf(propKey)] || {}).intensity}`);
check('the avatar is lit too', (d.slotState[CAST] || {}).intensity > 0,
  `slot ${CAST} intensity ${(d.slotState[CAST] || {}).intensity}`);
check('they do not share a slot', slotOf(propKey) !== slotOf(avatarKey));

console.log('SHADOW INTENT — reported per request');
const wants = d.shadows.wantsShadows.map((w) => w.key);
check('only the avatar wants shadows', wants.length === 1 && wants[0] === avatarKey,
  `wantsShadows = ${JSON.stringify(wants)}`);
check('and it is actually casting', d.shadows.anyCasting === true);

console.log('THE SEAM DEFAULT — shadow intent must be asked for');
// The regression guard: if the default ever flips back to true, the generic
// caller starts claiming the slot again and this goes red.
rig.releaseOwner('entity:lantern-1');
rig.releaseOwner('body:mythos:1');
const bare = rig.attachLamps(glowing('orb', [0, 1, -0.4]), 'entity:orb-2');
rig.updateRig(20000);
const d2 = rig.rigDebug();
check('a bare attachLamps() call requests NO shadows',
  d2.shadows.wantsShadows.length === 0,
  `wantsShadows = ${JSON.stringify(d2.shadows.wantsShadows.map((w) => w.key))}`);
const bareReq = d2.requests.find((r) => r.key === bare[0].key) || {};
check('...but it is still a working light',
  bareReq.slot >= 0 && (d2.slotState[bareReq.slot] || {}).intensity > 0,
  `slot ${bareReq.slot} intensity ${(d2.slotState[bareReq.slot] || {}).intensity}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
