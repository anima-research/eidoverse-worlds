// test/protocol/blockers-mutants.ts — the RED side of every blocker's row, run (review of PR #260, 2026-10-18: "red mutations").
// For each of the reviewer's blockers (B1–B10 but B3, whose per-world fence main's #255 removed: 7d3050686), the architecture note's items that have code (M1–M8), review r14's three
// (M1–M3) and the security review's four (H1, H2, M6, L11), ONE mutation of the fix's code — a text find/replace applied to a scratch copy of the tree, the mechanism
// txn-check --mutants and r10/r11-check MUTANTS use — and the ONE suite whose named row(s) it must turn red. Plus a no-op control
// that must stay green. Each find text must occur exactly once at HEAD (a fix that moved is a FAIL here, not a silent skip).
// This suite's output is the PR's red/green table: `id → mutant → row turned red`.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/protocol/blockers-mutants.ts            every mutant (the gate runs it in pieces: --group)
//   … --only B4,M5                                                                        a subset (an id with no row is refused)
//   … --group a                                                                           one of the gate's pieces (GROUPS); --list prints the ids it would run
// Bounded: each mutant runs only the one suite it names; the scratch tree links node_modules and copies server/, shared/,
// client/lib, mcpl/, tools/, test/, spec/, docs/, defs/ (the suites read spec and docs as text). No browser.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, linkInto, readLF } from "../gate/common.ts";

type Mutant = { id: string; what: string; file: string; find: string; repl: string; suite: string; rows: string[]; expect: number };
// suite: the gate's name for it (test/gate/suites.ts) → the file to run, relative to the scratch root
const SUITE_FILE: Record<string, string> = {
  authority: "test/protocol/authority-check.ts", access: "test/protocol/access-check.ts", "reset-race": "test/protocol/reset-race-check.ts",
  r10: "test/protocol/r10-check.ts", "dismount-height": "test/client/dismount-height-test.ts", inplace: "test/protocol/inplace-check.ts",
  settle: "test/protocol/settle-check.ts", txn: "test/protocol/txn-check.ts", identity: "test/protocol/identity-check.ts",
  kernel: "test/protocol/kernel-check.ts", "gov-reserved": "test/protocol/gov-reserved-check.ts",
};

