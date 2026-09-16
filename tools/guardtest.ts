// Guard matrix — `comp {id, type: "guard", data: true}` makes a thing its
// placer's to author.
//
// The guard is the rights edge the lock is not: while it is on, the server
// refuses every AUTHORING verb on the entity (comp, motion, behavior attach,
// place, punt, cargo-mount/dismount, remove, same-id spawn/light) from anyone
// but the placer, the world's owner, or an operator. Using the thing (use,
// sitting on it) stays open. Setting or clearing the guard is placer-gated
// even while it is off. A behavior writes with its AUTHOR's standing, so the
// placer's script may change a guarded thing and a stranger's may not.
//
// Boots nothing itself — point it at a SCRATCH sequencer:
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8994 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8994/ws JOIN_TOKEN=test-door bun run tools/guardtest.ts

const URL = process.env.WORLD_URL ?? "ws://localhost:8994/ws";
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
  const r = await fetch(`${HTTP}/upload?as=script&token=${TOKEN}&by=guardtest`, { method: "POST", body: src });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
  return (await r.json()).path;
}

/** The folded comp bag of `id` as a fresh spectator sees it. */
async function foldedBag(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const bag = eye.msgs.find((m) => m.type === "snapshot").state.entities?.[id]?.comp;
  eye.close();
  return bag;
}

const WORLD = `guardtest-${Math.random().toString(36).slice(2, 8)}`;
const RATE_WINDOW = 4200;   // the verb rate window (12/4s) — refusals count too

console.log(`\nguard matrix — world "${WORLD}"\n`);

// ---- alice owns the fresh world; bob and carol are drop-in builders ---------
const alice = await open({ id: "alice", world: WORLD });
await alice.settle();
const bob = await open({ id: "bob", world: WORLD });
const carol = await open({ id: "carol", world: WORLD });
await bob.settle();

bob.verb("spawn", { id: "frame1", lib: "deco/frame.glb", pos: [0, 0, 0], yaw: 0 });
bob.verb("spawn", { id: "frame2", lib: "deco/frame.glb", pos: [3, 0, 0], yaw: 0 });
bob.verb("spawn", { id: "truck1", lib: "deco/truck.glb", pos: [5, 0, 5], yaw: 0 });
bob.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/a.png", part: "picture" } });
await bob.settle();
check("a builder places and dresses his things — no error", bob.errors.length === 0, bob.errors.join("; "));

// ---- guard it ---------------------------------------------------------------
bob.verb("comp", { id: "frame1", type: "guard", data: true });
await bob.settle();
check("guarding your own thing is an ordinary comp — no error", bob.errors.length === 0, bob.errors.join("; "));
check("the guard folds (comp.guard in a fresh snapshot)", (await foldedBag(WORLD, "frame1"))?.guard === true);

// ---- the refusal matrix: every authoring verb, from a stranger --------------
const refusals = (s: Sock) => s.errors.length;
const last = (s: Sock) => s.errors.at(-1) ?? "no error";
let before = refusals(carol);
carol.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/trollface.png", part: "picture" } });
await carol.settle();
check("a stranger's comp on a guarded thing is refused, naming who may",
  refusals(carol) === before + 1 && /guarded/.test(last(carol)) && /bob/.test(last(carol)), last(carol));
check("…and the picture is unchanged", (await foldedBag(WORLD, "frame1"))?.picture?.src === "eidoverse/assets/a.png");

