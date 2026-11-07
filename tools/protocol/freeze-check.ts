// tools/protocol/freeze-check.ts — the §F freeze of docs/DESIGN-log-vocabulary.md as fixtures: F22–F31 and P3's identity grammar.
//   F28–F31 feature declarations (shared/protocol/features.js); F24 provenance (shared/protocol/provenance.js; F25, a repair body's, lands with the first repair writer);
//   F22/F23 the join's hello order (shared/protocol/hello.js, server/server.ts join); F26 a key is not admission;
//   F27 custody at startup and in backups (server/custodycheck.ts); P3 the person shape is exactly u-{20} | u-{24}.
//   bun tools/protocol/freeze-check.ts
// @ts-nocheck
import fs from "node:fs"; import path from "node:path"; import os from "node:os"; import crypto from "node:crypto"; import { spawnSync } from "node:child_process";
import { tryUntil, until } from "./wait.ts";
import { FEATURE_ID, checkRequires, requiresAdd, featureDecision, declaredBefore, MAX_FEATURES, KNOWN_FEATURES, FEATURE_VERBS } from "../../shared/protocol/features.js";
import { checkProvenance, provenanceOf } from "../../shared/protocol/provenance.js";
import { sourceTreeSha256, sourceRevisionOf } from "../../server/provenance.ts";
import { checkHello, missingFeatures, NEED, helloOf } from "../../shared/protocol/hello.js";
import { readLog, fold, DIALECT, VERSION } from "../../shared/protocol/fold.js";
import { PERSON_ID } from "../../shared/protocol/ids.js";
import { ACTOR_ID } from "../../shared/protocol/names.js";
import { custodyVerdict, readOnlyCustody, backupManifestOf, checkBackupManifest, MANIFEST } from "../../server/custodycheck.ts";
import { openLive } from "./labhost.ts";
import { backupWorld } from "../../server/backups.ts";
import { foundWorld } from "../../server/worldlog.ts";
import { request } from "../../shared/protocol/authority.js";
import { custodyFileIn } from "../../server/keyfiles.ts";

