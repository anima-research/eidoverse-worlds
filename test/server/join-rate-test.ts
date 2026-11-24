// join-rate-test: joining is bounded where it ships (server/server.ts, server/routes.ts /ws): one connection may join
// JOIN_BURST times at once, then JOIN_RATE a second; a re-join to the world it is already in (an avatar change, a replica's
// resync) is never refused, only held until the bucket has room, the latest one winning; an address may hold
// WS_PER_ADDRESS sockets (the box's own loopback services are not counted). `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/join-rate-test.ts`
import { suite } from "../gate/suite.ts";
import { scratchSequencer } from "../harness/harness.ts";
import { helloOf } from "../../shared/protocol/hello.js";
import { until, tryUntil, pause } from "../gate/wait.ts";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join_ } from "node:path";

const S = suite("join-rate");
const W = "joinrate", W2 = "joinrate-b";
// the worlds' owner is an enrolled agent (keeper, below), so the suite can moderate while everyone else stays a guest
const toks = mkdtempSync(join_(tmpdir(), "join-rate-tok-")); process.on("exit", () => rmSync(toks, { recursive: true, force: true }));
writeFileSync(join_(toks, "tokens.json"), JSON.stringify({ "tok-keeper": { id: "keeper" } }));
const h = await scratchSequencer("join-rate", { worlds: [W, W2], owner: "agent:token:keeper", preload: join_(import.meta.dir, "anon-stats-preload.ts"),
  serverEnv: { JOIN_RATE: "1", JOIN_BURST: "3", WS_PER_ADDRESS: "2", SKIP_OPT_SWEEP: "1", AGENT_TOKENS_PATH: join_(toks, "tokens.json") } });
