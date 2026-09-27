// perfscope (client/lib/perfscope.js) — the viewer-local cost overlay, driven with REAL three against a
// small scene fixture (tools/perfscope-stub.mjs): modes on/off, solid vs overlay, hull/veil creation and
// teardown counts, the texture-bytes estimate (mip factor, bpp, compressed payloads, hidden-LOD textures),
// the receipt, the loupe's switch, and render.js's measured drawStats feed. Each block names the product
// line that must turn it red:
//   · applyTint skipping fabric when solid (perfscope.js `if (fabric && !solidOn) continue`) → "solid tints the fabric"
//   · setMode('off') leaving overlays behind (perfscope.js `if (mode === 'off') clearTint()`) → "off tears every overlay down"
//   · texBytes without the mip factor (perfscope.js `(hasMips ? 4 / 3 : 1)`)                → "texture VRAM counts the mip chain"
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/perfscope-test.ts
import { plugin } from 'bun';
const here = (f: string) => new URL(f, import.meta.url).pathname;
plugin({ name: 'perfscope-stubs', setup(b) {
  for (const m of ['core', 'base', 'world']) b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./perfscope-stub.mjs') }));
  b.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

const stub = await import('./perfscope-stub.mjs');
const { THREE, scene, entities, entityMeta, renders } = stub;
const ps = await import('../client/lib/perfscope.js');
const render = await import('../client/lib/render.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- the fixture: three entities, a person, two fabric meshes, an instanced crowd, a hidden LOD
const box = () => new THREE.BoxGeometry(1, 1, 1);                       // 12 tris
const T = ps.TIERS;
// 2400×2100 RGBA8 with a mip chain: 20.16 MB flat, 26.88 MB with the ×4/3 — straddles the 24 MB tier line
const bigTex = new THREE.DataTexture(null, 2400, 2100); bigTex.generateMipmaps = true; bigTex.minFilter = THREE.LinearMipmapLinearFilter;
// 1000×1000 RGBA8, no mips (DataTexture defaults: Nearest, generateMipmaps false): exactly 4.0 MB
const flatTex = new THREE.DataTexture(null, 1000, 1000);
// 2000×2000 single-channel, no mips: 4.0 MB (1 bpp), not 16
const redTex = new THREE.DataTexture(null, 2000, 2000, THREE.RedFormat);
// a compressed texture bills its real mip payloads: 3,000,000 + 600,000 B
const ktxTex = new THREE.CompressedTexture([{ data: new Uint8Array(3_000_000), width: 2048, height: 2048 }, { data: new Uint8Array(600_000), width: 1024, height: 1024 }], 2048, 2048);

const entity = (id: string, lib: string, ...meshes: any[]) => { const g = new THREE.Group(); g.name = id; g.add(...meshes); scene.add(g); entities.set(id, g); entityMeta.set(id, { lib }); return g; };
const fountainMesh = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ map: bigTex }));
const fountain = entity('fountain', 'library/fountain.glb', fountainMesh);
const ktxMesh = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ map: ktxTex }));
entity('ktxthing', 'library/ktx.glb', ktxMesh);
const redMesh = new THREE.Mesh(box(), new THREE.MeshBasicMaterial({ map: redTex }));
entity('redthing', 'library/red.glb', redMesh);
// a visible low-poly level plus a HIDDEN high-poly one carrying the texture: tris bill the shown chain, VRAM bills both
const lodLow = new THREE.Mesh(box(), new THREE.MeshStandardMaterial());
const lodHigh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), new THREE.MeshStandardMaterial({ map: flatTex })); lodHigh.visible = false;
entity('lodthing', 'library/lod.glb', lodLow, lodHigh);
const crowdMesh = new THREE.InstancedMesh(box(), new THREE.MeshStandardMaterial(), 50);
entity('crowd', 'library/crowd.glb', crowdMesh);
const keir = new THREE.Group(); keir.userData.who = 'keir';
const keirMesh = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.6 }));   // see-through: never hulled
keir.add(keirMesh); scene.add(keir);
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 4, 4), new THREE.MeshStandardMaterial()); terrain.name = 'terrain';
const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 8, 6), new THREE.MeshBasicMaterial({ side: THREE.BackSide })); sky.name = 'sky';
scene.add(terrain, sky);
scene.updateMatrixWorld(true);

