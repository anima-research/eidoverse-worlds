// msgrate-test — the per-connection message cap (server/msgrate.ts), on a hand clock: a backlog of up to the burst (two
// seconds' worth) is not charged to the client — a longer stall is; a sustained flood is refused as before; legal steady traffic never is.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/msgrate-test.ts
import { newBucket, admitMessage } from "../../server/msgrate.ts";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  " + JSON.stringify(info)}`); };
const RATE = 60;

// the cap as it was until 10-22 (server.ts: a one-second window, counted when handled), kept here as the control
const oldWindow = () => { const c = { win: 0, n: 0 }; return (now: number) => { if (now - c.win > 1000) { c.win = now; c.n = 0; } return ++c.n > RATE ? (c.n <= 2 * RATE ? "refuse" : "drop") : "run"; }; };
const bucket = () => { const b = newBucket(2 * RATE); return (now: number) => admitMessage(b, now, RATE); };

/** arrival times: one message every `every` ms from `from` up to (not including) `to` */
const stream = (from: number, to: number, every: number) => { const out: number[] = []; for (let t = from; t < to; t += every) out.push(t); return out; };
const run = (limiter: (now: number) => string, handledAt: number[]) => { const tally: Record<string, number> = { run: 0, refuse: 0, drop: 0 }; for (const t of [...handledAt].sort((a, b) => a - b)) tally[limiter(t)]++; return tally; };

// B1: a legal 40 msgs/s; the authority stalls 1.5 s (2.0–3.5 s); what arrived meanwhile is handled at 3.5 s, all at once
{ const arrivals = stream(0, 6000, 25);   // 40/s
  const handled = arrivals.map((t) => (t >= 2000 && t < 3500 ? 3500 : t));
  const old = run(oldWindow(), handled), now = run(bucket(), handled);
  check("B1 control: the old window charges the server's 1.5 s stall to a client sending a legal 40/s (it refuses some)", old.refuse + old.drop > 0, old);
  check("B1 the bucket refuses none of it", now.refuse === 0 && now.drop === 0 && now.run === arrivals.length, now); }

// B2: steady legal traffic just under the rate, 10 s: never refused, by either
{ const handled = stream(0, 10_000, 1000 / 55);
  const old = run(oldWindow(), handled), now = run(bucket(), handled);
  check("B2 a steady 55/s for 10 s is never refused (old window and bucket alike)", old.run === handled.length && now.run === handled.length, { old, now }); }

// B3: a sustained flood, 200/s for 3 s: the bucket runs at most its burst plus the rate × time, refuses the rest
{ const handled = stream(0, 3000, 5);   // 200/s → 600 messages
  const now = run(bucket(), handled), allowed = 2 * RATE + 3 * RATE;
  check("B3 a 200/s flood for 3 s: at most burst + 60/s runs (≤ 300 of 600), the rest refused or dropped", now.run <= allowed + 1 && now.run >= allowed - 2 && now.refuse + now.drop === handled.length - now.run, { now, allowed }); }

// B4: over the limit a request is answered, but at most `rate` answers a second; past that it's dropped
{ const b = newBucket(2 * RATE); let refused = 0, dropped = 0;
  for (let i = 0; i < 2 * RATE; i++) admitMessage(b, 0, RATE);   // spend the burst at t=0
  for (let i = 0; i < 3 * RATE; i++) { const v = admitMessage(b, 0, RATE); if (v === "refuse") refused++; else if (v === "drop") dropped++; }
  check("B4 past the bucket, at most 60 refusals are answered in a second; the rest are dropped (a flood can't buy replies)", refused === RATE && dropped === 2 * RATE, { refused, dropped }); }

// B5: the bucket refills: after a flood, a pause of 2 s gives the whole burst back
{ const b = newBucket(2 * RATE); for (let i = 0; i < 500; i++) admitMessage(b, 0, RATE);
  let ok = 0; for (let i = 0; i < 2 * RATE; i++) if (admitMessage(b, 2000, RATE) === "run") ok++;
  check("B5 two quiet seconds after a flood refill the whole burst (120 run again)", ok === 2 * RATE, ok); }

// B6: a clock that steps back (WSL, 10-22) never adds tokens
{ const b = newBucket(2 * RATE); for (let i = 0; i < 2 * RATE; i++) admitMessage(b, 10_000, RATE);
  check("B6 a clock stepping back 1.4 s adds no tokens", admitMessage(b, 8600, RATE) !== "run", b); }

// W1: the cap where it ships (server/server.ts websocket.message), not just the bucket: a scratch server at MSG_RATE=10
{ const { scratchSequencer } = await import("../harness/harness.ts");
  const { helloOf } = await import("../../shared/protocol/hello.js");
  const W = "ratewire", WIRE_RATE = 10;
  const h = await scratchSequencer("msgrate", { worlds: [W], owner: "keeper", serverEnv: { MSG_RATE: String(WIRE_RATE), TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" } });
  const WS = h.BASE.replace("http", "ws") + "/ws";
  const join = (id: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
    const ws = new WebSocket(WS), c = { ws, msgs: [] as any[] }, t = setTimeout(() => rej(new Error(`${id}: no snapshot`)), 8000);
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); c.msgs.push(m); if (m.type === "snapshot") { clearTimeout(t); res(c); } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id, replica: true }));
  });
  try {
    const flood = await join("flooder"), calm = await join("calm");
    for (let i = 0; i < 2 * WIRE_RATE + 25; i++) flood.ws.send(JSON.stringify({ type: "request", id: `f${i}`, verb: "help", args: {} }));
    await h.sleep(1500);   // a quiet period: the refusal count below is over the whole flood
    const rate = flood.msgs.filter((m) => m.type === "reply" && m.reply?.refused?.code === "rate");
    check("W1 a flood past MSG_RATE on one connection is refused with code rate, from this connection", rate.length > 0 && rate.every((m) => /from this connection/.test(m.reply.refused.reason)), rate[0] ?? flood.msgs.length);
    check("W1 ...at most MSG_RATE refusals answered in that second (a flood can't buy replies)", rate.length <= WIRE_RATE, rate.length);
    const before = calm.msgs.length; calm.ws.send(JSON.stringify({ type: "request", id: "c1", verb: "help", args: {} }));
    const { tryUntil } = await import("../gate/wait.ts");
    const mine = await tryUntil("calm's reply", () => calm.msgs.slice(before).find((m) => m.type === "reply" && m.id === "c1"), { ms: 5000 });
    check("W1 another connection's request still runs", mine?.ok === true, mine);
    flood.ws.close(); calm.ws.close();
  } finally { await h.cleanup(fail ? 1 : 0); }
}

console.log(`[msgrate-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
