// Folded-component late-join parity (#71). Boots nothing itself — point it at
// a SCRATCH sequencer whose fold threshold is 1, so every append folds and a
// joiner's world is 100% folded state with an EMPTY tail (the same code path
// as booting from snapshot.json, minus the restart choreography):
//
//   WORLDS_DIR=$(mktemp -d) FOLD_EVERY=1 JOIN_TOKEN=test-door PORT=8995 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8995/ws JOIN_TOKEN=test-door bun tools/compfold-test.ts
//
// The contract under test (issue #71): a folded late join must reconstruct
// every current durable component with the same identity and deletion
// semantics as browser reconstruction (shared/fold.js stateToEntries
// replays e.comp; the agent's must stay in step) — as state replay, not a
// fresh authored act: no live world-change percept, no re-run reactions.
//
// Reactions fire server-side on `use` (server.ts resolveUse) and behaviors run
// in the server's BehaviorHost — a joiner reconstructing state sends neither,
// and the "no world-authored motion around a join" check pins that down.

process.env.EW_EMITTER_COALESCE_SEC = "1";
const { WorldAgent } = await import("../mcpl/agent.ts");

const URL = process.env.WORLD_URL ?? "ws://localhost:8995/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
(process.env as Record<string, string>).WORLD_TOKEN ??= TOKEN;
const WORLD = `compfold-${Math.random().toString(36).slice(2, 8)}`;

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Raw = { ws: WebSocket; snapshot: any; entries: any[]; live: any[]; errors: string[] };
function rawJoin(id: string, extra: Record<string, unknown> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s: Raw = { ws, snapshot: null, entries: [], live: [], errors: [] };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOKEN, world: WORLD, id, ...extra }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { s.snapshot = m.state; s.entries = m.entries ?? []; resolve(s); }
      if (m.type === "log") s.live.push(m.entry);
      if (m.type === "error") s.errors.push(String(m.error));
    };
    ws.onerror = (e) => reject(e);
  });
}
const send = (c: Raw, verb: string, args: unknown) =>
  c.ws.send(JSON.stringify({ type: "verb", verb, args }));

console.log(`\nfolded-component late-join parity (#71) — world "${WORLD}"\n`);

// ---- author the world; every entry folds immediately (FOLD_EVERY=1) ---------
const author = await rawJoin("author");           // first joiner = owner
await sleep(300);
send(author, "spawn", { id: "swing1", lib: "deco/bench.glb", pos: [0, 0, 0], yaw: 0 });
send(author, "comp", { id: "swing1", type: "sockets", data: { seat: { pos: [0, 0.55, 0] } } });
send(author, "comp", { id: "swing1", type: "reactions", data: { push: { impulse: 0.35 } } });
send(author, "comp", { id: "swing1", type: "sparkle", data: { hue: "amber" } });   // inert custom type
send(author, "comp", { id: "swing1", type: "doomed", data: { gone: "soon" } });
send(author, "motion", { id: "swing1", type: "pendulum", axis: [1, 0, 0], pivot: [0, 2.4, 0], amp: 0.2, period: 3.2, damp: 0.06 });
send(author, "comp", { id: "swing1", type: "particles",
  data: { preset: "fire", seed: 99, origin: [0, 0.25, 0], count: 120 } });
send(author, "spawn", { id: "crate1", lib: "deco/crate.glb", pos: [3, 0, 3], yaw: 0 });
send(author, "mount", { id: "crate1", to: "swing1", offset: [0, 0.8, 0] });        // folded cargo
send(author, "comp", { id: "swing1", type: "doomed", data: null });                // deleted PRE-fold
send(author, "comp", { id: "swing1", type: "lock", data: true });                  // lock LAST (it gates mounts/moves)
await sleep(500);
check("author built without refusals", author.errors.length === 0, author.errors.join("; "));

// ---- the fold really is the only carrier ------------------------------------
const eye = await rawJoin("eye1", { spectate: true });
const st = eye.snapshot;
check("fold: swing carries its full component bag",
  st?.entities?.swing1?.comp?.sockets != null
  && st.entities.swing1.comp.sparkle?.hue === "amber"
  && st.entities.swing1.comp.lock === true
  && st.entities.swing1.comp.particles?.preset === "fire"
  && st.entities.swing1.comp.motion?.type === "pendulum",
  JSON.stringify(st?.entities?.swing1?.comp));
check("fold: the deleted component is gone from state", st?.entities?.swing1?.comp?.doomed === undefined);
check("fold: cargo rides the swing as parent", st?.entities?.crate1?.parent?.to === "swing1",
  JSON.stringify(st?.entities?.crate1?.parent));
