// edge — the world's bounds, drawn (R 10-11 00:07: "ball rolled out of world bounds and now I can't touch it"; 23:01: "the
// actual world boundary should visually match the world construct"). @world.bounds is the box the authority refuses moves
// past (controller keepInBounds stops the body there); this draws that box as a faint fence: a line ring at the floor and
// at FENCE_H, corner posts, and a translucent wall. Presentation only; nothing reads it back. No bounds: nothing drawn.
import { THREE, scene } from './core.js';
import { replica } from './net.js';
import { bus } from './base.js';
import { onWorldChange } from './state.js';
import { pushHostHook } from './autohooks.js';

const FENCE_H = 2.5, COLOR = 0x7fb8ff;
let group = null, key = '', shown = null;

const boundsNow = () => { const B = replica.st?.entities?.['@world']?.c?.bounds; const ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && ok(B.min) && ok(B.max) ? B : null; };

function build(B) {
  const g = new THREE.Group(); g.name = 'world-edge'; g.userData.noPick = true;
  const [x0, , z0] = B.min, [x1, , z1] = B.max; const y0 = Math.max(B.min[1], -0.01), y1 = y0 + FENCE_H;
  const ring = (y) => [[x0, y, z0], [x1, y, z0], [x1, y, z0], [x1, y, z1], [x1, y, z1], [x0, y, z1], [x0, y, z1], [x0, y, z0]];
  const posts = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].flatMap(([x, z]) => [[x, y0, z], [x, y1, z]]);
  const pts = [...ring(y0), ...ring(y1), ...posts].flat();
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLOR, transparent: true, opacity: 0.55 })));
  // the wall: four quads, drawn from both sides, never writing depth (things beyond it still show through)
  const w = new THREE.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
  const quad = (a, b) => { const q = new THREE.BufferGeometry();
    q.setAttribute('position', new THREE.Float32BufferAttribute([a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]], 3)); return new THREE.Mesh(q, w); };
  g.add(quad([x0, z0], [x1, z0]), quad([x1, z0], [x1, z1]), quad([x1, z1], [x0, z1]), quad([x0, z1], [x0, z0]));
  for (const m of g.children) { m.raycast = () => {}; m.frustumCulled = false; }
  return g;
}

function refresh() {
  const B = boundsNow(); const k = B ? JSON.stringify([B.min, B.max]) : '';
  if (k === key) return;
  // the key moves only once the scene has: a throw in between (the WebGPU renderer's dispose has thrown on other
  // geometry) would otherwise leave a stale fence that never refreshes
  const old = group; group = null; shown = null;
  if (old) { scene.remove(old); try { old.traverse((o) => { o.geometry?.dispose?.(); }); } catch (err) { console.warn('[edge] dispose', err); } }
  if (B && wanted) { group = build(B); scene.add(group); shown = [B.min.slice(), B.max.slice()]; }
  key = k;
}
// off unless asked (R 10-11 23:04: "not sure how I feel about the walls… looks a bit clunky"): the rules already keep things in
// (placement past the edge is refused, what rests or flies out goes home), so the fence is for sizing a world, not for living in it
let wanted = (() => { try { return localStorage.getItem('ew-world-edge') === '1'; } catch { return false; } })();
export const worldEdgeWanted = () => wanted;
export function setWorldEdgeShown(on) { wanted = !!on; try { localStorage.setItem('ew-world-edge', on ? '1' : '0'); } catch { /* private mode */ } key = ''; refresh(); }

// bounds is a plain @world component: the view's 'world' events cover sky/terrain/grass only, so listen to every folded
// batch too (refresh is a key compare; it rebuilds only when the box changed)
export function initWorldEdge() { refresh(); onWorldChange(refresh); bus.on('log-applied', refresh); bus.on('cut-adopted', refresh); pushHostHook(refresh); }   // and once a frame: six numbers compared, never missed
/** Probe surface: the drawn fence's box, or null. */
export const worldEdgeShown = () => ({ box: shown, bounds: boundsNow(), key });   // an object always: a probe's eval of a bare null reads as nothing
