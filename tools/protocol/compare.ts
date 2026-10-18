// The JS fold (shared/protocol/fold.js) against the Python reference reader (spec/conformance/reader.py, written from
// PROTOCOL alone) on every conformance log: status, digest, and diagnostic codes. Ported from
// the protocol lab's conformance/compare.js @ 11db981. Also runs the reference reader's own tests (test_reader.py,
// test_chain.py; the latter needs python3 `cryptography`). usage: bun tools/protocol/compare.ts  (exit 1 on any difference; PYTHON=<interpreter>, default python3 on PATH)
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { ENGINE } from "./common.ts";

const here = ENGINE + "spec/conformance/";
const py = (args: string[]) => Bun.spawnSync([process.env.PYTHON || "python3", "-B", ...args], { cwd: here, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
const files = ["EXAMPLE-01.jsonl", ...fs.readdirSync(here + "logs").sort().map((f) => "logs/" + f)];
// Where §2.3/§2.4 (normative) and the reference reader disagree, the JS fold follows the spec; list each here.
const KNOWN: Record<string, string> = {};

let diffs = 0;
for (const f of files) {
  const raw = fs.readFileSync(here + f);
  const js = fold(readLog(raw)); const jsOut: any = { status: js.status, digest: js.status === "ok" ? digest(js) : null, codes: js.diagnostics.map(([s, c]: any) => `${s}:${c}`) };
  const p = JSON.parse(py([here + "reader.py", here + f, "--json"]).stdout.toString());
  const pyOut: any = { status: p.status, digest: p.digest, codes: p.diagnostics.map(([s, c]: any) => `${s}:${c}`) };
  const same = (k: string) => JSON.stringify(jsOut[k]) === JSON.stringify(pyOut[k]);
  const okAll = same("status") && same("digest") && same("codes");
  if (!okAll && !KNOWN[f]) diffs++;
  console.log(`${okAll ? "same " : KNOWN[f] ? "known" : "DIFF "} ${f.padEnd(30)} ${jsOut.status} ${jsOut.digest?.slice(0, 16) ?? "-"}${okAll ? "" : `  | py ${pyOut.status} ${pyOut.digest?.slice(0, 16) ?? "-"}`}`);
  if (!okAll) { for (const k of ["status", "digest"]) if (!same(k)) console.log(`      ${k}: js ${jsOut[k]}  py ${pyOut[k]}`);
    if (!same("codes")) { const a = new Set(jsOut.codes), b = new Set(pyOut.codes);
      console.log(`      only js: ${[...a].filter((x) => !b.has(x)).join(" ")}\n      only py: ${[...b].filter((x) => !a.has(x)).join(" ")}`); }
    if (KNOWN[f]) console.log(`      why: ${KNOWN[f]}`); }
}
console.log(`${files.length} logs, ${diffs} unexplained differences`);

// the reference reader's own suites. test_reader.py regenerates logs/ from its builders: they must come out byte-identical
const before = new Map(files.map((f) => [f, fs.readFileSync(here + f, "utf8")]));
let suiteFails = 0;
for (const t of ["test_reader.py", "test_chain.py", "test_gov.py"]) {   // test_gov: governance (§13), with the add-key rule (review 10-07 H4)
  const r = py([t]); const out = (r.stdout.toString() + r.stderr.toString()).trim().split("\n");
  console.log(`${r.exitCode === 0 ? "ok  " : "FAIL"} python ${t}: ${out.find((l) => /^\d+\/\d+ passed/.test(l)) ?? out.at(-1)}`);
  if (r.exitCode !== 0) { suiteFails++; console.log(out.slice(-8).join("\n")); }
}
const drift = files.filter((f) => fs.readFileSync(here + f, "utf8") !== before.get(f));
if (drift.length) { suiteFails++; console.log(`FAIL test_reader.py rewrote ${drift.join(", ")} differently (fixtures no longer what the reader's builders make)`); }
// The engine's OWN output against the spec's readers (review F1, 2026-10-05: the conformance run checked the lab's
// logs but never what this server writes). Found a world through the engine authority, write a few kinds of request, then
// the reference reader must say ok with 0 malformed, the Python chain verifier must accept every head and signature,
// and a value altered after the fact must break the chain.
{ const { openLive } = await import("../../server/livehost.ts"); const { request } = await import("../../shared/protocol/authority.js");
  const os = await import("node:os"); const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-conf-")); let T = 1800000000000;
  const w: any = openLive(path.join(tmp, "w"), "w", { now: () => (T += 100), custodyFile: path.join(tmp, "custody.json") });
  const rs = [["create-world", { title: "conf" }], ["create", { id: "tbl", model: "table", place: { at: [0, 2] } }], ["set", { id: "tbl", component: "label", value: "probe-value" }],
    ["say", { text: "hello" }], ["delete", { id: "tbl" }], ["undo", {}]].map(([t, a]: any) => request(w, "ann", t, a));
  const log = path.join(tmp, "w", "world.jsonl"); const text = fs.readFileSync(log, "utf8");
  const rd = JSON.parse(py([here + "reader.py", log, "--json"]).stdout.toString());
  const ch = JSON.parse(py([here + "chain.py", "verify", log]).stdout.toString());
  fs.writeFileSync(log + ".t", text.replace("probe-value", "probe-valuf")); const bad = JSON.parse(py([here + "chain.py", "verify", log + ".t"]).stdout.toString());
  const checks: [boolean, string, unknown][] = [
    [rs.every((r: any) => r.ok), "the engine authority admitted every probe request", rs.map((r: any) => r.refused?.code ?? "ok")],
    [rd.status === "ok" && !(rd.diagnostics ?? []).some((d: any) => String(d).includes("malformed")), "the reference reader reads the engine's own log as ok, 0 malformed", rd.status],
    [ch.status === "ok" && ch.unsigned_tail === 0 && ch.last_signed === text.trimEnd().split("\n").length - 1, "the chain verifier accepts every head and signature the engine wrote", ch],
    [(() => { const salted = (x: any) => typeof x?.salt === "string" && /^[A-Za-z0-9_-]{22}$/.test(x.salt);
      const L = text.trimEnd().split("\n").slice(1).map((l) => JSON.parse(l));
      return L.every((e: any) => e.kind === "change" ? (e.verb === "batch" ? e.body.ops : [{ verb: e.verb, ...e.body }]).every((o: any) => o.verb !== "set" || salted(o)) : !["act", "say", "sim"].includes(e.kind) || salted(e.body))
        && L.some((e: any) => e.kind === "say"); })(), "every set, and every act/say/sim body, carries a 16-byte salt (§2.4; round-2 R3: chat is most of the personal data)", null],
    [bad.status === "broken", "a value altered after the fact breaks the chain", bad]];
  // a fork's genesis (parent {world, seq, head}) and a founder's own tier-0 key (review 10-07 H4, H5): the spec's readers take them
  { const crypto = await import("node:crypto"); const key = "ed25519:" + Buffer.from(crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("base64url");
    const f: any = openLive(path.join(tmp, "f"), "f", { now: () => (T += 100), custodyFile: path.join(tmp, "custody.json") });
    const made = [request(f, "ann", "create-world", { title: "fork", ownerKey: key, from: { world: "sha256:" + "a".repeat(64), seq: 41, head: "b".repeat(64), name: "src" } }), request(f, "ann", "create", { model: "table" })];
    const flog = path.join(tmp, "f", "world.jsonl"); const g = f.entries[0].body;
    const frd = JSON.parse(py([here + "reader.py", flog, "--json"]).stdout.toString()); const fch = JSON.parse(py([here + "chain.py", "verify", flog]).stdout.toString());
    checks.push([made.every((r: any) => r.ok) && g.parent?.seq === 41 && g.owners[0][0] === key && frd.status === "ok" && !(frd.diagnostics ?? []).some((d: any) => String(d).includes("malformed")) && fch.status === "ok",
      "a fork's genesis.parent and a founder's tier-0 key: the reference reader and chain verifier read the engine's log as ok", { g, frd: frd.status, fch: fch.status }]); }
  for (const [okk, what, why] of checks) { console.log(`${okk ? "ok  " : "FAIL"} engine output: ${what}${okk ? "" : " — " + JSON.stringify(why).slice(0, 200)}`); if (!okk) suiteFails++; }
  fs.rmSync(tmp, { recursive: true, force: true }); }
process.exit(diffs || suiteFails ? 1 : 0);
