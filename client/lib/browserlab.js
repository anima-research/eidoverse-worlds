// browserlab — the same 25 seconds, in two browsers, on one machine (#42).
//
// The Firefox/Safari-vs-Chrome question has been argued from FPS numbers taken
// at different places, in different worlds, with different people standing
// around. Those numbers cannot settle it: at commons scale the population in
// frustum moves the frame cost more than the browser does (4.6M triangles and
// 41 skinned VRMs collapsed CHROME on an RTX 2080 SUPER), so an uncontrolled
// pair of readings compares two scenes, not two renderers.
//
// This is the controlled version. One machine, one world, one EXACT camera pose
// (controller.setPhotoCamera — the receipt carries it so the second browser
// stands where the first stood), UI hidden, three foliage arms in a fixed
// order, raw rAF deltas rather than a smoothed FPS counter.
//
//   await EW.browserlab()                          // 3 arms × 25s here
//   await EW.browserlab({ secs: 30 })
//   await EW.browserlab({ camera: { pos: [...], yaw: …, pitch: …, fov: … } })
//   await EW.browserlab({ label: 'firefox-154' })
//
// Everything that decides whether a number may be PUBLISHED lives in
// browserlab_core.js, which is DOM-free and unit-tested with mutations
// (tools/browserlab-core-test.ts). This file is the part that has to touch a
// browser: pin a camera, freeze a meadow, count frames, put it all back.
//
// WHY p50/p95 AND NOT FPS: a browser that renders 60 frames in a second, one of
// which took 300ms, reports "60fps" and feels broken. perf.ms is an EWMA built
// for a HUD, and perf.fps is a 1Hz window — neither can answer "how bad is the
// bad frame". Percentiles over raw deltas can, and the tail is where the
// non-Chromium reports actually live ("stutter", "input lag", not "low FPS").
//
// WHAT IT DOES NOT DO: nothing here changes shared world facts. No verb is
// sent, nothing is persisted, every toggle is browser-local and restored in a
// finally block — including on a throw mid-arm, including the console patches
// and listeners the trouble watcher installs.

import { renderer, scene, THREE } from './core.js';
import { perf } from './perf.js';
import { governorDebug, getRenderScale, setRenderScale, RENDER_SCALES } from './governor.js';
import { getGrassField, grassTiles } from './terrain.js';
import { autoHooks, releaseHook } from './autohooks.js';
import { entities } from './world.js';
import { remotes } from './remotes.js';
import { net } from './net.js';
import { photoMode, togglePhotoMode, setPhotoCamera, getPhotoCamera } from './controller.js';
import {
  classifyCounter, summarize, throttleVerdict, sceneDigest, foliageCost,
} from './browserlab_core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise((r) => requestAnimationFrame(r));
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
    renderScale: g.renderScale, renderScalePinned: g.renderScale !== 'auto', casterBudget: g.casterBudget, slotCap: g.slotCap,
    emitters: g.emitters, grassDensity: g.grass, detailShed: g.detailShed,
    refreshHint: null,
  };
}

/** The build the SERVER is serving, from its own /version route. The driver
 *  adds a working-tree digest on the node side; between them a receipt names
 *  the code it came from, instead of being authenticated by having been
 *  committed afterwards. */
async function serverBuild() {
  try {
    const r = await fetch('/version', { cache: 'no-store' });
    if (!r.ok) return { error: `/version ${r.status}` };
    const v = await r.json();
    return { sha: v.sha ?? null, dirty: v.dirty ?? null, commitTime: v.commitTime ?? null, startedAt: v.startedAt ?? null };
  } catch (e) { return { error: String(e).slice(0, 160) }; }
}

// ---- per-frame counters, classified rather than assumed ---------------------

/** Sample renderer counters across consecutive frames and let browserlab_core
 *  classify each. `render.calls` is a LIFETIME total and `render.drawCalls` a
 *  per-frame one; both are read, and each is reported as whatever it turned out
 *  to be, so a mislabelled field cannot become a published claim again. */