check("the join tail is EMPTY — folded state is the only carrier",
  eye.entries.filter((e: any) => e.verb === "comp").length === 0 && eye.entries.length === 0,
  `${eye.entries.length} tail entries`);

// ---- a fresh headless agent joins after the fold ----------------------------
const body = new WorldAgent({ url: URL, name: "late-body", world: WORLD });
const heard: any[] = [];
(body as any).onEvent = (ev: any) => { heard.push(ev); };
await body.connect();
await sleep(600);
check("replay produced no fabricated build activity", (body as any).act30.builds === 0,
  `${(body as any).act30.builds} builds`);

const bag = () => (body.entities.get("swing1") as any)?.comp ?? {};
check("post-fold join: agent reconstructs the component bag",
  bag().sockets != null && bag().reactions != null && bag().lock === true,
  JSON.stringify(bag()));
check("post-fold join: agent and browser serialization agree on the bag",
  JSON.stringify(bag()) === JSON.stringify(st.entities.swing1.comp), JSON.stringify(bag()));
// non-vacuous: absence only counts as deletion if the rest of the bag arrived
check("post-fold join: pre-fold deletion stays deleted", bag().doomed === undefined && bag().sockets != null);

const seen = body.look();
check("look() enumerates the folded socket", /sit\/mount: seat/.test(seen),
  seen.split("\n").find((l: string) => l.includes("swing1")));
check("look() names the folded lock", /🔒 locked/.test(seen));
check("look() names the folded emitter semantically", /emitting fire/.test(seen));
check("look() lists the inert custom component", /components: sparkle/.test(seen));
check("look() shows the folded motion", /in motion \(pendulum\)/.test(seen));
check("look() knows the folded cargo rides the swing", /carrying: crate1/.test(seen),
  seen.split("\n").find((l: string) => l.includes("swing1")));
check("replay emitted no false live event of any kind", heard.length === 0,
  JSON.stringify(heard));
check("no reaction re-ran on join (no world-authored motion in anyone's live feed)",
  !author.live.some((e: any) => e.verb === "motion" && e.actor === "world"),
  JSON.stringify(author.live.filter((e: any) => e.verb === "motion")));

// ---- the agent can EXPLAIN a lock refusal it just received -------------------
body.verb("place", { id: "swing1", pos: [1, 0, 1] });
await sleep(400);
check("server refuses the move (lock is enforced)",
  body.lastRefusal != null && /locked/.test(body.lastRefusal.text),
  body.lastRefusal?.text ?? "(no refusal)");
check("...and the agent's own look() already explains why", /🔒 locked/.test(body.look()));

// ---- replay + subsequent live replacement = ONE current component -----------
await sleep(4200);   // VERB_RATE window reset — the author's build burst counts, and refused verbs would too
send(author, "comp", { id: "swing1", type: "sparkle", data: { hue: "teal" } });
await sleep(400);
check("live replacement lands on the replayed bag as ONE current value",
  bag().sparkle?.hue === "teal" && Object.keys(bag()).filter((k) => k === "sparkle").length === 1,
  JSON.stringify(bag().sparkle));

const body2 = new WorldAgent({ url: URL, name: "late-body2", world: WORLD });
await body2.connect();
await sleep(400);
const bag2 = (body2.entities.get("swing1") as any)?.comp ?? {};
check("a joiner after the replacement folds sees only the current value",
  bag2.sparkle?.hue === "teal", JSON.stringify(bag2.sparkle));

// ---- deletion: comp {data:null} then fold leaves it absent for both ----------
send(author, "comp", { id: "swing1", type: "sparkle", data: null });
await sleep(400);
check("live deletion clears the replayed bag too", bag().sparkle === undefined && bag().lock === true, JSON.stringify(bag()));

const eye2 = await rawJoin("eye2", { spectate: true });
const body3 = new WorldAgent({ url: URL, name: "late-body3", world: WORLD });
await body3.connect();
await sleep(400);
const bag3 = (body3.entities.get("swing1") as any)?.comp ?? {};
check("post-deletion fold: absent for a fresh browser-path snapshot",
  eye2.snapshot?.entities?.swing1?.comp?.sparkle === undefined);
check("post-deletion fold: absent for a fresh agent",
  bag3.sparkle === undefined && bag3.lock === true, JSON.stringify(bag3));

for (const s of [author, eye, eye2]) { try { s.ws.close(); } catch { /* done */ } }
for (const b of [body, body2, body3]) { try { (b as any).close?.(); (b as any).ws?.close(); } catch { /* done */ } }

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
