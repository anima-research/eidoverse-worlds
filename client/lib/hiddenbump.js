// hiddenbump — what my body bumps that I hid with the eye (R 10-12 17:33). A thing hidden in my view is not drawn and not
// pickable, but it stays SOLID: my body still collides with it. So walking into it is never a mystery: while my body
// touches one, a hazy outline of its collider fades in with a crossed-out eye over it ("you hid this"), and it fades out
// after the contact ends. Mine only: nothing here is sent or logged, and its sound is not touched.
import { THREE, scene } from './core.js';
import { stroke as strokeIcon } from './icons.js';
import { frameOf } from './colliders.js';
import { outOfMyView } from './myview.js';

export const FADE_IN = 0.25, HOLD = 0.6, FADE_OUT = 0.8;   // seconds
const TINT = 0xb08ad8;   // edittheme's `mine`: the colour of "only you"

/** One step of a mark's opacity: touching, it rises to 1 over FADE_IN; untouched, it holds HOLD s, then falls over FADE_OUT. */
export function stepMark(m, touching, dt) {
  if (touching) { m.since = 0; m.a = Math.min(1, m.a + dt / FADE_IN); }
  else { m.since += dt; if (m.since > HOLD) m.a = Math.max(0, m.a - dt / FADE_OUT); }
  return m.a;
}

let eyeTex = null;
function eyeTexture() {
  if (eyeTex) return eyeTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  g.strokeStyle = 'rgba(10,8,16,0.85)'; strokeIcon(g, 'eyeOff', 96, 14);   // a dark halo, so it reads on sky and on snow
  g.strokeStyle = '#ffffff'; strokeIcon(g, 'eyeOff', 96, 7);
  eyeTex = new THREE.CanvasTexture(c); eyeTex.colorSpace = THREE.SRGBColorSpace;
  return eyeTex;
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);
const EDGES = new THREE.EdgesGeometry(UNIT);
function makeMark() {
  const group = new THREE.Group(); group.name = 'hidden-bump'; group.renderOrder = 999;
  const shell = new THREE.Group(); group.add(shell);
  const lines = [1, 1.04, 1.08].map((k, i) => {   // three nested edges, each fainter: a haze, not a wireframe
    const l = new THREE.LineSegments(EDGES, new THREE.LineBasicMaterial({ color: TINT, transparent: true, opacity: 0, depthWrite: false }));
    l.scale.setScalar(k); l.userData.peak = [0.85, 0.4, 0.18][i]; shell.add(l); return l; });
  const fill = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial({ color: TINT, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  fill.userData.peak = 0.07; shell.add(fill);
  const eye = new THREE.Sprite(new THREE.SpriteMaterial({ map: eyeTexture(), transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
  eye.scale.setScalar(0.4); eye.userData.peak = 1; eye.renderOrder = 1000; group.add(eye);
  scene.add(group);
  return { a: 0, since: 0, group, shell, eye, parts: [...lines, fill, eye] };
}
function place(m, entry) {
  const { yaw, box, pillar } = frameOf(entry); const o = entry.obj, s = o.scale?.x || 1;
  const min = box.min.clone(), max = box.max.clone();
  if (pillar) { const cx = (min.x + max.x) / 2, cz = (min.z + max.z) / 2; min.x = cx - 0.25; max.x = cx + 0.25; min.z = cz - 0.25; max.z = cz + 0.25; }
  m.group.position.copy(o.position); m.group.rotation.set(0, yaw, 0);
  m.shell.position.set((min.x + max.x) / 2 * s, (min.y + max.y) / 2 * s, (min.z + max.z) / 2 * s);
  m.shell.scale.set(Math.max(0.01, (max.x - min.x) * s), Math.max(0.01, (max.y - min.y) * s), Math.max(0.01, (max.z - min.z) * s));
  m.eye.position.set(m.shell.position.x, max.y * s + 0.3, m.shell.position.z);
}

const marks = new Map();   // collider entry → its mark
/** Each frame, after my body's collision: `touched` is colliders.lastContacts(). */
export function bumpTick(touched, dt) {
  const now = new Set();
  for (const e of touched ?? []) if (e?.obj && outOfMyView(e.obj, { eyeOnly: true })) now.add(e);
  for (const e of now) if (!marks.has(e)) marks.set(e, makeMark());
  for (const [e, m] of marks) {
    const touching = now.has(e) && !!outOfMyView(e.obj, { eyeOnly: true });
    const a = stepMark(m, touching, dt);
    if (a <= 0 && !touching) { scene.remove(m.group); for (const p of m.parts) p.material.dispose(); marks.delete(e); continue; }
    place(m, e);
    for (const p of m.parts) p.material.opacity = a * p.userData.peak;
  }
}
/** Probe window: each mark's thing and opacity. */
export const bumpMarks = () => [...marks].map(([e, m]) => ({ id: e.obj?.userData?.entityId ?? null, a: m.a, eye: m.eye.material.opacity }));
