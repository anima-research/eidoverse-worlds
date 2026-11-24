// confirmcenter-test — the centre card's one-at-a-time rule: an ask made while a card is open waits its turn, never
// answering the open one (review #359 5: a moderator's warning arriving must not dismiss the consent question). A
// dismissal (closeCenter: a headset session starting) answers each with ITS cancel (confirmCenter → false, askCenter →
// null, chooseCenter → its `cancel`), the waiting ones too, as each function's doc says (bot #213).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/confirmcenter-test.ts
// Mutations (must go red): in client/lib/edit/confirmcenter.js answer the open card when another is asked
// (`open?.settle(open.cancel)` at the top of each ask, as before #359 5); settle a dismissed one with `cancel ?? false`.
// Then (xr-confirm review S3): an Enter aimed at an element outside the card is not the card's (mutation: drop the
// aimedElsewhere line in chooseCenter's onKey), and closeCenter() answers the open card with its cancel, never a yes.
// Then (cold read of #359's fixes): no press or Enter counts in a card's first ARM_MS, and one then isn't kept for later
// (mutation: `armed = () => true` in arm()). The page's clock is the test's: `later()` moves it past a card's arm time.
// And a held key's auto-repeat answers nothing (mutation: drop `!e.repeat` from an onKey's Enter or Escape).
// And a click counts from the press that began it (mutation: `clicked` returns `armed(e)` in arm()).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ width: 800, height: 600 });
let now = 1e6; performance.now = () => now;   // event timeStamps read it too
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  — ${detail}` : ''}`); };
const C = await import('../../client/lib/edit/confirmcenter.js');
const settled = async (p: Promise<any>) => { let v: any = 'unsettled'; p.then((x) => { v = x; }); for (let i = 0; i < 20; i++) await Promise.resolve(); return v; };
const title = () => document.querySelector('#confirm-center #cc-title')?.textContent ?? null;
const later = () => { now += C.ARM_MS; };   // a person's time to see the card: an answer counts from then on
// a click on the open card's button `label`, by default once the card can be answered
const press = (label: string, { early = false } = {}) => { if (!early) later(); [...document.querySelectorAll('#confirm-center button')].find((b) => b.textContent === label)?.click(); };
const enter = (target: Element | null = document.activeElement) => target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
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
{ // (cold read) the first ARM_MS of a card: a press or an Enter then was meant for what was there before, and counts for nothing
  const a = C.chooseCenter({ title: 'consent', choices: [{ v: 'yes', label: 'Turn on' }, { v: 'no', label: 'Not now' }], cancel: 'dismissed', focus: 'no' });
  press('Turn on', { early: true });
  check('a click in a card\'s first ARM_MS answers nothing: the card stays open', (await settled(a)) === 'unsettled' && title() === 'consent', String(await settled(a)));
  enter();
  check('…nor does an Enter on its focused Not now (no remembered no)', (await settled(a)) === 'unsettled' && C.confirmOpen(), String(await settled(a)));
  later();
  check('…and neither is kept for later: once it can be answered, it is still open', (await settled(a)) === 'unsettled' && C.confirmOpen(), String(await settled(a)));
  enter();
  check('…and an Enter then answers it (Not now, its focused choice)', (await settled(a)) === 'no' && !C.confirmOpen(), String(await settled(a)));
  const b = C.confirmCenter({ title: 'first' }), c = C.confirmCenter({ title: 'second' });
  press('OK'); press('OK', { early: true });   // a double-press: the second lands on the next card, just shown where the first was
  check('a double-press answers the first card and not the one shown in its place', (await settled(b)) === true && (await settled(c)) === 'unsettled' && title() === 'second', `${await settled(b)} / ${await settled(c)} / ${title()}`);
  press('Cancel');
  check('…which a press once it can be answered does answer', (await settled(c)) === false && !C.confirmOpen(), String(await settled(c)));
  const d = C.askCenter({ title: 'name?', value: 'x' }); enter(document.querySelector('#confirm-center input'));
  const dEarly = await settled(d); later(); enter(document.querySelector('#confirm-center input'));
  check('an askCenter Enter in its first ARM_MS answers nothing; one after answers the field', dEarly === 'unsettled' && (await settled(d)) === 'x', `${dEarly} / ${await settled(d)}`);
  const e = C.chooseCenter({ title: 'esc', choices: [{ v: 'go', label: 'Go' }], cancel: 'stay' });
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  check('a dismissal (Esc) is never held back: it is no answer', (await settled(e)) === 'stay' && !C.confirmOpen(), String(await settled(e)));
}
{ // (cold read) a held key: its first keydown answers the card, its auto-repeat (repeat: true) never answers the next one
  const key = (k: string, repeat: boolean) => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, repeat, bubbles: true, cancelable: true }));
  const a = C.confirmCenter({ title: 'A' }), b = C.confirmCenter({ title: 'B' });
  later(); key('Enter', false); later(); key('Enter', true);
  check('Enter held down answers the card it was pressed on, and its repeat never the next (its OK focused)', (await settled(a)) === true && (await settled(b)) === 'unsettled' && title() === 'B', `${await settled(a)} / ${await settled(b)} / ${title()}`);
  key('Escape', true);
  check('…nor does a held Escape\'s repeat', (await settled(b)) === 'unsettled' && C.confirmOpen(), String(await settled(b)));
  key('Escape', false);
  const c = C.chooseCenter({ title: 'consent', choices: [{ v: 'yes', label: 'Turn on' }, { v: 'no', label: 'Not now' }], cancel: 'dismissed', focus: 'no' });
  later(); key('Enter', true);
  const d = C.askCenter({ title: 'name?', value: 'x' }); later(); key('Enter', true);   // waits behind c: the field isn't up, the key goes to c
  check('a repeat on a chooseCenter card answers nothing (no remembered no)', (await settled(c)) === 'unsettled', String(await settled(c)));
  C.closeCenter();
  check('…and closeCenter still dismisses each (dismissed, null)', (await settled(c)) === 'dismissed' && (await settled(d)) === null, `${await settled(c)} / ${await settled(d)}`);
  const f = C.askCenter({ title: 'name?', value: 'y' }); later(); key('Enter', true);
  check('a repeat on an askCenter field answers nothing', (await settled(f)) === 'unsettled' && C.confirmOpen(), String(await settled(f)));
  key('Enter', false);
  check('…and a fresh Enter there answers it', (await settled(f)) === 'y', String(await settled(f)));
}
{ // (cold review of the arm time) a pointer's click is its release: it counts from the press that began it. A press
  // that starts in a card's first ARM_MS and is let go after was meant for what was there before (a double-press held a
  // moment), and answers nothing; nor does a click whose press the card never saw (it began before the card was there)
  const at = (b: Element | undefined, type: string, init: any = {}) => b?.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, ...init }));
  const btn = (label: string) => [...document.querySelectorAll('#confirm-center button')].find((b) => b.textContent === label);
  const hold = (label: string, down: number, up: number) => { const t0 = now, b = btn(label);
    now = t0 + down; at(b, 'pointerdown', { pointerType: 'mouse' }); at(b, 'mousedown');
    now = t0 + up; at(b, 'pointerup', { pointerType: 'mouse' }); at(b, 'mouseup'); at(b, 'click', { detail: 1 }); now = t0; };
  const consent = () => C.chooseCenter({ title: 'consent', choices: [{ v: 'yes', label: 'Turn on' }, { v: 'no', label: 'Not now' }], cancel: 'dismissed' });
  const a = consent(); hold('Turn on', 300, 470);
  check('a mouse press begun 300 ms after the card appeared and let go at 470 answers nothing', (await settled(a)) === 'unsettled' && C.confirmOpen(), String(await settled(a)));
  C.closeCenter(); const b = consent(); hold('Turn on', 120, 470);
  check('…nor one begun at 120 ms and let go at 470', (await settled(b)) === 'unsettled' && C.confirmOpen(), String(await settled(b)));
  C.closeCenter(); const c = consent(); later(); at(btn('Turn on'), 'click', { detail: 1 });
  check('a pointer click whose press the card never saw answers nothing', (await settled(c)) === 'unsettled' && C.confirmOpen(), String(await settled(c)));
  hold('Turn on', 0, 10);
  check('…and a press begun once the card can be answered is its answer', (await settled(c)) === 'yes' && !C.confirmOpen(), String(await settled(c)));
  const d = consent(), t0 = now; now = t0 + 300; btn('Turn on')?.focus(); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  now = t0 + 470; at(btn('Turn on'), 'click');   // Space's click comes at its keyup (detail 0)
  check('Space pressed at 300 ms and let go at 470 answers nothing', (await settled(d)) === 'unsettled' && C.confirmOpen(), String(await settled(d)));
  C.closeCenter(); const e = consent(); later(); at(btn('Turn on'), 'click');
  check('…while a click with no press behind it (a script, assistive tech) still counts from when it lands', (await settled(e)) === 'yes', String(await settled(e)));
}
{ // (review #359 10) max: null is no limit: the speech server's address (audio/ttsrow.js) was unlimited in main's prompt()
  const long = 'ws://127.0.0.1:8927/?sig=' + 'a'.repeat(400);
  const a = C.askCenter({ title: 'Add a speech server', value: long, max: null });
  const inp = document.querySelector('#confirm-center input') as HTMLInputElement | null;
  const shown = inp?.value.length ?? -1; press('Save');
  check('askCenter with max: null keeps a 425-character value whole, and answers it', shown === long.length && (await settled(a)) === long, `${shown} shown, ${String(await settled(a)).length} answered`);
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