// the server's guest ids, {held, departed} (anon-stats-preload.ts writes them into the scratch dir)
const anonStats = (): { held: number; departed: number } | null => { try { return JSON.parse(readFileSync(join_(h.SCRATCH, "anon-stats.json"), "utf8")); } catch { return null; } };
const WS = h.BASE.replace("http", "ws") + "/ws";
// a second server at the shipped defaults: what a household or a venue behind one NAT meets
const hd = await scratchSequencer("join-rate-defaults", { worlds: [W], owner: "keeper", serverEnv: { SKIP_OPT_SWEEP: "1" } });
const WSD = hd.BASE.replace("http", "ws") + "/ws";
type Conn = { ws: WebSocket; msgs: any[]; open: Promise<boolean> };
// from: the address a trusted proxy (loopback) says the socket is from; none = the loopback itself
const connect = (from?: string, url = WS): Conn => {
  const ws = new WebSocket(url, from ? { headers: { "x-real-ip": from } } as any : undefined);
  const c: Conn = { ws, msgs: [], open: new Promise((res) => { ws.onopen = () => res(true); ws.onerror = () => res(false); ws.onclose = () => res(false); }) };
  ws.onmessage = (e) => c.msgs.push(JSON.parse(String(e.data)));
  return c;
};
const join = (c: Conn, id: string, world = W, avatar?: string) => c.ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, replica: true, ...(avatar ? { avatar } : {}) }));
// a path names a body as it is (server.ts: no roster lookup), so each change is told apart
const body = (n: string) => `test/${n}.vrm`;
// the avatar the rest of the world last heard `id` arrive in (an observer's view of a body change)
const lastArrive = (o: Conn, id: string) => o.msgs.filter((m) => m.type === "arrive" && m.id === id).at(-1)?.avatar;
const youOf = (c: Conn) => c.msgs.find((m) => m.type === "snapshot")?.you;
const snapshots = (c: Conn) => c.msgs.filter((m) => m.type === "snapshot").length;
const refusals = (c: Conn) => c.msgs.filter((m) => m.type === "error" && m.about === "join").length;
try {
  // J1: ten joins at once on one socket, travelling between two worlds: the burst is served, a travel past it refused in
  // words (j3, j5, j7, j9: the socket stays in the world it was in, so j4, j6, j8 are re-joins to it, held as one), and
  // the socket stays open
  { const c = connect("198.51.100.7"); await c.open;
    for (let i = 0; i < 10; i++) join(c, "hopper", i % 2 ? W2 : W);
    await until("every join is answered", () => snapshots(c) >= 4 && refusals(c) >= 3, { ms: 15_000, step: 50 });
    S.check("J1 ten joins at once travelling between two worlds: JOIN_BURST (3) are served, the travels past it refused", snapshots(c) === 4 && refusals(c) >= 3, { snapshots: snapshots(c), refusals: refusals(c) });
    S.check("J1b ...and the connection stays open (a refused join leaves it where it was)", c.ws.readyState === WebSocket.OPEN);
    // after a pause the bucket refills: a travel runs again
    const before = snapshots(c);
    await tryUntil("a join after a pause runs", async () => { join(c, "hopper", W2); return await until("answered", () => snapshots(c) > before || false, { ms: 1200, step: 50 }).then(() => true, () => false); }, { ms: 8000, step: 600 });
    S.check("J1c a travel after a pause runs again", snapshots(c) > before, { before, now: snapshots(c) });
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
  // J6: an upgrade that fails (a plain GET on /ws) gives its address's socket back: five of them, then the address may still
  // open WS_PER_ADDRESS (2) sockets
  { const http = h.BASE + "/ws";
    const plain: number[] = []; for (let i = 0; i < 5; i++) plain.push((await fetch(http, { headers: { "x-real-ip": "203.0.113.50" } })).status);
    const two = [connect("203.0.113.50"), connect("203.0.113.50")]; const opened = await Promise.all(two.map((x) => x.open));
    S.check("J6 a failed upgrade gives its socket back: after five plain GETs on /ws an address still opens WS_PER_ADDRESS sockets", plain.every((x) => x === 400) && opened.every(Boolean), { plain, opened });
    for (const x of two) try { x.ws.close(); } catch { /* gone */ } }
  // J7: a guest's join refused after its old id was let go (a name refused at the door, past the release in admitJoin): the
  // world hears it leave once, and the name is free again for the next person
  { const o = connect(), g = connect(); await Promise.all([o.open, g.open]);
    join(o, "watcher3"); join(g, "Gus");
    await until("both are in", () => snapshots(o) && snapshots(g), { ms: 10_000, step: 50 });
    const gid = youOf(g);
    join(g, "<b>Gus</b>");   // markup in a typed name: refused (4004) after the old id is released
    await until("the refused guest's socket closes", () => g.ws.readyState === WebSocket.CLOSED, { ms: 5000, step: 20 });
    await until("the world hears the guest leave", () => o.msgs.some((m) => m.type === "leave" && m.id === gid), { ms: 5000, step: 20 });
    await pause("a second leave, if the close sent one, has had its time to arrive", 500);
    // every leave the world heard, under any name: the refused join renamed the socket before refusing it (admitJoin), so
    // a second leave would come under the refused name, not the guest's
    const heard = o.msgs.filter((m) => m.type === "leave").map((m) => m.id), leaves = heard.length;
    const again = connect(); await again.open; join(again, "Gus");
    const back = await tryUntil("the name is taken again", () => snapshots(again) > 0 && youOf(again), { ms: 5000, step: 50 });
    S.check("J7 a guest refused on a re-join, after its old id is let go, leaves the world once, under its own name", leaves === 1 && heard[0] === gid, { heard, gid });
    S.check("J7b ...and its name is free for the next person", back === "Gus", { back, errs: again.msgs.filter((m) => m.type === "error") });
    for (const x of [o, again]) try { x.ws.close(); } catch { /* gone */ } }
  // J8: a guest's refused travel can't speak a leave for someone else: Mal, in W, travels to a world that doesn't exist under
  // Alice's name; the travel leaves W (as Mal), admitJoin takes the name before the refusal, and the close must not then
  // tell W that Alice left (she would vanish for everyone)
  { const alice = connect(), o = connect(), mal = connect(); await Promise.all([alice.open, o.open, mal.open]);
    join(alice, "Alice"); join(o, "watcher4"); join(mal, "Mal");
    await until("all three are in", () => snapshots(alice) && snapshots(o) && snapshots(mal), { ms: 10_000, step: 50 });
    const aliceId = youOf(alice), malId = youOf(mal);
    join(mal, "Alice", "no-such-world-xyz");
    await until("the refused traveller's socket closes", () => mal.ws.readyState === WebSocket.CLOSED, { ms: 5000, step: 20 });
    await until("the world hears Mal leave", () => o.msgs.some((m) => m.type === "leave" && m.id === malId), { ms: 5000, step: 20 });
    await pause("a spoofed leave, if the close sent one, has had its time to arrive", 500);
    const heard = o.msgs.filter((m) => m.type === "leave").map((m) => m.id);
    S.check("J8 a refused travel under another's name broadcasts no leave for them: the world hears only the traveller leave", heard.length === 1 && heard[0] === malId && !heard.includes(aliceId) && !heard.includes("Alice"), { heard, aliceId, malId });
    for (const x of [alice, o]) try { x.ws.close(); } catch { /* gone */ } }
  // J9: a guest's id is let go (directory.ts release) on every way its socket leaves, or ANON_IDS_KEPT never forgets it.
  // A kick (expel) unmaps the socket before closing it, so its close finds no client: the kick itself must let it go. The
  // refusals after the id is minted (a client that doesn't fold the log, an aux leg with no primary) close before they
  // unmap, and one guest leaves normally (the control). Every id these five guests were given is departed afterwards
  { await until("the server's guest ids are readable", () => anonStats(), { ms: 5000, step: 50 });
    const keeper = connect(); await keeper.open;
    keeper.ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id: "keeper", agentToken: "tok-keeper", replica: true }));
    await until("the owner is in", () => snapshots(keeper), { ms: 5000, step: 50 });
    await pause("the earlier sections' closes have landed", 300);
    const before = anonStats()!;
    const g = [connect(), connect(), connect(), connect(), connect()]; await Promise.all(g.map((x) => x.open));
    g[0].ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id: "nofold1" }));   // no replica: refused at the fold check
    g[1].ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id: "nofold2" }));
    g[2].ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: W, id: "nobody-here", surface: "voice", replica: true }));   // aux, no primary
    join(g[3], "leaves-normally"); join(g[4], "kicked-guest");
    await until("the control and the kicked guest are in", () => snapshots(g[3]) && snapshots(g[4]), { ms: 5000, step: 50 });
    g[3].ws.close();
    const kicked = g[4].msgs.find((m) => m.type === "snapshot")?.actor;
    keeper.ws.send(JSON.stringify({ type: "request", id: "k1", verb: "kick", args: { who: kicked } }));
    const kick = await tryUntil("the kick is answered", () => keeper.msgs.find((m) => m.type === "reply" && m.id === "k1"), { ms: 5000, step: 20 });
    await until("every guest's socket closes", () => g.every((x) => x.ws.readyState === WebSocket.CLOSED), { ms: 5000, step: 20 });
    const after = await tryUntil("the server counts five more departed guests", () => { const s = anonStats(); return s && s.departed - before.departed >= 5 ? s : null; }, { ms: 3000, step: 50 }) ?? anonStats()!;
    S.check("J9 a kicked guest, the refused ones (no fold, aux with no primary) and one that leaves all let their ids go: every new guest id is departed",
      kick?.reply?.ok === true && after.held - before.held === 5 && after.departed - before.departed === 5,
      { kick: kick?.reply, before, after, refusals: g.map((x) => x.msgs.find((m) => m.type === "error")?.error?.slice(0, 50) ?? null) });
    keeper.ws.close(); }
  // J9b: the class, not the sites: nothing in server.ts takes a socket off the map but unmap (which lets a guest's id go)
  { const src = readFileSync(join_(import.meta.dir, "../../server/server.ts"), "utf8").split("\n");
    const raw = src.map((l, i) => [i + 1, l] as const).filter(([, l]) => /(?<![\w.])clients\.delete\(/.test(l) && !/^function unmap\(/.test(l));
    S.check("J9b server.ts unmaps sockets only through unmap()", raw.length === 0, raw); }
  // J4: at the defaults, a person changes avatar six times, 150 ms apart (the browser re-sends join on the same socket for
  // each, mybody.js): none is refused, and the world sees the last body
  { const o = connect(undefined, WSD), p = connect("198.51.100.8", WSD); await Promise.all([o.open, p.open]);
    join(o, "watcher"); join(p, "trier", W, body("a0"));
    await until("both are in", () => snapshots(o) && snapshots(p), { ms: 10_000, step: 50 });
    const me = youOf(p);
    for (let i = 1; i <= 6; i++) { join(p, "trier", W, body(`a${i}`)); await pause("swaps at a person's pace, as the repro clicks them", 150); }
    const seen = await tryUntil("the world sees the last body", () => lastArrive(o, me) === body("a6"), { ms: 8000, step: 50 });
    S.check("J4 six avatar changes 150 ms apart at the default JOIN_RATE/JOIN_BURST: none refused, and the world sees the last", refusals(p) === 0 && seen === true, { refused: refusals(p), last: lastArrive(o, me) });
    o.ws.close(); p.ws.close(); }
  // J5: twenty re-joins to the same world at once (a client looping on resync): none refused, the last lands, and the
  // snapshots they cost stay within the bucket (JOIN_BURST 3, then JOIN_RATE 1 a second); a re-join is not a free snapshot
  { const o = connect(), p = connect("198.51.100.9"); await Promise.all([o.open, p.open]);
    join(o, "watcher2"); join(p, "looper", W, body("z0"));
    await until("both are in", () => snapshots(o) && snapshots(p), { ms: 10_000, step: 50 });
    const me = youOf(p), before = snapshots(p);
    for (let i = 1; i <= 20; i++) join(p, "looper", W, body(`z${i}`));
    const seen = await tryUntil("the world sees the last body", () => lastArrive(o, me) === body("z20"), { ms: 8000, step: 50 });
    await pause("nothing more is owed: any re-join still held would run within a second", 1200);
    const cost = snapshots(p) - before;
    S.check("J5 twenty re-joins at once to the same world: none refused, the last lands", refusals(p) === 0 && seen === true, { refused: refusals(p), last: lastArrive(o, me) });
    S.check("J5b ...and they cost at most JOIN_BURST + 1 snapshots, not twenty", cost >= 1 && cost <= 4, { cost });
    o.ws.close(); p.ws.close(); }
  // J3: at the defaults, a household or a venue behind one NAT (seventy people, each with a socket) all get in
  { const many = Array.from({ length: 70 }, () => connect("198.51.100.70", WSD));
    const opened = (await Promise.all(many.map((x) => x.open))).filter(Boolean).length;
    S.check("J3 at the default WS_PER_ADDRESS, seventy sockets from one address (a venue behind one NAT) all open", opened === 70, { opened });
    for (const x of many) try { x.ws.close(); } catch { /* gone */ } }
} finally { await h.cleanup(0); await hd.cleanup(0); }
S.done();