const ENGINE = path.resolve(import.meta.dir, "../.."); let pass = 0, fail = 0;
const check = (name: string, ok: unknown, info?: unknown) => { if (ok) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${info === undefined ? "" : " — " + JSON.stringify(info).slice(0, 400)}`); } };
const S = fs.mkdtempSync(path.join(process.env.PROTOCOL_SCRATCH ?? os.tmpdir(), "freeze-"));
const procs: any[] = []; process.on("exit", () => { for (const p of procs) try { p.kill(); } catch {} });
const found = (W: string, name: string) => { const r = spawnSync(process.execPath, ["tools/protocol/world.ts", "found", name, "--owner", "u-aaaaaaaaaaaaaaaaaaaaaa", "--title", name], { cwd: ENGINE, env: { ...process.env, WORLDS_DIR: W }, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return path.join(W, name); };
const G = (requires?: string[]) => ({ kind: "genesis", actor: "system", body: { dialect: DIALECT, v: VERSION, nonce: "XWVu1u7BpaZTDFSETYiphg", owners: [[]], sequencer: "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic", ...(requires ? { requires } : {}) } });
const gov = (requiresAdd: string[]) => ({ kind: "governance", actor: "system", body: { requiresAdd, sigs: [] } });
const chg = { kind: "change", actor: "system", op: "create", body: { id: "a" } };

try {
  // ---- F-1: feature declarations ----
  const ids = ["eido:physics-v2@1", "a:b@1", "a:b@2", "x-1:y-2@9999"];
  check("F-1 grammar: namespace:name@major ids are accepted", ids.every((i) => FEATURE_ID.test(i)));
  check("F-1 grammar: ranges, wildcards, uppercase, a leading digit, major 0 and a 5-digit major are refused",
    ["a:b@0", "a:b@10000", "A:b@1", "1a:b@1", "a:b@1-2", "a:*@1", "a:b", "a:b@1.0", "a:b@", ":b@1"].every((i) => !FEATURE_ID.test(i)));
  check("F-1 grammar: the longest id the grammar admits is 86 ≤ 88 characters, one segment longer is refused, 65 ids are refused, 64 pass", checkRequires(["a".repeat(32) + ":" + "b".repeat(48) + "@1234"]) === null && ("a".repeat(32) + ":" + "b".repeat(48) + "@1234").length <= 88 && checkRequires(["a".repeat(33) + ":" + "b".repeat(48) + "@1234"])?.code === "requires-id"
    && checkRequires(Array.from({ length: MAX_FEATURES + 1 }, (_, i) => `a:f${String(i).padStart(3, "0")}@1`))?.code === "requires-count"
    && checkRequires(Array.from({ length: MAX_FEATURES }, (_, i) => `a:f${String(i).padStart(3, "0")}@1`)) === null);
  check("F-1 grammar: requires is sorted and unique; absent is []", checkRequires(["a:b@2", "a:b@1"])?.code === "requires-order" && checkRequires(["a:b@1", "a:b@1"])?.code === "requires-order" && checkRequires(undefined) === null && checkRequires("a:b@1")?.code === "requires-shape");
  { const known = new Set(["a:b@1"]);
    const d = featureDecision([G(["a:b@1", "z:unknown@1"]), chg], known);
    check("F28 an unknown id in genesis: the world is unsupported-feature at seq 0, before entry 1", d.unsupported?.seq === 0 && d.unsupported.ids.join() === "z:unknown@1", d);
    check("F28 (control) a known id in genesis is declared at seq 0", featureDecision([G(["a:b@1"]), chg], known).unsupported === null && featureDecision([G(["a:b@1"]), chg], known).declaredAt["a:b@1"] === 0);
    const d2 = featureDecision([G(["a:b@1"]), chg, gov(["z:unknown@1"]), chg], known);
    check("F29 an unknown requiresAdd refuses at that seq; what was required before it stands", d2.unsupported?.seq === 2 && d2.requires.join() === "a:b@1,z:unknown@1" && d2.declaredAt["a:b@1"] === 0, d2);
    const known3 = new Set(["a:b@1", "c:d@1"]); const d3 = featureDecision([G(["a:b@1"]), chg, gov(["c:d@1"]), chg], known3);
    check("F30 a use before the declaration is refused: c:d@1 is not declared at seq 1, is at seq 2 and after", d3.unsupported === null && !declaredBefore(d3, "c:d@1", 1) && declaredBefore(d3, "c:d@1", 2) && declaredBefore(d3, "c:d@1", 3) && !declaredBefore(d3, "q:q@1", 9), d3);
    check("F31 a requiresAdd that removes (re-adds what is there), reorders, or repeats is invalid; the union is monotonic and sorted",
      requiresAdd(["a:b@1"], ["a:b@1"]).code === "requiresAdd-present" && requiresAdd(["a:b@1"], ["d:d@1", "c:c@1"]).code === "requiresAdd-order" && requiresAdd([], ["c:c@1", "c:c@1"]).code === "requiresAdd-order"
      && requiresAdd(["c:c@1"], ["a:a@1"]).requires.join() === "a:a@1,c:c@1");
    { const d = featureDecision([G(), gov([])], KNOWN_FEATURES); const py = Bun.spawnSync([process.env.PYTHON || "python3", "-c", "import sys; sys.path.insert(0, 'spec/conformance'); import reader; print(reader.feature_decision([{'body': {}}, {'kind': 'governance', 'body': {'requiresAdd': []}}], set())[0])"], { cwd: ENGINE });
      check("F31b an empty requiresAdd is invalid, as gov.py holds it (a governance decision that changes nothing): the JS fold and reader.py agree", requiresAdd([], []).code === "requiresAdd-empty" && d.malformed?.code === "requiresAdd-empty" && /requiresAdd-empty/.test(String(py.stdout)), [requiresAdd([], []), d.malformed, String(py.stdout)]); }
    const d4 = featureDecision([G(["a:b@1"]), chg, gov(["a:b@1"]), chg], known);
    check("F31 …and in a log, such a governance entry is malformed at its seq, nothing after it declared", d4.malformed?.seq === 2 && d4.malformed.code === "requiresAdd-present" && d4.requires.join() === "a:b@1", d4); }

  // ---- F-2: provenance ----
  const tree = "f".repeat(64), reg = "0".repeat(64);
  const P = provenanceOf({ registrySha256: reg, name: "eidoverse-server", version: "4.1.0", sourceRevision: "git:sha1:" + "a".repeat(40), sourceTreeSha256: tree, dirty: false });
  check("F24 a schema-valid provenance passes, and the builder round-trips through the validator", checkProvenance(P) === null && P.registry.id === "registry-pin" && P.writer.name === "eidoverse-server");
  check("F24 dirty: true without sourceTreeSha256 is invalid (and so is dirty: false without it: the tree hash is always written)",
    checkProvenance({ ...P, writer: { ...P.writer, dirty: true, sourceTreeSha256: undefined } })?.code === "provenance-writer-tree" && (() => { const w = { ...P.writer, dirty: true }; delete w.sourceTreeSha256; return checkProvenance({ ...P, writer: w })?.code === "provenance-writer"; })()
    && checkProvenance({ ...P, writer: { ...P.writer, dirty: true, sourceTreeSha256: "nope" } })?.code === "provenance-writer-tree");
  check("F24 the writer name grammar, semver, and git:sha1 | git:sha256 revisions are checked",
    checkProvenance({ ...P, writer: { ...P.writer, name: "Server" } })?.code === "provenance-writer-name" && checkProvenance({ ...P, writer: { ...P.writer, name: "a".repeat(49) } })?.code === "provenance-writer-name"
    && checkProvenance({ ...P, writer: { ...P.writer, version: "4" } })?.code === "provenance-writer-version"
    && checkProvenance({ ...P, writer: { ...P.writer, sourceRevision: "git:sha256:" + "b".repeat(64) } }) === null && checkProvenance({ ...P, writer: { ...P.writer, sourceRevision: "hg:" + "a".repeat(40) } })?.code === "provenance-writer-revision"
    && checkProvenance({ ...P, registry: { id: "registry", sha256: reg } })?.code === "provenance-registry" && checkProvenance({ ...P, extra: 1 })?.code === "provenance-shape");
  { // genesis is never redactable: a redaction naming seq 0 is refused by the fold, and the genesis stays
    const lines = fs.readFileSync(path.join(ENGINE, "spec/conformance/logs/09-redaction.jsonl"), "utf8").split("\n").filter(Boolean).slice(0, 2);
    const wid = JSON.parse(lines[1]).world;
    const redaction = JSON.stringify({ world: wid, kind: "redaction", actor: "system", ts: 2, body: { values: [{ seq: 0 }] } });
    const st = fold(readLog(lines.join("\n") + "\n" + redaction + "\n"));
    check("F24 genesis provenance is non-redactable: a redaction naming seq 0 is diagnosed and nothing of genesis is stripped", st.status === "ok" && st.diagnostics.some(([, c]) => c === "redaction-target-range") && st.worldId === wid, st.diagnostics); }
  { // the server stamps it: a world it founds carries this tree's provenance in genesis, and the fold reads it
    const W0 = path.join(S, "w0"); fs.mkdirSync(W0); const d0 = found(W0, "stamped"); const g0 = readLog(fs.readFileSync(path.join(d0, "world.jsonl")))[0];
    const rev = sourceRevisionOf(ENGINE);
    check("F24 a world the server founds carries genesis.body.provenance: schema-valid, writer eidoverse-server at this tree's revision and tree hash; the fold reads the world",
      checkProvenance(g0.body.provenance) === null && g0.body.provenance.writer.name === "eidoverse-server" && g0.body.provenance.writer.sourceRevision === rev.sourceRevision && /^[0-9a-f]{64}$/.test(g0.body.provenance.writer.sourceTreeSha256)
      && fold(readLog(fs.readFileSync(path.join(d0, "world.jsonl")))).status === "ok", g0.body); }
  { // the tree hash of a real tree, and a revision from git
    const R = path.join(S, "tree"); fs.mkdirSync(R); const git = (...a: string[]) => spawnSync("git", ["-C", R, ...a], { encoding: "utf8" });
    git("init", "-q"); git("config", "user.email", "t@example.invalid"); git("config", "user.name", "t"); fs.writeFileSync(path.join(R, "a.txt"), "one\n"); git("add", "."); git("commit", "-qm", "one");
    const h1 = await sourceTreeSha256(R), r1 = await sourceRevisionOf(R);
    fs.writeFileSync(path.join(R, "a.txt"), "two\n"); const h2 = await sourceTreeSha256(R), r2 = await sourceRevisionOf(R);
    fs.writeFileSync(path.join(R, "b.txt"), "new, untracked\n"); const h3 = await sourceTreeSha256(R);
    check("F24 sourceTreeSha256 hashes the running tree: 64 hex, moved by an edit and by an untracked file; the revision is git:sha1:<40 hex> with dirty read from the tree",
      /^[0-9a-f]{64}$/.test(h1) && h1 !== h2 && h2 !== h3 && /^git:sha1:[0-9a-f]{40}$/.test(r1.sourceRevision) && r1.dirty === false && r2.dirty === true && r1.sourceRevision === r2.sourceRevision, { h1, h2, h3, r1, r2 }); }

  // ---- F-3: the hello, pure ----
  const good = { dialect: DIALECT, v: VERSION, features: [] };
  check("F22 (pure) a known hello passes; an unknown dialect or v, a stray key (a minor: there is none), a missing hello, or a malformed features list is update-required with need {dialect, v} and nothing else",
    checkHello(good) === null && [undefined, null, {}, { ...good, dialect: "other" }, { ...good, v: 3 }, { ...good, minor: 1 }, { ...good, features: "x" }, { ...good, features: ["BAD"] }]
      .every((h) => { const r = checkHello(h); return r?.type === "refused" && r.code === "update-required" && Object.keys(r).sort().join() === "code,need,type" && Object.keys(r.need).sort().join() === "dialect,v"; }));
  check("F23 (pure) unsupported-feature names the missing ids only; nothing missing is no refusal", missingFeatures(["a:b@1", "c:d@1"], ["c:d@1"])?.need.join() === "a:b@1" && Object.keys(missingFeatures(["a:b@1"], [])).sort().join() === "code,need,type" && missingFeatures(["a:b@1"], ["a:b@1"]) === null && missingFeatures([], undefined) === null);

  // ---- F-3 on the server: the hello before any world lookup; F26: a key is not admission ----
  const freePort = async (from: number) => { for (let p = from; p < from + 200; p++) { const ok = await new Promise((res) => { try { const s = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (ok) return p; } throw new Error("no free port"); };
  const startServer = async (worlds: string, tag: string, env: Record<string, string>, pre: string[] = []) => {
    const port = await freePort(9100 + procs.length * 7); const logf = path.join(S, `${tag}.log`);
    const p = Bun.spawn([process.execPath, ...pre, "server/server.ts"], { cwd: ENGINE, env: { ...process.env, PORT: String(port), WORLDS_DIR: worlds, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", JOIN_TOKEN: "", SERVER_OPERATORS: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
    procs.push(p);
    if (!(await tryUntil(`the ${tag} server answers /worlds`, async () => (await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).status > 0, { ms: 115_000, step: 150 }))) throw new Error(`${tag} server didn't come up: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-800) : ""}`);
    return port;
  };
  /** One join; resolves with every message received and the close code. */
  const join = (port: number, msg: any) => new Promise<{ msgs: any[]; close: number }>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = []; let done = false; const end = (close: number) => { if (!done) { done = true; res({ msgs, close }); } };
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "snapshot") { ws.close(); end(1000); } };
    ws.onclose = (ev) => end(ev.code); ws.onerror = () => end(-1);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", avatar: "", replica: true, ...msg }));
  });
  const W1 = path.join(S, "w1"); fs.mkdirSync(W1); found(W1, "here");
  const port = await startServer(W1, "open", {});
  { const r = await join(port, { world: "nope", id: "ann", hello: { ...good, v: VERSION + 1 } }); const text = JSON.stringify(r.msgs);
    check("F22 an unknown v is refused update-required BEFORE any world lookup: the reply carries need {dialect, v} and no world name or existence", r.msgs.length === 1 && r.msgs[0].code === "update-required" && r.msgs[0].need.v === NEED.v && !("minor" in r.msgs[0].need) && !/nope/.test(text) && !/world/i.test(text) && r.close === 4005, r); }
  { const r = await join(port, { world: "nope", id: "ann" }); const text = JSON.stringify(r.msgs);
    check("F22 the hello is always required (S5: no knob): the same join with none is refused update-required before any world lookup, naming no world", r.msgs.length === 1 && r.msgs[0].code === "update-required" && !/nope/.test(text) && r.close === 4005, r); }
  { const r = await join(port, { world: "here", id: "ann", hello: good }); const snap = r.msgs.find((m) => m.type === "snapshot");
    check("F23 a known hello joins, and the snapshot repeats the authoritative {dialect, v, requires} (no minor)", snap && snap.dialect === DIALECT && snap.v === VERSION && !("minor" in snap) && Array.isArray(snap.requires) && snap.requires.length === 0, snap && { dialect: snap.dialect, v: snap.v, minor: snap.minor, requires: snap.requires }); }
  { const r = await join(port, { world: "here", id: "ann", hello: { ...good, features: ["a:b@1"] } });
    check("F23 a client declaring more features than the world requires is not refused", r.msgs.some((m) => m.type === "snapshot"), r.msgs.map((m) => m.type)); }
  const W2 = path.join(S, "w2"); fs.mkdirSync(W2); found(W2, "here");
  const port2 = await startServer(W2, "strict", { JOIN_TOKEN: "sesame" });
  { const r = await join(port2, { world: "nope", id: "ann", token: "sesame" }); const text = JSON.stringify(r.msgs);
    check("F22 behind a join token too, a missing hello fails loudly (update-required), with no legacy default and no world name", r.msgs.length === 1 && r.msgs[0].code === "update-required" && !/nope/.test(text), r); }
  { const r = await join(port2, { world: "here", id: "ann", token: "wrong", hello: { ...good, v: VERSION + 1 } });
    check("F23 step 1 precedes step 2: a principal the door refuses gets the door's refusal, never update-required or unsupported-feature", r.msgs.length === 1 && r.msgs[0].type === "error" && !/update-required|unsupported-feature/.test(JSON.stringify(r.msgs)) && r.close === 4003, r); }
  { const r = await join(port2, { world: "here", id: "ann", ownerKey: "ed25519:BP7aKo17f474DD1aBSLG0a3Pb29Qs3yqQ6Ve0wSRVD0", hello: good });
    check("F26 a key alone is no admission: a join presenting a founder's key and no host credential is refused at the door", r.msgs.length === 1 && r.msgs[0].type === "error" && /token/.test(r.msgs[0].error) && r.close === 4003, r); }
  check("F26 (pending design row) create quota: the server sets no per-identity create quota today (worldlog.ts: 'sets no quotas'), so 'no quota without a host capability' has nothing to bind to yet; recorded, not claimed", true);
  // F23 step 4 over a world that requires a feature: a server that implements test:probe@1 (a preload adds it), a world founded requiring it
  const PROBE = "test:probe@1", pre = path.join(S, "probe-feature.ts");
  fs.writeFileSync(pre, `import { KNOWN_FEATURES } from ${JSON.stringify(path.join(ENGINE, "shared/protocol/features.js"))}; KNOWN_FEATURES.add(${JSON.stringify(PROBE)});\n`);
  const W4 = path.join(S, "w4"); fs.mkdirSync(W4);
  KNOWN_FEATURES.add(PROBE); try { foundWorld(path.join(W4, "needs"), "needs", "keeper", "needs", undefined, { requires: [PROBE] }); } finally { KNOWN_FEATURES.delete(PROBE); }
  const port4 = await startServer(W4, "features", {}, ["--preload", pre]);
  { const r = await join(port4, { world: "needs", id: "ann", hello: good });
    check("F23 a world requiring a feature the client lacks: after access, unsupported-feature naming only that id (no snapshot)", r.msgs.length === 1 && r.msgs[0].code === "unsupported-feature" && JSON.stringify(r.msgs[0].need) === JSON.stringify([PROBE]) && r.close === 4005, r); }
  { const r = await join(port4, { world: "needs", id: "ann", hello: { ...good, features: [PROBE] } }); const snap = r.msgs.find((m) => m.type === "snapshot");
    check("F23 …a client declaring it joins, and the snapshot repeats requires", !!snap && JSON.stringify(snap.requires) === JSON.stringify([PROBE]), snap ? snap.requires : r.msgs); }
  { const r = await join(port4, { world: "nope", id: "ann", hello: good });
    check("F23 …and a missing world is world-unavailable, never unsupported-feature (step 4 only after access)", r.msgs.length === 1 && r.msgs[0].code === "world-unavailable" && !/unsupported/.test(JSON.stringify(r.msgs)), r); }
  { // F30 in the authority: a feature's verb before the world declares it is refused; declared in genesis, it runs
    KNOWN_FEATURES.add(PROBE); FEATURE_VERBS.set("say", PROBE);
    try { const W5 = path.join(S, "w5"); fs.mkdirSync(W5);
      foundWorld(path.join(W5, "plain"), "plain", "keeper", "plain"); foundWorld(path.join(W5, "declared"), "declared", "keeper", "declared", undefined, { requires: [PROBE] });
      const [a, b] = ["plain", "declared"].map((n) => { const w = openLive(path.join(W5, n), n); return request(w, w.entries[1].actor, "say", { text: "hi" }); });
      check("F30 the authority refuses a feature's verb before the world declares it (unsupported-feature, via declaredBefore), and runs it once genesis requires it", a?.ok === false && a.refused?.code === "unsupported-feature" && b?.ok === true, { a, b }); }
    finally { KNOWN_FEATURES.delete(PROBE); FEATURE_VERBS.delete("say"); } }
  // F-3: every in-repo client sends a valid hello (helloOf): each joins (the browser's two paths: refusedjoin-check W0)
  const port6 = port, url6 = `ws://127.0.0.1:${port6}/ws`;
  { const { WorldAgent } = await import("../../mcpl/agent.ts"); const a: any = new WorldAgent({ url: url6, name: "probe-agent", world: "here", declares: null });
    let err = ""; try { await a.connect(); } catch (e) { err = String(e?.message ?? e); } try { a.close(); } catch {}
    check("F22 mcpl/agent.ts sends a valid hello: it joins", !err, err); }
  { const r = spawnSync(process.execPath, ["server/tend.ts", "here"], { cwd: ENGINE, env: { ...process.env, PORT: String(port6), JOIN_TOKEN: "" }, encoding: "utf8", timeout: 20_000 });
    check("F22 server/tend.ts sends a valid hello: it joins (exit 0 at the snapshot)", r.status === 0, (r.stderr ?? "") + (r.stdout ?? "")); }
  { const { WorldClient } = await import("../captionbot/world.ts"); const c: any = new WorldClient({ url: url6, token: "", world: "here", actor: "probe-captions", screenId: "none", agent: false });
    c.connect(); const ok = await tryUntil("the captionbot joins", () => c.open === true, { ms: 10_000, step: 50 }); c.ws.onclose = null; c.ws.close();
    check("F22 tools/captionbot/world.ts sends a valid hello: it joins", !!ok); }
  { // S5: one hello helper. Every file that builds a join imports helloOf (the page's inline socket spells it, checked below;
    // this suite's own raw join is the no-hello probe; Python spells it as HELLO)
    const own = new Set(["client/index.html", "tools/protocol/freeze-check.ts", "tools/surface-test.py"]); const bad: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(ENGINE, d), { withFileTypes: true })) { const r = path.join(d, e.name);
      if (e.isDirectory()) { if (!["node_modules", ".git", "worlds", "spec", ".siblings"].includes(e.name)) walk(r); continue; }
      if (!/\.(ts|js|mjs|html)$/.test(e.name) || own.has(r)) continue; const t = fs.readFileSync(path.join(ENGINE, r), "utf8");
      if (/type\s*:\s*['"]join['"]/.test(t) && !/\bhelloOf\b/.test(t)) bad.push(r); } };
    for (const d of ["client", "server", "mcpl", "tools", "shared"]) walk(d);
    check("F22 every in-repo file that builds a join sends helloOf() (shared/protocol/hello.js): one helper, no hand-spelled or missing hello", !bad.length, bad.slice(0, 10)); }
  { const html = fs.readFileSync(path.join(ENGINE, "client/index.html"), "utf8"); const m = /hello: (\{ dialect: 'eidoverse-log'[^}]*\})/.exec(html);
    const inline = m ? Function(`return (${m[1]});`)() : null;
    check("F22 the page's inline early socket spells exactly helloOf() (it imports nothing; refusedjoin-check W0 joins with it)", JSON.stringify(inline) === JSON.stringify(helloOf()), { inline, helloOf: helloOf() }); }

  // ---- F-5: custody ----
  const W3 = path.join(S, "w3"); fs.mkdirSync(W3); const d3 = found(W3, "keyed"); const cf = custodyFileIn(W3);
  const entries = readLog(fs.readFileSync(path.join(d3, "world.jsonl")));
  check("F27 (control) the custody file holds the key genesis names: the world opens writable", custodyVerdict(cf, entries).ok === true && !openLive(d3, "keyed").custody().readOnly);
  { const aside = cf + ".aside"; fs.renameSync(cf, aside); const listing = fs.readdirSync(W3).sort().join(",");
    const v = custodyVerdict(cf, entries); const w = openLive(d3, "keyed");
    let threw = ""; try { w.custody().sign("eidoverse-head:x:1:00"); } catch (e) { threw = String(e.message); }
    const r = request(w, "u-aaaaaaaaaaaaaaaaaaaaaa", "say", { text: "hello" });
    check("F27 a MISSING sequencer key: the world opens read-only, a write is refused (code custody), a sign throws, and NO key is minted (the custody file is still absent, the listing unchanged)",
      v.ok === false && /missing/.test(v.why) && w.custody().readOnly && /read-only/.test(threw) && r?.ok === false && r.refused?.code === "custody" && !fs.existsSync(cf) && fs.readdirSync(W3).sort().join(",") === listing, { v, threw, r, listing: fs.readdirSync(W3) });
    fs.renameSync(aside, cf); }
  { const other = JSON.parse(fs.readFileSync(cf, "utf8")); const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    other.sequencer = { pub: "ed25519:" + (publicKey.export({ format: "jwk" }) as any).x, priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
    const keep = fs.readFileSync(cf); fs.writeFileSync(cf, JSON.stringify(other));
    const v = custodyVerdict(cf, entries); const w = openLive(d3, "keyed"); const r = request(w, "u-aaaaaaaaaaaaaaaaaaaaaa", "say", { text: "hello" });
    check("F27 a MISMATCHED sequencer key: read-only too, the write refused, the file left as it was (not replaced by a mint)", v.ok === false && v.held === other.sequencer.pub && w.custody().readOnly && r?.ok === false && r.refused?.code === "custody" && fs.readFileSync(cf).equals(Buffer.from(JSON.stringify(other))), { v, r });
    fs.writeFileSync(cf, keep); }
  { const gentries = [...entries, { kind: "governance", actor: "system", body: { key: "ed25519:" + "A".repeat(43), sigs: [] } }];
    check("F27 the latest governance handoff's key is the expected one: after a handoff this custody no longer signs", custodyVerdict(cf, gentries).ok === false && custodyVerdict(cf, gentries).expected === "ed25519:" + "A".repeat(43)); }
  { const b = backupWorld(W3, "keyed", { backupsDir: path.join(S, "backups") }); const m = JSON.parse(fs.readFileSync(path.join(b.dir, MANIFEST), "utf8"));
    const custodyHash = crypto.createHash("sha256").update(fs.readFileSync(cf)).digest("hex"), seqFp = crypto.createHash("sha256").update(JSON.parse(fs.readFileSync(cf, "utf8")).sequencer.pub).digest("hex");
    check("F27 a backup's manifest records the sequencer and operator FINGERPRINTS (never a key) and the custody file's hash; the check passes it against the live custody", m.sequencer === seqFp && /^[0-9a-f]{64}$/.test(m.operator) && m.custodySha256 === custodyHash && !/ed25519/.test(JSON.stringify(m)) && checkBackupManifest(m, cf) === null, m);
    check("F27 a manifest without fingerprints, or without the custody hash, or naming other keys, fails the server check", /fingerprints/.test(checkBackupManifest({ ...m, sequencer: null }) ?? "") && /custody file hash/.test(checkBackupManifest({ ...m, custodySha256: undefined }) ?? "")
      && /other keys/.test(checkBackupManifest({ ...m, operator: "1".repeat(64) }, cf) ?? "") && /missing/.test(checkBackupManifest(undefined) ?? "") && JSON.stringify(backupManifestOf(cf)) === JSON.stringify(m));
    // D6 (Mica 11-05): the checker reads the custody file itself, so a builder defect is caught, not repeated; and the manifest is
    // read from the backup's bytes on disk as its own step (what a restore will do first; no restore path calls it yet: WISHLIST)
    { const disk = JSON.parse(fs.readFileSync(path.join(b.dir, MANIFEST), "utf8"));
      const swapped = checkBackupManifest({ ...disk, sequencer: disk.operator, operator: disk.sequencer }, cf), stale = checkBackupManifest({ ...disk, custodySha256: "0".repeat(64) }, cf);
      check("F27 the manifest read back from the backup on disk, as a separate step, checks against the live custody; a builder defect is caught by the checker (fingerprints swapped: other keys; a hash that isn't the custody file's: refused)",
        checkBackupManifest(disk, cf) === null && /other keys/.test(swapped ?? "") && /custody file's hash/.test(stale ?? ""), { swapped, stale }); }
    check("F27 (not minted) reading custody for a manifest or a verdict never creates a key file", !fs.existsSync(path.join(S, "nokeys.json")) && backupManifestOf(path.join(S, "nokeys.json")).sequencer === null && !fs.existsSync(path.join(S, "nokeys.json"))); }

  // ---- P3: the person shape ----
  const b32 = (n: number) => "u-" + "a".repeat(n);
  check("P3 the person shape accepts exactly u-{20} and u-{24}, refusing 19, 21–23, 25–32 (shared/protocol/ids.js, names.js)",
    PERSON_ID.test(b32(20)) && PERSON_ID.test(b32(24)) && [19, 21, 22, 23, 25, 28, 32].every((n) => !PERSON_ID.test(b32(n))) && !PERSON_ID.test("u-" + "A".repeat(20)) && !PERSON_ID.test("u-" + "1".repeat(20))
    && (b32(24).match(ACTOR_ID) ?? [])[0] === b32(24) && (b32(20).match(ACTOR_ID) ?? [])[0] === b32(20) && (("x " + b32(22) + " y").match(ACTOR_ID) ?? []).length === 0);
  { const g = spawnSync("grep", ["-rlE", "u-\\[a-z2-7\\]\\{20\\}[$\\\\]", "shared", "server", "client/lib", "mcpl", "--include=*.js", "--include=*.ts"], { cwd: ENGINE, encoding: "utf8" });
    const left = g.stdout.split("\n").filter(Boolean);
    check("P3 no runtime person-shape site still reads a bare u-{20} (the class, not the six sites the design lists)", left.length === 0, left); }
} finally { for (const p of procs) try { p.kill(); } catch {} fs.rmSync(S, { recursive: true, force: true }); }
console.log(`[freeze-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
