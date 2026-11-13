import { suite } from "../gate/suite.ts";
// namereveal — hold-to-reveal's input side (client/lib/avatar/namereveal.js), driven directly: the module the client loads.
//
//   bun test/client/namereveal-test.mjs
//
// What must hold: N (bare, not autorepeat, not while typing in a field) starts the reveal, its keyup ends it; sources
// are independent (the key and a second source, `xr`, which no controller binds today — releasing one keeps the other's hold); the level ramps from where
// it is, reaching 1 and 0 in REVEAL_EASE_MS; the action is registered where every binding list reads (actions.js) with
// its key; and N is bound NOWHERE else in the client (the reason it was chosen), nor are the VR reveal's buttons.

const S = suite("namereveal");
const check = (name, ok, detail) => S.check(name, ok, detail);
// a document whose focus the test controls (typingTarget reads document.activeElement)
let active = null;
globalThis.document = { get activeElement() { return active; } };

const R = await import('../../client/lib/avatar/namereveal.js').catch((e) => ({ err: String(e) }));
const A = await import('../../client/lib/actions.js');
const { REVEAL_EASE_MS: E } = await import('../../client/lib/avatar/platesize.js');
check('namereveal.js loads', !R.err && typeof R.setReveal === 'function', R.err);
if (!R.err) {
  const key = (code, extra = {}) => ({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
  check('N starts it', R.revealKeyDown(key('KeyN')));
  check('…not on autorepeat', !R.revealKeyDown(key('KeyN', { repeat: true })));
  check('…not as a chord (Ctrl/⌘/Alt+N belong to the browser and OS)', !R.revealKeyDown(key('KeyN', { ctrlKey: true }))
    && !R.revealKeyDown(key('KeyN', { metaKey: true })) && !R.revealKeyDown(key('KeyN', { altKey: true })));
  check('…not another key', !R.revealKeyDown(key('KeyM')) && !R.revealKeyDown(key('Tab')));
  active = { tagName: 'INPUT', type: 'text' };
  check('…not while typing in a text field', !R.revealKeyDown(key('KeyN')));
  active = { tagName: 'TEXTAREA' };
  check('…nor a textarea', !R.revealKeyDown(key('KeyN')));
  active = { tagName: 'DIV', isContentEditable: true };
  check('…nor contenteditable', !R.revealKeyDown(key('KeyN')));
  active = { tagName: 'INPUT', type: 'range' };
  check('…but a slider in focus does not swallow it', R.revealKeyDown(key('KeyN')));
  active = null;

  // the level, driven with explicit times
  const t = 1e6;
  check('rests at 0', R.revealLevel(t) === 0 && !R.revealHeld());
  R.setReveal('key', true, t);
  check('held: half-way (eased ½) at E/2, full at E', Math.abs(R.revealLevel(t + E / 2) - 0.5) < 1e-9 && R.revealLevel(t + E) === 1, `${R.revealLevel(t + E / 2)}`);
  R.setReveal('xr', true, t + 200);
  R.setReveal('key', false, t + 300);
  check('two sources: releasing the key keeps a second source’s hold', R.revealHeld() && R.revealLevel(t + 400) === 1, JSON.stringify(R.revealSources()));
  R.setReveal('xr', false, t + 500);
  check('last source released: eases out, gone at E', !R.revealHeld() && R.revealLevel(t + 500 + E / 2) > 0 && R.revealLevel(t + 500 + E) === 0);
  R.setReveal('key', true, t + 1000); R.setReveal('key', false, t + 1000 + E / 4);
  const ez = (r) => r * r * (3 - 2 * r);
  check('a quick tap turns back from where it got to (no snap)', Math.abs(R.revealLevel(t + 1000 + E / 4) - ez(0.25)) < 1e-9
    && Math.abs(R.revealLevel(t + 1000 + E / 4 + E / 8) - ez(0.125)) < 1e-9 && R.revealLevel(t + 1000 + E / 2) === 0);
  check('the same source twice is one hold', (R.setReveal('key', true, t + 2000), R.setReveal('key', true, t + 2010), R.revealSources().length === 1));
  R.setReveal('key', false, t + 3000);
}
const a = A.get('key:names');
check('registered in actions.js with its key (N) — every binding list reads it', a && a.key === 'N' && typeof a.run === 'function', JSON.stringify(a && { key: a.key, title: a.title }));
check('…findable by "names"', A.list('names').some((x) => x.action.id === 'key:names'));

// N bound nowhere else, and the VR buttons (no controller button reveals names; B/Y read once, the quick hide): test/client/one-binding-test.ts
// the setting
if (!R.err) {
  const store = new Map(); globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  check('always show names: off by default', !R.alwaysNames());
  R.setAlwaysNames(true);
  check('…on: a reveal source of its own, and persisted', R.alwaysNames() && R.revealHeld() && R.revealSources().includes('always') && store.get(R.ALWAYS_LS) === '1', JSON.stringify(R.revealSources()));
  R.setReveal('key', true); R.setReveal('key', false);
  check('…an N hold and release meanwhile leaves it on', R.revealHeld() && R.alwaysNames());
  R.setAlwaysNames(false);
  check('…off: gone, and stored off', !R.revealHeld() && !R.alwaysNames() && store.get(R.ALWAYS_LS) === '0');
}

S.done();
