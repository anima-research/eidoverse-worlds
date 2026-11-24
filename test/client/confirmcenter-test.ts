// confirmcenter-test — the centre card's one-at-a-time rule: an ask made while a card is open waits its turn, never
// answering the open one (review #359 5: a moderator's warning arriving must not dismiss the consent question). A
// dismissal (closeCenter: a headset session starting) answers each with ITS cancel (confirmCenter → false, askCenter →
// null, chooseCenter → its `cancel`), the waiting ones too, as each function's doc says (bot #213).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/confirmcenter-test.ts
// Mutations (must go red): in client/lib/edit/confirmcenter.js answer the open card when another is asked
// (`open?.settle(open.cancel)` at the top of each ask, as before #359 5); settle a dismissed one with `cancel ?? false`.
// Then (xr-confirm review S3): an Enter aimed at an element outside the card is not the card's (mutation: drop the
// aimedElsewhere line in chooseCenter's onKey), and closeCenter() answers the open card with its cancel, never a yes.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 800, height: 600 });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const C = await import('../../client/lib/edit/confirmcenter.js');
const settled = async (p: Promise<any>) => { let v: any = 'unsettled'; p.then((x) => { v = x; }); for (let i = 0; i < 20; i++) await Promise.resolve(); return v; };
const title = () => document.querySelector('#confirm-center #cc-title')?.textContent ?? null;
const press = (label: string) => [...document.querySelectorAll('#confirm-center button')].find((b) => b.textContent === label)?.click();
{ const a = C.chooseCenter({ title: 'consent', choices: [{ v: 'yes', label: 'Turn on' }, { v: 'no', label: 'Not now' }], cancel: 'dismissed' });
  const b = C.confirmCenter({ title: 'A moderator warned you', ok: 'I understand', cancel: 'Close' });
  check('an ask made while a card is open waits: the open one stays, unanswered', (await settled(a)) === 'unsettled' && title() === 'consent', `${await settled(a)} / ${title()}`);
  check('…and the waiting one is not answered either', (await settled(b)) === 'unsettled', String(await settled(b)));
  press('Not now');
  check('answering the open one gives ITS answer, and the waiting one is shown next', (await settled(a)) === 'no' && title() === 'A moderator warned you', `${await settled(a)} / ${title()}`);
  press('I understand');
  check('…which is answered in its turn, and then nothing is open', (await settled(b)) === true && !C.confirmOpen(), String(await settled(b)));
}
{ const a = C.askCenter({ title: 'name?' }), b = C.confirmCenter({ title: 'sure?' });
  const c = C.chooseCenter({ title: 'lock', choices: [{ v: 'move', label: 'Move anyway' }, { v: 'no', label: 'Cancel' }], cancel: 'no' });
  const d = C.chooseCenter({ title: 'lock2', choices: [{ v: 'x', label: 'x' }] });
  C.closeCenter();
  const got = [await settled(a), await settled(b), await settled(c), await settled(d)];
  check('a dismissal answers the open card and every waiting one with its own cancel (null, false, its cancel, null)', JSON.stringify(got) === JSON.stringify([null, false, 'no', null]) && !C.confirmOpen(), JSON.stringify(got));
}
{
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
