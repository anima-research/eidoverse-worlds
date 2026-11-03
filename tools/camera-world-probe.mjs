// bun tools/camera-world-probe.mjs — distance-driven decisions use the camera's WORLD position, not camera.position.
// In XR the camera is a child of the rig (xr.js rig.add(camera)); camera.position is then the head's offset INSIDE the
// rig. This parents the live camera to a rig 360 m from the origin (head 1.6 m up, as xr.js does) and checks:
//   residency/LOD distance (realize/models.js entDist, via residencyDistance): an entity at the origin is ~360 m away
//   (the rig-local read said ~1.6 m: everything near spawn loaded at full detail and never went to its LOD in VR);
//   an entity next to the rig is close; the baked sky dome (if the boot built one) centres on the rig, not the origin.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await pg.goto(`${world.origin}/?world=staging&name=camprobe&key=${world.key}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(() => globalThis.__ewEngineUp, null, { timeout: 60000 });
  await pg.waitForTimeout(3000);
  const r = await pg.evaluate(async () => {
    const { THREE, scene, camera } = await import('./lib/core.js');
    const M = await import('./lib/realize/models.js');
    const S = await import('./lib/sky_baked.js');
    const saved = { parent: camera.parent, p: camera.position.clone(), q: camera.quaternion.clone() };
    const rig = new THREE.Group(); rig.position.set(200, 0, -300); scene.add(rig);
    rig.add(camera); camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true); rig.updateMatrixWorld(true);
    // in VR the body stands where the rig is — point the avatar focus there (it is min()'d in; the headless visitor
    // stands at the origin and would mask the camera read). The page is thrown away after, so no restore needed.
    M.setResidencyFocus(() => ({ x: 200, y: 0, z: -300 }));
    const out = {
      origin: +M.residencyDistance({ pos: [0, 0, 0] }).toFixed(1),
      nearRig: +M.residencyDistance({ pos: [203, 0, -300] }).toFixed(1),
    };
    // the avatar-position focus must not mask the test: it is min()'d in — report whether one is set
    if (S.bakedActive()) {
      S.updateBakedDome();
      let dome = null; scene.traverse((o) => { if (o.userData?.odTag === 'sky') dome = o; });
      out.dome = dome ? [+dome.position.x.toFixed(1), +dome.position.z.toFixed(1)] : 'not found';
    } else out.dome = 'no baked dome this boot';
    rig.remove(camera); (saved.parent ?? scene)?.add?.(camera); if (!saved.parent) scene.remove(camera);
    camera.position.copy(saved.p); camera.quaternion.copy(saved.q); scene.remove(rig); camera.updateMatrixWorld(true);
    return out;
  });
  console.log('  ', JSON.stringify(r));
  check('an entity at the world origin reads ~360 m from a camera parented 360 m away (not the rig-local 1.6 m)', r.origin > 300, r.origin);
  check('an entity beside the rig reads close', r.nearRig < 5, r.nearRig);
  if (Array.isArray(r.dome)) check('the baked dome centres on the rig (world XZ), not the origin', Math.abs(r.dome[0] - 200) < 1 && Math.abs(r.dome[1] + 300) < 1, r.dome);
  else console.log(`  (dome: ${r.dome} — not asserted)`);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
