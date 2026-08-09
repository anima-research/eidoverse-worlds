// Support surfaces through the SHIPPED DOOR (#17, review of #53).
//
//   bun tools/support-lifecycle-test.ts        # spawns its own scratch server
//   URL=ws://host:8940/ws bun tools/...        # or against a running one
//
// tools/support-test.ts drives the physics and collider modules directly: it
// proves the solver rests a body on a box. It cannot prove that a real
// WorldAgent, joining a real world, turns the log it replays into those boxes
// — which is the half that actually shipped. This suite is that half, end to
// end, over a socket:
//
//   replay a world containing a platform
//     -> GET /geom
//       -> support registration
//         -> place / rescale / remove / motion
//           -> explicit drag release AND the 1.2s dragger-silence timeout
//
// Every assertion is a HEIGHT, because height is the thing #17 is about: a
// body released over a platform rests on the platform (root ≈ deck − hips
// offset), or it does not and lands on the terrain below (root ≈ −hips).
// The two are ~2m apart, so nothing here is a near-miss.
//
// On unmodified main every placed-floor case fails: the headless settle sim
// has no colliders at all, so every release resolves to terrain.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldAgent } from "../mcpl/agent.ts";

const EXTERNAL = process.env.URL;
const PORT = Number(process.env.PORT ?? 8994);
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const worldsDir = mkdtempSync(join(tmpdir(), "ew-support-"));

// A crate: small enough to stay a plain box, tall enough that resting on it
// is unmistakable. Deck top sits at local y 2.003, and the world puts its
// origin on flat terrain at y 0.
const LIB = "eidoverse/assets/models/crate_large_red.glb";
const DECK_Y = 2.003;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- server ----------------------------------------------------------------

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (EXTERNAL) return;
  server = spawn("bun", [join(import.meta.dir, "..", "server", "server.ts")], {
    env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "",
           VERB_RATE: "5000", MSG_RATE: "5000" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/avatars`)).ok) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

/** A bare socket: authors the scene and plays the dragger's hand. */
function hand(world: string, name: string) {
  return new Promise<any>((res) => {
    const ws = new WebSocket(`${URL_}?name=${name}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, token: TOKEN }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "snapshot") res({
        verb: (v: string, a: any) => ws.send(JSON.stringify({ type: "verb", verb: v, args: a })),
        send: (o: any) => ws.send(JSON.stringify(o)),
        close: () => ws.close(),
      });
    };
  });
}

/** Knock a body down, then drag it and let go over `overY`, either by an
 *  explicit release or by going silent for the 1.2s timeout. Returns where
 *  the agent's OWN settle sim put its root. */
async function dropOver(h: any, ag: any, name: string, at: number[], overY: number,
                        how: "release" | "silence") {
  h.send({ type: "puppet", target: name, ragdoll: { lean: [1, 0, 0] } });
  await sleep(2200);
  h.send({ type: "bodydrag", target: name, grab: { joint: "hips" } });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] },
           p: [at[0], overY + 0.4, at[1]], yaw: 0 });
  await sleep(250);
  if (how === "release") {
    h.send({ type: "bodydrag", target: name, end: true, pose: { hips: [0, 0, 0, 1] },
             p: [at[0], overY + 1.2, at[1]], yaw: 0 });
  } else {
    // the dragger's last word, then nothing — the body reclaims itself at 1.2s
    h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] },
             p: [at[0], overY + 1.2, at[1]], yaw: 0 });
  }
  await sleep(how === "release" ? 6000 : 8000);
  return ag.pos.y as number;
}

// The hips offset of a lying rig: a settled body's ROOT sits this far below
// the surface it rests on. Measured live rather than assumed, because it is
// rig-dependent — and because reading it as "sunk into the ground" is the
// misreading that sent issue #17 chasing a phantom.
let hipsOffset = 0.68;
const onDeck = (rootY: number) => Math.abs(rootY - (DECK_Y - hipsOffset)) < 0.35;
const onTerrain = (rootY: number) => Math.abs(rootY - (0 - hipsOffset)) < 0.35;

// ---- the run ---------------------------------------------------------------

