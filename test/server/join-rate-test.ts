// join-rate-test: joining is bounded where it ships (server/server.ts, server/routes.ts /ws): one connection may join
// JOIN_BURST times at once, then JOIN_RATE a second; an address may hold WS_PER_ADDRESS sockets (the box's own loopback
// services are not counted). `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/join-rate-test.ts`
import { suite } from "../gate/suite.ts";
import { scratchSequencer } from "../harness/harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";
import { until, tryUntil } from "../gate/wait.ts";

const S = suite("join-rate");
const W = "joinrate";
const h = await scratchSequencer("join-rate", { worlds: [W], owner: "keeper",
  serverEnv: { JOIN_RATE: "1", JOIN_BURST: "3", WS_PER_ADDRESS: "2", SKIP_OPT_SWEEP: "1" } });
const WS = h.BASE.replace("http", "ws") + "/ws";
type Conn = { ws: WebSocket; msgs: any[]; open: Promise<boolean> };
// from: the address a trusted proxy (loopback) says the socket is from; none = the loopback itself
const connect = (from?: string): Conn => {
  const ws = new WebSocket(WS, from ? { headers: { "x-real-ip": from } } as any : undefined);
  const c: Conn = { ws, msgs: [], open: new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); ws.onclose = () => res(false); }) };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(String(e.data)));
  return c;
};
const join = (c: Conn, id: string) => c.ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id, replica: true }));
const snapshots = (c: Conn) => c.msgs.filter((m) => m.type === "snapshot").length;
const refusals = (c: Conn) => c.msgs.filter((m) => m.type === "error" && m.about === "join").length;
try {
  // J1: ten joins at once on one socket: the burst is served, the rest refused in words, and the socket stays open
  { const c = connect("198.51.100.7"); await c.open;
    for (let i = 0; i < 10; i++) join(c, "hopper");
    await until("every join is answered", () => snapshots(c) + refusals(c) >= 10, { ms: 15_000, step: 50 });
    S.check("J1 ten joins at once on one connection: JOIN_BURST (3) are served, the rest refused", snapshots(c) <= 4 && refusals(c) >= 6, { snapshots: snapshots(c), refusals: refusals(c) });
    S.check("J1b ...and the connection stays open (a refused join leaves it where it was)", c.ws.readyState === WebSocket.OPEN);
    // after a pause the bucket refills: a join runs again
    const before = snapshots(c);
    await tryUntil("a join after a pause runs", async () => { join(c, "hopper"); return await until("answered", () => snapshots(c) > before || false, { ms: 1200, step: 50 }).then(() => true, () => false); }, { ms: 8000, step: 600 });
    S.check("J1c a join after a pause runs again", snapshots(c) > before, { before, now: snapshots(c) });
    c.ws.close(); }
  // J2: an address holds at most WS_PER_ADDRESS sockets; another address, and the loopback, are not refused
  { const a = connect("203.0.113.9"), b = connect("203.0.113.9");
    const ab = await Promise.all([a.open, b.open]);
    const third = connect("203.0.113.9"); const t = await third.open;
    const other = connect("192.0.2.44"); const o = await other.open;
    const locals = [connect(), connect(), connect()]; const l = await Promise.all(locals.map((x) => x.open));
    S.check("J2 a third socket from one address is refused at WS_PER_ADDRESS=2", ab.every(Boolean) && t === false, { ab, third: t });
    S.check("J2b ...another address is not", o === true);
    S.check("J2c ...nor the box's own loopback (its renderers and agent door)", l.every(Boolean), l);
    a.ws.close();
    await until("the closed socket is let go", () => a.ws.readyState === WebSocket.CLOSED, { ms: 3000, step: 20 });
    const again = await tryUntil("a socket from that address opens again", async () => { const x = connect("203.0.113.9"); const ok = await x.open; if (ok) x.ws.close(); return ok || null; }, { ms: 5000, step: 100 });
    S.check("J2d once one of its sockets closes, the address may open another", again === true);
    for (const x of [b, third, other, ...locals]) try { x.ws.close(); } catch { /* gone */ } }
} finally { await h.cleanup(0); }
S.done();
