// receipt — the fixed-scene performance receipt (#42).
//
// Field reports on #42 are single screenshots from live tabs: real, but not
// comparable. This produces the comparable artifact: one JSON receipt that
// records WHO was measured (world, name, server build, liveness), WHAT the
// machine is (browser, OS, GPU adapter, WebGPU backend vs WebGL fallback,
// pixel ratio, quality tier), WHAT the scene held (draw calls, triangles,
// skinned bodies, textures, lights), HOW frames actually went (true
// per-frame time distribution, not a 1Hz average), and WHICH subsystem the
// cost lives in (one-at-a-time hide toggles: flora, sky, shadows, avatars —
// post effects do not exist in this client, and the receipt says so rather
// than leaving the reader to wonder).
//
// Run it from any browser the client boots in:
//
//   await EW.receipt()                  // ~35s, prints a table, returns JSON
//   await EW.receipt({ secsPer: 8 })    // longer phases on a noisy machine
//   /receipt [secs]                     // chat command: same, plus a .json
//                                       // download for attaching to GitHub
//
// Honesty rules, learned from the tabs that lied:
//   * the receipt OWNS its client: it refuses to run in a hidden tab, and
//     aborts (legibly) if the tab hides or frames stop advancing mid-run —
//     a stale tab produces an error, never a plausible-looking number;
//   * toggles are client-local visibility only — shared world state is
//     never touched, and every toggle restores in a finally;
//   * measurement is by difference (the grassdiag method, §22): each phase
//     hides ONE subsystem and samples real frame deltas, so "hiding X
//     recovered the frame rate" is read straight off the table.

import { perf } from './perf.js';
import { renderer, scene, THREE, CONFIG, sun } from './core.js';
import { net } from './net.js';
import { remotes } from './remotes.js';
import { getMe } from './mybody.js';
import { entities } from './world.js';
import { skyOwnedObjects, getCloudQuality } from './sky.js';
import { getGrassField, getGrassApplied } from './terrain.js';
import { governorDebug, getRenderScale } from './governor.js';
import { frameDebug } from './frame.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- sampling

/** True per-frame deltas over ~secs, via our own rAF rider. Rejects — never
 *  fakes — if the tab hides or frames stop (the stale-tab guard). */
