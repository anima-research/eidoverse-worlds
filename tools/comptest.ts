// Components / mounts / motion / use test matrix. Boots nothing itself —
// point it at a SCRATCH sequencer (fresh WORLDS_DIR, JOIN_TOKEN set):
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8993 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8993/ws JOIN_TOKEN=test-door bun run tools/comptest.ts
//
// Walks the whole swing story over real websockets: an owner builds a swing
// (sockets + pendulum motion + push reaction), a visitor pushes it (rank 0),
// the reaction appends a world-authored motion entry, a second push builds on
// the first (closed-form impulse), bodies mount themselves free while cargo
// stays builder-gated, and a fresh join folds all of it back.

const URL = process.env.WORLD_URL ?? "ws://localhost:8993/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Sock = {
  ws: WebSocket;
  msgs: any[];
  errors: string[];
  next(pred: string | ((m: any) => boolean), ms?: number): Promise<any>;
  verb(verb: string, args: any): void;
  settle(ms?: number): Promise<void>;
  close(): void;
};

function open(joinMsg: Record<string, unknown>): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s: Sock = {
      ws, msgs: [], errors: [],
      next(pred, ms = 4000) {
        const want = typeof pred === "string" ? (m: any) => m.type === pred : pred;
        return new Promise((res, rej) => {
          const hit = s.msgs.find(want);
          if (hit) return res(hit);
          const t0 = Date.now();
          const iv = setInterval(() => {
            const m = s.msgs.find(want);
            if (m) { clearInterval(iv); res(m); }
            else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`no match in ${ms}ms`)); }
          }, 20);
        });
      },
      verb(verb, args) { ws.send(JSON.stringify({ type: "verb", verb, args })); },
      settle(ms = 300) { return new Promise((r) => setTimeout(r, ms)); },
      close() { try { ws.close(); } catch { /* already */ } },
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOKEN, ...joinMsg }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      s.msgs.push(m);
      if (m.type === "error") s.errors.push(m.error);
    };
    ws.onclose = () => { /* fine */ };
    ws.onerror = (e) => reject(e);
    // resolve once the snapshot lands — joined and ready
    s.next("snapshot").then(() => resolve(s), reject);
  });
}

const motionOf = (m: any, id: string) =>
  m.type === "log" && m.entry?.verb === "motion" && m.entry?.args?.id === id ? m.entry : null;

const WORLD = `comptest-${Math.random().toString(36).slice(2, 8)}`;

console.log(`\ncomponents/mounts/motion matrix — world "${WORLD}"\n`);

// ---- build: first joiner owns the fresh world -------------------------------
const alice = await open({ id: "alice", world: WORLD });
await alice.settle();   // auto-owner grant lands

alice.verb("spawn", { id: "swing1", lib: "deco/bench.glb", pos: [0, 0, 0], yaw: 0 });
alice.verb("comp", { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } });
alice.verb("motion", { id: "swing1", type: "pendulum", axis: [1, 0, 0], pivot: [0, 2.4, 0], amp: 0, period: 3.2, damp: 0.06 });
alice.verb("comp", { id: "swing1", type: "reactions", data: { push: { impulse: 0.35 } } });
alice.verb("comp", { id: "swing1", type: "sparkle", data: { hue: "amber" } });   // a type NOBODY knows
alice.verb("spawn", { id: "crate1", lib: "deco/crate.glb", pos: [3, 0, 3], yaw: 0 });
await alice.settle();
check("owner authored swing + components without error", alice.errors.length === 0, alice.errors.join("; "));

// visitors: bob is explicitly demoted (owned world defaults to builder)
alice.verb("grant", { id: "bob", role: "visitor" });
await alice.settle();

// ---- the visitor and the swing ----------------------------------------------
const bob = await open({ id: "bob", world: WORLD });

bob.verb("comp", { id: "swing1", type: "graffiti", data: { text: "bob was here" } });
await bob.settle();
check("visitor cannot author components", bob.errors.length === 1, bob.errors.join("; "));

bob.verb("motion", { id: "swing1", type: "spin", degPerSec: 720 });
await bob.settle();
check("visitor cannot author motion directly", bob.errors.length === 2, bob.errors.join("; "));