const M: Mutant[] = [
  // ---- B1–B10: the reviewer's blockers, in review order ----
  { id: "B1", what: "writeLine throws → the entry reached memory anyway (chain ahead of disk)", file: "shared/protocol/authority/storage.js",
    find: 'durably("log", () => io.writeLine(line));',   // the entry in memory first; a throw leaves it there (the push after is undone on success)
    repl: 'entries.push(posAt(parsed, seq)); durably("log", () => io.writeLine(line)); entries.pop();', suite: "authority", rows: ["ST1"], expect: 9 },
  { id: "B2", what: "a batch op's args unchecked before any is built ({verb: delete, args: {id, componnent}} deletes the entity)", file: "shared/protocol/authority/verbs.js",
    find: "        if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, `batch request ${i}", repl: "        if (false) { const { code, reason, fix, ...rest } = bad; refuse(code, `batch request ${i}", suite: "authority", rows: ["BT1"], expect: 9 },
  { id: "B4", what: "a request whose connection was superseded while it awaited still writes", file: "server/request-capability.ts",
    find: "  if (!(c.world === w && !c.superseded && w.clients.has(c) && (c.gen ?? null) === cap.gen))", repl: "  if (false)", suite: "reset-race", rows: ["SR1"], expect: 1 },
  { id: "B5", what: "a server operator's repair is not narrow: any verb through the operator door", file: "shared/protocol/authority.js",
    find: '  if (!(door || verb === "unban"))\n    return { ok: false, refused: { code: "rights", reason: `an operator\'s repair covers', repl: '  if (false)\n    return { ok: false, refused: { code: "rights", reason: `an operator\'s repair covers', suite: "authority", rows: ["OP4"], expect: 9 },
  { id: "B6", what: "a created child's pose is read from before the write (resettle planned against the wrong state)", file: "shared/protocol/authority/followups.js",
    find: "const was = (k) => (before.entities[k] ? worldT(before, k) : null) ?? worldT(after, k);", repl: "const was = (k) => worldT(before, k);", suite: "r10", rows: ["F3"], expect: 2 },
  { id: "B7", what: "standing up zeroes Y (a seat upstairs stands me on the ground floor)", file: "client/lib/player/localbody.js",
    find: "    myState.pos.set(off.x, off.y, off.z); myState.yaw = exitYaw;", repl: "    myState.pos.set(off.x, 0, off.z); myState.yaw = exitYaw;", suite: "dismount-height", rows: ["D1"], expect: 1 },
  { id: "B8", what: "the old log is not rechecked after the last rename (a write that slipped in mid-swap is kept out)", file: "tools/world.ts",
    find: "    { const now = sourceChanged(path.join(D, ORIGINAL.log), r!.source); if (now) throw new Error(stillWriting(path.join(D, ORIGINAL.log), r!.source, now)); }", repl: "    { }", suite: "inplace", rows: ["IP15"], expect: 20 },
  { id: "B9", what: "a failed in-place translation leaves its minted identities in the shared directory", file: "tools/world.ts",
    find: "{ name, deferIdentities: true, approval, claim: CLAIM });", repl: "{ name, deferIdentities: false, approval, claim: CLAIM });", suite: "inplace", rows: ["IP17"], expect: 20 },
  { id: "B10", what: "deleting a support skips what is parented elsewhere but rested on it too", file: "shared/protocol/authority/writes.js",
    find: "      if (tops.some((s) => hitsIx(ctx.st, { min: [s.min[0], s.y - 0.01, s.min[1]], max: [s.max[0], s.y + 0.03, s.max[1]] }, k, 0))) wake.push(k); }", repl: "      if (false) wake.push(k); }", suite: "settle", rows: ["SE18"], expect: 6 },
  // ---- M1–M8: the architecture note's items (M9, read-time repair, lost its code with shape repair in 897601678; M10, the gate itself, has no code to mutate: --check-manifest is its row) ----
  { id: "M1", what: "a throw from a durable write reported rolled-back (no ambiguous outcome)", file: "shared/protocol/authority/storage.js",
    find: '  if (newLog || newMod) return { outcome: "ambiguous"', repl: '  if (false) return { outcome: "ambiguous"', suite: "txn", rows: ["T2"], expect: 1 },
  { id: "M2", what: "a connection that became someone else while its request waited is not refused (the capability's identity not rechecked at the commit seam)", file: "server/request-capability.ts",
    find: "  if (c.actorId !== cap.actorId ||", repl: "  if (false &&", suite: "txn", rows: ["T6"], expect: 1 },
  { id: "M3", what: "the operator's repair is not recorded as the operator's (no operator: true in the act)", file: "shared/protocol/authority/writes.js",
    find: "CTX.operator && CTX.operator === actor && !ctx.cap ? { ...(ctx.actExtra ?? {}), operator: true } : ctx.actExtra", repl: "ctx.actExtra", suite: "authority", rows: ["OP3"], expect: 9 },
  { id: "M4", what: "speech privacy: everyone reads the master log's say bodies, not only admins (the floor is null for all)", file: "server/world.ts",
    find: "  sayFloorFor(c: Client): number | null {\n    if (this.isAdmin(c)) return null;", repl: "  sayFloorFor(c: Client): number | null {\n    if (true) return null;", suite: "identity", rows: ["RS10"], expect: 42 },
  { id: "M5", what: "the kernel's scope shrinks (access leaves it): the pin and the code disagree, the registry's kernel names aren't the kernel's", file: "shared/protocol/kernelspec.js",
    find: 'export const KERNEL_COMPONENTS = Object.freeze(["roles", "access"]);', repl: 'export const KERNEL_COMPONENTS = Object.freeze(["roles"]);', suite: "kernel", rows: ["K1", "K12"], expect: 1 },   // K1 names the kernel's list; K12 builds its base from access (C11b: the trim paths no longer read the list, so K3/K13 rightly stay green)
  { id: "M6a", what: "the approval isn't bound to the report: a hash that doesn't match the report as it stands is accepted", file: "tools/world.ts",
    find: "  if (hash !== approved) die(`the dry-run report of", repl: "  if (false) die(`the dry-run report of", suite: "inplace", rows: ["IP21"], expect: 20 },
  { id: "M6b", what: "the countersignature isn't checked by the writer (a bad operator countersignature writes the log)", file: "tools/import-v1/world.ts",
    find: "    if (bad) throw new Error(`the approval is refused: ${bad}. Nothing written`);", repl: "    if (false) throw new Error(`the approval is refused: ${bad}. Nothing written`);", suite: "inplace", rows: ["IP29"], expect: 20 },
  { id: "M6c", what: "no owner can sign, but the translation proceeds without --operator-only-no-owner (the operator never said so knowingly)", file: "tools/world.ts",
    find: "  if (!noOwner) die(`\"${name}\": ${NO_FOUNDER}, so no owner can sign this approval.", repl: "  if (false) die(`\"${name}\": ${NO_FOUNDER}, so no owner can sign this approval.", suite: "inplace", rows: ["IP28"], expect: 20 },
  // #260 rereview blocker 1: a translation names no founder (nothing can bind a key to the v1 owner), refused at the CLI AND in the writer
  { id: "M6d", what: "translate accepts --founder-key / --approve-sig again (an operator-chosen key recorded as the owner's)", file: "tools/world.ts",
    find: '  if (rest.includes("--founder-key") || rest.includes("--approve-sig")) die(', repl: "  if (false) die(", suite: "inplace", rows: ["IP22"], expect: 20 },
  { id: "M6e", what: "the writer accepts an approval carrying an owner's signature (a key nothing binds to the owner)", file: "tools/import-v1/world.ts",
    find: "  if ((a as any).owner !== null) return", repl: "  if (false) return", suite: "inplace", rows: ["IP29"], expect: 20 },
  { id: "M6f", what: "the writer accepts a founder key for a translation (tier 0 filled with an unbound key)", file: "tools/import-v1/world.ts",
    find: "  if (founderKey !== undefined) throw new Error(`a translation takes no founder key:", repl: "  if (false) throw new Error(`a translation takes no founder key:", suite: "inplace", rows: ["IP29"], expect: 20 },
  { id: "M7", what: "a deferred feature (an air box on @world) is dropped quietly instead of refusing the translation", file: "tools/import-v1/world.ts",
    find: '    refused: deferred.length ? deferredRefusal(deferred, `"${world}"`) : watchRefusal(watch, `"${world}"`),', repl: '    refused: watchRefusal(watch, `"${world}"`),', suite: "inplace", rows: ["IP26"], expect: 20 },
  { id: "M8", what: "governance not marked reserved: a log holding a sequencer entry is served", file: "server/livehost.ts",
    find: '    if (g >= 0) throw new Error(`"${name}" can\'t be served: its log holds a governance entry', repl: '    if (false) throw new Error(`"${name}" can\'t be served: its log holds a governance entry', suite: "gov-reserved", rows: ["G2"], expect: 1 },
  // ---- review r14 (10-18) ----
  { id: "r14-M1", what: "voice-moderate writes through w.log.request directly (no capability, no queue, no meters)", file: "server/server.ts",
    find: '          void requestAs(c, ws, w, muted ? "mute" : "unmute",', repl: '          void w.log.request(actorIdOf(c), muted ? "mute" : "unmute",', suite: "txn", rows: ["T11"], expect: 1 },
  { id: "r14-M2", what: "the transaction outcome ignores the moderator log's wedge (a ban whose mod-log write threw is rolled-back)", file: "shared/protocol/authority/storage.js",
    find: 'export const wedgedOf = (w) => ({ log: !!w.wedged?.log, mod: !!w.wedged?.["moderator log"] });', repl: "export const wedgedOf = (w) => ({ log: !!w.wedged?.log, mod: false });", suite: "authority", rows: ["ST4"], expect: 9 },
  { id: "r14-M3", what: "rollback ignores files the server made since the translation (world.mod.jsonl is neither refused nor removed)", file: "tools/world.ts",
    find: "  const since = fs.readdirSync(D).filter((f) => !known.has(f) && !isCacheFile(f));", repl: "  const since: string[] = [];", suite: "inplace", rows: ["IP30"], expect: 20 },
  // ---- security review (10-18) ----
  { id: "sec-H1", what: "a server ban is filed without the account (a bare name): findBan binds nothing until a restart", file: "server/messages.ts",
    find: "    for (const account of accounts) serverBans[banKey(account)] = { by: c.id, ts, name: id, account, ...(until ? { until } : {}), ...(reason ? { reason } : {}) };", repl: "    for (const account of accounts) serverBans[banKey(account)] = { by: c.id, ts, name: id, ...(until ? { until } : {}), ...(reason ? { reason } : {}) };", suite: "access", rows: ["A12"], expect: 12 },
  { id: "sec-H2", what: "X-Real-IP trusted from any peer (a direct guest picks or frames an address)", file: "server/peer.ts",
    find: "  if (isTrustedProxy(peer, trusted)) {", repl: "  if (true) {", suite: "access", rows: ["A13"], expect: 12 },
  { id: "sec-M6", what: "an ended timed grant still lists its holder on read (until ignored until the sweep)", file: "shared/protocol/access.js",
    find: "  return !(now != null && Number.isSafeInteger(r.until) && r.until <= now);", repl: "  return true;", suite: "access", rows: ["A14"], expect: 12 },
  { id: "sec-L11", what: "a reserved agent name matched exact-lowercase only (\"Wre n\" gets through)", file: "server/server.ts",
    find: "      const reservedAs = [...at.names].find((n) => foldName(n) === foldName(c.id)) ?? null;", repl: "      const reservedAs = [...at.names].find((n) => n === c.id.toLowerCase()) ?? null;", suite: "identity", rows: ["C2f"], expect: 42 },
  // ---- the control: a comment changed, nothing else; its suite must stay green ----
  { id: "CONTROL", what: "no-op (a comment): must stay green", file: "shared/protocol/authority/storage.js",
    find: "// Persist before publishing: a line reaches memory", repl: "// Persist before publishing:  a line reaches memory", suite: "reset-race", rows: [], expect: 1 },
];