async function frameCost(frames = 4) {
  const draw = [], tris = [], lifetime = [];
  for (let i = 0; i < frames; i++) {
    await raf();
    draw.push(renderer.info.render.drawCalls);
    tris.push(renderer.info.render.triangles);
    lifetime.push(renderer.info.render.calls);
  }
  const d = classifyCounter(draw), t = classifyCounter(tris), l = classifyCounter(lifetime);
  return {
    drawCalls: d.value, drawCounter: `${d.kind} — ${d.why}`,
    triangles: t.value, triangleCounter: `${t.kind} — ${t.why}`,
    // recorded, never published as a frame cost: the field this harness used to
    // quote by mistake
    lifetimeCalls: { kind: l.kind, perFrame: l.value, last: lifetime[lifetime.length - 1] },
    samples: { draw, tris },
  };
}

// ---- what is actually in front of the camera --------------------------------

/** A census detailed enough to DIGEST. A frame-time delta is a browser delta
 *  only if the two runs folded the same world, and camera pose + people count +
 *  a global triangle total does not establish that: a body can move, an entity
 *  can be hidden, an asset can finish streaming, the log can advance. */
function sceneCensus() {
  let skinned = 0, meshes = 0, lights = 0, casters = 0;
  scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned++;
    else if (o.isMesh) meshes++;
    if (o.isLight) { lights++; if (o.castShadow) casters++; }
  });
  const strokes = grassTiles().strokes ?? [];
  const ents = [];
  try {
    for (const [id, e] of (entities ?? new Map())) {
      ents.push({ id, lib: e.lib ?? null, pos: e.pos ?? null, yaw: e.yaw ?? 0, scale: e.scale ?? 1,
        visible: e.obj ? e.obj.visible !== false : true });
    }
  } catch { /* a world shape we cannot census is reported as none, not faked */ }
  const ppl = [];
  try {
    for (const [id, rb] of (remotes ?? new Map())) {
      const p = rb?.avatar?.root?.position;
      ppl.push({ id, pos: p ? [p.x, p.y, p.z] : null, avatar: rb?.avatarPath ?? null });
    }
  } catch { /* likewise */ }

  const census = {
    people: ppl.length, entities: ents, peopleList: ppl,
    worldSeq: net?.lastSeq ?? null,
    skinnedMeshes: skinned, meshes, lights, shadowCasters: casters,
    geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
    grassStrokes: strokes.map((s) => ({ stroke: s.stroke, mode: s.mode, drawn: s.drawn, planted: s.planted,
      tiles: s.tiles, visible: s.visible, lodTiles: s.lodTiles })),
    grassDrawn: strokes.reduce((n, s) => n + (s.drawn ?? 0), 0),
  };
  census.digest = sceneDigest({ entities: ents, people: ppl, worldSeq: census.worldSeq });
  return census;
}

// ---- what went wrong while we watched --------------------------------------

/** Console errors/warnings and GPU context loss, for the duration of a run.
 *  stop() is idempotent and MUST be called from a finally: this patches global
 *  console methods and installs canvas listeners, and a throw mid-arm used to
 *  skip its cleanup entirely, leaving both in place for the rest of the
 *  session — a diagnostic that leaks itself into the thing it measures. */
function watchTrouble() {
  const seen = new Map();
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
  renderer.backend?.device?.lost?.then?.((info) => {
    contextEvents.push({ type: 'webgpu-device-lost', reason: info?.reason ?? null,
      message: String(info?.message ?? '').slice(0, 200), at: r2(performance.now()) });
  }).catch?.(() => {});

  let stopped = false;
  const collect = () => ({
    contextEvents,
    messages: [...seen].map(([line, count]) => ({ count, line })).sort((a, b) => b.count - a.count).slice(0, 12),
  });
  return {
    get stopped() { return stopped; },
    /** Idempotent. Restores only what is still OURS, so a watcher layered on
     *  top of this one is not clobbered by this one unwinding. */
    stop() {
      if (stopped) return collect();
      stopped = true;
      if (console.error !== realError) console.error = realError;
      if (console.warn !== realWarn) console.warn = realWarn;
      cvs?.removeEventListener('webglcontextlost', onLost);
      cvs?.removeEventListener('webglcontextrestored', onLost);
      return collect();
    },
  };
}

