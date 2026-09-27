// renderAside (client/lib/render.js): an off-eye render — sky bake, thumbnail, snapshot — while presenting
// must switch XR OFF around the pass, restore xr.enabled and the render target on EVERY exit including a
// throw, and rebuild the eyes from the rig afterwards. Review 2026-09-10 #1 removed the XR disable and the
// suite stayed green; this drives the real function against a recording renderer.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
import { plugin } from 'bun';
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
  build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
} });

const { renderer, camera } = await import('./core-stub.mjs');
// The recorder is installed BEFORE render.js imports: render.js binds renderer.render at module scope.
const log = [];
let target = null, throwNext = null;
renderer.getRenderTarget = () => target;
renderer.setRenderTarget = (t) => { target = t; log.push(['target', t?.name ?? null]); };
renderer.render = (sc, cam) => { log.push(['render', cam?.name ?? null, 'xr=' + renderer.xr.enabled, 'target=' + (target?.name ?? null)]); if (throwNext) { const e = throwNext; throwNext = null; throw e; } return 'rendered'; };
renderer.xr = { enabled: false, isPresenting: false, updateCamera: (c) => log.push(['updateCamera', c === camera ? 'rig-camera' : 'other']), getCamera: () => null, addEventListener() {}, removeEventListener() {} };
const { renderAside, renderWorld } = await import('../client/lib/render.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const sc = {}, cam = { name: 'aside-cam' }, rt = { name: 'bake-rt' }, prior = { name: 'prior-rt' };

console.log('RENDER ASIDE — not presenting');
{ target = prior; log.length = 0;
  const r = renderAside(sc, cam, rt);
  const rendered = log.find((l) => l[0] === 'render');
  check('renders into the requested target', rendered && rendered[3] === 'target=bake-rt', JSON.stringify(log));
  check('restores the prior render target', target === prior);
  check('returns the renderer\'s result', r === 'rendered');
  check('does not touch the eyes off-XR', !log.some((l) => l[0] === 'updateCamera'));
}
console.log('RENDER ASIDE — presenting');
{ renderer.xr.isPresenting = true; renderer.xr.enabled = true; target = null; log.length = 0;
  renderAside(sc, cam, rt);
  const rendered = log.find((l) => l[0] === 'render');
  check('XR is OFF during the aside pass', rendered && rendered[2] === 'xr=false', JSON.stringify(log));
  check('the pass targets the requested render target', rendered && rendered[3] === 'target=bake-rt');
  check('xr.enabled restored after', renderer.xr.enabled === true);
  check('render target restored after', target === null);
  const i = log.findIndex((l) => l[0] === 'updateCamera');
  check('the eyes are rebuilt from the RIG camera after the pass', i > log.findIndex((l) => l[0] === 'render') && log[i][1] === 'rig-camera', JSON.stringify(log));
}
console.log('RENDER ASIDE — presenting, the render THROWS');
{ renderer.xr.isPresenting = true; renderer.xr.enabled = true; target = prior; log.length = 0;
  throwNext = new Error('pipeline lost'); let caught = null;
  try { renderAside(sc, cam, rt); } catch (e) { caught = e; }
  check('the error propagates', caught?.message === 'pipeline lost');
  check('xr.enabled restored despite the throw', renderer.xr.enabled === true);
  check('render target restored despite the throw', target === prior);
  check('the eyes are still rebuilt', log.some((l) => l[0] === 'updateCamera' && l[1] === 'rig-camera'));
}
console.log('RENDER WORLD — presenting: the eyes are rebuilt from the rig BEFORE the main pass');
{ renderer.xr.isPresenting = true; renderer.xr.enabled = true; target = null; log.length = 0;
  let threw = null; try { renderWorld(); } catch (e) { threw = e; }
  const iU = log.findIndex((l) => l[0] === 'updateCamera'), iR = log.findIndex((l) => l[0] === 'render');
  check('renderWorld ran', !threw, threw?.message);
  check('updateCamera(rig camera) precedes the main render', iU >= 0 && iR > iU && log[iU][1] === 'rig-camera', JSON.stringify(log)); }
console.log('RENDER WORLD — not presenting: a stale bound target is unbound at frame start');
{ renderer.xr.isPresenting = false; target = { name: 'stale-rt', constructor: { name: 'RenderTarget' }, width: 8, height: 8 }; log.length = 0;
  renderWorld();
  const iR = log.findIndex((l) => l[0] === 'render');
  check('the main pass renders to the canvas, not the stale target', iR >= 0 && log[iR][3] === 'target=null', JSON.stringify(log));
  check('no eye rebuild off-XR', !log.some((l) => l[0] === 'updateCamera')); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
