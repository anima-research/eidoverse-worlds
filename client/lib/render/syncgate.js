// syncgate — no pipeline is ever linked blocking on the render path (WebGL backend).
//
// three's WebGL backend builds a pipeline the first time a frame meets a render object it has no program for, and on
// that path (promises === null) the LINK_STATUS read blocks until the driver has linked (measured: up to a minute).
// KHR_parallel_shader_compile lets the link be polled, but three only polls inside compileAsync. The warms
// (assets.js, avatar.js, sky.js, warmqueue.js) keep builds off that path; this is the backstop for what they miss.
//
// With the extension present, a render-path build is handed three's polling branch; three itself skips drawing the
// object until its program links (Pipelines.isReady), so it pops in late instead of stopping the world. Without the
// extension nothing changes. ?syncgate=0 turns the gate off; the census stays.
//
// The census tees every render-path build that took ≥ SLOW_MS, naming object, material and shader sizes.

const SLOW_MS = 250;
const GIANT_FS = 400000;   // chars of fragment source: only the sky's cloud programs are this big
// the world's own pass: no user target bound, or the target three binds for it (its tone-mapping framebuffer, the XR
// eye target). Anything else is someone's target.
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
      // …but a BIG program compiling there can still freeze the GPU process on a cold cache: say which, immediately,
      // so a freeze leaves its name as the last line in the clientlog
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
    // Only the world drawn to the screen may wait a frame: a render into a target is usually one-shot (a bake, a
    // capture), where a skipped draw is a permanently wrong texture. Exception: a giant program (> GIANT_FS) into a
    // target defers too, since a blocking build of one can reset the driver; its owner redraws once it links.
    const fsLen = renderObject.pipeline?.fragmentProgram?.code?.length ?? 0;
    const giantAside = fsLen > GIANT_FS && !isWorldPass(renderer.getRenderTarget());
    const deferring = gate && !!be.parallel && (isWorldPass(renderer.getRenderTarget()) || giantAside);
    if (giantAside && gate && be.parallel) stats.intoTargetDeferred = (stats.intoTargetDeferred ?? 0) + 1;
    let ret;
    const mine = [];
    if (deferring) {
      ret = orig(renderObject, mine);
      if (mine.length) stats.deferred++;
      // a giant program still linking: anyone about to DRAW with it into a one-shot target (a bake) must wait
      // (whenGiantLinked), or the draw is skipped and the target stays black. compileAsync can't serve: once the
      // pipeline exists it resolves at once, linked or not.
      if (mine.length && fsLen > GIANT_FS) {
        const pipe = renderObject.pipeline;
        // a program whose material is disposed (its sky torn down while linking) holds nobody up
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
      // a BLOCKING build over a second (or a giant one into a target): name the target and the caller's stack.
      // The stack is only taken on this rare path.
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
  // resolves when every giant link pending now has landed. Never gives up (drawing with an unlinked giant program
  // leaves a baked target black; cold links have run for minutes): every tickMs it tees what the GL reports, and a
  // dead context is gpulost's to recover.
  stats.whenGiantLinked = (tickMs = 120000) => {
    const list = [...pendingGiant];
    if (!list.length) return Promise.resolve(true);
    const t0 = performance.now();
    const timer = setInterval(() => tee(`[syncgate] giant link still pending after ${((performance.now() - t0) / 1000).toFixed(0)} s (waiting, not drawing): ${list.map((p) => p.status?.() ?? '?').join(' | ')}`, true), tickMs);
    return Promise.all(list).then(() => true).finally(() => clearInterval(timer));
  };
  return stats;
}
