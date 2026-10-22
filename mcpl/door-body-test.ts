/**
 * The door's own body state: a tracks loop and treading water, a reach the
 * relay holds to more than one body, and a walk carried across a rejoin.
 *
 * Run: bun mcpl/door-body-test.ts
 *
 * The reach rows run on a bare WorldAgent (no world). The walk rows join a
 * stand-in world on a WebSocket, which then drops the connection, so the
 * rejoin is the agent's own: its snapshot resumes the walk.
 */
import { WorldAgent } from "./agent.ts";
import { pointClass } from "../shared/protocol/consent.js";
import { wireState } from "../shared/protocol/replica.js";
import { emptyState } from "../shared/protocol/fold.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await sleep(20); return ok(); };

console.log("a tracks loop");
{
  // Treading water is a swimmer at rest. A loop started while treading plays on; a swim stroke is a move, and ends it.
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  ag.anims = [{ name: "wave", mode: "loop", kind: "track" }];
  ag.clip = "tread"; ag.target = null;
  ag.watchAnim();
  check("a tracks loop plays on while its body treads water", ag.anims.some((a: any) => a.kind === "track"));
  ag.clip = "swim";
  ag.watchAnim();
  check("...and a swim ends it, as a move", !ag.anims.some((a: any) => a.kind === "track"));
}

