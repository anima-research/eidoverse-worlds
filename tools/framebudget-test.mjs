// framebudget's rules, headless: one shared budget per frame, first grant may overrun and is carried as debt, a
// starved lane is granted anyway, one gpu unit per frame, busy() from reported loading, the loop is the clock (with a
// fallback that still rolls the books). `node tools/framebudget-test.mjs`
import * as fb from '../client/lib/framebudget.js';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${d}`); } };
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

fb.__resetForTest();
ok('under the splash the budget is the big fixed bite', fb.budgetMs() === 14);
fb.__setBootedForTest(true);
ok('booted: share × period (0.36 × 16.67 ≈ 6 ms)', near(fb.budgetMs(), 6), String(fb.budgetMs()));

// shared budget, first grant, debt
fb.tick(1000);
ok('first ask of a frame is granted', fb.ask('a'));
fb.spent('a', 4);
ok('granted while budget remains', fb.ask('b'));
fb.spent('b', 4);
ok('a DIFFERENT lane is denied once the frame is spent (one budget, shared)', !fb.ask('c'));
fb.tick(1016.67);
ok('the overrun is carried as debt (6 - 2 left)', near(fb.budgetStats().debt, 2), JSON.stringify(fb.budgetStats()));
fb.spent('a', 3.5);
ok('debt shrinks this frame: 3.5 of 4 spent, still room', fb.ask('a'));
fb.spent('a', 1);
ok('…and 4.5 > 4 is denied', !fb.ask('a'));
fb.tick(1033.33);
fb.spent('a', 50);
fb.tick(1050);
ok('debt is capped at one budget — a huge frame cannot starve the next ten', near(fb.budgetStats().debt, fb.budgetMs()));
ok('…and the first grant still passes under full debt', fb.ask('a'));
fb.tick(1051);   // still under full debt; two callers with no history (nothing held, nothing charged)
ok('(setup) full debt', near(fb.budgetStats().debt, fb.budgetMs()), JSON.stringify(fb.budgetStats()));
ok('a cold caller takes the free first grant', fb.ask('cold1'));
ok('…and only ONE: a second cold caller is denied though nothing has been spent', !fb.ask('cold2'));

// aging, per waiter: every frame another lane takes the free first grant and overruns BEFORE the waiter wakes; the
// waiter must still get in after AGE_FRAMES frames (turn counts them), and not before.
{ const rafQ = []; globalThis.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
  let t = 1066.67, got = -1;
  fb.tick((t += 16.67)); fb.ask('hog'); fb.spent('hog', 20);
  const W = fb.turn('waiter').then(() => { got = f; });
  let f = 0;
  for (; f < 20 && got < 0; f++) {
    fb.tick((t += 16.67));
    fb.ask('hog'); fb.spent('hog', 20);                    // the hog is first, every frame
    for (const cb of rafQ.splice(0)) cb(t);
    await settle(1);
  }
  await W;
  // denial 1 is turn's first ask (before the loop); denials 2..8 are loop frames 0..6; frame 7's ask carries waited=8
  ok('a waiter behind a lane that overruns every frame is granted on its 8th denied frame, by aging', got === 7, `granted at frame ${got}`);
  delete globalThis.requestAnimationFrame; }

// the hold: a grant reserves its lane's typical cost until the work reports
{ let t = 3000;
  for (let i = 0; i < 12; i++) { fb.tick((t += 16.67)); fb.ask('heavy'); fb.spent('heavy', 20); }
  fb.tick((t += 16.67)); fb.tick((t += 16.67)); fb.tick((t += 16.67));   // idle frames: debt drains
  ok('(setup) the heavy lane has a history', fb.budgetStats().lanes.heavy.ewma > 10, JSON.stringify(fb.budgetStats().lanes.heavy));
  const g = fb.ask('heavy');
  ok('the heavy lane gets the frame', !!g);
  ok('…and holds its typical cost: another caller is denied before heavy has charged a thing', !fb.ask('light'));
  fb.spent('heavy', 1, null, g);
  ok('the measurement replaces the hold: heavy took 1 ms, so there is room again', fb.ask('light2')); }

// holds are per GRANT: records sharing a lane never release each other's (review 3, F1)
{ let t = 4000;
  for (let i = 0; i < 12; i++) { fb.tick((t += 16.67)); const g = fb.ask('shared'); fb.spent('shared', 2.5, null, g); }
  for (let i = 0; i < 3; i++) fb.tick((t += 16.67));
  const e0 = fb.budgetStats().lanes.shared.ewma;
  ok('(setup) shared lane ~2.4 ms typical, no debt', e0 > 2 && e0 < 2.6 && fb.budgetStats().debt === 0, JSON.stringify(fb.budgetStats()));
  const A = fb.ask('shared'), B = fb.ask('shared'), C = fb.ask('shared');
  ok('(setup) three records granted, their holds fill the frame', A && B && C && !fb.ask('shared'));
  fb.spent('shared', 5, performance.now() - 500, null);        // a FOURTH record reports a stale slice, no grant
  ok('a record reporting without a grant releases nobody else\'s hold', !fb.ask('shared'), JSON.stringify(fb.budgetStats()));
  ok('…and a stale slice leaves the lane\'s estimate alone (review 3, F2)', fb.budgetStats().lanes.shared.ewma === e0, `${e0} → ${fb.budgetStats().lanes.shared.ewma}`);
  fb.spent('shared', 0.5, null, A);
  ok('A\'s own measurement releases A\'s hold: room again', !!fb.ask('shared2'));
  // B's hold belonged to the frame that just rolled; reporting it late must not release anything from THIS frame
  fb.tick((t += 16.67));
  fb.spent('shared', 0, null, B);
  ok('a grant from an earlier frame releases nothing in this one (no phantom room)', fb.budgetStats().spentThis >= 0, String(fb.budgetStats().spentThis)); }

// gpu units (two idle frames first: the aging block left capped debt behind)
fb.tick(1083.33); fb.tick(1086); fb.tick(1090);
ok('the gpu unit of a frame is granted', fb.ask('sky', { gpu: true }));
ok('a second gpu unit in the same frame is not, budget or no', !fb.ask('other', { gpu: true }));
ok('cpu work still has budget in that frame', fb.ask('load'));
fb.tick(1100);
ok('next frame: a gpu unit again', fb.ask('sky', { gpu: true }));

// busy()
ok('nothing reported: not busy', !fb.busy());
fb.reportPending('warm', 2);
ok('reported loading: busy', fb.busy());
fb.reportPending('links', 1);
fb.reportPending('warm', 0);
ok('another lane still loading: busy', fb.busy());
fb.reportPending('links', 0);
ok('all drained: not busy', !fb.busy());

// the governor's knob
fb.setShare(0.25);
ok('share follows the governor', near(fb.budgetMs(), 0.25 * fb.budgetStats().periodMs, 0.02));
fb.setShare(9);
ok('share is clamped', fb.budgetStats().share === 0.8);
fb.setShare(0.25);

// period from the loop: 90 Hz
{ let t = 2000; for (let i = 0; i < 80; i++) fb.tick((t += 1000 / 90)); }
ok('period tracks the loop (≈11.1 ms at 90 Hz)', near(fb.budgetStats().periodMs, 11.11, 0.3), String(fb.budgetStats().periodMs));
ok('…so the budget shrinks with it (0.25 × 11.1 ≈ 2.8 ms)', near(fb.budgetMs(), 2.78, 0.1));

// charging: a slice that began before this frame (resumed from an await) charges nothing
fb.tick(5000);
const before = fb.budgetStats().spentThis;
fb.spent('load', 500, performance.now() - 500);
ok('a slice older than the frame charges 0 (its main-thread share is unknowable)', fb.budgetStats().spentThis === before, String(fb.budgetStats().spentThis));
{ const t0 = performance.now(); while (performance.now() - t0 < 3) {} fb.spent('load', performance.now() - t0, t0); }
ok('…a slice inside the frame charges what it took', fb.budgetStats().spentThis - before >= 2.5, String(fb.budgetStats().spentThis));

// the cap: a slow machine never gets more than the old 6 ms slice
fb.setShare(0.2);
{ let t = 7000; for (let i = 0; i < 80; i++) fb.tick((t += 66)); }
ok('15 fps × 0.2 would be 13 ms: capped at 6', fb.budgetMs() === 6, String(fb.budgetMs()));

// nextFrame: window rAF, raced with the watchdog
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(123456), 16);
{ const f0 = fb.budgetStats().frameNo; await fb.nextFrame(); ok('nextFrame rides rAF and rolls the books', fb.budgetStats().frameNo === f0 + 1); }
{ const f0 = fb.budgetStats().frameNo; await fb.nextFrame(); ok('…once per frame timestamp (rAF waiters in one frame share a roll)', fb.budgetStats().frameNo === f0); }
globalThis.requestAnimationFrame = () => 0;              // a clock that never answers
{ let back = false; const t0 = performance.now(); const q = fb.nextFrame().then(() => { back = true; }); await settle(150);
  ok('a stopped clock: still waiting at 150 ms', !back); await settle(200);
  ok('…the watchdog releases it by 350 ms', back, `${Math.round(performance.now() - t0)} ms`); await q; }
delete globalThis.requestAnimationFrame;
// the watchdog is cleared when the frame answers (review 3, F6)
{ const realClear = globalThis.clearTimeout; let cleared = 0; globalThis.clearTimeout = (id) => { cleared++; return realClear(id); };
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(777777), 5);
  await fb.nextFrame();
  ok('a frame that answers clears its watchdog timer', cleared >= 1, String(cleared));
  globalThis.clearTimeout = realClear; delete globalThis.requestAnimationFrame; }

// a hidden document whose loop still ticks (a PC headset session, desktop window occluded) stays on rAF (review 3, F9)
{ let rafCalls = 0; globalThis.requestAnimationFrame = (cb) => { rafCalls++; return setTimeout(() => cb(888888 + rafCalls), 5); };
  globalThis.document = { hidden: true };
  fb.tick(990000); await fb.nextFrame();
  ok('hidden + live loop: nextFrame rides rAF (the session clock)', rafCalls === 1, String(rafCalls));
  await settle(300); rafCalls = 0; await fb.nextFrame();
  ok('hidden + stopped loop: a timeout stands in (rAF is suspended in a hidden tab)', rafCalls === 0, String(rafCalls));
  delete globalThis.document; delete globalThis.requestAnimationFrame; }

{ fb.__resetForTest(); fb.__setBootedForTest(true); fb.ask('x'); fb.spent('x', 100);
  ok('(setup) over budget before the loop runs', !fb.ask('y'));
  await fb.nextFrame();
  ok('a yield with no loop yet still rolls the frame (boot loading proceeds before startFrame)', fb.ask('y')); }

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