// ---- counting helpers: overlays are the perfscopeIgnore children perfscope hangs under the originals
type Ov = { veils: any[]; hulls: any[] };
const overlays = (root: any = scene): Ov => { const r: Ov = { veils: [], hulls: [] }; root.traverse((o: any) => { if (!o.userData?.perfscopeIgnore || !o.isMesh) return; const n = o.material?.name ?? ''; if (n.startsWith('perfscope-hull')) r.hulls.push(o); else if (/^perfscope-(tint|solid)/.test(n)) r.veils.push(o); }); return r; };
const veilOf = (mesh: any) => overlays(mesh).veils.find((v) => v.parent === mesh);
const hullOf = (mesh: any) => overlays(mesh).hulls.find((v) => v.parent === mesh);
const hex = (m: any) => '#' + m.color.getHexString();
const shownOverlayMeshes = () => { let n = 0; const visit = (o: any) => { if (!o.visible) return; if (o.isMesh && o.userData?.perfscopeIgnore) n++; for (const c of o.children) visit(c); }; visit(scene); return n; };

// ============================================================ off → tris
console.log('PERFSCOPE — modes: off, tris');
{ check('starts off, no overlays', ps.activeMode() === 'off' && overlays().veils.length === 0 && overlays().hulls.length === 0);
  check('MODES carries the seven lenses plus off', Object.keys(ps.MODES).join(',') === 'off,rank,tris,draws,tex,mat,bones,alpha', Object.keys(ps.MODES).join(','));
  ps.setMode('tris');
  check('activeMode is tris', ps.activeMode() === 'tris');
  const o = overlays();
  // veils: fountain, ktx, red, lodLow, lodHigh, crowd, keir = 7 ; hulls: the six opaque ones (keir is see-through)
  check('one veil per subject mesh, fabric excluded (7)', o.veils.length === 7, `${o.veils.length}`);
  check('one hull per opaque subject mesh (6)', o.hulls.length === 6, `${o.hulls.length}`);
  check('the fabric (terrain, sky) is untouched in overlay mode', !veilOf(terrain) && !veilOf(sky) && !hullOf(terrain));
  check('a see-through body gets a veil but no hull', !!veilOf(keirMesh) && !hullOf(keirMesh));
  const v = veilOf(fountainMesh), h = hullOf(fountainMesh);
  check('the veil is a 25% transparent tint that rides the original', v && v.material.transparent && v.material.opacity === 0.25 && v.material.depthWrite === false && v.geometry === fountainMesh.geometry, v && JSON.stringify([v.material.transparent, v.material.opacity]));
  check('the veil draws after the original and never raycasts', v && v.renderOrder === 1 && v.raycast({}, []) === undefined && v.userData.perfscopeIgnore === true);
  check('the hull is an inverted (BackSide) node material with a displaced positionNode', h && h.material.side === THREE.BackSide && h.material.isNodeMaterial && !!h.material.positionNode);
  check('every subject is tier 0 by triangles (12–600 tris) → veils wear TIERS[0]', o.veils.every((x) => hex(x.material) === T[0]), o.veils.map((x) => hex(x.material)).join(','));
  const cv = veilOf(crowdMesh);
  check('an instanced original gets an instanced twin sharing its instance buffer', cv && cv.isInstancedMesh && cv.count === 50 && cv.instanceMatrix === crowdMesh.instanceMatrix);
  check('the hidden LOD level is overlaid too (it keeps its VRAM) but stays hidden', !!veilOf(lodHigh) && !lodHigh.visible);
  check('the originals\' materials are never touched', fountainMesh.material.map === bigTex && !fountainMesh.material.name.startsWith('perfscope'));
  check('hull materials are shared per tier (6 hulls, 1 material)', new Set(o.hulls.map((x) => x.material)).size === 1);
}

