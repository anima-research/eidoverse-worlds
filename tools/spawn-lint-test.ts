// Advisory spawn lint through the real sequencer, with isolated asset roots.
// bun run tools/spawn-lint-test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkCheck, scratchSequencer } from "./harness.ts";

const { check, tally } = mkCheck();
const assets = mkdtempSync(join(tmpdir(), "ew-spawn-assets-"));
const library = join(assets, "library"), overlay = join(assets, "overlay");
mkdirSync(library); mkdirSync(overlay);
// Lint checks resolvability, not GLB decode; no optimizer or renderer runs.
writeFileSync(join(library, "library.glb"), "fixture");
writeFileSync(join(overlay, "upload.VRM"), "fixture");
const run = await scratchSequencer("spawn-lint", {
  portFrom: 9180,
  serverEnv: {
    EIDOVERSE_DIR: library, OPT_DIR: overlay, SKIP_OPT_SWEEP: "1",
    HN_REQUIRE_LOGIN: "0", HN_ISSUER_KEY: "", VERB_RATE: "100",
  },
});
const sockets: WebSocket[] = [];
type Message = Record<string, any>;
async function open(id: string) {
  const ws = new WebSocket(run.BASE.replace("http:", "ws:") + "/ws");
  sockets.push(ws);
  const messages: Message[] = [];
  ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
  await until(() => ws.readyState === WebSocket.OPEN);
  ws.send(JSON.stringify({ type: "join", id, world: "lint-test" }));
  await until(() => messages.some(m => m.type === "snapshot"));
  return {
    ws, messages,
    send: (m: Message) => ws.send(JSON.stringify(m)),
    snapshot: messages.find(m => m.type === "snapshot")!,
  };
}
async function until(ok: () => boolean) {
  const end = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting for sequencer");
    await Bun.sleep(10);
  }
}
let request = 0;
async function debug(s: Awaited<ReturnType<typeof open>>) {
  const reqId = ++request;
  s.send({ type: "debug", reqId, kinds: ["spawn-lint"], limit: 100 });
  await until(() => s.messages.some(m => m.type === "debug" && m.reqId === reqId));
  return s.messages.find(m => m.type === "debug" && m.reqId === reqId)!.events as Message[];
}
let completed = false;
try {
  const author = await open("builder");
  const cases = [
    ["no-extension", "claude/violet-woven-blanket-with-mismatched-cushions", "malformed"],
    ["missing", "absent.glb", "not-found"],
    ["traversal", "../outside.glb", "malformed"],
    ["nul", "bad\0.glb", "malformed"],
    ["number", 42, "malformed"],
    ["library", "library.glb", null],
    ["overlay", "upload.VRM", null],
  ] as const;
  for (const [id, lib] of cases) {
    author.send({ type: "verb", verb: "spawn", args: { id, lib, pos: [0, 0, 0] } });
  }
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.verb === "spawn").length === cases.length);
  const events = await debug(author);
  check("advisory lint accepts every spawn without a wire refusal", !author.messages.some(m => m.type === "error"));
  for (const [id, lib, reason] of cases) {
    const event = events.find(e => e.entity === id);
    check(id + " has the expected diagnosis", reason ? event?.reason === reason : !event, JSON.stringify(event));
    if (reason) check(id + " names the actor, entity, library and log sequence",
      event?.by === author.snapshot.you && event?.lib === lib && Number.isInteger(event?.seq));
  }
  const eye = await open("observer");
  check("invalid library spawns still fold and appear on late join",
    cases.every(([id, lib]) => eye.snapshot.state.entities[id]?.lib === lib));
  check("joining does not replay lint", (await debug(eye)).length === events.length);
  const logPath = join(run.SCRATCH, "worlds", "lint-test", "log.jsonl");
  // Folded snapshots and wire echoes prove acceptance; the persisted log proves
  // lint stayed out of authored history. WorldLog's sink flushes periodically.
  await until(() => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").filter(line => JSON.parse(line).verb === "spawn").length === cases.length; }
    catch { return false; }
  });
  check("the world log contains no lint entries", !readFileSync(logPath, "utf8").includes('"verb":"spawn-lint"'));
  author.send({ type: "verb", verb: "remove", args: { id: "no-extension" } });
  await until(() => author.messages.some(m => m.type === "log" && m.entry.verb === "remove"));
  const after = await open("after-remove");
  check("a warned ghost remains removable", !after.snapshot.state.entities["no-extension"]);
  check("unrelated verbs do not lint", (await debug(after)).length === events.length);
  const uploaded = await fetch(run.BASE + "/upload?as=script", {
    method: "POST", body: 'world.emit("spawn", {id: "script-ghost", lib: "script-missing.glb"});',
  });
  if (!uploaded.ok) throw new Error("script upload: " + await uploaded.text());
  const script = await uploaded.json() as { path: string };
  author.send({ type: "verb", verb: "behavior", args: {
    id: "spawner", src: script.path, caps: { verbs: ["spawn"] },
  } });
  await until(() => author.messages.some(m => m.type === "log" && m.entry.verb === "spawn" && m.entry.args.id === "script-ghost"));
  const scriptEntry = author.messages.find(m => m.type === "log" && m.entry.args?.id === "script-ghost")!.entry;
  const scriptWarning = (await debug(author)).filter(e => e.entity === "script-ghost");
  check("script-authored spawns receive exactly one warning via the commit bus",
    scriptWarning.length === 1 && scriptWarning[0].by === scriptEntry.actor && scriptWarning[0].seq === scriptEntry.seq);
  completed = true;
} finally {
  for (const ws of sockets) ws.close();
  await run.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(assets, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
