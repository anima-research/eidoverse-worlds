// Entity-lease test matrix (docs/leases.md), over real websockets against a
// SCRATCH sequencer:
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8997 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8997/ws JOIN_TOKEN=test-door bun run tools/leasetest.ts
//
// Claims, denials, proximity takes, stream fan-out, commit-on-release,
// commit-on-DISCONNECT, the stale sweep is not waited on (10s) but its
// mechanism (lastAt) is what disconnect exercises.

const URL = process.env.WORLD_URL ?? "ws://localhost:8997/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
const W = `lease-${Math.random().toString(36).slice(2, 8)}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sock = {
  ws: WebSocket; msgs: any[];
  next: (pred: (m: any) => boolean, ms?: number) => Promise<any>;
  lease: (op: string, id: string, extra?: any) => void;
  verb: (v: string, a: any) => void;
  pose: (p: number[]) => void;
  close: () => void;
};
function open(name: string): Promise<Sock> {
  return new Promise((res) => {
    const ws = new WebSocket(`${URL}?name=${name}`);
    const msgs: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; res: (m: any) => void }> = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      msgs.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { waiters[i].res(m); waiters.splice(i, 1); }
      }
      if (m.type === "snapshot") res(sock);
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: W, id: name, token: TOKEN }));
    const sock: Sock = {
      ws, msgs,
      next: (pred, ms = 3000) => new Promise((r, j) => {
        const hit = msgs.find(pred);
        if (hit) return r(hit);
        waiters.push({ pred, res: r });
        setTimeout(() => j(new Error("timeout")), ms);
      }),
      lease: (op, id, extra = {}) => ws.send(JSON.stringify({ type: "lease", op, id, ...extra })),
      verb: (v, a) => ws.send(JSON.stringify({ type: "verb", verb: v, args: a })),
      pose: (p) => ws.send(JSON.stringify({ type: "pose", pose: { p, yaw: 0, speed: 0, clip: "idle" } })),
      close: () => ws.close(),
    };
  });
}

console.log("entity leases:\n");

const a = await open("kicker");
const b = await open("taker");
const c = await open("watcher");
a.verb("spawn", { id: "ball", lib: "x.glb", pos: [0, 0, 0] });
await sleep(300);

// 1. claim + stream + fan-out
a.lease("claim", "ball");
const g = await a.next((m) => m.type === "lease" && m.op === "granted" && m.id === "ball");
check("claim granted", !!g);
a.lease("state", "ball", { p: [1, 0.5, 0], q: [0, 0, 0, 1] });
const st = await c.next((m) => m.type === "lease" && m.op === "state" && m.id === "ball");
check("stream fans out to watchers", st.p?.[0] === 1 && st.by === "kicker");

// 2. double-claim denied; non-holder states dropped
b.lease("claim", "ball");
const dn = await b.next((m) => m.type === "lease" && m.op === "denied" && m.id === "ball");
check("second claim denied while held", !!dn && String(dn.why).includes("kicker"));
const before = c.msgs.filter((m) => m.type === "lease" && m.op === "state").length;
b.lease("state", "ball", { p: [99, 99, 99] });
await sleep(300);
check("a non-holder's state is dropped",
  c.msgs.filter((m) => m.type === "lease" && m.op === "state").length === before);

// 3. proximity take: taker stands next to the ball's LIVE position → takes it
b.pose([1.2, 0, 0.2]);
await sleep(200);
b.lease("claim", "ball", { take: true });
const tk = await b.next((m) => m.type === "lease" && m.op === "granted" && m.id === "ball");
check("proximity take granted", !!tk);
check("...and the grant carries the live state to resume from", tk.from?.p?.[0] === 1, JSON.stringify(tk.from));
const lost = await a.next((m) => m.type === "lease" && m.op === "lost" && m.id === "ball");
check("...old holder told they lost it", lost.to === "taker");

// 4. far take denied
a.pose([50, 0, 50]);
await sleep(200);
a.lease("claim", "ball", { take: true });
const far = await a.next((m) => m.type === "lease" && m.op === "denied" && m.id === "ball");
check("a take from across the field is denied", !!far);

// 5. release commits: a place entry, server-authored, provenance carried
b.lease("state", "ball", { p: [3, 0, 4], yaw: 1 });
await sleep(100);
b.lease("release", "ball", { p: [3, 0, 4], yaw: 1 });
const pl = await c.next((m) => m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === "ball");
check("release commits a place entry", pl.entry.args.pos?.[0] === 3);
check("...actor is the world, the kicker is the cause",
  pl.entry.actor === "world" && pl.entry.args.by === "taker" && pl.entry.args.via === "lease");
await c.next((m) => m.type === "lease" && m.op === "released" && m.id === "ball");
check("...and everyone hears the lease end", true);

// 6. commit-on-disconnect: holder vanishes mid-flight, object lands at the
// last streamed transform — the lease's whole promise
a.verb("spawn", { id: "crate", lib: "x.glb", pos: [5, 0, 5] });
await sleep(200);
b.lease("claim", "crate");
await b.next((m) => m.type === "lease" && m.op === "granted" && m.id === "crate");
b.lease("state", "crate", { p: [7, 0.2, 7], yaw: 2 });
await sleep(150);
b.close();
const pl2 = await c.next((m) => m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === "crate", 5000);
check("holder disconnect commits the last streamed transform",
  pl2.entry.args.pos?.[0] === 7 && pl2.entry.args.by === "taker");

// 7. claiming nothing
a.lease("claim", "ghost");
const gh = await a.next((m) => m.type === "lease" && m.op === "denied" && m.id === "ghost");
check("claiming a nonexistent entity is refused", String(gh.why).includes("no such"));

// 8. replay honesty: a late joiner folds only place entries — no lease residue
const d = await open("latecomer");
const snap = d.msgs.find((m) => m.type === "snapshot");
const ballAt = snap?.state?.entities?.ball?.pos ?? snap?.entries?.filter((e: any) => e.verb === "place" && e.args.id === "ball").pop()?.args?.pos;
check("late joiner sees the ball where it came to rest", ballAt?.[0] === 3, JSON.stringify(ballAt));
d.close();

// 9. the punt VERB: a rank-0 cause any client may emit — including agents
// via world_verb, which is the whole point (no tool needed). Server gates
// shape and reach; folds to nothing. (punt, not kick: kick is moderation.)
a.pose([3.4, 0, 4.2]);           // stand next to the resting ball [3,0,4]
await sleep(200);
a.verb("punt", { id: "ball", power: 99, dir: [1, 0, 0] });
const kentry = await c.next((m) => m.type === "log" && m.entry?.verb === "punt");
check("punt verb reaches the log, attributed to the kicker", kentry.entry.actor === "kicker");
check("...with the power clamped to sane", kentry.entry.args.power === 10, String(kentry.entry.args.power));
a.verb("punt", { id: "ghost" });
const kg = await a.next((m) => m.type === "error" && String(m.error).includes("ghost"));
check("kicking a nonexistent thing is refused", !!kg);
a.pose([40, 0, 40]);
await sleep(200);
a.verb("punt", { id: "ball" });
const kf = await a.next((m) => m.type === "error" && String(m.error).includes("too far"));
check("kicking from across the field is refused", !!kf);

// 10. and a late joiner never re-simulates a kick — the entry is inert
const e2 = await open("latecomer2");
await sleep(300);
const ball2 = e2.msgs.find((m) => m.type === "snapshot")?.state?.entities?.ball?.pos;
check("punt folds to nothing — late joiner sees only where it rests", ball2?.[0] === 3, JSON.stringify(ball2));
e2.close();

// 11. full orientation (PROTOCOL §9 amendment): a tumbled thing rests tilted
const TILT = [0.5, 0.5, 0.5, 0.5];                      // 120° about (1,1,1): on an edge, not a face
const f = await open("tumbler");
f.pose([20, 0, 20]);
f.verb("spawn", { id: "die", lib: "x.glb", pos: [20, 0, 20] });
await sleep(250);
f.lease("claim", "die");
await f.next((m) => m.type === "lease" && m.op === "granted" && m.id === "die");
f.lease("state", "die", { p: [21, 0.4, 20], q: TILT });
await sleep(120);
f.lease("release", "die", { p: [21, 0.4, 20] });
const pq = await c.next((m) => m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === "die");
check("a release after a tumble commits the streamed q", JSON.stringify(pq.entry.args.q) === JSON.stringify(TILT), JSON.stringify(pq.entry.args));
f.lease("claim", "die");
await f.next((m) => m.type === "lease" && m.op === "granted" && m.id === "die");
f.lease("state", "die", { p: [21, 0.4, 20], q: TILT });
await sleep(120);
f.lease("release", "die", { p: [21, 0.5, 20], yaw: 0.7 });
const pu = await c.next((m) => m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === "die" && m.entry.args.pos?.[1] === 0.5);
check("...a release that states a yaw (no q) rests upright", pu.entry.args.q === undefined && pu.entry.args.yaw === 0.7, JSON.stringify(pu.entry.args));
f.lease("claim", "die");
await f.next((m) => m.type === "lease" && m.op === "granted" && m.id === "die");
f.lease("state", "die", { p: [22, 0.4, 20], q: TILT });
await sleep(150);
f.close();
const pd = await c.next((m) => m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === "die" && m.entry.args.pos?.[0] === 22, 5000);
check("...a holder who vanishes mid-tumble leaves it tilted", JSON.stringify(pd.entry.args.q) === JSON.stringify(TILT), JSON.stringify(pd.entry.args));
const g2 = await open("latecomer3");
await sleep(300);
const dieQ = g2.msgs.find((m) => m.type === "snapshot")?.state?.entities?.die?.q;
check("...and a late joiner folds the tilt", Array.isArray(dieQ) && Math.abs(dieQ[0] - 0.5) < 1e-12, JSON.stringify(dieQ));
g2.close();

a.close(); c.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