// ============================================================ tex: the estimate
console.log('PERFSCOPE — texture VRAM estimate (mode tex + the receipt)');
let receipt: any = null;
{ ps.setMode('tex');
  check('activeMode is tex', ps.activeMode() === 'tex');
  check('texture VRAM counts the mip chain: 2400×2100×4 × 4/3 = 26.9 MB → tier 2 (> 24 MB)', hex(veilOf(fountainMesh).material) === T[2], `${hex(veilOf(fountainMesh).material)} want ${T[2]}`);
  check('a flat 4 MB texture is tier 0', hex(veilOf(redMesh).material) === T[0] && hex(veilOf(lodLow).material) === T[0]);
  check('a compressed texture bills its mip payloads (3.6 MB → tier 0)', hex(veilOf(ktxMesh).material) === T[0]);
  // the receipt: the same numbers, written down. The 'copy receipt' button is the product's own route.
  let clip = '';
  // happy-dom's navigator.clipboard is a read-only accessor; copyReceipt falls back to console.log when
  // writeText throws, so both routes land in `clip`
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { clip = t; } }, configurable: true }); } catch {}
  const _log = console.log; console.log = (...a: any[]) => { if (typeof a[0] === 'string' && a[0].startsWith('{')) clip = a[0]; else _log(...a); };
  const stack = document.createElement('div'); document.body.append(stack);
  const toasts: string[] = [];
  ps.buildPerfPanel(stack, { toast: (m: string) => toasts.push(m) });
  const btn = [...stack.querySelectorAll('button')].find((b) => b.textContent === 'copy receipt') as HTMLElement;
  btn.click(); await tick(); await tick();
  console.log = _log;
  receipt = clip ? JSON.parse(clip) : null;
  check('the receipt lands on the clipboard and says it is an estimate', receipt?.kind === 'perfscope-receipt' && receipt.estimated === true, clip.slice(0, 80));
  check('the toast counts the subjects (7: five entities, keir, the fabric bucket — no perfscope helpers)', toasts.some((t) => t.includes('7 subjects')), toasts.join(' | '));
  const sub = (label: string) => receipt?.subjects.find((s: any) => s.label.startsWith(label));
  check('fountain: texMB 26.9', sub('fountain')?.texMB === 26.9, String(sub('fountain')?.texMB));
  check('fountain: top texture is 2400x2100 raw 26.9MB', sub('fountain')?.topTex[0] === '2400x2100 raw 26.9MB', String(sub('fountain')?.topTex[0]));
  check('ktxthing: 3.6 MB and not "raw"', sub('ktxthing')?.texMB === 3.6 && sub('ktxthing')?.topTex[0] === '2048x2048 3.6MB', JSON.stringify(sub('ktxthing')?.topTex));
  check('redthing: single-channel bills 1 bpp (4.0 MB)', sub('redthing')?.texMB === 4, String(sub('redthing')?.texMB));
  check('lodthing: the hidden level\'s texture counts (4.0 MB) while its tris do not (12)', sub('lodthing')?.texMB === 4 && sub('lodthing')?.tris === 12 && sub('lodthing')?.meshes === 2, JSON.stringify(sub('lodthing')));
  check('crowd: 50 instances × 12 tris', sub('crowd')?.tris === 600 && sub('crowd')?.instances === 50, JSON.stringify(sub('crowd')));
  check('the label carries the library basename', sub('fountain')?.label === 'fountain  (fountain.glb)', sub('fountain')?.label);
  check('the mode select reflects the live mode', (stack.querySelector('select') as HTMLSelectElement).value === 'tex');
  check('the receipt never carries the page query (join key)', receipt?.page && !String(receipt.page).includes('?'));
}

