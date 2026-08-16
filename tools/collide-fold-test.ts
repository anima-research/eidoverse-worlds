// The spawn verb's `collide` override must survive the FOLD.
//
//   bun tools/collide-fold-test.ts
//
// `spawn {collide: "exact"|"box"}` overrides the size-derived collider choice
// (client/lib/colliders.js decide()). The clients present at the spawn read it
// off the broadcast entry and honoured it; every later joiner folded a
// snapshot that had never carried it, and got the size heuristic instead. Same
// object, walkable or solid depending on when you arrived — the exact drift
// AGENTS.md house rule 1 forbids ("if foldEntry and applyEntry drift, joiners
// see a world that never existed").
//
// The subtlety this test exists for: a joiner gets state + TAIL, and an entry
// still in the tail carries its own args, so a spawn that has not been folded
// yet looks fine whether or not the bug is fixed. So FOLD_EVERY is set to 5
// and the spawn is pushed well past the fold line before anyone re-joins —
// the assertion is only meaningful once `throughSeq` is past the spawn.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8994);
const URL_ = `ws://127.0.0.1:${PORT}/ws`;
const WORLD = `collide-${Date.now().toString(36)}`;
const worldsDir = mkdtempSync(join(tmpdir(), "ew-collide-"));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  ws!: WebSocket;
  snapshot: any = null;
  entries: any[] = [];
  constructor(public id: string) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_);
      const t = setTimeout(() => reject(new Error(`${this.id}: join timeout`)), 8000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({
        type: "join", world: WORLD, id: this.id,
        avatar: "eidoverse/assets/vrms/claude.vrm",
      }));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "log") this.entries.push(m.entry);
        if (m.type === "snapshot") { this.snapshot = m; clearTimeout(t); resolve(); }
      };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error(`${this.id}: socket error`)); };
    });
  }
  verb(verb: string, args: unknown) { this.ws.send(JSON.stringify({ type: "verb", verb, args })); }
  close() { this.ws.close(); }
}

const alive = async () => {
  try { return (await fetch(`http://127.0.0.1:${PORT}/avatars`)).ok; } catch { return false; }
};

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  // A LEFTOVER sequencer on this port is not a nuisance, it is a false pass:
  // startServer polls until something answers, a stale process answers
  // instantly, and the whole suite then tests whatever code THAT process was
  // started with. This test was briefly green against a reverted fix for
  // exactly that reason — `kill()` does not reliably reap a bun child on
  // Windows. So: refuse to run rather than report a result about the wrong
  // build.
  if (await alive()) {
    throw new Error(`port ${PORT} is already serving — a previous run's sequencer is still up. `
      + `Kill it (or set PORT=) before trusting any result from this test.`);
  }
  // process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on
  // Windows, and it is the reason stopServer needs a tree-kill at all — the
  // shim exits immediately, so the "grandchild" named below is really just
  // the server, orphaned. Spawning the binary directly makes our pid the
  // sequencer's own.
  server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
    env: {
      ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "",
      FOLD_EVERY: "5", VERB_RATE: "5000", MSG_RATE: "5000",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    if (await alive()) return;
    await sleep(100);
  }
  throw new Error("server did not start");
}

/** Kill it and WAIT for the port to go quiet — see the note in startServer.
 *  On Windows neither SIGTERM nor SIGKILL reliably reaps a bun child (the
 *  signal is emulated), and a survivor silently poisons the NEXT run, so fall
 *  back to taskkill on the process tree. */
async function stopServer() {
  if (!server) return;
  // Since startServer spawns the binary directly, our pid IS the sequencer and
  // a plain kill would do. The tree-walk stays as belt-and-braces: it costs one
  // call, and it still reaps anything the sequencer itself spawned. Order
  // matters — walk the tree while the parent exists, then fall back to signals.
  if (process.platform === "win32" && server.pid) {
    spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    for (let i = 0; i < 30; i++) {
      if (!(await alive())) return;
      await sleep(100);
    }
  }
  server.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (!(await alive())) return;
    await sleep(100);
  }
  console.warn(`  \x1b[33m!\x1b[0m sequencer on ${PORT} outlived the test — kill it before re-running`);
}

try {
  console.log(`\ncollide-fold: ${URL_}  world=${WORLD}\n`);
  await startServer();

  const a = new Client("builder");
  await a.connect();

  // three spawns: an explicit override each way, and one that says nothing
  a.verb("spawn", { id: "blanket", lib: "store/fake-blanket.glb", pos: [0, 0, 0], collide: "exact" });
  a.verb("spawn", { id: "hut", lib: "store/fake-hut.glb", pos: [8, 0, 0], collide: "box" });
  a.verb("spawn", { id: "plain", lib: "store/fake-plain.glb", pos: [16, 0, 0] });
  await sleep(300);
  const spawnSeq = Math.max(...a.entries.filter((e) => e.verb === "spawn").map((e) => e.seq));

  // push the spawns well past the fold line (FOLD_EVERY=5)
  for (let i = 0; i < 20; i++) a.verb("say", { text: `advancing the log ${i}` });
  await sleep(600);

  const b = new Client("latecomer");
  await b.connect();
  const st = b.snapshot.state;
  const ents = st.entities ?? {};

  check("the spawn is genuinely behind the fold line (else this proves nothing)",
    b.snapshot.throughSeq >= spawnSeq,
    `throughSeq ${b.snapshot.throughSeq} < spawn seq ${spawnSeq}`);

  check('collide: "exact" survives the fold',
    ents.blanket?.collide === "exact", `got ${JSON.stringify(ents.blanket?.collide)}`);
  check('collide: "box" survives the fold',
    ents.hut?.collide === "box", `got ${JSON.stringify(ents.hut?.collide)}`);
  check("a spawn with no override stays un-opinionated (no invented default)",
    ents.plain != null && !("collide" in ents.plain),
    `got ${JSON.stringify(ents.plain?.collide)}`);

  // The same joiner's tail must not contradict the state it just folded.
  const tailSpawn = (b.snapshot.entries ?? []).find((e: any) => e.verb === "spawn" && e.args?.id === "blanket");
  check("no duplicate spawn in the tail to disagree with it", tailSpawn == null,
    "the spawn appears in BOTH state and tail");

  // Guard the sibling field, so a future fold edit that drops one drops both
  // loudly rather than silently.
  a.verb("spawn", { id: "scaled", lib: "store/fake.glb", pos: [0, 0, 8], scale: 2.5, collide: "exact" });
  for (let i = 0; i < 20; i++) a.verb("say", { text: `advancing again ${i}` });
  await sleep(600);
  const c = new Client("third");
  await c.connect();
  const sc = (c.snapshot.state.entities ?? {}).scaled;
  check("scale and collide survive together", sc?.scale === 2.5 && sc?.collide === "exact",
    `scale ${sc?.scale}, collide ${JSON.stringify(sc?.collide)}`);

  a.close(); b.close(); c.close();
} catch (err) {
  fail++;
  console.error(`\n  \x1b[31mharness error\x1b[0m ${String(err)}`);
} finally {
  await stopServer();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