// ---- the measurement --------------------------------------------------------

/** Raw rAF deltas for `secs`, after a settle window. */
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
  return {
    ...summarize(deltas),
    seconds: r2((last - t0) / 1000),
    hud: { fps: perf.fps, ms: r2(perf.ms), worst: perf.worst, doubled: perf.doubled, spikes: perf.spikes },
  };
}

// ---- the foliage arms -------------------------------------------------------
//
// full   → everything on, as the world ships
// static → the meadow is DRAWN but stops moving
// off    → the meadow is not drawn at all
//
// 🔴 SCOPED TO THE MEADOW'S OWN HOOKS, BY IDENTITY.
//
// The first version of this arm emptied `globalThis._autoParticleSystems`
// wholesale. That array's documented owners are the SKY (cloud drift, weather)
// and every entity emitter as well as the meadow — autohooks.js says so in its
// first paragraph — so the arm stopped the clouds and every particle system in
// the world, then attributed the recovered milliseconds to grass. It could not
// have supported the attribution it existed to make.
//
// What the meadow owns is knowable exactly: each stroke's own wind clock
// (`update(t){ uT.value = t }`, returned by the vegetation module) and whatever
// the field registered on `field.autoHooks`. Those come out by identity through
// autohooks.releaseHook and go back on the way out. Every other entry stays put,
// and the arm counts the foreign hooks it left running so the receipt can say
// so rather than ask to be believed.
//
// The wind AMPLITUDES are zeroed too: freezing the clock alone leaves blades
// stopped mid-gust and leaning, which is a frozen meadow rather than a still
// one.

function armControls() {
  let frozenHooks = [], frozenWind = [], foreignBefore = null, savedVisible = null;

  const field = () => getGrassField();
  const meshes = () => {
    const f = field();
    if (!f) return [];
    return [f.mesh, ...(f._strokes ?? []).map((s) => s.mesh)].filter(Boolean);
  };
  /** Hooks this meadow owns — never "everything in the array". */
  const meadowHooks = () => {
    const f = field();
    if (!f) return [];
    return [...(f._strokes ?? []).map((s) => s.update), ...(f.autoHooks ?? [])]
      .filter((fn) => typeof fn === 'function');
  };
  const countForeign = () => {
    const mine = new Set(meadowHooks());
    return autoHooks().filter((h) => !mine.has(h)).length;
  };

  return {
    get ready() { return !!field()?.mesh; },
    /** Proof, for the receipt, that the arm did what it says and no more. */
    effect() {
      return {
        hooksFrozen: frozenHooks.length,
        windZeroed: frozenWind.length,
        foreignHooksLeftRunning: countForeign(),
        foreignHooksAtStart: foreignBefore,
        totalHooks: autoHooks().length,
      };
    },
    apply(arm) {
      this.restore();
      const f = field();
      if (foreignBefore === null && f) foreignBefore = countForeign();
      if (savedVisible === null && f) savedVisible = new Map(meshes().map((m) => [m, m.visible]));

      if (arm === 'static') {
        // Record WHERE each hook sat and remove back-to-front, so the indices
        // stay valid as the array shortens. Appending them back would restore
        // membership but not POSITION, and the engine drains this array in
        // order — "the array is left exactly as it was found" has to be true
        // rather than nearly true. (Raised on the sibling change in #151.)
        const live = autoHooks();
        const mine = meadowHooks()
          .map((fn) => ({ fn, at: live.indexOf(fn) }))
          .filter((h) => h.at >= 0)
          .sort((a, b) => b.at - a.at);
        for (const h of mine) if (releaseHook(h.fn)) frozenHooks.push(h);
        for (const st of (f?._strokes ?? [])) {
          const u = st.uniforms;
          if (u?.base && u?.gust) {
            frozenWind.push({ u, base: u.base.value, gust: u.gust.value });
            u.base.value = 0; u.gust.value = 0;
          }
        }
      } else if (arm === 'off') {
        for (const m of meshes()) m.visible = false;
      }
    },
    restore() {
      // plain splice, not pushHostHook: these were never marked host-owned,
      // and restoring must leave the array exactly as it was found — order
      // included
      if (frozenHooks.length) {
        // ascending, so each splice lands before the ones still to come
        const live = autoHooks();
        for (const h of [...frozenHooks].sort((a, b) => a.at - b.at)) {
          live.splice(Math.min(h.at, live.length), 0, h.fn);
        }
        frozenHooks = [];
      }
      for (const w of frozenWind) { w.u.base.value = w.base; w.u.gust.value = w.gust; }
      frozenWind = [];
      if (savedVisible) for (const [m, v] of savedVisible) m.visible = v;
    },
  };
}

