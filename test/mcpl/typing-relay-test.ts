// The door's typing relay (mcpl/typing-relay.ts) on a short clock: signals at `start`, keeps on while the host re-says
// `start`, stops at `stop` or when the refresh is overdue (a lost `stop` can't leave the dots up), and only through the
// body the latest `start` named. The wire is typing-mcpl-test.ts. Waits: test/gate/wait.ts.

import { TypingRelay, TYPING_REASSERT_MS, TYPING_OVERDUE_MS } from "../../mcpl/typing-relay.ts";
import { suite } from "../gate/suite.ts";
import { tryUntil, pause } from "../gate/wait.ts";

const came = async (what: string, pred: () => boolean, ms: number) => (await tryUntil(what, pred, { ms, step: 5 })) !== undefined;
const S = suite("typing-relay");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

const REASSERT = 40, OVERDUE = 200, DEADLINE = 2000;
const body = () => { const b = { signals: 0, typing() { b.signals++; } }; return b; };
const relay = () => new TypingRelay(REASSERT, OVERDUE);

// defaults sit between the two clocks around the relay: the client draws dots 4 s after a signal; agent-framework re-starts every 7 s
check("the default re-assert is under the client's 4 s window", TYPING_REASSERT_MS < 4000, `${TYPING_REASSERT_MS}`);
check("the default overdue window is over the host's 7 s refresh", TYPING_OVERDUE_MS > 7000, `${TYPING_OVERDUE_MS}`);
check("and leaves a re-assert's worth of margin over it", TYPING_OVERDUE_MS - 7000 >= TYPING_REASSERT_MS, `${TYPING_OVERDUE_MS}`);

{
  const r = relay(), b = body();
  r.start(b);
  check("start signals at once", b.signals === 1, `signals=${b.signals}`);
  check("it keeps signalling while the host's start is fresh", await came("three signals", () => b.signals >= 3, DEADLINE), `signals=${b.signals}`);
  r.stop();
  const atStop = b.signals;
  await pause("no signal may come for three re-asserts after stop", REASSERT * 3);
  check("stop ends the signals", b.signals === atStop && !r.active, `signals ${atStop} -> ${b.signals}`);
}

{
  const r = relay(), b = body();
  const t0 = performance.now();
  r.start(b);
  check("with no refresh, it stops by itself once the refresh is overdue", await came("the overdue stop", () => !r.active, DEADLINE));
  const took = performance.now() - t0;
  check("no sooner than the overdue window", took >= OVERDUE, `stopped after ${took.toFixed(0)} ms`);
  // the stop comes at the first re-assert past the window (a loaded machine only lowers the count)
  check("at the first re-assert past the window", b.signals <= OVERDUE / REASSERT + 1, `signals=${b.signals}`);
  const after = b.signals;
  await pause("no signal may come for three re-asserts after the overdue stop", REASSERT * 3);
  check("and signals no more", b.signals === after, `signals ${after} -> ${b.signals}`);
}

{
  // the default clock is monotonic: a wall clock stepped back an hour must not hold off the overdue stop
  const r = new TypingRelay(REASSERT, OVERDUE), b = body();
  const wall = Date.now;
  try {
    r.start(b);
    Date.now = () => wall() - 3_600_000;
    check("a wall clock stepped back doesn't hold off the overdue stop", await came("the overdue stop", () => !r.active, DEADLINE));
  } finally {
    Date.now = wall;
    r.stop();
  }
}

{
  // a refreshing host keeps the relay up through a window ten refresh intervals wide: only a missed refresh can end it
  const WIDE = 1000, REFRESH = 100;
  const r = new TypingRelay(REASSERT, WIDE), b = body();
  r.start(b);
  let lapsed = false;
  const end = performance.now() + WIDE * 1.5;
  while (performance.now() < end) {
    await pause("the host's refresh interval", REFRESH);
    if (!r.active) lapsed = true;
    r.start(b);
  }
  check("a host that keeps refreshing keeps it up past the overdue window, without a lapse", !lapsed);
  // one signal per start and one re-assert timer: a second timer would add a timer's worth of signals per refresh
  const ms = WIDE * 1.5;
  const expected = ms / REASSERT + ms / REFRESH + 1;
  check("a start while it runs adds no second timer", b.signals <= expected * 1.3, `signals=${b.signals}, expected about ${expected}`);
  r.stop();
}

{
  // a start for another body (the session travelled) moves the signals there: the old body gets no more
  const r = relay(), a = body(), b = body();
  r.start(a);
  r.start(b);
  const aAt = a.signals;
  check("after a start for a new body, the signals go to it", await came("three signals to the new body", () => b.signals >= 3, DEADLINE), `new body signals=${b.signals}`);
  check("and the old body gets none", a.signals === aAt, `old body ${aAt} -> ${a.signals}`);
  r.stop();
}

{
  // WorldAgent.typing's one-a-second throttle is monotonic too: with the wall clock stepped back, it still signals after the second
  const { WorldAgent } = await import("../../mcpl/agent.ts");
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
    await pause("past the body's one-a-second throttle", 1100);
    ag.typing();
    check("a wall clock stepped back doesn't hold the body's next signal", sent === 2, `sent=${sent}`);
  } finally {
    Date.now = wall;
  }
}

S.done();
