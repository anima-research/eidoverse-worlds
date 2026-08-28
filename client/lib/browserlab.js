// browserlab — the same 25 seconds, in two browsers, on one machine (#42).
//
// The Firefox/Safari-vs-Chrome question has been argued from FPS numbers taken
// at different places, in different worlds, with different people standing
// around. Those numbers cannot settle it: at commons scale the population in
// frustum moves the frame cost more than the browser does (4.6M triangles and
// 41 skinned VRMs collapsed CHROME on an RTX 2080 SUPER), so an uncontrolled
// pair of readings compares two scenes, not two renderers.
//
// This is the controlled version. One machine, one account, one world, one
// EXACT camera pose (controller.setPhotoCamera — the receipt carries it so the
// second browser stands where the first stood), UI hidden, three foliage arms
// in a fixed order, raw rAF deltas rather than a smoothed FPS counter.
//
//   await EW.browserlab()                          // 3 arms × 25s here
//   await EW.browserlab({ secs: 30 })
//   await EW.browserlab({ camera: { pos: [...], yaw: …, pitch: …, fov: … } })
//   await EW.browserlab({ label: 'firefox-143' })  // names the run in the receipt
//
// It prints a markdown block ready to paste into docs/browser-perf-receipt.md
// and leaves the whole object on EW.__lab for `copy(EW.__lab)`.
//
// WHY p50/p95 AND NOT FPS: a browser that renders 60 frames in a second, one of
// which took 300ms, reports "60fps" and feels broken. perf.ms is an EWMA built
// for a HUD, and perf.fps is a 1Hz window — neither can answer "how bad is the
// bad frame". Percentiles over raw deltas can, and the tail is where the
// non-Chromium reports actually live ("stutter", "input lag", not "low FPS").
//
// WHAT IT DOES NOT DO: nothing here changes shared world facts. No verb is
// sent, nothing is persisted, every toggle is browser-local and restored in a
// finally block — including on a throw mid-arm. It measures; it does not tune.

import { renderer, scene, camera, THREE } from './core.js';
import { perf } from './perf.js';
import { governorDebug } from './governor.js';
import { getGrassField, getGrassDensity, grassTiles } from './terrain.js';
import { freezePushers } from './flora.js';
import { remotes } from './remotes.js';
import { photoMode, togglePhotoMode, setPhotoCamera, getPhotoCamera } from './controller.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const r2 = (n) => +Number(n).toFixed(2);

// ---- what the machine is ---------------------------------------------------

/** Adapter/backend identity, best effort across three renderer backends and
 *  three browsers. Anything absent is reported as absent, never guessed —
 *  "unknown backend" is a finding, not a gap to paper over. */
async function environment() {
  const backend = renderer.backend;
  const dev = backend?.device ?? null;
  let adapter = null;
  try {
    // three keeps the adapter it picked; navigator.gpu is the fallback probe
    // when it does not (Firefox's WebGPU shipped later than three's cache).
    const a = backend?.adapter ?? (navigator.gpu ? await navigator.gpu.requestAdapter() : null);
    if (a) {
      const info = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
      adapter = info
        ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
        : { note: 'adapter present, no info surface' };
      adapter.isFallback = a.isFallbackAdapter ?? null;
    }
  } catch (e) { adapter = { error: String(e).slice(0, 200) }; }

  const size = renderer.getDrawingBufferSize?.(new THREE.Vector2()) ?? null;
  const g = governorDebug();
  return {
    ua: navigator.userAgent,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null,
    // "which renderer am I actually in" — the single most misreported line in
    // every field report so far.
    backend: backend?.constructor?.name ?? 'unknown',
    isWebGPU: !!renderer.isWebGPURenderer,
    hasNavigatorGpu: !!navigator.gpu,
    adapter,
    deviceLimits: dev?.limits ? { maxTextureDimension2D: dev.limits.maxTextureDimension2D,
      maxBufferSize: dev.limits.maxBufferSize, maxBindGroups: dev.limits.maxBindGroups } : null,
    devicePixelRatio: window.devicePixelRatio,
    rendererPixelRatio: renderer.getPixelRatio?.() ?? null,
    drawingBuffer: size ? [size.x, size.y] : null,
    viewport: [innerWidth, innerHeight],
    // the governor's dial IS the quality tier — record it, because a browser
    // that quietly shed pixels is not slower, it is showing you less.
    renderScale: g.renderScale, casterBudget: g.casterBudget, slotCap: g.slotCap,
    emitters: g.emitters, grassDensity: g.grass, detailShed: g.detailShed,
    refreshHint: null,   // filled from the measured cadence below
  };
}