function sampleFrames(secs, label) {
  return new Promise((resolve, reject) => {
    const dts = [];
    let lastT = 0;
    let done = false;
    const t0 = performance.now();
    const fail = (why) => {
      if (done) return;
      done = true;
      reject(new Error(`receipt aborted during "${label}": ${why}`));
    };
    const watchdog = setInterval(() => {
      if (done) { clearInterval(watchdog); return; }
      if (document.visibilityState !== 'visible') fail('tab went hidden (a hidden tab suspends frames; the numbers would be fiction)');
      else if (performance.now() - Math.max(t0, lastT) > 3000) fail('frames stopped advancing (renderer stalled or rAF suspended)');
      if (done) clearInterval(watchdog);
    }, 500);
    function tick(now) {
      if (done) return;
      if (lastT) {
        const dt = now - lastT;
        if (dt < 2000) dts.push(dt);   // a longer gap is a suspension, not a frame
      }
      lastT = now;
      if (now - t0 < secs * 1000) requestAnimationFrame(tick);
      else {
        done = true;
        clearInterval(watchdog);
        if (dts.length < 5) reject(new Error(`receipt aborted during "${label}": only ${dts.length} frames in ${secs}s`));
        else resolve(dts);
      }
    }
    requestAnimationFrame(tick);
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];

/** One phase's numbers: fps over the window plus the frame-time distribution. */
function stats(dts) {
  const sorted = [...dts].sort((a, b) => a - b);
  const total = dts.reduce((a, b) => a + b, 0);
  return {
    frames: dts.length,
    fps: +((dts.length * 1000) / total).toFixed(1),
    ms: {
      mean: +(total / dts.length).toFixed(2),
      p50: +pct(sorted, 50).toFixed(2),
      p75: +pct(sorted, 75).toFixed(2),
      p95: +pct(sorted, 95).toFixed(2),
      p99: +pct(sorted, 99).toFixed(2),
      worst: +sorted[sorted.length - 1].toFixed(1),
    },
    // §22p vocabulary: doubled = waited one extra vsync (pacing arithmetic,
    // expected whenever fps < refresh); spikes = >40ms, the only real hitches
    doubledPerSec: +((dts.filter((d) => d > 25 && d <= 40).length * 1000) / total).toFixed(1),
    spikesPerSec: +((dts.filter((d) => d > 40).length * 1000) / total).toFixed(1),
  };
}

// ---------------------------------------------------------------- the facts

async function environment() {
  const nav = navigator;
  const b = renderer.backend;
  const backend = b?.isWebGPUBackend ? 'webgpu'
    : b?.isWebGLBackend ? 'webgl-fallback'
    : (b?.constructor?.name ?? 'unknown');
  let adapter = null;
  if (nav.gpu?.requestAdapter) {
    try {
      const a = await nav.gpu.requestAdapter();
      if (a) {
        const i = a.info ?? {};
        adapter = {
          vendor: i.vendor ?? '', architecture: i.architecture ?? '',
          device: i.device ?? '', description: i.description ?? '',
          isFallbackAdapter: a.isFallbackAdapter ?? false,
          maxTextureDimension2D: a.limits?.maxTextureDimension2D ?? null,
          maxBufferSizeMB: a.limits?.maxBufferSize ? Math.round(a.limits.maxBufferSize / 1048576) : null,
        };
      }
    } catch (e) { adapter = { error: String(e) }; }
  }
  const size = renderer.getDrawingBufferSize?.(new THREE.Vector2()) ?? null;
  return {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform ?? nav.platform ?? '',
    brands: nav.userAgentData?.brands?.map((x) => `${x.brand} ${x.version}`) ?? null,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,   // chromium-only; null elsewhere
    devicePixelRatio: window.devicePixelRatio,
    window: `${window.innerWidth}x${window.innerHeight}`,
    drawingBuffer: size ? `${size.x}x${size.y}` : null,
    webgpuAvailable: !!nav.gpu,
    backend,
    adapter,
  };
}

function quality() {
  const g = governorDebug();
  return {
    renderScale: getRenderScale(),
    pixelRatio: g.pixelRatio,
    governor: {
      casterBudget: g.casterBudget, slotCap: g.slotCap, emitters: g.emitters,
      grass: g.grass, detailShed: g.detailShed, history: g.history,
    },
    clouds: getCloudQuality(),
    grassApplied: (() => { try { return getGrassApplied(); } catch { return null; } })(),
    shadowMapEnabled: renderer.shadowMap?.enabled ?? null,
    shadowMapSize: sun?.shadow?.mapSize ? `${sun.shadow.mapSize.width}x${sun.shadow.mapSize.height}` : null,
  };
}

function census() {
  let meshes = 0, skinned = 0, sprites = 0, lights = 0, shadowLights = 0;
  scene.traverse((o) => {
    if (o.isMesh) { meshes++; if (o.isSkinnedMesh) skinned++; }
    if (o.isSprite) sprites++;
    if (o.isLight) { lights++; if (o.castShadow) shadowLights++; }
  });
  const info = renderer.info;
  return {
    drawCalls: info?.render?.drawCalls ?? info?.render?.calls ?? null,
    triangles: info?.render?.triangles ?? null,
    geometries: info?.memory?.geometries ?? null,
    textures: info?.memory?.textures ?? null,
    meshes, skinned, sprites, lights, shadowLights,
    entities: entities.size,
    people: remotes.size + 1,   // +1: the local body
  };
}

async function identity() {
  const url = new URL(location.href);
  url.searchParams.delete('token');   // never write a credential into a receipt
  let server = null;
  try { server = await (await fetch('/version')).json(); } catch { /* legible below */ }
  return {
    world: CONFIG.world, name: CONFIG.name, url: url.href,
    joined: net.joined === true,
    wsState: ['connecting', 'open', 'closing', 'closed'][net.ws?.readyState] ?? 'none',
    serverBuild: server ? `${server.sha}${server.dirty === true ? ' (DIRTY TREE)' : ''}` : 'unknown (/version unavailable)',
    capturedAt: new Date().toISOString(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ---------------------------------------------------------------- the run

export async function perfReceipt({ secsPer = 5, log = console.log } = {}) {
  if (document.visibilityState !== 'visible') {
    throw new Error('receipt refused: this tab is hidden. A hidden tab suspends frames; run it in the tab you are actually looking at.');
  }

  // console-error capture for the run's duration: the receipt records what
  // the page complained about while being measured, not a lifetime of scroll
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { if (errors.length < 40) errors.push(a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300)); origError.apply(console, a); };
  const onWinErr = (e) => { if (errors.length < 40) errors.push(String(e.reason ?? e.message ?? e).slice(0, 300)); };
  window.addEventListener('error', onWinErr);
  window.addEventListener('unhandledrejection', onWinErr);

  const phases = [];
  const notes = [];
  const run = async (name, on, off) => {
    on();
    try {
      await sleep(400);   // settle: let the toggle's own cost (pipeline churn) pass
      phases.push({ phase: name, ...stats(await sampleFrames(secsPer, name)) });
    } finally { off(); }
  };

  // the toggle surfaces, gathered up front; each absent one is SAID, not skipped silently
  const field = getGrassField();
  const skyObjs = skyOwnedObjects();
  const skyVis = skyObjs.map((o) => o.visible);
  const bodies = [getMe()?.root, ...[...remotes.values()].map((r) => r.avatar?.root)].filter(Boolean);
  const bodyVis = bodies.map((o) => o.visible);
  // shadows toggle = per-light castShadow, the governor's own lever (§12.1:
  // "in no pipeline key — free toggles"). NEVER renderer.shadowMap.enabled:
  // flipping that live nulls the shadow map under a ShadowNode that still
  // ticks (ShadowNode.updateBefore reads shadowMap.depthTexture unguarded)
  // and costs ~1s of dead frames — receipt v1's own first run caught it.
  const casters = [];
  scene.traverse((o) => { if (o.isLight && o.castShadow) casters.push(o); });

  try {
    phases.push({ phase: 'baseline', ...stats(await sampleFrames(secsPer, 'baseline')) });

    if (field?.mesh) {
      await run('flora hidden', () => { field.mesh.visible = false; }, () => { field.mesh.visible = true; });
    } else notes.push('flora: no grass field in this world; phase skipped');

    if (skyObjs.length) {
      await run('sky hidden', () => skyObjs.forEach((o) => { o.visible = false; }),
        () => skyObjs.forEach((o, i) => { o.visible = skyVis[i]; }));
    } else notes.push('sky: no sky objects in this world; phase skipped');

    if (casters.length) {
      await run(`shadows off (${casters.length} caster${casters.length === 1 ? '' : 's'})`,
        () => casters.forEach((l) => { l.castShadow = false; }),
        () => casters.forEach((l) => { l.castShadow = true; }));
    } else notes.push('shadows: no light was casting before the run; phase skipped');

    if (bodies.length) {
      await run(`avatars hidden (${bodies.length})`, () => bodies.forEach((o) => { o.visible = false; }),
        () => bodies.forEach((o, i) => { o.visible = bodyVis[i]; }));
      notes.push('avatars phase hides bodies (GPU cost); their animation still ticks on the CPU — see systems.remotes for that half');
    } else notes.push('avatars: no bodies loaded; phase skipped');

    notes.push('post effects: none exist in this client (no composer/effect chain); nothing to toggle');
  } finally {
    // a throw mid-phase must not leave the world half-hidden
    if (field?.mesh) field.mesh.visible = true;
    skyObjs.forEach((o, i) => { o.visible = skyVis[i]; });
    bodies.forEach((o, i) => { o.visible = bodyVis[i]; });
    casters.forEach((l) => { l.castShadow = true; });
    console.error = origError;
    window.removeEventListener('error', onWinErr);
    window.removeEventListener('unhandledrejection', onWinErr);
  }

  const receipt = {
    schema: 'perf-receipt/1',
    identity: await identity(),
    environment: await environment(),
    quality: quality(),
    scene: census(),
    systems: frameDebug(),          // per-system CPU ms — the main-thread half of the story
    phases,
    consoleErrors: errors,
    notes,
  };

  // the human summary; the return value is the artifact
  const base = phases[0];
  log(`receipt ${receipt.identity.world} @ ${receipt.identity.capturedAt} — ${receipt.environment.backend}` +
    (receipt.environment.adapter ? ` (${receipt.environment.adapter.vendor} ${receipt.environment.adapter.architecture})` : ''));
  log(`  scene: ${receipt.scene.drawCalls} draws, ${receipt.scene.triangles?.toLocaleString?.() ?? '?'} tris, ` +
    `${receipt.scene.skinned}/${receipt.scene.meshes} skinned meshes, ${receipt.scene.textures} textures, ` +
    `${receipt.scene.lights} lights (${receipt.scene.shadowLights} casting)`);
  for (const p of phases) {
    const d = p === base ? '' : `  Δ ${p.fps - base.fps >= 0 ? '+' : ''}${(p.fps - base.fps).toFixed(1)}fps`;
    log(`  ${p.phase.padEnd(24)} ${String(p.fps).padStart(6)}fps  p50 ${String(p.ms.p50).padStart(6)}ms  p95 ${String(p.ms.p95).padStart(6)}ms  worst ${String(p.ms.worst).padStart(6)}ms  spk ${p.spikesPerSec}/s${d}`);
  }
  if (errors.length) log(`  console errors during run: ${errors.length} (receipt.consoleErrors)`);
  return receipt;
}
