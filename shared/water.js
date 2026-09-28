// Renderer-independent water queries. Metres, Y-up; parameters come from comp data.
export const MAX_WATER = 4, MAX_AIR = 16, MAX_WAVES = 8;
const finite = (x, d) => Number.isFinite(x) ? x : d;
export function vector(v, fallback = [0, 0, 0]) {
  return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? [...v] : [...fallback];
}
export function waterParams(data = {}) {
  const size = vector(data.size, [200, 200, 200]).map(x => Math.max(.01, Math.min(100000, Math.abs(x))));
  return { center: vector(data.center), size,
    absorption: vector(data.absorption, [.16, .055, .025]).map(x => Math.max(0, x)),
    scatter: vector(data.scatter, [.015, .12, .18]).map(x => Math.max(0, x)),
    speed: Math.max(.1, Math.min(20, finite(data.speed, 2.4))),
    waves: (Array.isArray(data.waves) ? data.waves : []).slice(0, MAX_WAVES).map(w => {
      const dir = vector([w?.direction?.[0], 0, w?.direction?.[1]], [1, 0, 0]);
      const len = Math.hypot(dir[0], dir[2]) || 1;
      return { amplitude: Math.max(0, Math.min(5, finite(w?.amplitude, 0))),
        wavelength: Math.max(.1, finite(w?.wavelength, 10)),
        direction: [dir[0] / len, dir[2] / len], phase: finite(w?.phase, 0) };
    }) };
}
export function waveHeight(water, x, z, time) {
  let height = water.top;
  for (const w of water.waves) {
    const k = Math.PI * 2 / w.wavelength;
    height += w.amplitude * Math.sin(k * (w.direction[0] * x + w.direction[1] * z) - Math.sqrt(9.81 * k) * time + w.phase);
  }
  return height;
}
export function inBox(p, box) {
  const q = box.toLocal ? box.toLocal(p) : p.map((v, i) => v - box.center[i]);
  return q.every((v, i) => Math.abs(v) <= box.size[i] / 2);
}
export function mediumAt(p, waters, airs, time = 0) {
  if (airs.some(b => inBox(p, b))) return null;
  // Last authored volume wins where volumes overlap; deterministic ordering by id in adapter.
  for (let i = waters.length - 1; i >= 0; --i) {
    const w = waters[i];
    if (Math.abs(p[0] - w.center[0]) <= w.size[0] / 2 && Math.abs(p[2] - w.center[2]) <= w.size[2] / 2 &&
        p[1] >= w.bottom && p[1] <= waveHeight(w, p[0], p[2], time)) return w;
  }
  return null;
}
// Slab intersection on the finite camera-to-fragment segment. Parallel rays and
// zero length rays need no epsilon displacement, including on box boundaries.
export function boxInterval(a, b, box) {
  const local = p => box.toLocal ? box.toLocal(p) : p.map((v, i) => v - box.center[i]);
  a = local(a); b = local(b);
  let lo = 0, hi = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i], h = box.size[i] / 2;
    if (Math.abs(d) < 1e-10) { if (Math.abs(a[i]) > h) return null; }
    else { const x = (-h-a[i])/d, y = (h-a[i])/d; lo = Math.max(lo, Math.min(x,y)); hi = Math.min(hi, Math.max(x,y)); }
  }
  return hi > lo ? [lo,hi] : null;
}
export function unionLength(intervals) {
  let length = 0, end = -Infinity;
  for (const [a,b] of intervals.filter(Boolean).sort((a,b) => a[0]-b[0])) {
    length += Math.max(0, b-Math.max(a,end)); end = Math.max(end,b);
  }
  return length;
}
export function waterPath(a, b, water, airs = []) {
  const wet = boxInterval(a,b,water);
  if (!wet) return 0;
  const dry = airs.map(box => boxInterval(a,b,box)).filter(Boolean)
    .map(([lo,hi]) => [Math.max(lo,wet[0]), Math.min(hi,wet[1])]).filter(([lo,hi]) => hi>lo);
  return Math.max(0,wet[1]-wet[0]-unionLength(dry)) * Math.hypot(...b.map((v,i) => v-a[i]));
}
// Substepped by the controller for collision. Idle swimmers float up gently;
// descending releases the surface latch, and releasing ascent never jumps out.
export function swimStep(pos, velocity, input, water, dt, time) {
  dt = Math.max(0, Math.min(.1, finite(dt, 0)));
  const speed = water.speed * (input.fast ? 1.65 : 1);
  const dir = vector(input.direction), length = Math.max(1, Math.hypot(...dir));
  const target = dir.map(v => v / length * speed);
  if (!input.dive && !input.rise) target[1] += .16;
  const blend = 1-Math.exp(-5*dt);
  const vel = velocity.map((v,i) => v+(target[i]-v)*blend);
  const next = pos.map((v,i) => v+vel[i]*dt);
  const surface = waveHeight(water,next[0],next[2],time)-1.1;
  let mode = 'swim';
  if (!input.dive && next[1] >= surface-.12) { next[1] = surface; vel[1] = 0; mode = 'surface'; }
  return { pos:next, velocity:vel, mode };
}