/** What is actually in front of the camera. A frame-time delta is only a
 *  browser delta if these match between the two runs. */
function sceneCensus() {
  let skinned = 0, meshes = 0, lights = 0, casters = 0;
  scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned++;
    else if (o.isMesh) meshes++;
    if (o.isLight) { lights++; if (o.castShadow) casters++; }
  });
  const strokes = grassTiles().strokes ?? [];
  return {
    people: remotes.size,
    skinnedMeshes: skinned, meshes, lights, shadowCasters: casters,
    drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
    grassStrokes: strokes.map((s) => ({ stroke: s.stroke, mode: s.mode, drawn: s.drawn, planted: s.planted,
      tiles: s.tiles, visible: s.visible, lodTiles: s.lodTiles })),
    grassDrawn: strokes.reduce((n, s) => n + (s.drawn ?? 0), 0),
  };
}

// ---- what went wrong while we watched --------------------------------------

/** Console errors/warnings and GPU context loss, for the duration of a run.
 *  The pre-reload Chrome specimen on this issue was five repeats of one
 *  destroyed-ShadowDepthTexture message — the kind of thing that never reaches
 *  a receipt unless something is holding the pen. */
function watchTrouble() {
  const seen = new Map();   // message → count
  const note = (kind, args) => {
    const line = `${kind}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`.slice(0, 300);
    seen.set(line, (seen.get(line) ?? 0) + 1);
  };
  const realError = console.error, realWarn = console.warn;
  console.error = (...a) => { note('error', a); realError.apply(console, a); };
  console.warn = (...a) => { note('warn', a); realWarn.apply(console, a); };

  const contextEvents = [];
  const cvs = renderer.domElement;
  const onLost = (e) => { contextEvents.push({ type: e.type, at: r2(performance.now()) }); };
  cvs?.addEventListener('webglcontextlost', onLost);
  cvs?.addEventListener('webglcontextrestored', onLost);
  // WebGPU announces device loss through a promise, not an event.
  renderer.backend?.device?.lost?.then?.((info) => {
    contextEvents.push({ type: 'webgpu-device-lost', reason: info?.reason ?? null,
      message: String(info?.message ?? '').slice(0, 200), at: r2(performance.now()) });
  }).catch?.(() => {});

  return {
    stop() {
      console.error = realError; console.warn = realWarn;
      cvs?.removeEventListener('webglcontextlost', onLost);
      cvs?.removeEventListener('webglcontextrestored', onLost);
      return {
        contextEvents,
        messages: [...seen].map(([line, count]) => ({ count, line })).sort((a, b) => b.count - a.count).slice(0, 12),
      };
    },
  };
}

// ---- the measurement --------------------------------------------------------

/** Raw rAF deltas for `secs`, after a settle window. Returns the distribution,
 *  not an average: the tail is the complaint. */
