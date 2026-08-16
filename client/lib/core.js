// core — the things every other module needs: config, renderer, scene, camera,
// the eidoverse module-host contract, and a tiny event bus.
//
// Import rule: core imports NOTHING from the rest of the client. Everything
// else may import core. That keeps the module graph acyclic at load time even
// where the runtime call graph is circular.

import * as THREE from 'three';
import * as TSL from 'three/tsl';

export { THREE, TSL };

// ------------------------------------------------------------ event bus
// Cross-cutting notifications (a verb landed, the connection changed, a toast)
// travel on this instead of through imports, which is what keeps net.js from
// having to know about the palette and vice versa.

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    for (const fn of listeners.get(evt) ?? []) {
      try { fn(payload); } catch (e) { console.error(`bus:${evt}`, e); }
    }
  },
};

// ------------------------------------------------------------ config
// One place that reads the URL and localStorage, so no module has to re-derive
// "who am I" from query params.

const params = new URLSearchParams(location.search);
export const CONFIG = {
  params,
  world: params.get('world') || 'commons',
  spectate: params.has('spectate'),
  renderer: params.has('renderer'),
  follow: params.get('follow'),
  // Door key: ?key=… once, remembered for this origin thereafter.
  token: params.get('key') || localStorage.getItem('ew-key') || '',
  name: params.get('name') || localStorage.getItem('ew-name') ||
    `guest-${Math.random().toString(36).slice(2, 6)}`,
};
if (params.get('key')) localStorage.setItem('ew-key', CONFIG.token);
localStorage.setItem('ew-name', CONFIG.name);

/** Rename in place (the front-door panel calls this before connecting). */
export function setName(name) {
  CONFIG.name = name;
  localStorage.setItem('ew-name', name);
}
export function setToken(token) {
  CONFIG.token = token;
  localStorage.setItem('ew-key', token);
}

// ------------------------------------------------------------ wgsl debug
// ?wgsldebug — surface Tint's REAL compilation diagnostics (Chrome only logs
// "invalid due to a previous error" at pipeline time; the substance lives in
// getCompilationInfo on the shader module).
if (params.has('wgsldebug') && globalThis.GPUDevice) {
  const orig = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    const mod = orig.call(this, desc);
    mod.getCompilationInfo?.().then((info) => {
      const errs = info.messages.filter((m) => m.type === 'error');
      if (!errs.length) return;
      for (const m of errs.slice(0, 3)) {
        console.error(`[wgsl] ${m.lineNum}:${m.linePos} ${m.message}`);
        const lines = desc.code.split('\n');
        console.error('[wgsl-src]\n' + lines.slice(Math.max(0, m.lineNum - 3), m.lineNum + 2)
          .map((l, i) => `${Math.max(0, m.lineNum - 3) + i + 1}: ${l}`).join('\n'));
      }
    });
    return mod;
  };
}

// ------------------------------------------------------------ renderer
export const canvas = document.createElement('canvas');
// focusable so pointer-lock re-entry works after an Esc unlock: Chrome wants
// the request to come from a focused target, and a canvas is not focusable by
// default.
canvas.tabIndex = -1;
canvas.style.outline = 'none';
document.body.prepend(canvas);

// MSAA policy (§22n measured, §22r reverted to ON): the 4×MSAA resolve at
// 2× retina costs ~4ms/frame (+10fps when dropped, drift-controlled A/B),
// but a silently-vanished AA reads as a rendering bug to anyone not holding
// the measurement — so MSAA stays the default everywhere and ?msaa=0 is the
// opt-out lever (the +10fps is one flag away; §22q bought the frames back
// for the default look). The dPR-gated auto-off waits for a real settings
// row alongside the other quality dials.
export const renderer = new THREE.WebGPURenderer({ canvas,
  antialias: CONFIG.params.get('msaa') !== '0' });
renderer.setSize(innerWidth, innerHeight);
// Spectators start a notch lower — an audience laptop's job is 30fps for an
// hour, not maximum sharpness. Adaptive scaling adjusts from here.
export const BASE_PIXEL_RATIO = Math.min(devicePixelRatio, CONFIG.spectate ? 1.5 : 2);
renderer.setPixelRatio(BASE_PIXEL_RATIO);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
await renderer.init();
// the splash watchdog (index.html) stops worrying: modules resolved and the
// GPU answered — everything past this point can report its own failures
globalThis.__ewEngineUp = true;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101828);
scene.fog = new THREE.FogExp2(0x101828, 0.018);

// The far plane has to hold the SKY, not just the scene. Skye's world-space
// sky builds a cloud dome ~3200 units out, and the ringworld package hangs its
// band 4940 up — at the old far plane of 300 the entire atmosphere was clipped
// away and the sky rendered black while the ground looked perfectly fine.
// WebGPU's reversed-Z keeps depth precision honest across this range in a way
// WebGL's would not.
export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.15, 20000);
camera.position.set(3.5, 2.6, 5.5);
camera.lookAt(0, 1, 0);

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------ base lighting
// The sky module owns these once a sky verb lands; these are the "empty world"
// defaults so a fresh world is not pitch black.
export const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x283024, 0.75);
scene.add(hemi);
export const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(14, 22, 10);
scene.add(sun);

// The stage floor, replaced the moment a terrain verb lands.
export const ground = new THREE.Mesh(
  new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2),
  new THREE.MeshStandardNodeMaterial({ color: 0x2a3440, roughness: 0.9, metalness: 0.05 }),
);
ground.receiveShadow = true;
scene.add(ground);
export const grid = new THREE.GridHelper(160, 80, 0x3a4a5a, 0x222c38);
grid.position.y = 0.01;
scene.add(grid);