console.log("a reach held to two bodies");
// Ann stands at the origin and Cal 0.1 m from her, so a point at chest height between them lands in both. Cal stands
// further off, at x = 2, in the frame rows. The relay holds a reach to every body its point lands in (reachgate.ts
// touched) and strips it if any of them refuses.
const pose = (p: number[], extra: Record<string, unknown> = {}) => ({ p, yaw: 0, speed: 0, clip: "idle", ...extra });
const reacher = (cal: number[], ann: Record<string, unknown> = {}) => {
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  ag.people.set("Ann", { id: "Ann", avatar: "", pose: pose([0, 0, 0], ann) });
  ag.people.set("Cal", { id: "Cal", avatar: "", pose: pose(cal) });
  ag.actorIds.set("Ann", "a-ann"); ag.actorIds.set("Cal", "a-cal");
  ag.joined = true;
  ag.refreshReachReading = async () => {};
  ag.solveReachEntry = () => ({ state: "pending" });
  return ag;
};
const refusal = (to: string, cls: string, ago = 0) => ({ to, cls, why: "their table says no", limb: "rightHand", ts: Date.now() - ago });
// a refusal said for this reach, not one said earlier and read back (that one's words say when it was said)
const fresh = (r: any, who: string) => r.ok === false && new RegExp(`${who}'s consent refused it`).test(r.text) && /nobody saw your hand there/.test(r.text);
const between = [0.05, 1.2, 0];
const annCls = pointClass([0, 0, 0], between), calCls = pointClass([0, 0, 0], [between[0] - 0.1, between[1], between[2]]);
check("(the point between them lands in both bodies)", !!annCls && !!calCls);
{
  const ag = reacher([0.1, 0, 0]);
  setTimeout(() => ag.reachRefusals.push(refusal("a-cal", calCls)), 60);
  const r = await ag.reach("rightHand", { p: between });
  check("a reach refused by the second body it lands in is refused", fresh(r, "Cal"), r.text);
  check("...and withdrawn", !ag.reaches.has("rightHand"));
}
{
  const ag = reacher([0.1, 0, 0]);
  setTimeout(() => ag.reachRefusals.push(refusal("a-ann", annCls)), 60);
  const r = await ag.reach("rightHand", { p: between });
  check("...and so is one refused by the first", fresh(r, "Ann"), r.text);
}
{
  // the relay says a refusal once per REACH_NOTE_MS, so one said a second ago stands for this reach too
  const ag = reacher([0.1, 0, 0]);
  ag.reachRefusals.push(refusal("a-cal", calCls, 1000));
  const r = await ag.reach("rightHand", { p: between });
  check("a refusal the second body said a moment ago stands for a reach again", r.ok === false && /Cal's consent refused it/.test(r.text) && /That was said/.test(r.text), r.text);
}
// A point in a body's own frame lands where its pose draws it. Ann's frame here is turned a quarter about +y by her pose's
// q (a swimmer's whole-body turn), with her yaw left at 0: 2 m in front of her, in her frame, is then at x = 2, in Cal.
const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const ahead = [0, 1.2, 2];
const calThere = pointClass([0, 0, 0], [0, 1.2, 0]);
check("(2 m in front of a body is beside it, not in it)", !pointClass([0, 0, 0], ahead) && !!calThere);
{
  const ag = reacher([2, 0, 0], { q: quarter });
  setTimeout(() => ag.reachRefusals.push(refusal("a-cal", calThere)), 60);
  const r = await ag.reach("rightHand", { p: ahead, space: "Ann" });
  check("a point in a turned body's frame is held to the body it lands in, by its pose's q", fresh(r, "Cal"), r.text);
}
{
  // this body's own frame, turned by its yaw
  const ag = reacher([2, 0, 0]);
  ag.yaw = Math.PI / 2;
  setTimeout(() => ag.reachRefusals.push(refusal("a-cal", calThere)), 60);
  const r = await ag.reach("rightHand", { p: ahead, space: "self" });
  check("...and so is a point in this body's own frame, by its yaw", fresh(r, "Cal"), r.text);
}
{
  // a reach that streamed, and is refused later by a body its point lands in that it doesn't name
  const ag = reacher([2, 0, 0], { q: quarter });
  ag.reaches.set("rightHand", { t: { p: ahead, space: "Ann" } });
  const dropped = ag.dropReachesAt("a-cal", "rightHand", calThere);
  check("a later refusal from a body the reach lands in withdraws it", dropped.length === 1 && !ag.reaches.has("rightHand"), JSON.stringify(dropped));
}

console.log("a walk carried across a rejoin");
{
  // A stand-in world: every join is answered with an empty world's snapshot.
  const snapshot = () => JSON.stringify({ type: "snapshot", state: null, entries: [], present: [], cut: { state: wireState(emptyState()), head: 0, worldId: "w" } });
  const sockets = new Map<string, any>();
  const world = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("no", { status: 404 }); },
    websocket: { message(ws, data) { const m = JSON.parse(String(data)); if (m.type === "join") { sockets.set(m.id, ws); ws.send(snapshot()); } } },
  });
  // The authority's answers to "move", which the stand-in leaves to this row: while `held`, an asked move waits (a request
  // the old connection sent, answered only after the rejoin); else it is answered yes at once, at the point asked.
  const walker = (name: string) => {
    const ag: any = new WorldAgent({ name, world: "w", url: `ws://127.0.0.1:${world.port}/ws` });
    const io = { held: true, waiting: [] as ((v: unknown) => void)[], moves: 0 };
    ag.request = (verb: string, args: any) => {
      if (verb !== "move") return Promise.resolve({ ok: true });
      io.moves++;
      return io.held ? new Promise((res) => io.waiting.push(res)) : Promise.resolve({ ok: true, at: args.to });
    };
    return { ag, io };
  };
  const timedOut = { ok: false, refused: { code: "timeout", reason: "the authority did not answer within 8 s" } };
  // Drop the connection as a restarting server does, let the body dial again, and wait for its new snapshot.
  const rejoin = async (name: string, ag: any, io: { held: boolean }) => {
    const before = sockets.get(name);
    io.held = false;
    before.close(1001, "restarting");
    return until(() => ag.joined && sockets.get(name) !== before, 5000);
  };
  {
    // Tracked at the drop: a stretch asked on the old connection is still out, and a shove in flight holds the gate.
    const { ag, io } = walker("tracked");
    await ag.connect();
    ag.target = { x: 0, y: 0, z: 200 };
    ag.trackAt = [0, 0, 0]; ag.trackArrived = true;
    ag.walkGate = { mode: "tracked", permit: [0, 0, 0.5], busy: false, hold: 1 };
    ag.extendPermit(ag.walkGate);   // the old connection's stretch, still out
    const rejoined = await rejoin("tracked", ag, io);
    const asked = io.moves;
    // the resumed walk asks where it stands (one move), then for its next stretch (another)
    const goesOn = await until(() => io.moves >= asked + 2, 3000);
    check("a walk carried across a rejoin asks for its next stretch", rejoined && goesOn, JSON.stringify({ rejoined, moves: io.moves, asked, gate: ag.walkGate }));
    for (const answer of io.waiting) answer(timedOut);
    await sleep(50);
    check("...and the old connection's late answer doesn't end it", ag.target !== null && ag.lastWalkRefusal?.code !== "timeout",
      JSON.stringify({ target: ag.target, refusal: ag.lastWalkRefusal }));
    ag.close();
  }
  {
    // In sync at the drop: the walk had asked where it stands, and the old connection's answer comes after the rejoin.
    const { ag, io } = walker("syncing");
    await ag.connect();
    ag.target = { x: 0, y: 0, z: 200 };
    ag.trackAt = null; ag.trackArrived = false;
    ag.walkGate = { mode: "sync", permit: null, busy: false };
    ag.syncWalkGate(ag.walkGate);   // where it stands, asked on the old connection
    const rejoined = await rejoin("syncing", ag, io);
    const asked = io.moves;
    const goesOn = await until(() => io.moves >= asked + 2, 3000);
    check("a walk still finding where it stands at the drop is resumed too, and asks for its next stretch", rejoined && goesOn, JSON.stringify({ rejoined, moves: io.moves, asked, gate: ag.walkGate }));
    for (const answer of io.waiting) answer(timedOut);
    await sleep(50);
    check("...and the old connection's late answer doesn't end it", ag.target !== null && ag.lastWalkRefusal?.code !== "timeout",
      JSON.stringify({ target: ag.target, refusal: ag.lastWalkRefusal }));
    ag.close();
  }
  world.stop(true);
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
