// confirmcenter-test — the centre card's one-at-a-time rule: asking again answers the open question with ITS cancel
// (confirmCenter → false, askCenter → null, chooseCenter → its `cancel`), as each function's doc says (bot #213).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/confirmcenter-test.ts
// Mutation (must go red): in client/lib/confirmcenter.js settle the open one with `open.cancel ?? false` again.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 800, height: 600 });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const C = await import('../client/lib/confirmcenter.js');
const settled = async (p: Promise<any>) => { let v: any = 'unsettled'; p.then((x) => { v = x; }); for (let i = 0; i < 20; i++) await Promise.resolve(); return v; };
{ const a = C.askCenter({ title: 'name?' }); check('setup: an ask is open', C.confirmOpen());
  const b = C.confirmCenter({ title: 'sure?' });
  check('an interrupted askCenter resolves null (its cancel), not false', (await settled(a)) === null, String(await settled(a)));
  const c = C.chooseCenter({ title: 'lock', choices: [{ v: 'move', label: 'Move anyway' }, { v: 'no', label: 'Cancel' }], cancel: 'no' });
  check('an interrupted confirmCenter resolves false', (await settled(b)) === false, String(await settled(b)));
  const d = C.confirmCenter({ title: 'again' });
  check('an interrupted chooseCenter resolves its own cancel value', (await settled(c)) === 'no', String(await settled(c)));
  const e = C.chooseCenter({ title: 'lock2', choices: [{ v: 'x', label: 'x' }] });
  check('…and a chooseCenter with no cancel resolves null, not false', ((await settled(d)) === false) && (await settled(C.confirmCenter({ title: 'end' })), (await settled(e)) === null), String(await settled(e)));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