/** Blades drawn right now, counted from mesh VISIBILITY: grassTiles() reports
 *  planted-and-tiled truth, which does not change when a mesh is hidden. */
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
 *  its construction. Wait for it, bounded, and record whether it arrived. */
async function waitForGrass(ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (getGrassField()?.mesh) { await sleep(1500); return true; }
    await sleep(500);
  }
  return false;
}

// ---- the run ----------------------------------------------------------------

const ARMS = ['full', 'static', 'off'];

export async function browserlab({ secs = 25, settleMs = 2000, arms = ARMS, camera: pose = null,
  label = null, hideUI = true, buildStamp = null, renderScale = '1', _throwOnArm = null } = {}) {
  if (!(secs >= 5 && secs <= 120)) throw new Error('browserlab: secs must be 5–120');
  const bad = arms.filter((a) => !ARMS.includes(a));
  if (bad.length) throw new Error(`browserlab: unknown arm(s) ${bad.join(', ')} — use ${ARMS.join('/')}`);
  if (document.hidden) throw new Error(
    'browserlab: this tab is BACKGROUNDED — requestAnimationFrame is throttled to nothing, '
    + 'so every frame time would be a lie. Front the tab, leave it fronted, and run again.');

  // 🔴 PIN THE PIXEL BUDGET. The frame governor's cruise moves the render
  // scale under load, so an identical --size can still produce different
  // drawing buffers in two browsers: the first re-run after the review had
  // Chrome at 1280x800 and Firefox at 960x600, because Firefox's governor had
  // shed a quarter of the pixels and nothing said so. A browser comparison
  // cannot let an adaptive dial change the workload mid-experiment. Pass
  // renderScale: 'auto' to measure WITH the governor deliberately.
  // setRenderScale REFUSES an unknown value and returns the current one, so an
  // invalid setting would silently leave the governor in charge — the exact
  // failure this pin exists to prevent. Refuse loudly instead.
  if (renderScale && !RENDER_SCALES.includes(renderScale)) {
    throw new Error(`browserlab: renderScale must be one of ${RENDER_SCALES.join(', ')} — got "${renderScale}"`);
  }
  const priorScale = getRenderScale();
  if (renderScale && renderScale !== priorScale) {
    const got = setRenderScale(renderScale);
    if (got !== renderScale) throw new Error(`browserlab: render scale would not pin (asked ${renderScale}, got ${got})`);
  }

  const enteredPhoto = !photoMode;
  if (pose) setPhotoCamera(pose);
  else if (!photoMode) togglePhotoMode();
  const cam = getPhotoCamera();

  const hadPhotoClass = document.body.classList.contains('photo');
  if (hideUI) document.body.classList.add('photo');

  let backgrounded = false;
  const onVis = () => { if (document.hidden) backgrounded = true; };
  document.addEventListener('visibilitychange', onVis);

  const controls = armControls();
  const foliageArmed = await waitForGrass(20_000);
  if (!foliageArmed) console.warn('[browserlab] no grass field after 20s — the foliage arms will change nothing here');

  // Everything from here is inside ONE try/finally, the trouble watcher
  // included. It patches console.error/warn and installs canvas listeners, and
  // a throw mid-arm previously skipped stop() entirely.
  const trouble = watchTrouble();
  const startedAt = new Date().toISOString();
  const results = [];
  let census = null, env = null, build = null, observed = null;

  try {
    env = await environment();
    // the page can only see what the SERVER reports about itself; the driver
    // hands in the working-tree digest, so the receipt names the code that
    // produced it rather than a commit the tree is not
    build = { ...(await serverBuild()), ...(buildStamp ?? {}) };
    for (const arm of arms) {
      controls.apply(arm);
      if (!controls.ready) console.warn(`[browserlab] arm "${arm}": no grass field in this world — this arm changes nothing`);
      // test seam: prove the finally actually unwinds a mid-arm failure
      if (_throwOnArm === arm) throw new Error(`browserlab: injected failure on the "${arm}" arm`);
      const focusBefore = document.hasFocus();
      const m = await measure(secs, settleMs);
      const cost = await frameCost();
      if (arm === 'full') { census = sceneCensus(); census.triangles = cost.triangles; census.drawCalls = cost.drawCalls; }
      const suspect = throttleVerdict(m);
      results.push({ arm, ...m, blades: bladesDrawn(), grassField: controls.ready, armEffect: controls.effect(),
        drawCalls: cost.drawCalls, drawCounter: cost.drawCounter,
        triangles: cost.triangles, triangleCounter: cost.triangleCounter,
        lifetimeCalls: cost.lifetimeCalls,
        focus: { before: focusBefore, after: document.hasFocus() }, visibility: document.visibilityState,
        ...(suspect ? { suspect } : {}) });
      console.log(`[browserlab] ${arm.padEnd(6)} p50 ${m.p50}ms  p95 ${m.p95}ms  max ${m.max}ms  (${m.frames} frames)`
        + (suspect ? `  ⚠ ${suspect}` : ''));
    }
  } finally {
    controls.restore();
    if (renderScale && renderScale !== priorScale) setRenderScale(priorScale);
    observed = trouble.stop();
    document.removeEventListener('visibilitychange', onVis);
    if (hideUI && !hadPhotoClass) document.body.classList.remove('photo');
    if (enteredPhoto && photoMode) togglePhotoMode();
  }

  const best = results.reduce((a, b) => (a && a.p50 <= b.p50 ? a : b), null);
  if (env) env.refreshHint = best ? `${Math.round(1000 / best.p50)}Hz-ish (fastest arm p50 ${best.p50}ms)` : null;

  const lab = { issue: 42, label, startedAt, secsPerArm: secs, camera: cam, env, build, scene: census,
    foliage: foliageArmed ? 'present' : 'absent', arms: results, observed, tainted: null };
  const suspects = results.filter((a) => a.suspect);
  lab.tainted = backgrounded
    ? 'the tab was backgrounded during the run — frame times are throttle, not renderer'
    : suspects.length ? `${suspects.map((a) => a.arm).join(', ')}: ${suspects[0].suspect}` : null;
  if (lab.tainted) console.warn(`[browserlab] ${lab.tainted}`);

  lab.markdown = renderMarkdown(lab);
  globalThis.EW && (globalThis.EW.__lab = lab);
  console.log(lab.markdown);
  console.log('[browserlab] full object on EW.__lab — `copy(EW.__lab)` to paste it whole');
  return lab;
}

