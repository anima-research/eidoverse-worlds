// anim-backpressure-test — an anim (up to 64 KB) skips a socket still holding a backlog (security review M5).
//   bun test/server/anim-backpressure-test.ts
const { mkCheck } = await import("../harness/harness.ts");
const { check, tally } = mkCheck();
const { MESSAGES } = await import("../../server/messages.ts");
const got: Record<string, string[]> = {};
const sock = (id: string, buffered: number) => ({ id, ws: { send: (s: string) => { (got[id] ??= []).push(JSON.parse(s).stop ? "stop" : "anim"); }, getBufferedAmount: () => buffered } });
const me = sock("me", 0), quick = sock("quick", 0), slow = sock("slow", 10_000_000);
const world = { clients: new Set([me, quick, slow]), broadcast(m: unknown, except: any) { for (const t of this.clients) if (t !== except) t.ws.send(JSON.stringify(m)); } } as any;
const c = Object.assign(me, { world, spectator: false }) as any;   // the sender is the very socket in the set
const ctx = { c, ws: c.ws, now: Date.now(), expel: () => {} } as any;
MESSAGES["anim"](ctx, { dur: 1, tracks: { hips: [[0, 0, 0, 1]] } });
MESSAGES["anim"](ctx, { stop: true });
check("a reader keeping up gets the anim and the stop", got.quick?.join() === "anim,stop", JSON.stringify(got));
check("a socket holding a backlog skips the anim, but still gets the stop (or a loop would never end)", got.slow?.join() === "stop", JSON.stringify(got));
check("the sender isn't echoed", !got.me, JSON.stringify(got));
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
