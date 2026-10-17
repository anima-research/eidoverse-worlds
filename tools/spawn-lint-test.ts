// Advisory spawn lint through the real sequencer, with isolated asset roots.
// bun run tools/spawn-lint-test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkCheck, scratchSequencer } from "./harness.ts";

const { check, tally } = mkCheck();
const assets = mkdtempSync(join(tmpdir(), "ew-spawn-assets-"));
const library = join(assets, "library"), overlay = join(assets, "overlay"), patched = join(assets, "patched");
mkdirSync(library); mkdirSync(overlay); mkdirSync(patched);
// The ladder's first rung: a model only the patched directory holds.
writeFileSync(join(patched, "patched-only.glb"), "fixture");
// Lint checks resolvability, not GLB decode; no optimizer or renderer runs.
writeFileSync(join(library, "library.glb"), "fixture");
writeFileSync(join(overlay, "upload.VRM"), "fixture");
// The route keeps URL.pathname encoded: literal disk names alone are not
// fetchable under these URLs; encoded-name fixtures are a separate case.
writeFileSync(join(library, "space model.glb"), "literal-only");
writeFileSync(join(library, "café.glb"), "literal-only");
writeFileSync(join(library, "encoded%20model.glb"), "fixture");
writeFileSync(join(library, "caf%C3%A9-served.glb"), "fixture");
// A directory on a higher rung shadows the file below it: the route stops at
// the first entry that exists and answers it with an error.
mkdirSync(join(patched, "shadow.glb")); writeFileSync(join(library, "shadow.glb"), "fixture");
mkdirSync(join(overlay, "body.vrm")); writeFileSync(join(library, "body.vrm"), "fixture");
// Animation defs name clips by library path, and the clip roster lists a
// def's clip only where /library serves it: under its encoded name.
const defs = join(assets, "defs");
mkdirSync(join(defs, "animations"), { recursive: true });
mkdirSync(join(library, "clips"));
writeFileSync(join(defs, "animations", "encoded-clip.json"), JSON.stringify({ vrma: "clips/space clip.vrma" }));
writeFileSync(join(library, "clips", "space%20clip.vrma"), "fixture");
writeFileSync(join(defs, "animations", "literal-clip.json"), JSON.stringify({ vrma: "clips/literal clip.vrma" }));
writeFileSync(join(library, "clips", "literal clip.vrma"), "literal-only");
const run = await scratchSequencer("spawn-lint", {
  portFrom: 9180,
  serverEnv: {
    EIDOVERSE_DIR: library, OPT_DIR: overlay, PATCH_DIR: patched, SKIP_OPT_SWEEP: "1",
    HN_REQUIRE_LOGIN: "0", HN_ISSUER_KEY: "", VERB_RATE: "100", DEFS_DIR: defs,
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
    ["versioned", "library.glb?v=123", null],
    ["fragment", "library.glb#mesh", null],
    ["query-fragment", "library.glb?v=123#mesh", null],
    ["missing-versioned", "absent.glb?v=123", "not-found"],
    ["literal-space", "space model.glb", "not-found"],
    ["literal-unicode", "café.glb", "not-found"],
    ["encoded-space", "encoded model.glb", null],
    ["encoded-unicode", "café-served.glb", null],
    ["already-encoded", "encoded%20model.glb", null],
    ["patched", "patched-only.glb", null],
    ["patched-directory", "shadow.glb", "not-found"],
    ["overlay-directory", "body.vrm", "not-found"],
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
  for (const lib of ["library.glb?v=123", "library.glb#mesh", "library.glb?v=123#mesh", "patched-only.glb"]) {
    const served = await fetch(run.BASE + "/library/" + lib);
    check("lint matches the actual asset route for " + lib, served.ok && await served.text() === "fixture");
  }
  for (const lib of ["shadow.glb", "body.vrm"]) {
    const served = await fetch(run.BASE + "/library/" + lib);
    check("the route serves no file where a directory shadows one: " + lib, !served.ok, String(served.status));
  }
  const clips = await (await fetch(run.BASE + "/animations")).json() as { name: string; path: string }[];
  const encodedClip = clips.find(c => c.name === "encoded-clip");
  check("a def's clip is listed where /library serves it, under its encoded name",
    !!encodedClip && /^clips\/space clip\.vrma\?v=\d+$/.test(encodedClip.path), JSON.stringify(clips));
  const servedClip = await fetch(run.BASE + "/library/" + encodedClip?.path);
  check("the listed clip's path is served", servedClip.ok && await servedClip.text() === "fixture");
  check("a clip only its literal disk name holds is not listed, since /library can't serve it",
    !clips.some(c => c.name === "literal-clip"), JSON.stringify(clips));
  for (const [lib, available] of [["space model.glb", false], ["café.glb", false],
      ["encoded model.glb", true], ["café-served.glb", true], ["encoded%20model.glb", true]] as const) {
    const served = await fetch(run.BASE + "/library/" + lib);
    check("URL-encoded pathname agrees with the actual route for " + lib,
      available ? served.ok && await served.text() === "fixture" : served.status === 404);
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
  const inert = [
    { id: "library" }, { id: "library", lib: "" }, { id: "library", lib: null },
    { id: "never-created", lib: false }, { id: "never-created", lib: 0 },
  ];
  for (const args of inert) author.send({ type: "verb", verb: "spawn", args });
  await until(() => author.messages.filter(m => m.type === "log" && m.entry.verb === "spawn").length === cases.length + inert.length);
  const afterInert = await open("after-inert");
  check("fold-inert spawns leave the existing entity unchanged",
    JSON.stringify(afterInert.snapshot.state.entities.library) === JSON.stringify(eye.snapshot.state.entities.library));
  check("fold-inert new ids do not create entities", !afterInert.snapshot.state.entities["never-created"]);
  check("fold-inert spawns add no misleading lint", (await debug(afterInert)).length === events.length);
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

  // A restart replays the world's history at boot; that replay commits
  // nothing new, so it lints nothing, unresolvable spawns included.
  const history = join(run.SCRATCH, "worlds", "lint-test");
  const restarted = await scratchSequencer("spawn-lint-restart", {
    portFrom: 9200,
    prepare: (scratch) => { cpSync(history, join(scratch, "worlds", "lint-test"), { recursive: true }); },
    serverEnv: {
      EIDOVERSE_DIR: library, OPT_DIR: overlay, PATCH_DIR: patched, SKIP_OPT_SWEEP: "1",
      HN_REQUIRE_LOGIN: "0", HN_ISSUER_KEY: "", VERB_RATE: "100",
    },
  });
  try {
    const ws = new WebSocket(restarted.BASE.replace("http:", "ws:") + "/ws");
    sockets.push(ws);
    const messages: Message[] = [];
    ws.onmessage = ev => messages.push(JSON.parse(String(ev.data)));
    await until(() => ws.readyState === WebSocket.OPEN);
    ws.send(JSON.stringify({ type: "join", id: "after-restart", world: "lint-test" }));
    await until(() => messages.some(m => m.type === "snapshot"));
    const snapshot = messages.find(m => m.type === "snapshot")!;
    check("the restart replayed the history", snapshot.state.entities["missing"]?.lib === "absent.glb");
    ws.send(JSON.stringify({ type: "debug", reqId: 1, kinds: ["spawn-lint"], limit: 100 }));
    await until(() => messages.some(m => m.type === "debug" && m.reqId === 1));
    // The bound script runs again after the restart and its spawn is a new
    // live commit, linted as one; nothing the replay re-folded is.
    const lastReplayed = Math.max(...author.messages.filter(m => m.type === "log").map(m => m.entry.seq));
    const linted = messages.find(m => m.type === "debug" && m.reqId === 1)!.events as Message[];
    check("a boot replay of unresolvable spawns lints nothing it replayed",
      linted.every(e => e.seq > lastReplayed), JSON.stringify(linted.filter(e => e.seq <= lastReplayed).slice(0, 3)));
  } finally {
    await restarted.cleanup(tally.failed ? 1 : 0);
  }
  completed = true;
} finally {
  for (const ws of sockets) ws.close();
  await run.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(assets, { recursive: true, force: true });
}
console.log(`${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
