// bun tools/foliage-probe.mjs — Video › foliage (client/lib/foliage.js) through the REAL prepareObject.
// A synthetic canopy: six stacked leaf planes whose texture has solid leaflets, 50% rims and see-through gaps
// (transparent + map + opacity 1 → qualifies), and a glass pane (transparent, no map, opacity 0.4 → must not).
//   qualify   — the leaf meshes register, the glass does not
//   restore   — soft → fast → soft renders byte-identical to the first soft render
//   look      — fast differs from soft on a small share of the canopy's pixels (solid interiors are the same colour)
//   fill      — EW.overdraw: fast shades far fewer canopy fragments than soft
//   raycast   — a ray through the canopy hits each leaf plane once (the core twin answers no raycasts)
//   auto      — resolves to soft on the desktop
// Usage: bun tools/foliage-probe.mjs   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();

try {
  const pg = await page();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=folprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp && globalThis.EW?.overdraw, null, { timeout: 60000 });
  await pg.waitForTimeout(3000);
  const r = await Promise.race([pg.evaluate(async () => {
    const { THREE, scene, renderer } = await import('./lib/core.js');
    const { prepareObject } = await import('./lib/materials.js');
    const F = await import('./lib/foliage.js');
    const { renderAside } = await import('./lib/render.js');
    // leaf texture: vertical leaflets — solid (255), a 1-texel 50% rim, see-through gaps (0)
    const N = 64, px = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const k = x % 8, a = k < 4 ? 255 : k === 4 || k === 7 ? 128 : 0, i = (y * N + x) * 4;
      px[i] = 70 + (x * 2) % 60; px[i + 1] = 120 + (y * 3) % 80; px[i + 2] = 40; px[i + 3] = a;
    }
    const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat); tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    const root = new THREE.Group(); root.userData.odTag = 'canopy'; root.position.set(0, 50, -200);
    const leaves = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.MeshStandardNodeMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, roughness: 0.8 });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), m);
      p.position.set((i % 3) * 0.37 - 0.37, ((i / 3) | 0) * 0.3 - 0.15, -i * 0.5); p.rotation.z = i * 0.21;
      root.add(p); leaves.push(p);
    }
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardNodeMaterial({ color: 0x88aacc, transparent: true, opacity: 0.4 }));
    glass.position.set(2.5, 0, 0.5); root.add(glass);
    scene.add(root); root.updateMatrixWorld(true);
    const glassFunc0 = glass.material.depthFunc;
    F.setFoliageMode('soft');
    prepareObject(root, { kind: 'model' });
    const reg = F.foliageDebug();
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
    cam.position.set(0.3, 50, -193); cam.lookAt(0.3, 50, -200); cam.updateMatrixWorld(true);
    const W = 320, H = 180;
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType });
    const shot = async () => {
      await renderer.compileAsync(scene, cam);
      renderAside(scene, cam, rt);
      return Array.from(await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H));
    };
    const soft1 = await shot();
    const odSoft = await EW.overdraw({ mode: 'actual', w: W, camera: cam });
    F.setFoliageMode('fast');
    for (let i = 0; i < 100 && F.foliageDebug().showing < reg.meshes; i++) await new Promise((res) => setTimeout(res, 100));
    const fastDbg = F.foliageDebug();
    const fast = await shot();
    const odFast = await EW.overdraw({ mode: 'actual', w: W, camera: cam });
    const glassUntouched = glass.material.depthFunc === glassFunc0 && !glass.children.length;
    const rc = new THREE.Raycaster(new THREE.Vector3(0.1, 50, -190), new THREE.Vector3(0, 0, -1));
    const hits = rc.intersectObjects(leaves, true).map((h) => h.object.name || 'leaf');
    F.setFoliageMode('soft');
    const soft2 = await shot();
    // THE CLONE PATH (review 2, H1): a loaded prototype is prepared without foliage, every placement is a skeletonClone
    // registered on its own — one clone placed before 'fast', one after; both must get a core the mode reaches
    const { clone: skeletonClone } = await import('three/addons/utils/SkeletonUtils.js');
    const pmat = new THREE.MeshStandardNodeMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    const proto = new THREE.Group(); proto.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), pmat));
    prepareObject(proto, { kind: 'model', foliage: false });
    const protoCores = proto.children[0].children.length;
    const c1 = skeletonClone(proto); F.registerFoliage(c1); c1.position.set(10, 50, -200); scene.add(c1);
    F.setFoliageMode('fast');
    const c2 = skeletonClone(proto); F.registerFoliage(c2); c2.position.set(14, 50, -200); scene.add(c2);
    for (let i = 0; i < 100 && F.foliageDebug().showing < reg.meshes + 2; i++) await new Promise((res) => setTimeout(res, 100));
    // a clone BEHIND the viewer (its own material): the warm must compile it anyway (review 5: frustum culling made the
    // compile a no-op that still marked the material warm)
    const { camera: mainCam } = await import('./lib/core.js');
    const bmat = new THREE.MeshStandardNodeMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    const bproto = new THREE.Group(); bproto.add(new THREE.Mesh(new THREE.PlaneGeometry(3, 3), bmat));
    prepareObject(bproto, { kind: 'model', foliage: false });
    const behind = skeletonClone(bproto);
    { const d = new THREE.Vector3(); mainCam.getWorldDirection(d); behind.position.copy(mainCam.getWorldPosition(new THREE.Vector3())).addScaledVector(d, -30); }
    const culledAtCompile = [];
    const origCA = renderer.compileAsync.bind(renderer);
    renderer.compileAsync = (o, ...rest) => { if (o?.userData?.foliageCore) culledAtCompile.push(o.frustumCulled); return origCA(o, ...rest); };
    F.registerFoliage(behind); scene.add(behind);
    for (let i = 0; i < 60 && culledAtCompile.length === 0; i++) await new Promise((res) => setTimeout(res, 100));
    renderer.compileAsync = origCA;
    scene.remove(behind);
    const coreOf = (c) => c.children[0].children.find((k) => k.userData.foliageCore);
    const k1 = coreOf(c1), k2 = coreOf(c2);
    const cloneFast = { k1: !!k1, k2: !!k2, shared: k1?.material === k2?.material, vis: !!k1?.material.visible, depth: pmat.depthFunc === THREE.LessDepth };
    const rc2 = new THREE.Raycaster(new THREE.Vector3(10, 50, -190), new THREE.Vector3(0, 0, -1)); c1.updateMatrixWorld(true);
    const cloneHits = rc2.intersectObject(c1, true).map((h) => h.object.name || 'leaf');
    F.setFoliageMode('soft');
    const cloneSoft = { vis: !!k1?.material.visible, depth: pmat.depthFunc };
    scene.remove(c1); scene.remove(c2);
    F.setFoliageMode('auto');
    const autoEff = F.foliageEffective();
    scene.remove(root);
    return { reg, fastDbg, soft1, fast, soft2, odSoft: odSoft.byTag?.canopy, odFast: odFast.byTag?.canopy, glassUntouched, hits, autoEff, protoCores, cloneFast, cloneHits, cloneSoft, culledAtCompile, soft0: THREE.LessEqualDepth };
  }), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 120 s')), 120000))]);
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++; return n; };
  const lit = r.soft1.reduce((n, v, i) => n + (i % 4 === 1 && v > 0 ? 1 : 0), 0);
  console.log(`  registered ${JSON.stringify(r.reg)} | fast ${JSON.stringify(r.fastDbg)} | overdraw canopy soft ${JSON.stringify(r.odSoft)} fast ${JSON.stringify(r.odFast)} | hits ${r.hits.length}`);
  check('qualify: the 6 leaf planes register, the glass does not', r.reg.meshes === 6 && r.glassUntouched, JSON.stringify(r.reg));
  check('fast: every leaf shows its warmed core', r.fastDbg.showing === 6, JSON.stringify(r.fastDbg));
  const back = r.soft1.filter((v, i) => v !== r.soft2[i]).length;
  check('restore: soft → fast → soft is byte-identical', back === 0, `${back} bytes differ`);
  const d = diff(r.soft1, r.fast), share = d / Math.max(1, (r.odSoft?.covered ?? 1));
  check('look: fast changes < 1% of the canopy\'s pixels (these planes sort back-to-front, so correct two-pass = blend; 0 measured)', share < 0.01 && (r.odSoft?.covered ?? 0) > 1000, `${d} px differ (${(100 * share).toFixed(1)}% of ${r.odSoft?.covered} covered)`);
  check('fill: fast ≈ one solid layer per covered pixel plus rims (≤ 1.5; soft pays every layer)', r.odFast && r.odSoft && r.odFast.perCovered <= 1.5 && r.odSoft.perCovered > 3, `${r.odSoft?.perCovered} → ${r.odFast?.perCovered} layers/px`);
  check('raycast: the core twin is invisible to rays (one hit per leaf crossed)', r.hits.length > 0 && r.hits.every((h) => h !== 'foliage-core'), r.hits.join(','));
  check('clones: the prototype itself gets no core', r.protoCores === 0, String(r.protoCores));
  check('clones: placed before AND after the switch, both have a core, sharing one cutout material, shown in fast', r.cloneFast.k1 && r.cloneFast.k2 && r.cloneFast.shared && r.cloneFast.vis && r.cloneFast.depth, JSON.stringify(r.cloneFast));
  check('clones: a clone\'s core answers no raycast', r.cloneHits.length > 0 && r.cloneHits.every((h) => h !== 'foliage-core'), r.cloneHits.join(','));
  check('clones: soft hides every core and restores the blend', r.cloneSoft.vis === false && r.cloneSoft.depth !== 2 /* THREE.LessDepth */, JSON.stringify(r.cloneSoft));
  check('warm: a core behind the viewer is compiled with culling off (never a no-op marked warm)', r.culledAtCompile.length > 0 && r.culledAtCompile.every((c) => c === false), JSON.stringify(r.culledAtCompile));
  check('auto: soft on the desktop', r.autoEff === 'soft', r.autoEff);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  void lit;
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
