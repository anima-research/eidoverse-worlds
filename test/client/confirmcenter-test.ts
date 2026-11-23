// confirmcenter-test — the centre card's one-at-a-time rule: asking again answers the open question with ITS cancel
// (confirmCenter → false, askCenter → null, chooseCenter → its `cancel`), as each function's doc says (bot #213).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/confirmcenter-test.ts
// Mutation (must go red): in client/lib/edit/confirmcenter.js settle the open one with `open.cancel ?? false` again.
// Then (xr-confirm review S3): an Enter aimed at an element outside the card is not the card's (mutation: drop the
// aimedElsewhere line in chooseCenter's onKey), and closeCenter() answers the open card with its cancel, never a yes.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 800, height: 600 });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const C = await import('../../client/lib/edit/confirmcenter.js');
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
{ await settled(C.confirmCenter({ title: 'flush' })); C.closeCenter();
  const field = document.createElement('input'); document.body.append(field);
  const q = C.chooseCenter({ title: 'consent', choices: [{ v: 'yes', label: 'Turn on' }, { v: 'no', label: 'Not now' }], cancel: 'dismissed' });
  let seen = false; field.addEventListener('keydown', () => { seen = true; });
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));   // what the VR keyboard's ⏎ sends (xrkeyboard.js enter)
  check("an Enter aimed at a text field outside the card doesn't answer the card", (await settled(q)) === 'unsettled' && C.confirmOpen(), String(await settled(q)));
  check('…and reaches the field it was aimed at', seen);
  C.closeCenter();
  check('closeCenter answers the open card with its cancel (a dismissal, not a yes)', (await settled(q)) === 'dismissed' && !C.confirmOpen(), String(await settled(q)));
  field.remove();
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