async function measure(secs, settleMs) {
  await sleep(settleMs);
  const deltas = [];
  let last = performance.now();
  const t0 = last;
  await new Promise((done) => {
    const tick = (now) => {
      const d = now - last; last = now;
      if (d > 0 && d < 5000) deltas.push(d);
      if (now - t0 >= secs * 1000) return done();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const sorted = [...deltas].sort((a, b) => a - b);
  const mean = deltas.reduce((s, d) => s + d, 0) / (deltas.length || 1);
  return {
    frames: deltas.length,
    seconds: r2((last - t0) / 1000),
    p50: r2(q(sorted, 0.50)), p95: r2(q(sorted, 0.95)), p99: r2(q(sorted, 0.99)),
    min: r2(sorted[0] ?? 0), max: r2(sorted[sorted.length - 1] ?? 0), mean: r2(mean),
    // fps FROM the median frame, so it cannot be inflated by a burst
    fpsFromP50: r2(1000 / (q(sorted, 0.50) || 1)),
    // >40ms is perf.js's definition of a real hitch (beyond vsync pacing);
    // >100ms is what a human calls a freeze.
    over40ms: deltas.filter((d) => d > 40).length,
    over100ms: deltas.filter((d) => d > 100).length,
    // the HUD's own view, for cross-checking against a screenshot
    hud: { fps: perf.fps, ms: r2(perf.ms), worst: perf.worst, doubled: perf.doubled, spikes: perf.spikes },
  };
}

/** Is this distribution a renderer, or a metronome?
 *
 *  A renderer under load SPREADS: p50 below p95 below p99, and a max well
 *  above all three, because real work varies frame to frame. A backgrounded or
 *  fully-occluded tab does not render at all — rAF arrives on a fixed timer and
 *  every percentile lands on the same number, classically 1000ms.
 *
 *  This is not hypothetical. The first Chrome run of this harness returned
 *  `off: p50 1000.06, p95 1000.11, p99 1000.11` and would have been published
 *  as "hiding foliage made it 60× slower". document.hidden was FALSE the whole
 *  time — visibility is not the only way a tab stops being drawn — so the
 *  distribution has to be the thing that gives it away. */
function throttleVerdict(m) {
  if (m.p50 < 200) return null;                    // nothing this slow is a metronome
  const spread = m.p50 > 0 ? (m.p99 - m.p50) / m.p50 : 1;
  if (spread >= 0.02) return null;                 // real variance: believe it
  return `cadence lock at ${m.p50}ms — p50, p95 and p99 within ${(spread * 100).toFixed(2)}% of each other. `
    + 'That is a background/occlusion throttle handing out timer ticks, not a frame time.';
}

// ---- the foliage arms -------------------------------------------------------
//
// full   → everything on, as the world ships
// static → the meadow is DRAWN but stops moving: the shader's pusher
//          displacement early-outs and every auto-ticked system (wind, gust,
//          billboards, tile ticks) is unhooked. Same pixels, no animation.
// off    → the meadow is not drawn at all. The ceiling on what foliage costs.
//
// Off/static/full is Mica's discriminator for #42 and the semantics task 3
// proposes to expose as a viewer-local eye; measuring them here is what tells
// us whether such a control would even help a Firefox visitor.

// 🔴 RESOLVE THE FIELD LATE, EVERY TIME. A meadow is built asynchronously —
// the flora module is fetched, the species maps are primed, then tiles are
// planted — so `getGrassField()` at harness start can be null in a world that
// is about to have 86,000 blades in it. Snapshotting it once produced a run
// where "off" hid nothing, "static" froze an auto-list that was still empty,
// and restore() put the empty list back: three arms, one scene, a receipt that
// said foliage was free.
function armControls() {
  let saved = null;   // captured the first time we actually see a field

  const field = () => getGrassField();
  const meshes = () => {
    const f = field();
    if (!f) return [];
    return [f.mesh, ...(f._strokes ?? []).map((s) => s.mesh)].filter(Boolean);
  };
  const capture = () => {
    if (saved) return saved;
    const autos = globalThis._autoParticleSystems;
    saved = { autos, autoList: autos ? [...autos] : null,
      visible: new Map(meshes().map((m) => [m, m.visible])) };
    return saved;
  };

  return {
    /** Is there a meadow to toggle RIGHT NOW? Asked per arm, not once. */
    get ready() { return !!field()?.mesh; },
    apply(arm) {
      this.restore();
      capture();
      if (arm === 'static') {
        freezePushers(true);
        if (saved.autos) saved.autos.length = 0;          // wind, gust, billboards, tile ticks
      } else if (arm === 'off') {
        for (const m of meshes()) m.visible = false;
      }
    },
    restore() {
      freezePushers(false);
      if (saved?.autos && saved.autoList && saved.autos.length !== saved.autoList.length) {
        saved.autos.length = 0; saved.autos.push(...saved.autoList);
      }
      if (saved) for (const [m, v] of saved.visible) m.visible = v;
    },
  };
}

/** Blades actually drawn right now — the one number the arms are supposed to
 *  move, and the check that each arm did what it says. Counts only strokes
 *  whose mesh is VISIBLE: grassTiles() reports planted-and-tiled truth, which
 *  does not change when a mesh is hidden, so using it raw made the "off" arm
 *  claim it was still drawing 85,910 blades. */
function bladesDrawn() {
  const f = getGrassField();
  if (!f?.mesh?.visible) return 0;
  const byLabel = new Map((f._strokes ?? []).map((st) => [st.strokeLabel, st.mesh]));
  return (grassTiles().strokes ?? []).reduce((n, s) => {
    const mesh = byLabel.get(s.stroke);
    return n + (mesh && !mesh.visible ? 0 : (s.drawn ?? 0));
  }, 0);
}

/** A meadow is built asynchronously and the FIRST arm would otherwise measure
 *  its construction: the reference Chrome run charged foliage 46 frames over
 *  40ms that were the field being planted, not drawn. Wait for it, bounded, and
 *  record whether it ever arrived. */
async function waitForGrass(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (getGrassField()?.mesh) { await sleep(1500); return true; }   // + settle for the tiles
    await sleep(500);
  }
  return false;
}

/** Draws and triangles for ONE frame.
 *
 *  `renderer.info.render.calls` is a RUNNING TOTAL here, not a per-frame count
 *  (three's WebGPU path leaves autoReset off), so reading it straight gave
 *  4841 / 9710 / 14576 across three arms of an identical scene — a number that
 *  looks like a finding and is only a clock. Difference across one frame is the
 *  real per-frame cost. */
async function frameCost() {
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  await raf();
  const c0 = renderer.info.render.calls, t0 = renderer.info.render.triangles;
  await raf(); await raf();
  const raw = renderer.info.render.calls, rawTris = renderer.info.render.triangles;
  const dc = raw - c0, dt = rawTris - t0;
  // Cumulative counters grow by about a frame's worth per frame, so over two
  // frames the delta is COMPARABLE TO the reading itself. A per-frame counter
  // that happens to wobble by a few draws is not that, and must not be mistaken
  // for one — reporting `drawCalls: 3` for a 187k-triangle scene is worse than
  // reporting nothing.
  const cumulative = dc > c0 * 0.5;
  return cumulative
    ? { drawCalls: Math.round(dc / 2), triangles: Math.round(dt / 2), counter: 'cumulative (differenced over one frame)' }
    : { drawCalls: raw, triangles: rawTris, counter: 'per-frame (read directly)' };
}

// ---- the run ----------------------------------------------------------------

const ARMS = ['full', 'static', 'off'];

export async function browserlab({ secs = 25, settleMs = 2000, arms = ARMS, camera: pose = null,
  label = null, hideUI = true } = {}) {
  if (!(secs >= 5 && secs <= 120)) throw new Error('browserlab: secs must be 5–120');
  const bad = arms.filter((a) => !ARMS.includes(a));
  if (bad.length) throw new Error(`browserlab: unknown arm(s) ${bad.join(', ')} — use ${ARMS.join('/')}`);
  // A backgrounded tab gets no rAF at all: the measurement loop would never
  // resolve, and if it did the numbers would describe a throttle rather than a
  // renderer. Refuse rather than hang. (Learned the hard way — the first run of
  // this harness was driven from a hidden automation pane and sat there
  // forever, drawing zero frames, reporting nothing.)
  if (document.hidden) throw new Error(
    'browserlab: this tab is BACKGROUNDED — requestAnimationFrame is throttled to nothing, ' +
    'so every frame time would be a lie. Front the tab, leave it fronted, and run again.');

  // Fixed camera. Without photo mode the follow camera keeps breathing with
  // the body, and a body that idles is a body whose bones keep skinning.
  const enteredPhoto = !photoMode;
  if (pose) setPhotoCamera(pose);
  else if (!photoMode) togglePhotoMode();
  const cam = getPhotoCamera();

  // F1's job, done from here: the HUD and panels are real DOM cost, and they
  // are not the same DOM cost in two browsers.
  const hadPhotoClass = document.body.classList.contains('photo');
  if (hideUI) document.body.classList.add('photo');

  // …and if it goes to the background MID-RUN, say so on the receipt instead of
  // quietly publishing a throttled arm as a browser finding.
  let backgrounded = false;
  const onVis = () => { if (document.hidden) backgrounded = true; };
  document.addEventListener('visibilitychange', onVis);

  const controls = armControls();
  const foliageArmed = await waitForGrass(20_000);
  if (!foliageArmed) console.warn('[browserlab] no grass field after 20s — the foliage arms will change nothing here');
  const trouble = watchTrouble();
  const startedAt = new Date().toISOString();
  const env = await environment();
  const results = [];
  let census = null;

  try {
    for (const arm of arms) {
      controls.apply(arm);
      if (!controls.ready) console.warn(`[browserlab] arm "${arm}": no grass field in this world — this arm changes nothing`);
      const focusBefore = document.hasFocus();
      const m = await measure(secs, settleMs);
      const cost = await frameCost();
      if (arm === 'full') census = sceneCensus();
      const suspect = throttleVerdict(m);
      results.push({ arm, ...m, blades: bladesDrawn(), grassField: controls.ready,
        drawCalls: cost.drawCalls, triangles: cost.triangles, counter: cost.counter,
        focus: { before: focusBefore, after: document.hasFocus() }, visibility: document.visibilityState,
        ...(suspect ? { suspect } : {}) });
      console.log(`[browserlab] ${arm.padEnd(6)} p50 ${m.p50}ms  p95 ${m.p95}ms  max ${m.max}ms  (${m.frames} frames)`
        + (suspect ? `  ⚠ ${suspect}` : ''));
    }
  } finally {
    controls.restore();
    document.removeEventListener('visibilitychange', onVis);
    if (hideUI && !hadPhotoClass) document.body.classList.remove('photo');
    if (enteredPhoto && photoMode) togglePhotoMode();
  }

  const observed = trouble.stop();
  // refresh cadence, inferred from the quietest arm — names the vsync ceiling
  // the percentiles are pressed against.
  const best = results.reduce((a, b) => (a && a.p50 <= b.p50 ? a : b), null);
  env.refreshHint = best ? `${Math.round(1000 / best.p50)}Hz-ish (fastest arm p50 ${best.p50}ms)` : null;

  const lab = { issue: 42, label, startedAt, secsPerArm: secs, camera: cam, env, scene: census,
    foliage: foliageArmed ? 'present' : 'absent', arms: results, observed, tainted: null };
  const suspects = results.filter((a) => a.suspect);
  lab.tainted = backgrounded
    ? 'the tab was backgrounded during the run — frame times are throttle, not renderer'
    : suspects.length ? `${suspects.map((a) => a.arm).join(', ')}: ${suspects[0].suspect}` : null;
  if (lab.tainted) console.warn(`[browserlab] ${lab.tainted}`);
  lab.markdown = renderMarkdown(lab);   // the receipt travels WITH the data
  globalThis.EW && (globalThis.EW.__lab = lab);
  console.log(lab.markdown);
  console.log('[browserlab] full object on EW.__lab — `copy(EW.__lab)` to paste it whole');
  return lab;
}

// ---- the receipt ------------------------------------------------------------

/** A markdown block that can be pasted into the issue unedited. Anything the
 *  probe could not read prints as "not exposed" rather than vanishing. */
export function renderMarkdown(lab) {
  const e = lab.env, s = lab.scene, na = (v) => (v === null || v === undefined ? '_not exposed_' : v);
  const ad = e.adapter;
  const L = [];
  L.push(`### browserlab receipt${lab.label ? ` — ${lab.label}` : ''}`, '');
  L.push(`\`${e.ua}\``, '');
  L.push('| | |', '|---|---|');
  L.push(`| backend | \`${e.backend}\` (isWebGPURenderer ${e.isWebGPU}, navigator.gpu ${e.hasNavigatorGpu}) |`);
  L.push(`| adapter | ${ad ? `vendor \`${na(ad.vendor)}\` · arch \`${na(ad.architecture)}\` · device \`${na(ad.device)}\` · fallback ${na(ad.isFallback)}` : '_none reported_'} |`);
  L.push(`| pixel ratio | device ${e.devicePixelRatio} · renderer ${na(e.rendererPixelRatio)} · render scale ${na(e.renderScale)} |`);
  L.push(`| buffer | ${e.drawingBuffer ? e.drawingBuffer.join('×') : '_not exposed_'} (viewport ${e.viewport.join('×')}) |`);
  L.push(`| cadence | ${na(e.refreshHint)} |`);
  L.push(`| cores / memory | ${na(e.cores)} / ${e.deviceMemoryGB ? e.deviceMemoryGB + 'GB' : '_not exposed_'} |`);
  L.push(`| quality tier | casters ${na(e.casterBudget)} · light slots ${na(e.slotCap)} · emitters ${na(e.emitters)} · grass ${na(e.grassDensity)} · detail shed ${na(e.detailShed)} |`);
  if (s) L.push(`| scene | ${s.people} people · ${s.skinnedMeshes} skinned · ${s.drawCalls} draws · ${s.triangles.toLocaleString()} tris · ${s.textures} textures · ${s.grassDrawn.toLocaleString()} blades |`);
  L.push(`| camera | pos [${lab.camera.pos.join(', ')}] yaw ${lab.camera.yaw} pitch ${lab.camera.pitch} fov ${lab.camera.fov} |`);
  L.push('', `**${lab.secsPerArm}s per arm, fixed camera, UI hidden.** Frame time in ms — lower is better.`
    + (lab.foliage === 'absent' ? ' ⚠ **No grass field in this world — the arms changed nothing.**' : ''), '');
  L.push('| foliage | p50 | p95 | p99 | max | mean | fps (p50) | >40ms | >100ms | blades drawn |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const a of lab.arms) {
    L.push(`| ${a.arm}${a.suspect ? ' ⚠' : ''} | ${a.p50} | ${a.p95} | ${a.p99} | ${a.max} | ${a.mean} | ${a.fpsFromP50} | ${a.over40ms} | ${a.over100ms} | ${(a.blades ?? 0).toLocaleString()}${a.grassField === false ? ' _(no field)_' : ''} |`);
  }
  const full = lab.arms.find((a) => a.arm === 'full'), off = lab.arms.find((a) => a.arm === 'off');
  if (full && off) {
    L.push('', full.suspect || off.suspect
      ? '**Foliage cost: not computed** — one of the two arms is a throttle, and subtracting a metronome from a renderer produces a number that means nothing.'
      : `Foliage costs **${r2(full.p50 - off.p50)}ms** at the median and **${r2(full.p95 - off.p95)}ms** at p95 from this camera.`);
  }
  L.push('', `**Console during the run:** ${lab.observed.messages.length ? '' : '_clean_'}`);
  for (const m of lab.observed.messages) L.push(`- ×${m.count} \`${m.line}\``);
  L.push(`**Context loss:** ${lab.observed.contextEvents.length ? lab.observed.contextEvents.map((c) => c.type).join(', ') : '_none_'}`);
  if (lab.tainted) L.push('', `> ⚠ **TAINTED** — ${lab.tainted}. Do not quote these numbers.`);
  L.push('', '> Comparability: this receipt is only a browser delta against another',
    '> receipt with the same camera pose, the same people count, and the same',
    '> world. Check those three lines before reading the frame times.');
  return L.join('\n');
}