// ---------------------------------------------------------- eidoverse host
// The browser as a compliant eidoverse module host: same globalThis contract as
// render_scene.mjs, so toolkit files (terrain.js, grass.js, sky_system.js, …)
// eval-load UNMODIFIED from Skye's repo via /library.

globalThis.THREE = Object.assign({}, THREE, TSL); // engine merges three/tsl into THREE
// We render FORWARD (single color target), not the engine's MRT pipeline.
// Eidoverse modules guard their G-buffer opt-outs on the presence of THREE.mrt,
// and an mrtNode in a forward pipeline emits an EMPTY fragment output struct
// that Chrome/Tint rejects. Two belts: a non-MRT host honestly declares itself
// by not exposing mrt, AND upstream now honours an explicit opt-out flag
// (EANPA_NO_MRT), which is the supported way as of the eanpa sky port.
delete globalThis.THREE.mrt;
globalThis.EANPA_NO_MRT = true;
globalThis._s = scene; globalThis._c = camera; globalThis._r = renderer;
globalThis._sun = sun; globalThis._hemi = hemi;
globalThis._sceneTime = 0;

// ------------------------------------------------------------ error routing
// Modules call report(); ui.js decides how to show it. Before the UI has
// registered a sink, errors still reach the console.
let errorSink = null;
export function setErrorSink(fn) { errorSink = fn; }

// A fault inside the frame loop reports 60 times a second. Identical messages
// are counted and re-reported on a decaying schedule instead of flooding the
// console and the toast stack — the first one is the useful one, and the
// hundredth actively hides everything else.
const seenErrors = new Map(); // key -> { n, nextAt }
export function report(context, err) {
  const message = err?.message ?? String(err ?? 'unknown error');
  const key = `${context}:${message}`;
  const now = performance.now();
  const rec = seenErrors.get(key) ?? { n: 0, nextAt: 0 };
  rec.n++;
  const suppressed = now < rec.nextAt;
  if (!suppressed) {
    // 1st, then 2s, 10s, 60s… — enough to show a fault is ongoing, not enough to drown
    rec.nextAt = now + Math.min(60000, 2000 * rec.n);
    console.error(context, err, rec.n > 1 ? `(×${rec.n})` : '');
    errorSink?.(context, rec.n > 1 ? `${message} (×${rec.n})` : message);
    bus.emit('error', { context, message, count: rec.n });
  }
  seenErrors.set(key, rec);
}
addEventListener('unhandledrejection', (e) => report('async', e.reason));
addEventListener('error', (e) => report('uncaught', e.error ?? e.message));

// ------------------------------------------------------------ misc helpers

/** Shortest signed angular difference, a → b. Used everywhere yaw is lerped. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Bounded-concurrency map — prefetch must not be serial, nor open 50 sockets. */
export async function parallelMap(items, fn, limit = 6) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

// ---- per-participant colour --------------------------------------------------
// A wall of chat all in one colour makes you read every name to follow a
// conversation. Each participant gets a stable colour instead, derived from
// their name alone — so it is the SAME colour in every client, and "the blue
// one" means the same person to everyone in the world. No assignment, no
// server state, nothing to keep in sync.
//
// A curated palette rather than hue = hash % 360: hand-picked entries are all
// legible on the dark panel and reliably distinct from each other, which a
// continuous hue wheel is not (it wanders through muddy olives and near-blacks
// at fixed lightness). Amber and mint are deliberately absent — those are the
// UI's own words for "you were mentioned" and "link/accent", and a person
// wearing them would be reading as punctuation.
const NAME_COLORS = [
  '#7cc4ff', '#ff9fc4', '#b8e06a', '#ffab6b',
  '#c4a6ff', '#6ee0d0', '#ff9a8f', '#9fb8ff',
  '#e9a6ff', '#7fe0a0', '#d8c470', '#62d3f0',
];
/** FNV-1a: cheap, and spreads short similar names (bot1/bot2) far apart. */
export function preferredColor(name) {
  let h = 0x811c9dc5;
  const s = String(name ?? '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NAME_COLORS[h % NAME_COLORS.length];
}

// Hashing alone is not enough. With twelve colours and six people in a room
// there is a ~78% chance two of them collide — and two speakers wearing one
// colour is exactly the confusion this was meant to remove. (Measured, not
// theorised: the first build put lyra and antra both on #ffab6b.)
//
// So the hash is a PREFERENCE, and the people actually present negotiate. Every
// client runs the same assignment over the same roster in the same order, so
// the answer is identical everywhere without a byte crossing the wire: sort the
// names, let each take its preferred colour, and linear-probe when it is taken.
// Whoever sorts first keeps their preference, so a colour only ever moves for
// the loser of a collision. People who have left keep the colour they had —
// their lines are still on the screen.
const claimed = new Map();   // name -> colour, sticky once assigned

/** The colour to draw `name` in, anywhere in the UI. */
export function colorFor(name) {
  const k = String(name ?? '').toLowerCase();
  return claimed.get(k) ?? preferredColor(name);
}

/** Re-negotiate colours for the people present. Call on roster changes. */
export function assignColors(names) {
  const present = [...new Set(names.map((n) => String(n ?? '').toLowerCase()))].filter(Boolean).sort();
  const used = new Set();
  for (const n of present) {
    const start = NAME_COLORS.indexOf(preferredColor(n));
    let c = NAME_COLORS[start];
    for (let k = 1; used.has(c) && k <= NAME_COLORS.length; k++) {
      c = NAME_COLORS[(start + k) % NAME_COLORS.length];
    }
    used.add(c);
    claimed.set(n, c);
  }
  return claimed;
}