bob.verb("use", { id: "swing1", action: "push" });
const push1 = await bob.next((m) => !!motionOf(m, "swing1")).then((m) => m.entry);
check("push → world-authored motion entry", push1.actor === "world");
check("push carries provenance", push1.args.by === "bob" && typeof push1.args.cause === "number");
check("push sets the pendulum moving", push1.args.type === "pendulum" && push1.args.amp > 0.1,
  `amp=${push1.args.amp}`);

await bob.settle(600);
const before = bob.msgs.filter((m) => motionOf(m, "swing1")).length;
bob.verb("use", { id: "swing1", action: "push" });
await bob.next((m) => bob.msgs.filter((x) => motionOf(x, "swing1")).length > before);
const push2 = bob.msgs.filter((m) => motionOf(m, "swing1")).map((m) => m.entry).pop();
check("second push re-expresses the same pendulum (fresh t0)", push2.args.t0 > push1.args.t0);
check("amplitude stays capped", push2.args.amp <= 1.1, `amp=${push2.args.amp}`);

bob.verb("use", { id: "crate1", action: "push" });
await bob.settle(500);
check("use on a thing with no reactions does nothing",
  !bob.msgs.some((m) => motionOf(m, "crate1")) && bob.errors.length === 2);

// ---- the flight recorder: why things bounced ----------------------------------
bob.ws.send(JSON.stringify({ type: "debug", reqId: "dbg1", limit: 100 }));
const dbg = (await bob.next((m) => m.type === "debug" && m.reqId === "dbg1")).events;
check("flight recorder: denied verbs are recorded with the reason",
  dbg.some((e: any) => e.kind === "denied" && e.who === "bob" && e.verb === "comp"),
  JSON.stringify(dbg.map((e: any) => e.kind)));
check("flight recorder: fired reactions carry cause→effect seqs",
  dbg.some((e: any) => e.kind === "reaction" && e.by === "bob"
    && typeof e.cause === "number" && typeof e.effect === "number"));
check("flight recorder: a use with nothing to react says why",
  dbg.some((e: any) => e.kind === "reaction-skip" && e.entity === "crate1"
    && /no reactions component/.test(String(e.why))), JSON.stringify(dbg.filter((e: any) => e.kind === "reaction-skip")));

// history with a verb filter — the other half of the debugging story
bob.ws.send(JSON.stringify({ type: "history", reqId: "h-use", verbs: ["use"], limit: 50 }));
const uses = (await bob.next((m) => m.type === "history" && m.reqId === "h-use")).entries;
check("history: verb filter isolates the causes",
  uses.length >= 3 && uses.every((e: any) => e.verb === "use"), `${uses.length} use entries`);

// ---- mounting: bodies free, cargo gated ---------------------------------------
bob.verb("mount", { id: "bob", to: "swing1", slot: "seat" });
await bob.settle();
check("a visitor may mount HIMSELF (sitting is using, not building)", bob.errors.length === 2, bob.errors.join("; "));

bob.verb("mount", { id: "crate1", to: "swing1" });
await bob.settle();
check("a visitor may not mount cargo", bob.errors.length === 3, bob.errors.join("; "));

alice.verb("mount", { id: "crate1", to: "swing1", offset: [0, 0.8, 0] });
await alice.settle();
alice.verb("mount", { id: "ghost", to: "nowhere" });
await alice.settle();
check("mount insists on an existing parent", alice.errors.length === 1, alice.errors.join("; "));

alice.verb("comp", { id: "swing1", type: "blob", data: { big: "x".repeat(9000) } });
await alice.settle();
check("component data is bounded (8KB)", alice.errors.length === 2, alice.errors.join("; "));

// ---- emitters: an ordinary component with a client-side evaluator --------------
// The full matrix (perception, lifecycle, the lint) lives in
// tools/particles-test.ts + tools/particles-probe.ts; these are the door's own
// obligations — rights, fold, and that nothing per-particle reaches the log.
const beforeParticles = alice.msgs.filter((m) => m.type === "log").length;
alice.verb("comp", { id: "swing1", type: "particles",
  data: { preset: "fire", seed: 1234, origin: [0, 0.25, 0] } });
await alice.settle();
check("owner can author an emitter", alice.errors.length === 2, alice.errors.join("; "));
check("an emitter is ONE log entry, never one per particle",
  alice.msgs.filter((m) => m.type === "log").length === beforeParticles + 1);
alice.verb("comp", { id: "swing1", type: "particles:smoke",
  data: { preset: "smoke", origin: [0, 1.2, 0], scale: 0.5, gravity: 0.3 } });
