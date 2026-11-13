// bun tools/dome-order-probe.mjs — the sky dome drawn AFTER the world's opaques renders the SAME image.
//
// sky_baked.js used to give the baked dome renderOrder −100 ("first, behind everything"): opaque, depthWrite:false,
// far behind the world — so it shaded every pixel of the eye buffers and was then overdrawn. Now 0.5 (after world
// opaques at 0, before overlays at ≥ 1 — core.js's grid 1 / axis 2 write no depth and stay after it). In the real
// client page with the real three, render a stand-in of every class that matters, old order vs new, and diff:
//   same     — pixels identical: a direction-varying dome, opaque boxes at several depths, a no-depth-write line
//              standing against the sky, a depthTest:false overlay at renderOrder 1
//   mutant   — a no-depth-write opaque at renderOrder 0 differs (where the dome now paints over it): the rule's edge
// The fill SAVING (early-z rejecting covered dome pixels) is by construction and not measured here (SwiftShader).
// Usage: bun tools/dome-order-probe.mjs   (run under a memory guard: headless Chromium renders on the CPU)
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';

const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
const pg = await page();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e)));
try {
  await pg.goto(`${world.origin}/?world=staging&name=domeprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(3000);
  const r = await Promise.race([pg.evaluate(async () => {
    const { THREE, TSL, renderer } = await import('./lib/core.js');
    const W = 320, H = 200;
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(60, W / H, 0.15, 20000); cam.position.set(0, 1.6, 6); cam.lookAt(0, 1.2, 0);
    const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const d = TSL.normalize(TSL.positionLocal);
    domeMat.colorNode = TSL.vec3(d.y.mul(0.5).add(0.5), TSL.sin(d.x.mul(9.0)).mul(0.25).add(0.4), TSL.float(0.8));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(14850, 48, 24), domeMat); dome.frustumCulled = false;
    sc.add(dome);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicNodeMaterial({ color: 0x556644 }));
    ground.rotation.x = -Math.PI / 2; sc.add(ground);
    for (const [x, z, c] of [[-1.5, 0, 0xaa3322], [1.2, -3, 0x2244aa], [0.3, 2, 0xdddd55]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicNodeMaterial({ color: c })); b.position.set(x, 1, z); sc.add(b);
    }
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff }); lineMat.depthWrite = false;   // like core.js axis
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(2.5, 0, 0), new THREE.Vector3(2.5, 30, 0)]), lineMat);
    sc.add(line);
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), new THREE.MeshBasicNodeMaterial({ color: 0x00ff88, depthTest: false }));
    overlay.position.set(-0.6, 2.2, 3); overlay.renderOrder = 1; sc.add(overlay);
    const rt = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType });
    const shot = async (domeOrder, lineOrder) => {
      dome.renderOrder = domeOrder; line.renderOrder = lineOrder;
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt);
      await renderer.compileAsync(sc, cam); renderer.render(sc, cam); renderer.setRenderTarget(prev);
      return await renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H);
    };
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    const old = await shot(-100, 2), neu = await shot(0.5, 2), mut = await shot(0.5, 0);   // the line is core's axis: depthWrite:false, renderOrder 2
    let sky = 0; for (let i = 0; i < old.length; i += 4) if (old[i + 2] > 190) sky++;   // dome pixels (blue 0.8)
    const where = []; for (let i = 0; i < old.length; i += 4) { if (old[i] !== neu[i] || old[i+1] !== neu[i+1] || old[i+2] !== neu[i+2]) { const p = i / 4; if (where.length < 12) where.push(`${p % W},${Math.floor(p / W)} old ${old[i]},${old[i+1]},${old[i+2]} new ${neu[i]},${neu[i+1]},${neu[i+2]}`); } }
    return { same: diff(old, neu), mutant: diff(old, mut), total: old.length, skyFrac: +(sky / (W * H)).toFixed(2), where };
  }), new Promise((_, rej) => setTimeout(() => rej(new Error('page pinned 60 s')), 60000))]);
  console.log('  result:', JSON.stringify(r));
  check('the test scene really shows sky AND world (not an empty measurement)', r.skyFrac > 0.1 && r.skyFrac < 0.9, `sky fraction ${r.skyFrac}`);
  check('same: dome at 0.5 is byte-identical to dome first (with a no-depth-write line at 2, like core\'s axis)', r.same === 0, `${r.same} of ${r.total} bytes differ`);
  check('mutant: a no-depth-write opaque at renderOrder 0 DOES differ (why stage lines must stay >= 1)', r.mutant > 0, `${r.mutant} bytes differ`);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran to completion', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
