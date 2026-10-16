// tools/oldworlds-test.ts — a world saved by the old protocol is FOUND, not skipped (owner 10-15 22:45: "when someone tries to
// open a world saved by the old protocol, ping them with 'use the translator'").
//   O1–O4  oldWorldsIn(dir) over a scratch WORLDS_DIR holding a current world, a first-protocol world (log.jsonl), a
//          pre-names world and an empty directory: exactly the two old ones, each with its kind, a new name that collides
//          with nothing, and a command in world.ts's own usage
//   O5     the printed command WORKS: run as printed (the founder key swapped for --no-founder-key), it makes a current
//          world, and the original log's bytes are unchanged
//   O6     the boot notice: one block per world, NOT served, the command with this WORLDS_DIR, the "kept untouched" line,
//          and one summary line
//   O7     what a visitor is told, for both kinds: plain words, no command line
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/oldworlds-test.ts
// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { oldWorldsIn, oldWorldAt, bootNotice, visitorText } from "../server/oldworlds.ts";
import { isWorldDir } from "../server/livehost.ts";

const ROOT = path.resolve(import.meta.dir, "..");
let pass = 0, fail = 0;
const ok = (cond: unknown, label: string, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? `\n       ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
};
const base = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "oldworlds-"));
process.on("exit", () => { if (!process.env.PROTOCOL_KEEP) fs.rmSync(base, { recursive: true, force: true }); });
const W = path.join(base, "worlds"), OPT = path.join(base, "opt");
fs.mkdirSync(W, { recursive: true }); fs.mkdirSync(OPT, { recursive: true });
const tool = (args: string[], worlds = W) => { const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], { cwd: ROOT,
  env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: worlds, OPT_DIR: OPT, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };

// a current world
ok(tool(["found", "garden", "--owner", "Ann"]).code === 0, "setup: a current world (garden)");
// a world saved by the first protocol: a log.jsonl of its verbs (the shape tools/protocol/server-check.ts S6 translates)
const T0 = 1790000000000;
const L = [
  { actor: "world", verb: "grant", args: { id: "Ann", role: "owner", gen: true } },
  { actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "test/table.glb", pos: [1, 0, 1], yaw: 0.5 } },
  { actor: "Ann", verb: "say", args: { text: "hello from the old days" } }];
fs.mkdirSync(path.join(W, "oldtown"));
const oldLog = path.join(W, "oldtown", "log.jsonl");
fs.writeFileSync(oldLog, L.map((e, k) => JSON.stringify({ seq: k, ts: T0 + k * 1000, ...e })).join("\n") + "\n");
const oldBytes = fs.readFileSync(oldLog);
// a log of the current family saved before the 2026-10-07 names pass: its genesis stated its number in its own field
ok(tool(["found", "prenamed", "--owner", "Ann"]).code === 0, "setup: a world to age into a pre-names one");
{ const f = path.join(W, "prenamed", "world.jsonl"); const lines = fs.readFileSync(f, "utf8").split("\n");
  const g = JSON.parse(lines[0]); const { v, ...rest } = g.body; g.body = { ...rest, version: v }; lines[0] = JSON.stringify(g);
  fs.writeFileSync(f, lines.join("\n")); }
// an empty directory, named where the first suggestion for oldtown would land
fs.mkdirSync(path.join(W, "oldtown-2"));

ok(isWorldDir(path.join(W, "garden")) && !isWorldDir(path.join(W, "prenamed")), "setup: garden is a current world, prenamed is not");

// ---- O1–O4 ----
const found = oldWorldsIn(W);
ok(JSON.stringify(found.map((o) => [o.name, o.kind]).sort()) === JSON.stringify([["oldtown", "translatable"], ["prenamed", "pre-names"]]),
  "O1 oldWorldsIn finds exactly the two old worlds, each with its kind (the current world, the empty dir and keys/ are not old worlds)", found.map((o) => [o.name, o.kind]));
const ot = found.find((o) => o.name === "oldtown"), pn = found.find((o) => o.name === "prenamed");
ok(ot?.file === path.join(W, "oldtown", "log.jsonl") && pn?.file === path.join(W, "prenamed", "world.jsonl"), "O2 each names the file it found", [ot?.file, pn?.file]);
ok(ot?.suggestedName === "oldtown-3" && pn?.suggestedName === "prenamed-2" && !fs.existsSync(path.join(W, ot.suggestedName)),
  "O3 the suggested new name collides with nothing on disk (oldtown-2 is taken, even though it is empty)", [ot?.suggestedName, pn?.suggestedName]);
const CMD = /^WORLDS_DIR=(\S+) bun tools\/protocol\/world\.ts translate ([a-z0-9_-]{1,64}) ([a-z0-9_-]{1,64}) --founder-key <[^>]+>$/i;
const m = CMD.exec(ot?.command ?? "");
ok(m && m[1] === W && m[2] === "oldtown" && m[3] === "oldtown-3", "O4 the command is world.ts's own usage, with this WORLDS_DIR filled in and the founder key a placeholder", ot?.command);
const pm = /^WORLDS_DIR=(\S+) bun tools\/protocol\/world\.ts translate (<[a-z-]+>) ([a-z0-9_-]{1,64}) --founder-key <[^>]+>$/i.exec(pn?.command ?? "");
ok(pm && pm[1] === W && pm[3] === "prenamed-2" && pm[2] !== "prenamed" && /found prenamed-2 --owner/.test(pn?.refound ?? ""),
  "O4 a pre-names world's command re-translates from its ORIGINAL old log (not itself), and a refound is offered", [pn?.command, pn?.refound]);
ok(oldWorldAt(W, "garden") === null && oldWorldAt(W, "oldtown-2") === null && oldWorldAt(W, "nowhere") === null && oldWorldAt(W, "oldtown")?.kind === "translatable",
  "O4 oldWorldAt answers one name: null for a current world, an empty dir and a missing one");

// ---- O5: the printed command, run ----
{ const argv = ((ot?.command ?? "x=y bun").replace(/--founder-key <[^>]+>$/, "--no-founder-key")).split(" ");
  const env = Object.fromEntries([argv.shift()!.split("=")]);
  ok(argv[0] === "bun" && argv[1] === "tools/protocol/world.ts", "O5 the command runs world.ts", argv);
  const r = Bun.spawnSync(argv, { cwd: ROOT, env: { ...process.env, ...env, OPT_DIR: OPT, TRUST_NAMES: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const out = r.stdout.toString() + r.stderr.toString();
  ok(r.exitCode === 0 && /0 divergences/.test(out), "O5 run as printed (--no-founder-key for the test), it translates", out.slice(-600));
  ok(isWorldDir(path.join(W, "oldtown-3")), "O5 …and the new name is a current world");
  ok(Buffer.compare(oldBytes, fs.readFileSync(oldLog)) === 0, "O5 …and the original log's bytes are unchanged");
  ok(oldWorldsIn(W).find((o) => o.name === "oldtown")?.suggestedName === "oldtown-4", "O5 the next suggestion steps past the world just made"); }

// ---- O6: the boot notice ----
{ const n = bootNotice(W); const blocks = n.split(/\n(?=\[boot\] old-format world)/);
  ok(blocks.length === 2 && /"oldtown"/.test(blocks[0] + blocks[1]) && /"prenamed"/.test(blocks[0] + blocks[1]), "O6 one block per old world", n);
  const b1 = blocks.find((b) => /"oldtown"/.test(b)) ?? "", b2 = blocks.find((b) => /"prenamed"/.test(b)) ?? "";
  ok(/NOT being served/.test(b1) && /NOT being served/.test(b2), "O6 each says it is NOT being served");
  ok(b1.includes(`WORLDS_DIR=${W} bun tools/protocol/world.ts translate oldtown oldtown-4 --founder-key <the founder's ed25519 key>`), "O6 the translatable block carries the exact command", b1);
  ok(/re-translate/i.test(b2) && /refound/.test(b2) && b2.includes(`found prenamed-2 --owner`), "O6 the pre-names block says re-translate from its original, or refound", b2);
  ok([b1, b2].every((b) => b.includes("the original log is kept untouched; translate into a new name, then point links at it (or rename the directories)")), "O6 each carries the kept-untouched line");
  ok(/^\[boot\] 2 world\(s\) need translating — see above$/m.test(n) && n.trimEnd().endsWith("see above"), "O6 one summary line, last", n.split("\n").at(-1));
  const empty = path.join(base, "none"); fs.mkdirSync(empty); tool(["found", "only", "--owner", "Ann"], empty);
  ok(bootNotice(empty) === "" && oldWorldsIn(empty).length === 0, "O6 a dir with no old world prints nothing"); }

// ---- O7: what a visitor is told ----
{ const v1 = visitorText("oldtown", "translatable"), v2 = visitorText("prenamed", "pre-names");
  ok(v1 === `"oldtown" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost — the world's log is kept as it was.`, "O7 the translatable visitor text, verbatim", v1);
  ok(/^"prenamed" /.test(v2) && /whoever runs this server/.test(v2) && /kept as it was/.test(v2) && v2 !== v1.replace("oldtown", "prenamed"), "O7 the pre-names visitor text, in its own words", v2);
  ok([v1, v2].every((t) => !/\bbun\b|tools\/|world\.ts|translate |--/.test(t)), "O7 neither carries a command line", [v1, v2]);
  ok(oldWorldAt(W, "oldtown")?.visitor === v1 && oldWorldAt(W, "prenamed")?.visitor === v2, "O7 oldWorldAt carries the visitor text the join sends"); }

console.log(`oldworlds: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