// ============================================================ solid
console.log('PERFSCOPE — setSolid / isSolid / applyTint when solid');
{ ps.setMode('tris');
  const before = veilOf(fountainMesh), hullsBefore = overlays().hulls.length;
  check('overlay by default', ps.isSolid() === false && before.material.name.startsWith('perfscope-tint-'));
  ps.setSolid(true);
  check('isSolid flips', ps.isSolid() === true);
  const v = veilOf(fountainMesh);
  check('the same veil object is kept, its material swapped to the opaque solid', v === before && v.material.name.startsWith('perfscope-solid-') && v.material.transparent === false, v?.material.name);
  check('solid tints the fabric: terrain and sky get veils', !!veilOf(terrain) && !!veilOf(sky), `terrain=${!!veilOf(terrain)} sky=${!!veilOf(sky)}`);
  check('…in the solid material', veilOf(terrain)?.material.name.startsWith('perfscope-solid-') === true);
  check('…but the fabric is never hulled (hull count unchanged)', !hullOf(terrain) && !hullOf(sky) && overlays().hulls.length === hullsBefore, `${overlays().hulls.length} vs ${hullsBefore}`);
  check('veils: 7 subjects + 2 fabric = 9', overlays().veils.length === 9, `${overlays().veils.length}`);
  const cb = [...document.querySelectorAll('input[type=checkbox]')].find((c) => c.closest('label')?.textContent?.includes('solid')) as HTMLInputElement;
  check('the panel\'s solid checkbox follows the state', cb?.checked === true);
  ps.setSolid(false);
  check('back to overlay: the fabric veils are dropped', !veilOf(terrain) && !veilOf(sky) && overlays().veils.length === 7, `${overlays().veils.length}`);
  check('…and the subject veil is the tint again, same object', veilOf(fountainMesh) === before && before.material.name.startsWith('perfscope-tint-'));
  check('the checkbox follows back', cb?.checked === false);
}

// ============================================================ churn
console.log('PERFSCOPE — scene churn: removed mesh, swapped geometry');
{ const ktxGroup = entities.get('ktxthing');
  scene.remove(ktxGroup);
  const stale = veilOf(ktxMesh);
  ps.setMode('tris');   // a re-sync is what the 3 s census does
  check('a subject churned out of the scene loses its overlays', !veilOf(ktxMesh) && !hullOf(ktxMesh) && stale.parent === null, `${!!veilOf(ktxMesh)}`);
  check('veils now 6, hulls 5', overlays().veils.length === 6 && overlays().hulls.length === 5, `${overlays().veils.length}/${overlays().hulls.length}`);
  const oldVeil = veilOf(fountainMesh);
  fountainMesh.geometry = new THREE.SphereGeometry(1, 8, 6);
  ps.setMode('tris');
  const nv = veilOf(fountainMesh);
  check('a geometry swap rebuilds the twin on the new geometry', nv && nv !== oldVeil && nv.geometry === fountainMesh.geometry && oldVeil.parent === null);
  check('still exactly one veil and one hull on that mesh', overlays(fountainMesh).veils.length === 1 && overlays(fountainMesh).hulls.length === 1);
  scene.add(ktxGroup);
}

// ============================================================ off: teardown
console.log('PERFSCOPE — setMode(off) tears every overlay down');
{ ps.setMode('tris');
  check('(control) overlays present before off', overlays().veils.length === 7 && overlays().hulls.length === 6, `${overlays().veils.length}/${overlays().hulls.length}`);
  ps.setMode('off');
  check('activeMode is off', ps.activeMode() === 'off');
  let ignored = 0; scene.traverse((o: any) => { if (o.userData?.perfscopeIgnore) ignored++; });
  check('off tears every overlay down: 0 veils, 0 hulls, no perfscope child anywhere', overlays().veils.length === 0 && overlays().hulls.length === 0 && ignored === 0, `${overlays().veils.length}/${overlays().hulls.length}/${ignored}`);
  check('the originals still have their own children only', fountainMesh.children.length === 0 && crowdMesh.children.length === 0 && terrain.children.length === 0);
  ps.setMode('bogus' as any);
  check('an unknown mode is off', ps.activeMode() === 'off' && overlays().veils.length === 0);
  ps.setMode('rank'); ps.setMode('off');
  check('on/off again leaves nothing behind', overlays().veils.length === 0 && overlays().hulls.length === 0);
}

