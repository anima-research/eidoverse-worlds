// Body-mount matrix — a body rides or steps off only by its own request.
//
// `mount`/`dismount` name a thing (cargo, builder rank) or a BODY (a
// participant id, folded into state.mounts and handed back on every rejoin).
// Sitting yourself down is rank 0 and must stay open. Seating or unseating
// SOMEONE ELSE's body is refused for everyone — builder, owner, and a script
// (which asks with its author's id) — because no rank, guard or lock is the
// body's own consent (DESIGN.md: each client owns its own avatar).
//
// Boots nothing itself — point it at a SCRATCH sequencer:
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8993 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8993/ws JOIN_TOKEN=test-door bun run tools/bodymounttest.ts

const URL = process.env.WORLD_URL ?? "ws://localhost:8993/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";
const HTTP = URL.replace(/^ws/, "http").replace(/\/ws$/, "");

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
    s.next("snapshot").then(() => resolve(s), reject);
  });
}

async function uploadScript(src: string): Promise<string> {
  const r = await fetch(`${HTTP}/upload?as=script&token=${TOKEN}&by=bodymounttest`, { method: "POST", body: src });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
  return (await r.json()).path;
}

/** The folded state as a fresh spectator sees it. */
async function folded(world: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const st = eye.msgs.find((m) => m.type === "snapshot").state;
  eye.close();
  return st;
}

const WORLD = `bodymount-${Math.random().toString(36).slice(2, 8)}`;
const RATE_WINDOW = 4200;   // the verb rate window (12/4s) — refusals count too
const refusals = (s: Sock) => s.errors.length;
const last = (s: Sock) => s.errors.at(-1) ?? "no error";

console.log(`\nbody-mount matrix — world "${WORLD}"\n`);

// ---- alice owns the fresh world; bob and carol drop in as builders; dave is
// demoted to visitor -----------------------------------------------------------
const alice = await open({ id: "alice", world: WORLD });
await alice.settle();
alice.verb("spawn", { id: "swing", lib: "(box)", pos: [0, 0, 0], yaw: 0 });
alice.verb("spawn", { id: "crate", lib: "(box)", pos: [40, 0, 40], yaw: 0 });
alice.verb("spawn", { id: "truck", lib: "(box)", pos: [10, 0, 0], yaw: 0 });
alice.verb("spawn", { id: "cargo", lib: "(box)", pos: [12, 0, 0], yaw: 0 });
alice.verb("grant", { id: "dave", role: "visitor" });
await alice.settle();
const bob = await open({ id: "bob", world: WORLD });
const carol = await open({ id: "carol", world: WORLD });
const dave = await open({ id: "dave", world: WORLD });
await bob.settle();
check("setup — no error", alice.errors.length === 0, alice.errors.join("; "));

// ---- sitting yourself down stays open, at rank 0 ----------------------------
carol.verb("mount", { id: "carol", to: "swing", offset: [0, 0.5, 0] });
dave.verb("mount", { id: "dave", to: "swing", offset: [1, 0.5, 0] });
await carol.settle();
check("a builder seats herself — no error", carol.errors.length === 0, carol.errors.join("; "));
check("a visitor seats himself (self-mount is rank 0) — no error", dave.errors.length === 0, dave.errors.join("; "));
let st = await folded(WORLD);
check("…both seats fold into state.mounts", st.mounts?.carol?.to === "swing" && st.mounts?.dave?.to === "swing", JSON.stringify(st.mounts));

// ---- someone else's body is refused, for every rank -------------------------
let before = refusals(bob);
bob.verb("mount", { id: "carol", to: "crate", offset: [0, 5, 0] });
await bob.settle();
check("a builder mounting someone else's body is refused, naming whose it is",
  refusals(bob) === before + 1 && /body/.test(last(bob)) && /carol/.test(last(bob)), last(bob));

before = refusals(alice);
alice.verb("mount", { id: "carol", to: "crate" });
await alice.settle();
check("…the world's owner too — rank is not the body's consent",
  refusals(alice) === before + 1 && /body/.test(last(alice)), last(alice));

before = refusals(bob);
bob.verb("mount", { id: "zed", to: "crate" });
await bob.settle();
check("…and a body that isn't here yet cannot be pre-seated",
  refusals(bob) === before + 1 && /body/.test(last(bob)), last(bob));

