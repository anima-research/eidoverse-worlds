// syncgate — no pipeline is ever LINKED on the render path (WebGL backend).
//
// three r186's WebGL backend builds a pipeline the first time a frame meets a render object it has no program for, and
// on that path (promises === null) it goes straight to _completeCompile, whose gl.getProgramParameter(LINK_STATUS)
// blocks until the driver has finished linking (three.webgpu.js ~75523/75697). KHR_parallel_shader_compile lets the
// link run off-thread and be POLLED, but three only takes that branch inside compileAsync. Measured on the owner's
// machine 2026-09-24 (a DevTools trace): one
// render-path getProgramParameter held the main thread 54.7 s in the Commons, and the whole browser froze with it.
// Every warm in the client (assets.js, avatar.js, sky.js, warmqueue.js …) exists to keep builds off that path; this is
// the backstop for whatever they miss (a variant change after the warm, a pass nobody pre-compiled).
//
// With the extension present, a render-path build is handed to three's own polling branch. The object is then simply
// not drawn until its program links, by three itself: _renderObjectDirect draws only when Pipelines.isReady(), which
// stays false until _completeCompile sets the pipeline (~65557/33289). It pops in late instead of stopping the world. Without the extension nothing
// changes (there is no way to link without blocking). ?syncgate=0 turns the gate off; the census stays.
//
// The census tees every render-path build that took ≥ SLOW_MS to request (with the gate off, that is the link itself),
// naming object, material and the generated shader sizes — the question the trace could not answer: WHICH material.

const SLOW_MS = 250;
const GIANT_FS = 400000;   // chars of fragment source: only the sky's cloud programs are this big
// the world's own pass: no user target bound — or the target three's _renderScene binds for it (its tone-mapping
// framebuffer, isPostProcessingRenderTarget ~63249; the XR eye target in a session). Anything else is someone's target.
const isWorldPass = (rt) => rt === null || !!rt?.isPostProcessingRenderTarget || !!rt?.isXRRenderTarget;
// the nearest named ancestor, with the path length — most three children are anonymous under a named root
const named = (o) => { for (let n = o, d = 0; n && d < 6; n = n.parent, d++) if (n.name) return d ? `${n.name}›${d}` : n.name; return '(unnamed)'; };