// ============================================================ loupe + full teardown
console.log('PERFSCOPE — loupe switch and perfscopeOff');
{ ps.setLoupe(true);
  check('the loupe arms: body.loupe-on and a .perf-loupe card', document.body.classList.contains('loupe-on') && !!document.querySelector('.perf-loupe'));
  ps.setMode('draws');
  check('(control) a mode is on alongside the loupe', ps.activeMode() === 'draws' && overlays().veils.length === 7);
  ps.perfscopeOff();
  check('perfscopeOff: mode off, loupe off, overlays gone', ps.activeMode() === 'off' && !document.body.classList.contains('loupe-on') && overlays().veils.length === 0 && overlays().hulls.length === 0);
}

// ============================================================ drawStats: render.js's measured feed
console.log('DRAWSTATS — render.js measures the main pass through renderer.info');
{ renders.length = 0;
  render.renderWorld();
  let s = render.drawStats();
  const visibleMeshes = () => { let n = 0; const visit = (o: any) => { if (!o.visible) return; if (o.isMesh) n++; for (const c of o.children) visit(c); }; visit(scene); return n; };
  check('renderWorld renders THE scene with THE camera once', renders.length === 1 && renders[0].scene === scene && renders[0].camera === stub.camera);
  check('drawCalls = the visible meshes (8: hidden LOD not drawn)', s.render.drawCalls === 8 && s.render.drawCalls === visibleMeshes(), JSON.stringify(s.render));
  // 4 boxes ×12 + 2 spheres(8,6) ×80 (sky, and the fountain after the churn block's swap) + crowd 600 + terrain 32
  check('triangles = 48 + 160 + 600 + 32 = 840', s.render.triangles === 840, String(s.render.triangles));
  check('passes counts the render calls of that frame', s.render.passes === 1);
  check('batching reports its switch', typeof s.batching.enabled === 'boolean');
  keir.visible = false;
  render.renderWorld(); s = render.drawStats();
  check('a hidden body drops one call and 12 tris — per frame, not cumulative', s.render.drawCalls === 7 && s.render.triangles === 828, JSON.stringify(s.render));
  keir.visible = true;
  ps.setMode('tris');
  render.renderWorld(); s = render.drawStats();
  const extra = shownOverlayMeshes();
  check('with an overlay on, the feed shows what the tool costs: +1 call per shown veil/hull', extra > 0 && s.render.drawCalls === 8 + extra, `${s.render.drawCalls} vs 8+${extra}`);
  ps.setMode('off');
  render.renderWorld(); s = render.drawStats();
  check('off: the feed is back to 8', s.render.drawCalls === 8, String(s.render.drawCalls));
  const src = render.drawStats({ sources: true }).sources;
  check('sources survey lists the instanced crowd and the library basenames', src.types.some((t: any) => t.type === 'instanced' && t.visibleObjects === 1) && src.types.some((t: any) => t.type === 'other'), JSON.stringify(src.types));
}

console.log('PERFSCOPE — a tier threshold is CROSSED, not reached (tierOf: v > th)');
{ // T.tris[0] is 5000: a subject at exactly 5000 tris is still tier 0; past it is tier 1.
  // PlaneGeometry(w,h,sx,sy) = sx*sy*2 tris → 50x50 = 5000 exactly; 50x51 = 5100.
  const atMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 50, 50), new THREE.MeshStandardMaterial());
  entity('atthreshold', 'library/at.glb', atMesh);
  const overMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 50, 51), new THREE.MeshStandardMaterial());
  entity('overthreshold', 'library/over.glb', overMesh);
  scene.updateMatrixWorld(true);
  ps.setMode('tris');
  check('exactly 5000 tris is still tier 0 (a threshold is crossed, not reached)', hex(veilOf(atMesh)!.material) === T[0], hex(veilOf(atMesh)!.material));
  check('5100 tris is tier 1', hex(veilOf(overMesh)!.material) === T[1], hex(veilOf(overMesh)!.material));
  ps.setMode('off'); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
