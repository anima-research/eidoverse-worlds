// The ShadowNode XR-off patch (client/lib/xrshadow.js, applied by core.js): while presenting, the shadow pass
// runs with xr.enabled=false and it is restored on every exit; not presenting, the original runs untouched.
// Third independent review 2026-09-10: removing the patch in core.js was green everywhere — nothing imported it.
import { patchShadowNodeForXR } from '../client/lib/xrshadow.js';
let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };
const seen = []; let throwNext = false;
class FakeShadowNode { updateShadow(frame) { seen.push('xr=' + frame.renderer.xr.enabled); if (throwNext) { throwNext = false; throw new Error('pass lost'); } return 'shadowed'; } }
const xr = { enabled: true, isPresenting: false };
const frame = { renderer: { xr } };
console.log('XR SHADOW PATCH');
check('patches once, reports it', patchShadowNodeForXR(FakeShadowNode.prototype) === true && patchShadowNodeForXR(FakeShadowNode.prototype) === false);
check('a prototype without updateShadow is left alone', patchShadowNodeForXR({}) === false && patchShadowNodeForXR(null) === false);
const node = new FakeShadowNode();
{ seen.length = 0; const r = node.updateShadow(frame); check('not presenting: original runs with xr untouched', r === 'shadowed' && seen[0] === 'xr=true' && xr.enabled === true, seen.join()); }
{ xr.isPresenting = true; seen.length = 0; const r = node.updateShadow(frame); check('presenting: the shadow pass runs with xr OFF', r === 'shadowed' && seen[0] === 'xr=false', seen.join()); check('…and xr.enabled is restored after', xr.enabled === true); }
{ seen.length = 0; throwNext = true; let err = null; try { node.updateShadow(frame); } catch (e) { err = e; } check('a throwing pass still restores xr.enabled and propagates', err?.message === 'pass lost' && xr.enabled === true && seen[0] === 'xr=false'); }
{ xr.enabled = false; seen.length = 0; node.updateShadow(frame); check('an already-disabled xr stays disabled after', xr.enabled === false); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
