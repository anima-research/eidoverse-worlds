// GRAB vs EDIT test matrix (2026-08-06). Boots nothing itself — point it at a
// SCRATCH sequencer (fresh WORLDS_DIR, JOIN_TOKEN set):
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8994 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8994/ws JOIN_TOKEN=test-door bun run tools/grabtest.ts
//
// The story: the client always knew picking-a-thing-up is a different act
// from editing-a-scene (handgrab.js), but the wire said `place` for both, so
// a visitor's grab was refused at release. Now the room act is rank 0:
//   use take — needs the `grab` comp, an unheld thing, and REACH
//   use put  — holder only, drop point in reach, world speaks the place
// Ungrabbable things can never be taken, only edited (place, rank 1).

const URL = process.env.WORLD_URL ?? "ws://localhost:8994/ws";
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
  pose(p: number[]): void;
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
      pose(p) { ws.send(JSON.stringify({ type: "pose", pose: { p, yaw: 0, speed: 0, clip: "idle" } })); },
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
    s.next("snapshot").then(() => resolve(s), reject);
  });
}

/** Clear the error ledger, perform the act, wait for a FRESH refusal. The
 *  naive next("error") kept matching stale errors in the message buffer —
 *  every check read the previous step's refusal (off-by-one cascade, found
 *  on first run). */
async function expectErr(s: Sock, act: () => void, substr: string): Promise<string> {
  s.errors.length = 0;
  act();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (s.errors.length) return s.errors.find((e) => e.includes(substr)) ?? `WRONG ERROR: ${s.errors.join("; ")}`;
    await new Promise((r) => setTimeout(r, 20));
  }
  return "NO ERROR ARRIVED";
}

const placeOf = (m: any, id: string) =>
  m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === id ? m.entry : null;

const WORLD = `grabtest-${Math.random().toString(36).slice(2, 8)}`;

console.log(`\ngrab-vs-edit matrix — world "${WORLD}"\n`);

// ---- build: an owner furnishes the room -------------------------------------
const alice = await open({ id: "alice", world: WORLD });
alice.verb("spawn", { id: "die1", lib: "deco/die.glb", pos: [1, 0, 0], yaw: 0 });
alice.verb("comp", { id: "die1", type: "grab", data: {} });
alice.verb("spawn", { id: "boulder", lib: "deco/boulder.glb", pos: [2, 0, 0], yaw: 0 });
alice.verb("grant", { id: "bob", role: "visitor" });
await alice.settle();
check("owner authored die (grab) + boulder (no grab)", alice.errors.length === 0, alice.errors.join("; "));

const bob = await open({ id: "bob", world: WORLD });

// ---- the old bug, still fenced: a visitor cannot EDIT ----------------------
let err = await expectErr(bob, () => bob.verb("place", { id: "die1", pos: [5, 0, 5] }), "place");
check("visitor speaking `place` is still refused (edit stays builder-gated)", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- no body position yet → actionable refusal ------------------------------
err = await expectErr(bob, () => bob.verb("use", { id: "die1", action: "take" }), "body position");
check("take before any pose → told to move first", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- out of reach → told to move closer -------------------------------------
bob.pose([9, 0, 9]);
await bob.settle(250);
err = await expectErr(bob, () => bob.verb("use", { id: "die1", action: "take" }), "out of reach");
check("take from 11m → move closer and try again", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- in reach, grabbable → the room act works for a visitor -----------------
bob.pose([1.5, 0, 0.5]);
await bob.settle(250);
bob.errors.length = 0;
bob.verb("use", { id: "die1", action: "take" });
const takeLog = await bob.next((m) => m.type === "log" && m.entry?.verb === "use" && m.entry?.args?.action === "take");
check("visitor takes the die (rank 0, in reach)", !!takeLog && bob.errors.length === 0, bob.errors.join("; "));

// ---- second hands off -------------------------------------------------------
const carol = await open({ id: "carol", world: WORLD });
carol.pose([1.5, 0, 0.5]);
await carol.settle(200);
err = await expectErr(carol, () => carol.verb("use", { id: "die1", action: "take" }), "holding");
check("carol cannot take what bob holds", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- drop too far → refused; optimistic client would revert -----------------
err = await expectErr(bob, () => bob.verb("use", { id: "die1", action: "put", pos: [9, 0, 9] }), "out of reach");
check("put 11m away → step closer", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- put in reach → the WORLD speaks the place ------------------------------
bob.verb("use", { id: "die1", action: "put", pos: [0.5, 0, 1.2], yaw: 0.7 });
const eff = await bob.next((m) => placeOf(m, "die1"));
check("world-authored place lands", eff.entry.actor === "world", `actor=${eff.entry.actor}`);
check("place carries the drop pose + provenance", eff.entry.args.pos[2] === 1.2 && eff.entry.args.by === "bob",
  JSON.stringify(eff.entry.args));

// ---- ungrabbable can never be taken, only edited ----------------------------
bob.pose([2.2, 0, 0.3]);
await bob.settle(250);
err = await expectErr(bob, () => bob.verb("use", { id: "boulder", action: "take" }), "doesn't invite taking");
check("boulder (no grab comp) refuses taking, points at edit", !err.startsWith("NO") && !err.startsWith("WRONG"), err);

// ---- holder leaving frees the thing ----------------------------------------
bob.verb("use", { id: "die1", action: "take" });
await bob.next((m) => m.type === "log" && m.entry?.verb === "use" && m.entry?.args?.action === "take" && m.entry.seq > eff.entry.seq);
bob.close();
await carol.settle(400);
carol.pose([0.6, 0, 1.1]);
await carol.settle(200);
carol.verb("use", { id: "die1", action: "take" });
const carolTake = await carol.next((m) => m.type === "log" && m.entry?.verb === "use" && m.entry?.args?.action === "take" && m.entry?.actor === "carol").catch(() => null);
check("disconnect releases the hold — carol takes it", !!carolTake, carol.errors.join("; "));

// ---- builders still edit at any distance ------------------------------------
alice.verb("place", { id: "boulder", pos: [30, 0, 30] });
await alice.next((m) => placeOf(m, "boulder"));
check("builder edits the boulder from across the room", alice.errors.length === 0, alice.errors.join("; "));

alice.close(); carol.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