// the gate's pieces (blockers-mutants-a…d in suites.ts), balanced by measured time; each runs the CONTROL too, and every
// mutant is in exactly one piece (checked below, in every piece, so a mutant added to M and to no group fails them all)
const GROUPS: Record<string, string[]> = {
  a: ["B8", "B9", "M6a", "M6b", "M6c"],                                                      // inplace
  b: ["M6d", "M6e", "M6f", "M7"],                                                            // inplace
  c: ["r14-M3", "M4", "sec-L11", "B4", "M1", "M2", "r14-M1", "B6", "B7", "B10", "M5", "M8"], // inplace, identity, the quick suites
  d: ["B1", "B2", "B5", "M3", "r14-M2", "sec-H1", "sec-H2", "sec-M6"],                       // authority, access
};
const argv = process.argv.slice(2);
const onlyI = argv.indexOf("--only"); const only = onlyI >= 0 ? new Set(argv[onlyI + 1].split(",")) : null;
const groupI = argv.indexOf("--group"); const group = groupI >= 0 ? argv[groupI + 1] : null;
const partition: string[] = [];
{ const seen = new Map<string, string>(); const ids = new Set(M.map((m) => m.id));
  for (const [g, xs] of Object.entries(GROUPS)) for (const x of xs) {
    if (x === "CONTROL" || !ids.has(x)) partition.push(`group ${g} names "${x}", which is not a mutant`);
    else if (seen.has(x)) partition.push(`"${x}" is in group ${seen.get(x)} and group ${g}`); else seen.set(x, g); }
  for (const m of M) if (m.id !== "CONTROL" && !seen.has(m.id)) partition.push(`"${m.id}" is in no group`); }