before = refusals(bob);
bob.verb("dismount", { id: "carol", pos: [99, 0, 99] });
await bob.settle();
check("unseating someone else's body is refused the same way",
  refusals(bob) === before + 1 && /body/.test(last(bob)), last(bob));

before = refusals(dave);
dave.verb("mount", { id: "carol", to: "crate" });
await dave.settle();
check("a visitor is refused on the body, not told to get builder rights",
  refusals(dave) === before + 1 && /body/.test(last(dave)) && !/builder/.test(last(dave)), last(dave));

st = await folded(WORLD);
check("…nothing landed: carol still rides the swing, no zed",
  st.mounts?.carol?.to === "swing" && JSON.stringify(st.mounts?.carol?.offset) === "[0,0.5,0]" && !st.mounts?.zed,
  JSON.stringify(st.mounts));

// ---- cargo (a thing) is unchanged ------------------------------------------
await bob.settle(RATE_WINDOW);
before = refusals(bob);
bob.verb("mount", { id: "cargo", to: "truck", offset: [0, 1, 0] });
await bob.settle();
check("loading cargo (a thing) onto a thing still works for a builder", refusals(bob) === before, bob.errors.slice(before).join("; "));
st = await folded(WORLD);
check("…folded as the cargo's parent", st.entities?.cargo?.parent?.to === "truck", JSON.stringify(st.entities?.cargo?.parent));
before = refusals(dave);
dave.verb("mount", { id: "cargo", to: "swing" });
await dave.settle();
check("…and cargo stays builder-rank for a visitor", refusals(dave) === before + 1 && /builder/.test(last(dave)), last(dave));

// ---- a script asks with its author's id -------------------------------------
const rideSrc = `
world.on('use', (e) => {
  if (e.action !== 'ride') return;
  world.emit('say', { text: 'seating ' + e.by });
  world.emit('mount', { id: e.by, to: 'crate', offset: [0, 5, 0] });
});`;
const path = await uploadScript(rideSrc);
await bob.settle(RATE_WINDOW);
before = refusals(bob);
bob.verb("behavior", { id: "ride", src: path, caps: { verbs: ["say", "mount"] } });
await bob.settle(600);   // sandbox load is async
check("a builder binds a world-level script that may mount", refusals(bob) === before, bob.errors.slice(before).join("; "));
const saidFor = (who: string) => (m: any) => m.entry?.actor === "bhv:ride" && m.entry?.verb === "say" && m.entry?.args?.text === `seating ${who}`;

carol.verb("use", { id: "crate", action: "ride" });
const ranC = await carol.next(saidFor("carol")).then(() => true, () => false);
check("the script ran for carol (it said so)", ranC);
await carol.settle(400);
st = await folded(WORLD);
check("…but its author's script cannot seat carol's body", st.mounts?.carol?.to === "swing", JSON.stringify(st.mounts?.carol));

bob.verb("use", { id: "crate", action: "ride" });
const ranB = await bob.next(saidFor("bob")).then(() => true, () => false);
check("the script ran for its author", ranB);
await bob.settle(400);
st = await folded(WORLD);
check("…and seats its author's own body", st.mounts?.bob?.to === "crate", JSON.stringify(st.mounts?.bob));
bob.verb("behavior", { id: "ride", remove: true });
bob.verb("dismount", { id: "bob" });
await bob.settle();

// ---- rejoin hands back only what the body asked for -------------------------
carol.close();
await alice.settle(500);
const carol2 = await open({ id: "carol", world: WORLD });
const snap = carol2.msgs.find((m) => m.type === "snapshot");
check("carol rejoins on the swing she chose, not on bob's crate",
  snap.state.mounts?.carol?.to === "swing", JSON.stringify(snap.state.mounts?.carol));
check("…and no mount entry for her body was authored by anyone else",
  !(snap.entries ?? []).some((e: any) => e.verb === "mount" && e.args?.id === "carol" && e.actor !== "carol"));

// ---- getting up yourself stays open -----------------------------------------
before = refusals(carol2);
carol2.verb("dismount", { id: "carol" });
await carol2.settle();
check("getting up yourself — no error", refusals(carol2) === before, carol2.errors.slice(before).join("; "));
st = await folded(WORLD);
check("…and the seat is gone from the fold", !st.mounts?.carol, JSON.stringify(st.mounts));

for (const s of [alice, bob, carol2, dave]) s.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