before = refusals(carol);
carol.verb("motion", { id: "frame1", type: "spin", axis: [0, 1, 0], period: 3 });
await carol.settle();
check("motion is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("place", { id: "frame1", pos: [9, 0, 9], yaw: 1, scale: 1 });
await carol.settle();
check("place is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)) && /move/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("remove", { id: "frame1" });
await carol.settle();
check("remove is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)) && /remove/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("punt", { id: "frame1", dir: [1, 0, 0] });
await carol.settle();
check("punt is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("mount", { id: "frame1", to: "truck1", slot: "bed" });
await carol.settle();
check("cargo-mounting the guarded thing is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("spawn", { id: "frame1", lib: "deco/crate.glb", pos: [0, 0, 0], yaw: 0 });
await carol.settle();
check("spawn onto the guarded id (wholesale replace) is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)) && /replace/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("light", { id: "frame1", pos: [0, 1, 0] });
await carol.settle();
check("light onto the guarded id (wholesale replace) is refused", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

await carol.settle(RATE_WINDOW);
before = refusals(carol);
carol.verb("comp", { id: "frame1", type: "guard", data: null });
await carol.settle();
check("a stranger cannot clear the guard", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

before = refusals(carol);
carol.verb("comp", { id: "frame2", type: "guard", data: true });
await carol.settle();
check("a stranger cannot guard someone else's UNguarded thing either",
  refusals(carol) === before + 1 && /placed by bob/.test(last(carol)), last(carol));
check("…so frame2 stays unguarded", !(await foldedBag(WORLD, "frame2"))?.guard);

// ---- what stays open: using it ---------------------------------------------
before = refusals(carol);
carol.verb("use", { id: "frame1", action: "admire" });
carol.verb("mount", { id: "carol", to: "frame1", slot: "seat" });   // sitting ON it is USING it
await carol.settle();
check("use and self-mount stay open while guarded", refusals(carol) === before, carol.errors.slice(before).join("; "));
carol.verb("dismount", { id: "carol" });
await carol.settle();

// ---- an unguarded neighbour is still everyone's ----------------------------
before = refusals(carol);
carol.verb("comp", { id: "frame2", type: "picture", data: { src: "eidoverse/assets/b.png", part: "picture" } });
carol.verb("place", { id: "frame2", pos: [4, 0, 0], yaw: 0.5, scale: 1 });
await carol.settle();
check("an unguarded neighbour still takes a stranger's comp and place (guard is per-entity)",
  refusals(carol) === before, carol.errors.slice(before).join("; "));

// ---- the placer and the world's owner keep authoring ----------------------
await bob.settle(RATE_WINDOW);
before = refusals(bob);
bob.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/c.png", part: "picture" } });
bob.verb("place", { id: "frame1", pos: [1, 0, 1], yaw: 0.2, scale: 1 });
await bob.settle();
check("the placer still edits and moves his guarded thing", refusals(bob) === before, bob.errors.slice(before).join("; "));

before = refusals(alice);
alice.verb("comp", { id: "frame1", type: "look", data: { note: "owner was here" } });
await alice.settle();
check("the world's owner may author it too (moderation power)", refusals(alice) === before, alice.errors.slice(before).join("; "));
const bag1 = await foldedBag(WORLD, "frame1");
check("placer's picture + owner's comp both landed, guard still on",
  bag1?.picture?.src === "eidoverse/assets/c.png" && bag1?.look?.note === "owner was here" && bag1?.guard === true, JSON.stringify(bag1));

// ---- ordering: guarded AND locked — a stranger hears "guarded", not "unlock it"
bob.verb("comp", { id: "frame1", type: "lock", data: true });
await bob.settle();
await carol.settle(RATE_WINDOW);
before = refusals(carol);
carol.verb("place", { id: "frame1", pos: [9, 0, 9], yaw: 0, scale: 1 });
await carol.settle();
check("guarded + locked: the stranger's refusal names the guard, not an unlock they may not do",
  refusals(carol) === before + 1 && /guarded/.test(last(carol)) && !/unlock/.test(last(carol)), last(carol));
bob.verb("comp", { id: "frame1", type: "lock", data: null });
await bob.settle();

// ---- behaviors write with their author's standing --------------------------
// The script says it tried (so the test can tell "ran and was refused" from
// "never ran"), then emits the comp. A refused emit throws in script land,
// so the say comes FIRST.
const swapSrc = `
world.on('use', (e) => {
  if (e.action !== 'next') return;
  world.emit('say', { text: 'swapping for ' + e.by });
  world.emit('comp', { id: 'frame1', type: 'picture', data: { src: 'eidoverse/assets/next.png', part: 'picture' } });
});`;
const path = await uploadScript(swapSrc);
const saidFrom = (actor: string) => (m: any) => m.entry?.actor === actor && m.entry?.verb === "say" && /swapping/.test(m.entry?.args?.text ?? "");

// a stranger's script, bound world-level (binding itself touches no entity;
// world-level scripts hear every `use`)
before = refusals(carol);
carol.verb("behavior", { id: "carolswap", src: path });
await carol.settle(600);   // sandbox load is async
check("a stranger may bind a world-level script (no entity authored yet)", refusals(carol) === before, carol.errors.slice(before).join("; "));
before = refusals(carol);
carol.verb("behavior", { id: "carolattach", src: path, attach: "frame1" });
await carol.settle();
check("…but may not ATTACH one to the guarded thing", refusals(carol) === before + 1 && /guarded/.test(last(carol)), last(carol));

carol.verb("use", { id: "frame1", action: "next" });
const ranC = await carol.next(saidFrom("bhv:carolswap")).then(() => true, () => false);
check("the stranger's script ran (it said so)", ranC);
await carol.settle(400);
check("…and its comp on the guarded thing did not land — scripts write with their author's standing",
  (await foldedBag(WORLD, "frame1"))?.picture?.src === "eidoverse/assets/c.png");
carol.verb("behavior", { id: "carolswap", remove: true });
await carol.settle();

// the placer's script, same code — writes
await bob.settle(RATE_WINDOW);
bob.verb("behavior", { id: "bobswap", src: path, attach: "frame1" });
await bob.settle(600);
carol.verb("use", { id: "frame1", action: "next" });
const ranB = await carol.next(saidFrom("bhv:bobswap")).then(() => true, () => false);
check("the placer's script ran on the stranger's use", ranB);
await carol.settle(400);
check("the placer's script, driven by the stranger's `use`, changes the guarded picture — the bounded interact",
  (await foldedBag(WORLD, "frame1"))?.picture?.src === "eidoverse/assets/next.png");
bob.verb("behavior", { id: "bobswap", remove: true });
await bob.settle();

// ---- clearing the guard reopens it -----------------------------------------
bob.verb("comp", { id: "frame1", type: "guard", data: null });
await bob.settle();
await carol.settle(RATE_WINDOW);
before = refusals(carol);
carol.verb("comp", { id: "frame1", type: "picture", data: { src: "eidoverse/assets/d.png", part: "picture" } });
await carol.settle();
check("guard cleared (data: null) — a stranger's comp lands again", refusals(carol) === before, carol.errors.slice(before).join("; "));
check("…folded", (await foldedBag(WORLD, "frame1"))?.picture?.src === "eidoverse/assets/d.png");

for (const s of [alice, bob, carol]) s.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