// ---- the receipt ------------------------------------------------------------

/** A markdown block that can be pasted into the issue unedited. Anything the
 *  probe could not read prints as "not exposed" rather than vanishing. */
export function renderMarkdown(lab) {
  const e = lab.env ?? {}, s = lab.scene, na = (v) => (v === null || v === undefined ? '_not exposed_' : v);
  const ad = e.adapter;
  const tick = String.fromCharCode(96);
  const code = (v) => `${tick}${v}${tick}`;
  const L = [];
  L.push(`### browserlab receipt${lab.label ? ` — ${lab.label}` : ''}`, '');
  L.push(code(e.ua ?? 'unknown agent'), '');
  L.push('| | |', '|---|---|');
  L.push(`| backend | ${code(e.backend)} (isWebGPURenderer ${e.isWebGPU}, navigator.gpu ${e.hasNavigatorGpu}) |`);
  L.push(`| adapter | ${ad ? `vendor ${code(na(ad.vendor))} · arch ${code(na(ad.architecture))} · device ${code(na(ad.device))} · fallback ${na(ad.isFallback)}` : '_none reported_'} |`);
  L.push(`| pixel ratio | device ${e.devicePixelRatio} · renderer ${na(e.rendererPixelRatio)} · render scale ${na(e.renderScale)} |`);
  L.push(`| buffer | ${e.drawingBuffer ? e.drawingBuffer.join('×') : '_not exposed_'} (viewport ${(e.viewport ?? []).join('×')}) |`);
  L.push(`| cadence | ${na(e.refreshHint)} |`);
  L.push(`| cores / memory | ${na(e.cores)} / ${e.deviceMemoryGB ? e.deviceMemoryGB + 'GB' : '_not exposed_'} |`);
  L.push(`| quality tier | casters ${na(e.casterBudget)} · light slots ${na(e.slotCap)} · emitters ${na(e.emitters)} · grass ${na(e.grassDensity)} · detail shed ${na(e.detailShed)} |`);
  if (s) L.push(`| scene | ${s.people} people · ${s.skinnedMeshes} skinned · ${s.entities.length} entities · ${s.textures} textures · ${s.grassDrawn.toLocaleString()} blades |`);
  if (s?.digest) L.push(`| scene digest | ${code(s.digest.hash)} · world seq ${na(s.digest.worldSeq)} |`);
  L.push(`| camera | pos [${lab.camera.pos.join(', ')}] yaw ${lab.camera.yaw} pitch ${lab.camera.pitch} fov ${lab.camera.fov} |`);
  const b = lab.build ?? {};
  L.push(`| build | server ${code(na(b.sha))}${b.dirty ? ' (dirty tree)' : ''} · tree ${code(na(b.digest))}${b.digestOf ? ` (${b.digestOf})` : ''} |`);
  L.push('', `**${lab.secsPerArm}s per arm, fixed camera, UI hidden.** Frame time in ms — lower is better.`
    + (lab.foliage === 'absent' ? ' ⚠ **No grass field in this world — the arms changed nothing.**' : ''), '');
  L.push('| foliage | p50 | p95 | p99 | max | mean | fps (p50) | >40ms | >100ms | blades | draws/frame |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of lab.arms) {
    const draws = (a.drawCalls === null || a.drawCalls === undefined)
      ? `_${String(a.drawCounter ?? 'unknown').split(' — ')[0]}_` : a.drawCalls;
    L.push(`| ${a.arm}${a.suspect ? ' ⚠' : ''} | ${a.p50} | ${a.p95} | ${a.p99} | ${a.max} | ${a.mean} | ${a.fpsFromP50} | ${a.over40ms} | ${a.over100ms} | ${(a.blades ?? 0).toLocaleString()}${a.grassField === false ? ' _(no field)_' : ''} | ${draws} |`);
  }
  const fc = foliageCost(lab.arms.find((a) => a.arm === 'full'), lab.arms.find((a) => a.arm === 'off'), { foliage: lab.foliage });
  L.push('', fc.ok
    ? `Foliage costs **${fc.p50}ms** at the median and **${fc.p95}ms** at p95 from this camera.`
    : `**Foliage cost: not computed** — ${fc.why}.`);

  const st = lab.arms.find((a) => a.arm === 'static')?.armEffect;
  if (st) {
    L.push('', `_Static arm scope: ${st.hooksFrozen} meadow-owned hooks released and ${st.windZeroed} wind amplitudes zeroed; `
      + `${st.foreignHooksLeftRunning} non-meadow hooks (sky, weather, entity emitters) left running — ${st.foreignHooksAtStart} at start._`);
  }
  L.push('', `**Console during the run:** ${lab.observed?.messages?.length ? '' : '_clean_'}`);
  for (const m of (lab.observed?.messages ?? [])) L.push(`- ×${m.count} ${code(m.line)}`);
  L.push(`**Context loss:** ${lab.observed?.contextEvents?.length ? lab.observed.contextEvents.map((c) => c.type).join(', ') : '_none_'}`);
  if (lab.tainted) L.push('', `> ⚠ **TAINTED** — ${lab.tainted}. Do not quote these numbers.`);
  L.push('', '> Comparability: this receipt is a browser delta only against another',
    '> receipt whose scene digest, world seq, camera pose and buffer match.',
    '> tools/browserlab-compare.mjs checks that before it prints one.');
  return L.join('\n');
}