export function installSyncGate(renderer, { tee = () => {}, gate = true } = {}) {
  const be = renderer.backend;
  if (!be || be.isWebGPUBackend || be.__syncGate) return null;
  const orig = be.createRenderPipeline?.bind(be);
  if (!orig) return null;
  const stats = { renderPath: 0, deferred: 0, intoTarget: 0, slow: [], parallel: !!be.parallel, gate };
  be.__syncGate = stats;
  const pendingGiant = new Set();

  be.createRenderPipeline = (renderObject, promises) => {
    if (promises != null) {                                              // compileAsync: three polls already
      // …but a BIG program compiling there can still freeze the GPU process on a cold cache (the owner, 09-27): say
      // which, immediately, so a freeze leaves its name as the last line in the clientlog
      const ret = orig(renderObject, promises);
      const fs = renderObject.pipeline?.fragmentProgram?.code?.length ?? 0;
      if (fs > 200000) {
        const o = renderObject.object, t0 = performance.now(), name = `${o?.type ?? '?'}:${named(o)} ${renderObject.material?.type ?? '?'} fs ${fs}`;
        tee(`[syncgate] async compile started: ${name}`, true);
        Promise.all(promises).then(() => tee(`[syncgate] async compile linked after ${(performance.now() - t0).toFixed(0)} ms: ${name}`, true), () => {});
      }
      return ret;
    }
    stats.renderPath++;
    if (!isWorldPass(renderer.getRenderTarget())) stats.intoTarget++;
    const t0 = performance.now();
    // Only the WORLD drawn to the screen may wait a frame. A render into a render target is usually ONE-SHOT — a bake,
    // an env/PMREM, a capture — and a skipped draw there is not a late pop-in but a permanently wrong texture (the sky
    // boot bake would come out black). Those keep upstream behaviour; their owners warm them (sky_baked compiles its
    // bands with compileAsync first).
    // …and the BACKSTOP (owner, 09-27: 'it simply can't block the rest of the world'): a GIANT program asked for
    // synchronously into a target defers too, whoever asks. On the owner's GPU a 1.76 MB sky program built this way blocked
    // 89–94 s, Windows reset the driver, the page reloaded and asked again: a loop that never finishes. Deferred, that
    // one draw into the target is skipped until the program links (a stale or empty texel set, redrawn by its owner's
    // next pass) instead of freezing Chrome. Measured sizes: world materials ~66 k, the sky programs 0.9–1.8 M.
    const fsLen = renderObject.pipeline?.fragmentProgram?.code?.length ?? 0;
    const giantAside = fsLen > GIANT_FS && !isWorldPass(renderer.getRenderTarget());
    const deferring = gate && !!be.parallel && (isWorldPass(renderer.getRenderTarget()) || giantAside);
    if (giantAside && gate && be.parallel) stats.intoTargetDeferred = (stats.intoTargetDeferred ?? 0) + 1;
    let ret;
    const mine = [];
    if (deferring) {
      ret = orig(renderObject, mine);
      if (mine.length) stats.deferred++;
      // a giant program still linking: anyone about to DRAW with it into a one-shot target (a bake) must wait, or the
      // draw is silently skipped and the target stays black (the owner's sky, 09-27 18:10). compileAsync can't be
      // used for that: once the pipeline exists, it resolves at once, linked or not.
      if (mine.length && fsLen > GIANT_FS) {
        const pipe = renderObject.pipeline;
        // a program whose material is disposed (its sky torn down while linking) holds nobody up: a new sky's bake
        // sat ~44 s behind the old sky's orphaned link on the owner's rig (09-27 20:27, medium→low, no clouds)
        const mat = renderObject.material;
        const gone = new Promise((res) => { const h = () => { mat?.removeEventListener?.('dispose', h); res(); }; mat?.addEventListener?.('dispose', h); });
        const p = Promise.race([Promise.all(mine).catch(() => {}), gone]).finally(() => pendingGiant.delete(p));
        p.status = () => { try { const gl = be.gl, prog = be.get(pipe)?.programGPU; if (!gl || !prog) return 'no program';
          const done = be.parallel ? gl.getProgramParameter(prog, be.parallel.COMPLETION_STATUS_KHR) : true;
          return done ? `complete, linked=${gl.getProgramParameter(prog, gl.LINK_STATUS)}` : 'still compiling'; } catch (e) { return `? ${e?.message ?? e}`; } };
        pendingGiant.add(p);
      }
    } else {
      ret = orig(renderObject, null);
    }
    const ms = performance.now() - t0;
    if (ms >= SLOW_MS || deferring) {
      const o = renderObject.object, m = renderObject.material, p = renderObject.pipeline;
      const row = {
        ms: +ms.toFixed(0), deferred: deferring,
        object: `${o?.type ?? '?'}:${named(o)}`,
        material: `${m?.type ?? '?'}:${m?.name || ''}`,
        vs: p?.vertexProgram?.code?.length ?? 0, fs: p?.fragmentProgram?.code?.length ?? 0,
        skinned: !!o?.isSkinnedMesh, morphs: o?.morphTargetInfluences?.length ?? 0,
        lights: renderObject.lightsNode?.getLights?.()?.length ?? null,
      };
      if (ms >= SLOW_MS) stats.slow.push(row);
      // a BLOCKING build over a second: who asked for it (09-27: an 89 s 1.76 MB build into a target froze the owner's
      // GPU process and its caller wasn't in the log). The stack is only taken on this rare path.
      const who = (giantAside || (!deferring && ms >= 1000)) ? ` into ${(() => { const t = renderer.getRenderTarget(); return t ? `${t.texture?.name || t.constructor?.name || 'target'} ${t.width}x${t.height}` : 'canvas'; })()} via ${(() => { const L = Error.stackTraceLimit; Error.stackTraceLimit = 60; try { return String(new Error().stack ?? ''); } finally { Error.stackTraceLimit = L; } })().split('\n').slice(3, 40).map((l) => l.trim().replace(/^at /, '').replace(/\(?https?:\/\/[^/]+\/(lib\/)?/, '').replace(/\)$/, '')).join(' < ')}` : '';
      if (ms >= SLOW_MS || row.fs > 60000) tee(`[syncgate] render-path build ${row.ms} ms${deferring ? ' (deferred link)' : ' (BLOCKING)'} ${row.object} ${row.material} vs ${row.vs} fs ${row.fs} chars skinned=${row.skinned} morphs=${row.morphs} lights=${row.lights}${who}`, ms >= 1000);
      // how long a big deferred program took to link, i.e. how long its object stayed off screen
      if (deferring && row.fs > 60000 && mine.length) Promise.all(mine).then(
        () => tee(`[syncgate] linked after ${(performance.now() - t0).toFixed(0)} ms: ${row.object} ${row.material} fs ${row.fs} chars`),
        (e) => tee(`[syncgate] link FAILED after ${(performance.now() - t0).toFixed(0)} ms: ${row.object} fs ${row.fs}: ${e?.message ?? e}`));
    }
    return ret;
  };

  tee(`[syncgate] installed: parallel-compile ${stats.parallel ? 'yes' : 'NO (gate inert: links block)'}; gate ${gate ? 'on' : 'off (?syncgate=0, census only)'}`);
  // resolves when every giant link pending now has landed; after maxMs it gives up, saying what the GL reports (a black
  // baked sky on the owner's rig, 09-27 18:10, with no 'linked after' line: this is the witness)
  // Never gives up: drawing with an unlinked giant program skips the draw and leaves a baked target black (audit M4;
  // cold links measured 125–583 s on the owner's rig). Every tickMs it says what the GL reports, so a stuck link is
  // visible; a dead context is gpulost's to recover (reload).
  stats.whenGiantLinked = (tickMs = 120000) => {
    const list = [...pendingGiant];
    if (!list.length) return Promise.resolve(true);
    const t0 = performance.now();
    const timer = setInterval(() => tee(`[syncgate] giant link still pending after ${((performance.now() - t0) / 1000).toFixed(0)} s (waiting, not drawing): ${list.map((p) => p.status?.() ?? '?').join(' | ')}`, true), tickMs);
    return Promise.all(list).then(() => true).finally(() => clearInterval(timer));
  };
  return stats;
}
