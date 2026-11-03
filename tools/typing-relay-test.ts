// The door's typing relay (mcpl/typing-relay.ts), on a short clock: it signals
// at `start`, keeps signalling while the host keeps saying `start`, stops at
// `stop`, stops by itself when the host's refresh is overdue, so a lost `stop`
// can't leave the dots up, and signals only through the body the latest
// `start` named. The wire is covered by typing-mcpl.test.ts.
//
// Waits poll for what they expect, with a deadline, rather than sleeping a
// fixed time, so a slow machine delays a pass instead of failing one.

import { TypingRelay, TYPING_REASSERT_MS, TYPING_OVERDUE_MS } from "../mcpl/typing-relay.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (pred: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(5); }
  return pred();
};
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

const REASSERT = 40, OVERDUE = 200, DEADLINE = 2000;
const body = () => { const b = { signals: 0, typing() { b.signals++; } }; return b; };
const relay = () => new TypingRelay(REASSERT, OVERDUE);

// The defaults are set against the two clocks around the relay: the client
// draws the dots for 4 s after a signal, and agent-framework refreshes its
// `start` every 7 s.
check("the default re-assert is under the client's 4 s window", TYPING_REASSERT_MS < 4000, `${TYPING_REASSERT_MS}`);
check("the default overdue window is over the host's 7 s refresh", TYPING_OVERDUE_MS > 7000, `${TYPING_OVERDUE_MS}`);
check("and leaves a re-assert's worth of margin over it", TYPING_OVERDUE_MS - 7000 >= TYPING_REASSERT_MS, `${TYPING_OVERDUE_MS}`);

{
  const r = relay(), b = body();
  r.start(b);
  check("start signals at once", b.signals === 1, `signals=${b.signals}`);
  check("it keeps signalling while the host's start is fresh", await waitUntil(() => b.signals >= 3, DEADLINE), `signals=${b.signals}`);
  r.stop();
  const atStop = b.signals;
  await sleep(REASSERT * 3);
  check("stop ends the signals", b.signals === atStop && !r.active, `signals ${atStop} -> ${b.signals}`);
}

{
  const r = relay(), b = body();
  const t0 = performance.now();
  r.start(b);
  check("with no refresh, it stops by itself once the refresh is overdue", await waitUntil(() => !r.active, DEADLINE));
  const took = performance.now() - t0;
  check("no sooner than the overdue window", took >= OVERDUE, `stopped after ${took.toFixed(0)} ms`);
  // The overdue check runs at each re-assert, so the stop comes at the first
  // one past the window: the start's signal and one per interval inside it.
  // A loaded machine only delays ticks, which lowers the count; a stop checked
  // less often raises it.
  check("at the first re-assert past the window", b.signals <= OVERDUE / REASSERT + 1, `signals=${b.signals}`);
  const after = b.signals;
  await sleep(REASSERT * 3);
  check("and signals no more", b.signals === after, `signals ${after} -> ${b.signals}`);
}

{
  // The default clock is monotonic: a wall clock stepped back an hour after
  // the start must not hold off the overdue stop.
  const r = new TypingRelay(REASSERT, OVERDUE), b = body();
  const wall = Date.now;
  try {
    r.start(b);
    Date.now = () => wall() - 3_600_000;
    check("a wall clock stepped back doesn't hold off the overdue stop", await waitUntil(() => !r.active, DEADLINE));
  } finally {
    Date.now = wall;
    r.stop();
  }
}

{
  // A host that keeps refreshing: the relay must stay up through the whole
  // window, not lapse at each overdue and come back at the next start. The
  // window here is ten refresh intervals wide, so only a missed refresh, not
  // a slow one, can end it.
  const WIDE = 1000, REFRESH = 100;
  const r = new TypingRelay(REASSERT, WIDE), b = body();
  r.start(b);
  let lapsed = false;
  const until = performance.now() + WIDE * 1.5;
  while (performance.now() < until) {
    await sleep(REFRESH);
    if (!r.active) lapsed = true;
    r.start(b);
  }
  check("a host that keeps refreshing keeps it up past the overdue window, without a lapse", !lapsed);
  // Each start signals once and one timer re-asserts; a second timer per start
  // would add a timer's worth of signals for every refresh.
  const ms = WIDE * 1.5;
  const expected = ms / REASSERT + ms / REFRESH + 1;
  check("a start while it runs adds no second timer", b.signals <= expected * 1.3, `signals=${b.signals}, expected about ${expected}`);
  r.stop();
}

{
  // A start for another body (the session travelled) moves the signals there:
  // the old body gets no more.
  const r = relay(), a = body(), b = body();
  r.start(a);
  r.start(b);
  const aAt = a.signals;
  check("after a start for a new body, the signals go to it", await waitUntil(() => b.signals >= 3, DEADLINE), `new body signals=${b.signals}`);
  check("and the old body gets none", a.signals === aAt, `old body ${aAt} -> ${a.signals}`);
  r.stop();
}

{
  // The body's own one-a-second throttle (WorldAgent.typing) runs on a
  // monotonic clock too: with the wall clock stepped back an hour, its next
  // signal still goes out once the second has passed.
  const { WorldAgent } = await import("../mcpl/agent.ts");
  const ag = new WorldAgent({ name: "throttle-test", world: "nowhere", url: "ws://127.0.0.1:1/ws" });
  let sent = 0;
  ag.joined = true;
  ag.ws = { readyState: 1, send() { sent++; } } as unknown as WebSocket;
  ag.typing();
  const wall = Date.now;
  try {
    Date.now = () => wall() - 3_600_000;
    ag.typing();
    check("the body sends at most one typing signal a second", sent === 1, `sent=${sent}`);
    await sleep(1100);
    ag.typing();
    check("a wall clock stepped back doesn't hold the body's next signal", sent === 2, `sent=${sent}`);
  } finally {
    Date.now = wall;
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