if (group !== null && !GROUPS[group]) partition.push(`no group "${group}" (${Object.keys(GROUPS).join(" | ")})`);
if (partition.length) { for (const p of partition) console.log(`FAIL partition: ${p}`); process.exit(1); }
const inGroup = group ? new Set([...GROUPS[group], "CONTROL"]) : null;
const todo = M.filter((m) => (!only || only.has(m.id)) && (!inGroup || inGroup.has(m.id)));
const unknown = only ? [...only].filter((id) => !M.some((m) => m.id === id)) : [];
if (unknown.length) { console.error(`[blockers-mutants] no mutant ${unknown.join(", ")} (the ids: ${M.map((m) => m.id).join(", ")})`); process.exit(2); }
// a selection that runs nothing is a mistake, never a green run
const outside = only && inGroup ? [...only].filter((id) => !inGroup.has(id)) : [];
if (outside.length) { console.error(`[blockers-mutants] ${outside.join(", ")} not in group ${group}`); process.exit(2); }
if (!todo.length) { console.error("[blockers-mutants] nothing selected"); process.exit(2); }
if (argv.includes("--list")) { console.log(todo.map((m) => m.id).join("\n")); process.exit(0); }

/** A scratch copy of the tree: what the suites read (code and text), node_modules linked. client/ is linked except lib/ (copied: B7 edits it). */
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const k of ["server", "shared", "mcpl", "tools", "test", "spec", "docs", "defs"]) fs.cpSync(path.join(ENGINE, k), path.join(d, k), { recursive: true, filter: (s) => !s.includes(`${path.sep}node_modules`) });
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") linkInto(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  for (const f of ["package.json", "AGENTS.md", "README.md", "bun.lock"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  linkInto(path.join(ENGINE, "node_modules"), path.join(d, "node_modules"));
  return d;
}
// the red rows of a run: `FAIL <id> …` (most suites), `FAIL <id>` from settle's console.log("FAIL", name), `✗ <id> …` (the tools/ tests)
const redRows = (out: string) => [...new Set([...out.replace(/\x1b\[[0-9;]*m/g, "").matchAll(/^\s*(?:FAIL|✗)\s+(\S+)/gm)].map((m) => m[1].replace(/[:,]$/, "")))];   // colours stripped (the tools/ tests paint ✗)

let bad = 0; const table: string[] = [];
console.log(`[blockers-mutants]${group ? ` group ${group}:` : ""} ${todo.length} mutant(s): each applied to a scratch copy of the tree, then its one suite run`);
for (const m of todo) {
  const t0 = performance.now();
  const src = readLF(path.join(ENGINE, m.file));   // read only: the count is taken here, the write goes to the copy below
  if (src.split(m.find).length !== 2) { bad++; console.log(`FAIL ${m.id} '${m.what}': its find text occurs ${src.split(m.find).length - 1}× in ${m.file} (must be exactly once: the fix moved?)`); table.push(`| ${m.id} | ${m.file} | (find text not found once) | ${m.suite} | FAIL |`); continue; }
  const d = copyTree(`bm-${m.id.toLowerCase()}`);
  const f = path.join(d, m.file); fs.writeFileSync(f, readLF(f).replace(m.find, m.repl)); fs.mkdirSync(path.join(d, ".scratch"), { recursive: true });
  const r = Bun.spawnSync(["bun", path.join(d, SUITE_FILE[m.suite])], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", PROTOCOL_SCRATCH: path.join(d, ".scratch") }, timeout: Math.max(180, m.expect * 6) * 1000 });
  const out = r.stdout.toString() + r.stderr.toString(); const red = redRows(out);
  const good = m.rows.length ? r.exitCode !== 0 && m.rows.every((x) => red.includes(x)) : r.exitCode === 0 && !red.length;
  if (!good) bad++;
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`${good ? "ok  " : "FAIL"} ${m.id} '${m.what}' → ${m.suite}: exit ${r.exitCode}, red ${red.join(",") || "(none)"} (want ${m.rows.join(",") || "green"}) ${s}s`);
  if (!good) console.log(out.split("\n").filter(Boolean).slice(-12).map((l) => `      ${l.slice(0, 240)}`).join("\n"));   // the suite's tail, so a wrong mutant says why
  table.push(`| ${m.id} | ${m.file} — ${m.what} | ${m.suite} | ${m.rows.join(", ") || "(control)"} | ${good ? (m.rows.length ? `red: ${red.filter((x) => m.rows.includes(x)).join(", ")}` : "green") : `WRONG (exit ${r.exitCode}, red ${red.join(",") || "none"})`} |`);
  fs.rmSync(d, { recursive: true, force: true });
}
if (!only) {   // --only refuses an id with no row (B3 ran nothing and exited 0)
  const r = Bun.spawnSync(["bun", import.meta.path, "--only", "B3"], { env: process.env }); const out = r.stdout.toString() + r.stderr.toString();
  const good = r.exitCode !== 0 && /no mutant B3/.test(out); if (!good) bad++;
  console.log(`${good ? "ok  " : "FAIL"} ONLY '--only B3 (no such row) is refused, not run as nothing': exit ${r.exitCode}`);
}
console.log(`\n| id | mutant | suite | row(s) it must turn red | seen |\n|---|---|---|---|---|\n${table.join("\n")}`);
console.log(`\n[blockers-mutants]${group ? ` group ${group}:` : ""} ${todo.length} run, ${bad} wrong (each mutant must turn its row(s) red; the control must stay green)`);
process.exit(bad ? 1 : 0);
