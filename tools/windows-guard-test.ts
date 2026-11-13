// windows-guard-test — windows.js under a browser that refuses storage, and at a viewport narrower than a frame's
// floor: the module still loads and the lock still toggles (bot #578); the painted min-width yields like fit()'s
// clamp does, so the frame can fit at all (bot #579).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/windows-guard-test.ts
// Mutation (must go red): make `let locked = localStorage.getItem(…)` bare again; paint `root.style.minWidth = minW` unclamped.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 390, height: 700 });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
// a sandboxed frame: every storage touch throws SecurityError
const deny = () => { throw new DOMException('denied', 'SecurityError'); };
Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: deny });   // as a sandboxed frame: the property itself throws
check('setup: storage throws', (() => { try { localStorage.getItem('x'); return false; } catch { return true; } })());
let W: any = null, err = '';
try { W = await import('../client/lib/windows.js'); } catch (e: any) { err = e?.message ?? String(e); }
check('windows.js loads where storage throws (the lock reads as off)', !!W && W.isLocked() === false, err);
if (W) {
  let threw = ''; try { W.setLocked(true); } catch (e: any) { threw = e?.message ?? String(e); }
  check('setLocked still toggles in memory where setItem throws', threw === '' && W.isLocked() === true && document.body.classList.contains('ui-locked'), threw);
  W.setLocked(false);
  const f = W.makeFrame('wide', { title: 'wide', w: 600, h: 200, minW: 500 });
  check('setup: the viewport (390) is narrower than the frame floor (500)', innerWidth === 390 && !!f, String(innerWidth));
  const painted = parseFloat(f.root?.style?.minWidth ?? document.querySelector('[data-frame=wide]')?.style.minWidth ?? 'NaN');
  check('the painted min-width yields to the viewport (fit()\'s innerWidth - 16 bound)', painted <= 390 - 16, String(painted));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