try {
  await startServer();
  console.log(`\nsupport lifecycle (the shipped door): ${URL_}\n`);

  // ---- 1. REPLAY: the platform is in the log BEFORE the body ever joins ----
  // This is the ordering that matters. The agent does not witness the spawn;
  // it folds it out of history at join, which is the path a reconnecting or
  // late-arriving resident always takes.
  {
    const W = `sup-replay-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    h.close();

    const ag = new WorldAgent({ url: URL_, name: "rep-bot", world: W });
    await ag.connect();
    await sleep(1200);
    const h2 = await hand(W, "hand2");

    // calibrate the offset on flat ground in THIS world, on THIS rig
    h2.send({ type: "puppet", target: "rep-bot", ragdoll: { lean: [1, 0, 0] } });
    await sleep(3000);
    hipsOffset = -ag.pos.y;
    check("a body knocked down on flat terrain reports a stable hips offset",
      hipsOffset > 0.3 && hipsOffset < 1.2, `offset=${hipsOffset.toFixed(2)}m`);
    await ag.walkTo(3, 0, false, 8000);

    const y = await dropOver(h2, ag, "rep-bot", [3, 0], DECK_Y, "release");
    check("REPLAYED platform holds a body released over it",
      onDeck(y), `root=${y.toFixed(2)} deck=${(DECK_Y - hipsOffset).toFixed(2)} terrain=${(-hipsOffset).toFixed(2)}`);
    h2.close(); ag.close?.();
  }

  // ---- 2. the 1.2s dragger-silence path, not just explicit release --------
  {
    const W = `sup-silence-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "sil-bot", world: W });
    await ag.connect();
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "sil-bot", [3, 0], DECK_Y, "silence");
    check("a SILENT dragger's body settles onto the platform too",
      onDeck(y), `root=${y.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 3. place moves the support with the thing --------------------------
  {
    const W = `sup-place-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "plc-bot", world: W });
    await ag.connect();
    await sleep(1200);
    h.verb("place", { id: "deck", pos: [-4, 0, 0], yaw: 0 });   // moved away
    await sleep(1200);

    await ag.walkTo(3, 0, false, 8000);
    const gone = await dropOver(h, ag, "plc-bot", [3, 0], DECK_Y, "release");
    check("support LEAVES the old spot after a place", onTerrain(gone), `root=${gone.toFixed(2)}`);

    await ag.walkTo(-4, 0, false, 10_000);
    const there = await dropOver(h, ag, "plc-bot", [-4, 0], DECK_Y, "release");
    check("...and ARRIVES at the new one", onDeck(there), `root=${there.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 4. remove takes the floor with it ----------------------------------
  {
    const W = `sup-remove-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "rm-bot", world: W });
    await ag.connect();
    await sleep(1200);
    h.verb("remove", { id: "deck" });
    await sleep(1000);
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "rm-bot", [3, 0], DECK_Y, "release");
    check("a REMOVED platform stops holding bodies up", onTerrain(y), `root=${y.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 5. a MOVING thing is not a floor (ghost-floor fence) ---------------
  // The browser evaluates the motion and its collider rides along; a headless
  // support box registered at the authored transform would not. Rather than
  // invent a floor where the object no longer is, the agent abstains — and
  // resumes supporting when the motion is taken off again.
  {
    const W = `sup-motion-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "mot-bot", world: W });
    await ag.connect();
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);

    // a path motion: this crate is now a lift, and it does not stay put
    h.verb("motion", { id: "deck", type: "path", points: [[3, 0, 0], [3, 0, 6]],
                       speed: 1.5, loop: "pingpong" });
    await sleep(1200);
    const moving = await dropOver(h, ag, "mot-bot", [3, 0], DECK_Y, "release");
    check("a MOVING platform is not a ghost floor", onTerrain(moving), `root=${moving.toFixed(2)}`);

    h.verb("motion", { id: "deck" });                  // type omitted = motion removed
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);
    const stopped = await dropOver(h, ag, "mot-bot", [3, 0], DECK_Y, "release");
    check("...and supports again once the motion is taken off", onDeck(stopped), `root=${stopped.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 6. an id reused for a different lib keeps its own geometry ---------
  // syncSupport awaits /geom; if the id is removed and respawned as something
  // else in that window, the old summary must not be applied to the new
  // thing. Asserted on the registry rather than by height, because the race
  // is what is under test and heights cannot see which lib a box came from.
  {
    const W = `sup-ident-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    const ag = new WorldAgent({ url: URL_, name: "id-bot", world: W });
    await ag.connect();
    await sleep(800);
    h.verb("spawn", { id: "swap", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    h.verb("remove", { id: "swap" });
    h.verb("spawn", { id: "swap", lib: "eidoverse/assets/models/corn_cob_low.glb", pos: [3, 0, 0], yaw: 0 });
    await sleep(2500);
    const ent = (ag as any).entities.get("swap");
    check("an id reused mid-fetch ends up with its OWN lib registered",
      ent?.lib === "eidoverse/assets/models/corn_cob_low.glb", `lib=${ent?.lib}`);
    h.close(); ag.close?.();
  }

  // ---- 7. a departing agent takes its world's floors with it -------------
  // The collider map is PROCESS state (physics.ts's declared seam), so one
  // process serving a second world must not inherit the first world's
  // platforms. Found by this suite's own cross-talk: six worlds in one
  // process, and world 1's crate was still holding bodies up in world 3.
  {
    const W1 = `sup-leak-a-${Date.now().toString(36)}`;
    const h1 = await hand(W1, "stagehand");
    h1.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const a1 = new WorldAgent({ url: URL_, name: "leak-a", world: W1 });
    await a1.connect();
    await sleep(1500);                                  // its support is registered
    h1.close(); a1.close?.();                           // ...and it leaves
    await sleep(500);

    // a different world, no platform anywhere in its log
    const W2 = `sup-leak-b-${Date.now().toString(36)}`;
    const h2 = await hand(W2, "stagehand");
    const a2 = new WorldAgent({ url: URL_, name: "leak-b", world: W2 });
    await a2.connect();
    await sleep(1200);
    await a2.walkTo(3, 0, false, 8000);
    const y = await dropOver(h2, a2, "leak-b", [3, 0], DECK_Y, "release");
    check("a departed agent's platform does not haunt the next world",
      onTerrain(y), `root=${y.toFixed(2)} — a floor from a world this body never joined`);
    h2.close(); a2.close?.();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  server?.kill();
}
process.exit(fail ? 1 : 0);