await alice.settle();
check("an entity can carry a second, named emitter — also one entry",
  alice.errors.length === 2 && alice.msgs.filter((m) => m.type === "log").length === beforeParticles + 2,
  alice.errors.join("; "));
bob.verb("comp", { id: "swing1", type: "particles", data: { preset: "smoke" } });
await bob.settle();
check("a visitor cannot light a fire on someone's swing",
  bob.errors.length === 4 && /builder rights/.test(bob.errors.at(-1) ?? ""), bob.errors.join("; "));

// ---- a fresh join folds all of it back ----------------------------------------
const eye = await open({ id: "eye1", world: WORLD, spectate: true });
const snap = eye.msgs.find((m) => m.type === "snapshot");
const st = snap.state;
const swing = st.entities?.swing1;
check("fold: swing carries its component bag",
  !!swing?.comp?.sockets && !!swing?.comp?.reactions && swing?.comp?.sparkle?.hue === "amber");
check("fold: unknown component types survive verbatim", swing?.comp?.sparkle?.hue === "amber");
check("fold: both emitters survive, each under its own key",
  (swing?.comp?.particles as any)?.preset === "fire" && (swing?.comp?.["particles:smoke"] as any)?.scale === 0.5);
check("fold: motion survives with the pushed amplitude",
  (swing?.comp?.motion as any)?.amp === push2.args.amp, JSON.stringify(swing?.comp?.motion));
check("fold: bob's body is mounted on the seat",
  st.mounts?.bob?.to === "swing1" && st.mounts?.bob?.slot === "seat", JSON.stringify(st.mounts));
check("fold: cargo rides the swing", st.entities?.crate1?.parent?.to === "swing1");

// ---- dismount stamps; remove orphans with a stamped pose ----------------------
alice.verb("dismount", { id: "crate1", pos: [5, 0, 5], yaw: 1.5 });
await alice.settle();
alice.verb("mount", { id: "crate1", to: "swing1", offset: [1, 0.8, 0] });
await alice.settle();
alice.verb("remove", { id: "swing1" });
await alice.settle();

const eye2 = await open({ id: "eye2", world: WORLD, spectate: true });
const st2 = eye2.msgs.find((m) => m.type === "snapshot").state;
check("removing the parent lands the cargo where the parent stood",
  !st2.entities?.crate1?.parent
  && Math.abs(st2.entities.crate1.pos[0] - 1) < 1e-6
  && Math.abs(st2.entities.crate1.pos[1] - 0.8) < 1e-6,
  JSON.stringify(st2.entities?.crate1?.pos));
check("removing the parent unseats the sitter too", !st2.mounts?.bob, JSON.stringify(st2.mounts));
check("the swing is gone", !st2.entities?.swing1);

// ---- placed lights: partial update + keep ------------------------------------
const bobErrs = bob.errors.length;
alice.verb("light", { id: "porch1", pos: [2, 2, 2], color: 0xff5533, intensity: 20, range: 12 });
await alice.settle();
alice.verb("light", { id: "porch1", intensity: 40, keep: true });   // brighten + pin, nothing else
await alice.settle();
bob.verb("light", { id: "bulb-bob", pos: [0, 1, 0] });
await bob.settle();
check("visitor cannot author lights", bob.errors.length === bobErrs + 1, bob.errors.join("; "));

const eye3 = await open({ id: "eye3", world: WORLD, spectate: true });
const porch = eye3.msgs.find((m) => m.type === "snapshot").state.entities?.porch1;
check("fold: light re-issue merges — intensity changed", porch?.intensity === 40, JSON.stringify(porch));
check("fold: light re-issue merges — color/range/pos untouched",
  porch?.color === 0xff5533 && porch?.range === 12 && porch?.pos?.[0] === 2, JSON.stringify(porch));
check("fold: keep flag survives the fold", porch?.keep === true, JSON.stringify(porch));

alice.verb("light", { id: "porch1", keep: false });
await alice.settle();
const eye4 = await open({ id: "eye4", world: WORLD, spectate: true });
const porch2 = eye4.msgs.find((m) => m.type === "snapshot").state.entities?.porch1;
check("keep: false clears the exemption without touching the rest",
  !!porch2 && porch2.keep === undefined && porch2.intensity === 40, JSON.stringify(porch2));

for (const s of [alice, bob, eye, eye2, eye3, eye4]) s.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
