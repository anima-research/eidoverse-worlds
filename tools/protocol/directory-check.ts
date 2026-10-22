// tools/protocol/directory-check.ts — the authority directory (server/directory.ts): who an identity is lives outside the log
// (§2.3), an id is reached only through an account, and typing someone's name yields nothing (round-2 review R1, R2).
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/directory-check.ts
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directoryAt, directoryFor, isMinted } from "../../server/directory.ts";
import { CUSTODY_FILE, DIRECTORY_FILE, OLD_NAMES, custodyFileIn } from "../../server/keyfiles.ts";
import { custodyAt } from "../../server/custody.ts";
import { openLive } from "../../server/livehost.ts";
import { request, actIndexOf, isBanned } from "../../shared/protocol/authority.js";

let pass = 0, fail = 0;
const ok = (c: unknown, what: string, why?: unknown) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${why === undefined ? "" : ` — ${JSON.stringify(why).slice(0, 300)}`}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dir-check-"));
const file = path.join(tmp, "worlds", ".directory.json");

// ---- D: the directory itself ----
{ const d = directoryAt(file);
  const ann = d.resolve({ sub: "human:discord:111", name: "Ann" });
  ok(isMinted(ann), "D1 an account's identity is an opaque minted id (u- + 20 base32)", ann);
  ok(d.resolve({ sub: "human:discord:111", name: "Ann" }) === ann, "D2 the same account gets the same id");
  ok(d.resolve({ sub: "human:discord:111", name: "Annie" }) === ann && d.nameOf(ann) === "Annie", "D3 a rename keeps the id; the display name follows", d.nameOf(ann));
  const twin = d.resolve({ sub: "human:discord:222", name: "Annie" });
  ok(twin !== ann, "D4 two people with one name are two identities");
  const a1 = d.resolve({ name: "Ann" }), a2 = d.resolve({ name: "Ann" });
  ok(a1 !== a2 && a1 !== ann && d.entry(a1)?.kind === "anon", "D5 with no account, every connection is a fresh identity, never anyone else's", [a1, a2]);
  const bot = d.resolve({ sub: "agent:rowan", name: "Rowan" });
  ok(d.entry(bot)?.kind === "account", "D6 an enrolled account is an account like any other (no kind of participant: §6a rule 3)");
  const leg = d.imported("Bea"); d.bind(leg, "human:discord:333");
  ok(d.resolve({ sub: "human:discord:333", name: "Bea" }) === leg, "D7 binding an account to a legacy identity lets that account wear it");
  let threw = false; try { d.bind(leg, "human:discord:111"); } catch { threw = true; }
  ok(threw, "D8 an account can't wear two identities");
  // Windows has no POSIX modes (stat reports 666 for any writable file; access is the profile's ACL), so this row is POSIX-only
  if (process.platform !== "win32") ok((fs.statSync(file).mode & 0o777) === 0o600, "D9 the directory file is 0600", (fs.statSync(file).mode & 0o777).toString(8));
  const again = directoryAt(file);
  ok(again.resolve({ sub: "human:discord:111", name: "Annie" }) === ann && again.nameOf(twin) === "Annie", "D10 it survives a reopen");
  ok(JSON.stringify(again.names([ann, twin, "u-nobody"])) === JSON.stringify({ [ann]: "Annie", [twin]: "Annie" }), "D11 names() gives display names only (never accounts), skipping unknown ids");
  // D12: a spectator's first sight never takes a name another account wears, however long the typed name
  const long = "L".repeat(64), max = 64; again.resolve({ sub: "human:discord:444", name: long });
  const free = (n) => !again.claimedByOther(n, "human:discord:555") && n.length <= max;
  const first = again.spectatorName(long, "human:discord:555", max), firstFree = free(first);
  again.resolve({ sub: "human:discord:666", name: first });   // another account now wears that first candidate
  const second = again.spectatorName(long, "human:discord:555", max), own = again.spectatorName("Zed", "human:discord:555", max);
  ok(firstFree && free(second) && second !== first && own === "Zed" && first.endsWith("-d555") && second.endsWith("-d5552"),
    "D12 a spectator's name is the typed one unless another account wears it; otherwise a name that keeps its account's tag (-d555), fits the limit and no other account wears", { first, second, own }); }

// ---- I: the authority with directory ids (R2: a role is held by an id, never by a name) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "w"), "w", { now: () => (T += 100), custodyFile: path.join(tmp, "custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const owner = d.resolve({ sub: "human:discord:111", name: "Annie" });
  ok(request(w, owner, "create-world", { title: "w" }).ok, "I1 the owner founds a world as their id");
  ok(request(w, owner, "set", { id: "@world", component: "default-role", value: { role: "inhabitant" } }).ok, "I1b …strangers are visitors");
  const imp = d.resolve({ name: "Annie" });   // someone typing the owner's display name, no account
  const r = request(w, imp, "set", { id: "@world", component: "about", value: { name: "mine now", text: "" } });
  ok(!r.ok && r.refused?.code === "rights", "I2 typing the owner's name (no account) gets a fresh identity with no rights", r.refused);
  const enc = request(w, "annie", "set", { id: "@world", component: "about", value: { name: "mine now", text: "" } });
  ok(!enc.ok, "I3 sending the owner's old-style name as the actor doesn't reach their role either", enc.refused);
  ok(request(w, owner, "create", { id: "lamp", model: "crate", place: { at: [0, 2] } }).ok, "I4 the owner builds");
  const lk = request(w, owner, "set", { id: "lamp", component: "lock", value: true });
  const bob = d.resolve({ sub: "human:discord:444", name: "Bob" }); request(w, owner, "set", { id: "@world", component: `roles:${bob}`, value: { role: "builder" } });
  const moved: any = request(w, bob, "delete", { id: "lamp" });
  ok(lk.ok && !moved.ok && /Annie/.test(moved.refused?.reason ?? "") && !/u-[a-z2-7]{20}/.test(moved.refused?.reason ?? ""), "I5 refusals say people's names from the directory, never their ids", moved.refused?.reason);
  const log = fs.readFileSync(path.join(tmp, "worlds", "w", "world.jsonl"), "utf8");
  ok(!/Annie|discord/.test(log), "I6 nothing about the person (name, account) is in the log", null); }

// ---- K: keys (round-2 R4, R5) ----
{ let T = 1800000000000; const d = directoryAt(file); const cust = path.join(tmp, "k-custody.json");
  const w: any = openLive(path.join(tmp, "worlds", "k"), "k", { now: () => (T += 100), custodyFile: cust, nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const me = d.resolve({ sub: "human:discord:555", name: "Kay" });
  ok(request(w, me, "create-world", { title: "k" }).ok, "K0 found a world");
  const g = w.entries[0].body;
  ok(JSON.stringify(g.owners[0]) === "[]" && g.owners[1]?.length === 1 && g.owners[1][0] !== g.sequencer,
    "K1 a founded world's genesis: tier 0 empty (custodial default, §2.4), the operator's governance key in tier 1, never the sequencer's key", g);
  const other: any = openLive(path.join(tmp, "worlds", "k"), "k", { now: () => (T += 100), custodyFile: path.join(tmp, "other-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const wr = request(other, me, "set", { id: "@world", component: "about", value: { name: "x", text: "" } });
  ok(!wr.ok && wr.refused?.code === "custody", "K2 an authority that doesn't hold the world's sequencer key refuses to write (it would sign lines the verifier calls forged)", wr.refused);
  ok(request(other, me, "look", {}).ok, "K3 …but reads still work");
  // K3b: a role for an identity this server doesn't know is refused with the lookup that exists, whois
  const unk = request(w, me, "set", { id: "@world", component: "roles:u-ffffffffffffffffffff", value: { role: "builder" } });
  ok(unk?.refused?.code === "shape" && /^whois \{name\}/.test(unk.refused.fix ?? ""), "K3b an unknown identity's role refusal names whois {name}", unk?.refused);
  // K4: nothing it does appends a line: not an unknown verb's logged refusal, nor a read's, nor anything after them
  const n0 = other.entries.length; const uv = request(other, me, "frobnicate", {}); const rd = request(other, me, "look", { id: "nothing-here" });
  ok(other.entries.length === n0, "K4 an authority without the world's key appends nothing for an unknown verb or a refused read", { appended: other.entries.length - n0, uv: uv?.refused?.code, rd: rd?.refused?.code });
  // K4b: …and its role sweep, which no request starts, ends quietly rather than throwing: a timed grant has run out, and a
  // throw there would stop the server's sweep before the worlds after this one
  const lee = d.resolve({ sub: "human:discord:556", name: "Lee" });
  const g5 = request(w, me, "set", { id: "@world", component: `roles:${lee}`, value: { role: "builder", until: T + 1000 } }); T += 5000;
  const other2: any = openLive(path.join(tmp, "worlds", "k"), "k", { now: () => (T += 100), custodyFile: path.join(tmp, "other-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const { expireRoles: expireW } = await import("../../shared/protocol/authority.js"); const n5 = other2.entries.length; let threw: any = null, e5: any;
  try { e5 = expireW(other2); } catch (x: any) { threw = String(x?.refused?.code ?? x?.code ?? x?.message ?? x); }
  ok(g5.ok && !threw && other2.entries.length === n5, "K4b its role sweep, with a timed grant run out, returns without appending or throwing", { g5: g5.ok ? "ok" : g5.refused, threw, e5 }); }
{ const { translateV1World } = await import("./import-v1/world.ts");
  const W = path.join(tmp, "tw"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const a = translateV1World(path.join(W, "old"), path.join(W, "a")), b = translateV1World(path.join(W, "old"), path.join(W, "b"));
  const ga = JSON.parse(fs.readFileSync(path.join(W, "a", "world.jsonl"), "utf8").split("\n")[0]).body;
  ok(a.worldId !== b.worldId, "K4 two translations of one v1 log are two worlds (random nonce: their signed heads can't replay into each other)", [a.worldId, b.worldId]);
  ok(ga.owners[1]?.[0] && ga.owners[1][0] !== ga.sequencer, "K5 a translated genesis: the operator's governance key, never the sequencer's", ga);
  // the old world remembered where each person stood by display NAME; the copy remembers it by identity
  fs.writeFileSync(path.join(W, "old", "poses.json"), JSON.stringify({ Ann: { p: [4, 0, 5], yaw: 1 }, Nobody: { p: [0, 0, 0] } }));
  const c = translateV1World(path.join(W, "old"), path.join(W, "c"));
  const pc = JSON.parse(fs.readFileSync(path.join(W, "c", "poses.json"), "utf8")); const ann = Object.keys(pc)[0];
  ok(c.poses === 1 && /^u-[a-z2-7]{20}$/.test(ann) && pc[ann].p[0] === 4 && !("Ann" in pc) && !("Nobody" in pc), "K6 a translated world's remembered places are keyed by identity (Ann's id), and a name the log never knew is dropped", pc); }

// ---- B: budgets and attempts (round-2 R6, R7) ----
{ let T = 1800000000000; const d = directoryAt(file); const kindOf = (id: string) => d.entry(id)?.kind ?? null;
  const w: any = openLive(path.join(tmp, "worlds", "b"), "b", { now: () => (T += 10), custodyFile: path.join(tmp, "b-custody.json"), nameOf: d.nameOf, kindOf } as any);
  const own = d.resolve({ sub: "human:discord:777", name: "Bo" }); request(w, own, "create-world", { title: "b" });
  request(w, own, "set", { id: "@world", component: "default-role", value: { role: "builder" } });
  const big = request(w, own, "say", { text: "x".repeat(9000) });
  ok(big.refused?.code === "too-big", "B1 a say is at most 8 KiB of text", big.refused);
  // the flood is big VALUES, not chat (20 says of 8 KiB stay under the cap): 60 KiB draft bags, well under 60 entries
  // (a label is capped at 80 since f5dbb31e; a namespaced draft component has no schema, so it carries the bulk)
  request(w, own, "create", { id: "slab", model: "crate", place: { at: [4, 4] } });
  const n0 = w.entries.length; let said = 0, stop: any = null;
  for (let i = 0; i < 40 && !stop; i++) { const r: any = request(w, own, "set", { id: "slab", component: "hesperus/pad", value: { pad: `${i}` + "y".repeat(60000) } }); if (r.ok) said++; else stop = r.refused; }
  const grew = w.entries.slice(n0).reduce((a: number, e: any) => a + JSON.stringify(e).length, 0);
  ok(stop?.code === "rate" && /KiB/.test(stop?.reason ?? "") && said < 8 && grew < 400 * 1024, "B2 one identity's BYTES per 10 s are capped (256 KiB), not just its entries", { said, grew, stop: stop?.reason });
  T += 20000;
  T += 20000;
  const anon = d.resolve({ name: "drifter" }); let aSaid = 0;
  for (let i = 0; i < 50; i++) { const r: any = request(w, anon, "say", { text: "z".repeat(7000) }); if (r.ok) aSaid++; else break; }
  ok(aSaid > 0 && aSaid <= 5, "B3 an identity with no account gets a smaller budget (32 KiB)", aSaid);
  T += 20000;
  const m0 = w.entries.length;
  const ref: any = request(w, anon, "delete", { id: "@world" });
  const rec = w.entries.slice(m0);
  ok(!ref.ok && rec.length === 1 && rec[0].kind === "act" && rec[0].actor === anon && rec[0].body?.refused?.code === ref.refused?.code && JSON.stringify(rec[0].body?.args) === '["id"]' && !("request" in rec[0].body),
    "B4 a refused write is recorded: an act with its argument names and {refused: {code}}, never the values (engine-scars 6a), no state", rec.map((e: any) => [e.kind, e.body]));
  const m1 = w.entries.length;
  request(w, anon, "delete", { id: "@world", dry: true }); request(w, anon, "inspect", { id: "nope" }); request(w, anon, "frobnicate", {});
  ok(w.entries.length === m1 + 1 && w.entries.at(-1).body?.refused?.code === "unknown-verb", "B5 dry runs and reads aren't recorded; an unknown verb is (it's what was tried)", w.entries.slice(m1).map((e: any) => e.body?.refused));
  const huge: any = request(w, anon, "set", { id: "nope", component: "label", value: "q".repeat(5000) });
  ok(!huge.ok && JSON.stringify(w.entries.at(-1).body?.args) === '["component","id","value"]' && JSON.stringify(w.entries.at(-1)).length < 600, "B6 a refused request's values never reach the log, however long: its names and code do (the values go to the in-memory ring)", w.entries.at(-1).body);
  T += 20000; const before = w.entries.length; const TRIES = 300;
  for (let i = 0; i < TRIES; i++) request(w, anon, "delete", { id: "@world" });   // refusals cost bytes too
  const written = w.entries.length - before; const grewB = w.entries.slice(before).reduce((a: number, e: any) => a + JSON.stringify(e).length, 0);
  ok(written > 0 && written < TRIES && grewB <= 32 * 1024, "B7 refusals are written only while the byte budget lasts (no flood)", { written, grewB });
  T += 20000; request(w, anon, "delete", { id: "@world" });
  ok(w.entries.at(-1).body?.unrecorded === TRIES - written, "B8 …and the next one that is written says exactly how many weren't", [w.entries.at(-1).body?.unrecorded, TRIES - written]);
  T += 20000; ok(request(w, own, "create", { id: "cube", model: "crate", place: { at: [2, 2] } }).ok, "B9 setup: a real change");
  request(w, own, "delete", { id: "nope-at-all" });  // a refusal, recorded, after it
  const u: any = request(w, own, "undo", {});
  ok(u.ok && !w.state().entities.cube, "B10 a bare undo steps over a recorded refusal to my last real change", u); }

// ---- S: the schema gate (round-2 R8, R9) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "s"), "s", { now: () => (T += 100), custodyFile: path.join(tmp, "s-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const me = d.resolve({ sub: "human:discord:888", name: "Sam" }); request(w, me, "create-world", { title: "s" });
  request(w, me, "create", { id: "cube", model: "crate", place: { at: [1, 1] } });
  const set = (component: string, value: unknown) => request(w, me, "set", { id: "cube", component, value }) as any;
  const typo = set("ligth", { intensity: 5 });
  ok(typo.refused?.code === "schema" && typo.refused?.didYouMean?.[0] === "light", "S1 a near-miss of a registered name is a typo: refused, did you mean light", typo.refused);
  ok(set("heart", { takes: 1 }).refused?.code === "schema" && set("local/heart", { takes: 1 }).ok && set("example.org/inscription", { text: "hi" }).ok, "S2 a world's own invention carries a namespace (local/heart, example.org/inscription): a bare unregistered name is the registry's, refused (PROTOCOL §4)");
  ok(set("transform@2", { pos: [1e9, 0, 0] }).refused?.code === "schema", "S3 transform@2 is a near-miss too");
  ok(request(w, me, "set", { id: "@world", component: "terrain:base", value: { amp: 0 } }).refused?.code === "shape" && set("light:main", { intnsity: 5 }).refused?.code === "shape",
    "S4 an unkeyed name written keyed (terrain:base, light:main) no longer dodges the schema");
  ok(set("label", 42).refused?.code === "shape" && set("sockets", "nope").refused?.code === "shape" && set("model", { x: 1 }).refused?.code === "shape", "S5 label, sockets and model are typed");
  ok(set("placer", { id: "me" }).refused?.code === "derived", "S6 placer is derived (L2): refused");
  const lit: any = request(w, me, "create", { id: "lamp", components: { transform: { pos: [2, 1, 2] }, light: {} } });
  ok(lit.ok && w.state().entities.lamp.c.light.intensity === 16 && w.state().entities.lamp.c.light.range === 10, "S7 an agent's light {} gets the renderer's defaults (16, 10), as the editor's does (R9)", w.state().entities.lamp?.c.light);
  ok(request(w, me, "set", { id: "@world", component: "sky", value: { hours: 9, rate: 1, weathr: "rain" } }).refused?.code === "schema", "S8 sky is registered: its fields are checked"); }

// ---- U: undo across people (F2 decided 10-05; round-2 R10, R11; round-1 F3) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "u"), "u", { now: () => (T += 1000), custodyFile: path.join(tmp, "u-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const P = (n: string) => d.resolve({ sub: `human:discord:u-${n}`, name: n });
  const ann = P("ann"), dee = P("dee"), bob = P("bob"), cy = P("cy"), vic = P("vic");
  const q = (who: string, verb: string, a: any = {}) => request(w, who, verb, a) as any;
  q(ann, "create-world", { title: "u" });
  for (const [id, role] of [[dee, "owner"], [bob, "builder"], [cy, "builder"], [vic, "inhabitant"]]) q(ann, "set", { id: "@world", component: `roles:${id}`, value: { role } });
  const actOf = (r: any) => r.act ?? r.seq - 1;
  const b1 = q(bob, "create", { id: "bench", model: "crate", place: { at: [1, 1] } });
  ok(q(vic, "undo", { act: actOf(b1) }).refused?.code === "rank", "U1 a visitor can't undo someone else's act");
  const r1 = q(cy, "undo", { act: actOf(b1) });
  ok(r1.ok && !w.state().entities.bench, "U2 a builder undoes another builder's act (peer review)", r1.refused);
  const a1 = q(ann, "create", { id: "arch", model: "crate", place: { at: [3, 3] } });
  ok(q(bob, "undo", { act: actOf(a1) }).refused?.code === "rank", "U3 a builder can't undo an owner's act (never upward)");
  ok(q(dee, "undo", { act: actOf(a1) }).ok && !w.state().entities.arch, "U4 an owner undoes another owner's act (owners revert owners)");
  const b2 = q(bob, "create", { id: "table", model: "table", place: { at: [5, 5] } }); q(cy, "set", { id: "table", component: "label", value: "cy's now" });
  const r4 = q(ann, "undo", { act: actOf(b2) });
  ok(!r4.ok && r4.refused?.code === "conflict" && w.state().entities.table, "U5 reverting someone's act never writes over a third person's later work", r4.refused);
  const a2 = q(ann, "create", { id: "shelf", model: "table", place: { at: [8, 8] } });
  q(bob, "create", { id: "cup", model: "crate", place: { on: "shelf" } });
  const cupAt = JSON.stringify(w.state().entities.cup?.c.transform?.pos);
  const r5 = q(ann, "undo", { act: actOf(a2) }); const cup = w.state().entities.cup;
  ok(r5.ok && !w.state().entities.shelf && cup && !cup.c.parent, "U6 undoing a create lets go of what others hung on it: it stays, unparented (round-1 F3)", [r5.refused, cup?.c.parent]);
  ok(cup && JSON.stringify(cup.c.transform.pos) !== cupAt && Math.abs(cup.c.transform.pos[0] - 8) < 1, "U7 …where it was in the world (its local pose became a world pose)", [cupAt, cup?.c.transform.pos]);
  q(ann, "create", { id: "post", model: "crate", place: { at: [11, 11] } });
  const war: any[] = [];
  for (const v of ["a", "b", "c"]) { const s1 = q(bob, "set", { id: "post", component: "label", value: v }); war.push(q(cy, "undo", { act: actOf(s1) })); }
  ok(war[0].ok && war[1].ok && war[2].refused?.code === "revert-war", "U8 the third revert across people on one thing within the hour is refused below owner (a dispute)", war.map((r) => r.ok || r.refused?.code));
  const last = [...w.entries.keys()].reverse().find((i) => w.entries[i].kind === "act" && w.entries[i].actor === bob && w.entries[i].verb === "set");
  ok(q(ann, "undo", { act: last }).ok, "U9 …an owner still can (owners settle it)");
  ok(q(bob, "undo", { acts: 3 }).refused?.code === "unknown-arg", "U10 a typo'd undo argument is refused, not a silent undo of your latest act (R10)"); }

// ---- W: the sky panel in a world (it couldn't write at all: fromv1 had no 'sky' / 'weather') ----
{ let T = 1800000000000; const d = directoryAt(file); const { worldEditOps } = await import("../../shared/worldentity.js");
  const w: any = openLive(path.join(tmp, "worlds", "wx"), "wx", { now: () => (T += 1000), custodyFile: path.join(tmp, "wx-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const own = d.resolve({ sub: "human:discord:w1", name: "Wyn" }), vis = d.resolve({ sub: "human:discord:w2", name: "Val" });
  request(w, own, "create-world", { title: "wx" }); request(w, own, "set", { id: "@world", component: `roles:${vis}`, value: { role: "inhabitant" } });
  const panel = { hours: 18, rate: 2, clouds: "cumulus", weather: "clear", azimuth: 1.2 };   // sun/fill/world/clock cut 10-16; the panel strips them (skypanel.js:114)
  const m: any = { verb: "sky", args: panel };   // what the sky panel sends (client/lib/skypanel.js)
  const we: any = worldEditOps({ sky: null, terrain: null, grass: null }, { "weather.state": "rain" }, { now: T });
  ok(we.ops.length === 1 && we.ops[0].verb === "weather" && we.ops[0].args.weather === "rain", "W1 edit @world plans the authority's own tools (weather), never a v1 verb", we);
  const r: any = request(w, own, m.verb, m.args); const sky = w.state().entities["@world"].c.sky;
  ok(r.ok && sky.hours === 18 && sky.azimuth === 1.2 && Number.isInteger(sky.ts) && !("seq" in sky) && !("by" in sky), "W2 sky sets the sky, stamped with the authority's clock, with no echo of who (R8)", [r.refused, sky]);
  const r2: any = request(w, own, "weather", { weather: "rain" }); const sky2 = w.state().entities["@world"].c.sky;
  ok(r2.ok && sky2.weather === "rain" && sky2.clouds === "cumulus" && sky2.azimuth === 1.2, "W3 weather merges onto the standing sky", [r2.refused, sky2]);
  ok(request(w, vis, "sky", panel).refused?.code === "rights", "W4 a visitor can't set the world's sky"); }

// ---- RB: an owner's rollback, undo {actor, since} (round-2 R11) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "rb"), "rb", { now: () => (T += 1000), custodyFile: path.join(tmp, "rb-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const P = (n: string) => d.resolve({ sub: `human:discord:rb-${n}`, name: n });
  const own = P("ola"), mal = P("mal"), car = P("car");
  const q = (who: string, verb: string, a: any = {}) => request(w, who, verb, a) as any;
  q(own, "create-world", { title: "rb" }); for (const id of [mal, car]) q(own, "set", { id: "@world", component: `roles:${id}`, value: { role: "builder" } });
  q(own, "create", { id: "fountain", model: "crate", place: { at: [0, 6] } });
  const since = { seq: w.entries.length - 1, head: w.headAt(w.entries.length - 1) };
  q(mal, "create", { id: "junk-1", model: "crate", place: { at: [2, 2] } }); q(mal, "create", { id: "junk-2", model: "crate", place: { at: [4, 2] } });
  q(mal, "set", { id: "fountain", component: "label", value: "mal was here" }); q(mal, "create", { id: "junk-3", model: "crate", place: { at: [6, 2] } });
  q(car, "set", { id: "junk-3", component: "label", value: "car kept this one" });
  ok(q(car, "undo", { actor: mal, since }).refused?.code === "rights", "RB1 rolling back someone's work needs owner");
  const r = q(own, "undo", { actor: mal, since }); const E = w.state().entities;
  ok(r.ok && !E["junk-1"] && !E["junk-2"] && E.fountain && E.fountain.c.label === undefined, "RB2 an owner rolls back everything a person did since a version, in one act", r.refused);
  ok(E["junk-3"]?.c.label === "car kept this one" && r.notes?.some((n: any) => n.skipped?.length), "RB3 …a third person's later work stands (and the reply says what was left)", [E["junk-3"]?.c, r.notes]);
  const rolled: number[] = w.entries.at(-2)?.body?.rollback?.acts ?? []; const X = actIndexOf(w);
  ok(rolled.length === 3 && rolled.every((qq) => X.undone.has(qq)), "RB4 the acts the rollback took back count as undone (the one left in force, junk-3, doesn't)", rolled);
  const s2 = { seq: w.entries.length - 1, head: w.headAt(w.entries.length - 1) };
  for (let i = 0; i < 22; i++) q(mal, "create", { id: `spam-${i}`, model: "crate", place: { at: [i - 11, -6] } });
  const big = q(own, "undo", { actor: mal, since: s2 });
  ok(big.refused?.code === "confirm" && big.refused?.acts === 22, "RB5 more than 20 acts needs confirm: true, and says how many", big.refused);
  const n0 = w.entries.length; const dry = q(own, "undo", { actor: mal, since: s2, dry: true });
  ok(dry.ok && w.entries.length === n0, "RB6 dry: true writes nothing", dry);
  ok(q(own, "undo", { actor: mal, since: s2, confirm: true }).ok && !Object.keys(w.state().entities).some((k) => k.startsWith("spam-")), "RB7 with confirm it rolls back all 22"); }

// ---- X: a translated thing whose reaction runs a v1 script (round-2 R14: this path threw a ReferenceError) ----
{ const { translateV1World } = await import("./import-v1/world.ts");
  const W = path.join(tmp, "xs"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "bell", lib: "a.glb", pos: [1, 0, 1] } },
    { seq: 2, ts: 3, actor: "Ann", verb: "comp", args: { id: "bell", type: "reactions", data: { ring: { kind: "script", script: "bell" } } } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  translateV1World(path.join(W, "old"), path.join(W, "new"));
  const w: any = openLive(path.join(W, "new"), "new", { now: () => 1800000000000 });
  let r: any = null, threw: any = null; try { r = request(w, "u-aaaaaaaaaaaaaaaaaaaa", "use", { id: "bell", action: "ring" }); } catch (e) { threw = String(e); }
  ok(!threw && r?.refused?.code === "no-runtime" && /bell's 'ring'/.test(r.refused.reason), "X1 using a translated script reaction refuses (no-runtime) and names the thing, instead of throwing", threw ?? r?.refused); }

// ---- XB: a v1 ban survives translation as a ban the authority enforces (component review, world-settings #3: it became a
// state key the authority never reads, so a translated world quietly unbanned everyone) ----
{ const { translateV1World } = await import("./import-v1/world.ts");
  const W = path.join(tmp, "xb"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Ann: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "Ann", verb: "ban", args: { id: "Mallory", reason: "spam" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  translateV1World(path.join(W, "old"), path.join(W, "new"));
  const w: any = openLive(path.join(W, "new"), "new", { now: () => 1800000000000 });
  const at = Object.keys(w.state().entities["@world"].c).find((k) => k.startsWith("imported-bans:")); const who = at?.slice("imported-bans:".length);
  ok(!!who && isBanned(w, who) && w.mod.some((m: any) => m.verb === "ban" && m.who === who && m.reason === "spam"), "XB1 a v1 ban is a ban the authority enforces after translation (filed in the moderator log, reason kept)", [at, w.mod]); }

// ---- V: a visitor undoes their own use, under the use's capability (round-2 R11) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "vu"), "vu", { now: () => (T += 1000), custodyFile: path.join(tmp, "vu-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const own = d.resolve({ sub: "human:discord:vu1", name: "Oda" }), vis = d.resolve({ sub: "human:discord:vu2", name: "Vee" });
  request(w, own, "create-world", { title: "vu" }); request(w, own, "set", { id: "@world", component: `roles:${vis}`, value: { role: "inhabitant" } });
  request(w, own, "create", { id: "gate", model: "door", components: { openable: { open: false }, reactions: { open: { kind: "toggle", component: "openable", field: "open" } } }, place: { at: [0, 4] } });
  const u: any = request(w, vis, "use", { id: "gate", action: "open" });
  ok(u.ok && w.state().entities.gate.c.openable.open === true, "V1 a visitor opens the gate through its handler", u.refused);
  const back: any = request(w, vis, "undo", {});
  ok(back.ok && w.state().entities.gate.c.openable.open === false, "V2 …and can undo that, under the same handler (not builder rank)", back.refused);
  request(w, vis, "use", { id: "gate", action: "open" }); request(w, own, "delete", { id: "gate", component: "reactions" });
  ok(request(w, vis, "undo", {}).refused?.code === "rights", "V3 with the handler gone, the capability is gone: the visitor's undo is refused on rank (asked again now, not at use time)"); }

// ---- K: the shared key files' names (the 2026-10-07 names pass: the number left their names) ----
// A worlds dir that holds only the old names is renamed once, the first time the path is asked for, so a local world keeps
// its sequencer key and its people their identities. Both names present: the current file wins, the old one stays put.
{ const wd = path.join(tmp, "oldnames"); fs.mkdirSync(wd, { recursive: true });
  const oldDir = path.join(wd, OLD_NAMES[DIRECTORY_FILE]), oldCust = path.join(wd, OLD_NAMES[CUSTODY_FILE]);
  const before = directoryAt(oldDir); const kim = before.resolve({ sub: "human:discord:kim", name: "Kim" });
  const seqBefore = custodyAt(oldCust).sequencer();
  const id = directoryFor(wd).resolve({ sub: "human:discord:kim", name: "Kim" });
  ok(id === kim, "K1 a directory left under its old name is the one the server opens: the same account, the same identity", [id, kim]);
  ok(fs.existsSync(path.join(wd, DIRECTORY_FILE)) && !fs.existsSync(oldDir), "K2 …renamed once, to the current name", fs.readdirSync(wd));
  ok(custodyAt(custodyFileIn(wd)).sequencer() === seqBefore && !fs.existsSync(oldCust), "K3 the governance keys keep their sequencer key through the rename", fs.readdirSync(wd));
  const both = path.join(tmp, "bothnames"); fs.mkdirSync(both);
  const cur = custodyAt(path.join(both, CUSTODY_FILE)).sequencer(), stale = custodyAt(path.join(both, OLD_NAMES[CUSTODY_FILE])).sequencer();
  ok(custodyAt(custodyFileIn(both)).sequencer() === cur && cur !== stale && fs.existsSync(path.join(both, OLD_NAMES[CUSTODY_FILE])), "K4 both names present: the current file wins and the old one is left alone, never merged");
  const fresh = path.join(tmp, "fresh"); fs.mkdirSync(fresh);
  ok(custodyFileIn(fresh) === path.join(fresh, CUSTODY_FILE) && fs.readdirSync(fresh).length === 0, "K5 a fresh worlds dir: the current name, and nothing created by asking", fs.readdirSync(fresh)); }

// ---- EP: a v1 log with a physics epoch (dialect 3) translates with her sim's outcomes (2026-10-08). The live Commons has
// eidosim@0.5.0 from seq 15641; translate-v1@9 kept each punt as an `imported` record and left the punted thing where it
// was punted FROM, reporting "0 divergences" because it compared only against the instant fold (her sim rests it
// elsewhere). The importer refused such logs until translate-v1@10 ran her sim beside the v1 fold. Each case goes
// through the real importer (translateV1World, in a child with a scratch library: epoch-probe.ts), tier 0 empty (a translation names no founder),
// directory identities and content addresses, and is compared with HER sim (shared/sim.js beside the v1 fold, as sweep §3).
{ const { emptyState: v1Empty, foldEntry } = await import("./import-v1/fold.js");
  const eidosim = await import("./import-v1/eidosim-v1.js");   // HER engine: what the v1 log means
  const { simFold, DEFAULT_ENGINE } = await import("../../shared/protocol/simlayer.js");
  const { readLog, fold } = await import("../../shared/protocol/fold.js");
  const TV1 = await import("./import-v1/translate-v1.js");
  const crypto = await import("node:crypto");
  const FIX = path.join(import.meta.dir, "../../spec/fixtures/replay");
  const parseLog = (f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const salt = crypto.randomBytes(16).toString("hex");   // makes this run's stand-in model bytes its own
  const shaHex = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
  // her world: the v1 fold composed with her sim, settled far past the end as her replaybench does
  const hers = (L: any[]) => { const st: any = v1Empty(), sim: any = eidosim.emptySim(); for (const e of L) { foldEntry(st, e); eidosim.simEntry(sim, e, st); }
    if (sim.epoch && !sim.epoch.foreign) eidosim.advanceSim(sim, sim.tick + 100_000); return { st, sim }; };
  let n = 0;
  // translate `L` through the real importer; `lib` maps a model path to bytes the scratch library holds (or a real library dir)
  const importer = (tag: string, L: any[], { lib = {}, libDir = null }: { lib?: Record<string, Buffer>; libDir?: string | null } = {}) => {
    const W = path.join(tmp, `ep-${tag}-${++n}`), LIB = libDir ?? path.join(W, "lib"), OPT = path.join(W, "opt");
    fs.mkdirSync(path.join(W, "worlds", "old"), { recursive: true }); fs.mkdirSync(OPT, { recursive: true });
    for (const [p, b] of Object.entries(lib)) { fs.mkdirSync(path.dirname(path.join(LIB, p)), { recursive: true }); fs.writeFileSync(path.join(LIB, p), b); }
    fs.writeFileSync(path.join(W, "worlds", "old", "log.jsonl"), L.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const run = Bun.spawnSync(["bun", path.join(import.meta.dir, "epoch-probe.ts"), path.join(W, "worlds", "old"), path.join(W, "worlds", "new")],
      { env: { ...process.env, OPT_DIR: OPT, EIDOVERSE_DIR: LIB, TRUST_NAMES: "" }, stdout: "pipe", stderr: "pipe" });
    const line = run.stdout.toString().trim().split("\n").pop() ?? ""; let res: any; try { res = JSON.parse(line); } catch { res = { ok: false, err: `probe printed ${JSON.stringify(line.slice(0, 200))}; stderr ${run.stderr.toString().slice(-400)}` }; }
    const file = path.join(W, "worlds", "new", "world.jsonl");
    const lines = res.ok && fs.existsSync(file) ? readLog(fs.readFileSync(file, "utf8")) : [];
    return { ...res, lines, back: lines.length ? fold(lines) : null, dir: res.ok ? directoryAt(path.join(W, "worlds", DIRECTORY_FILE)) : null, at: path.join(W, "worlds", "new") };
  };
  const endOf = (lines: any[]) => Math.max(0, ...lines.map((e: any) => (Number.isFinite(e?.ts) ? e.ts : 0)));
  // the facts every physics-era translation must have; returns [pass, why] per fact (why names what broke)
  const facts = (t: any, L: any[], { addresses = {} as Record<string, string>, launches = -1 } = {}) => {
    const out: Record<string, [boolean, unknown]> = {};
    if (!t.ok) return { translated: [false, t.err] as [boolean, unknown] };
    const { st, sim } = hers(L); const E = t.back.entities;
    const bad = Object.entries<any>(sim.bodies).filter(([id, b]) => JSON.stringify(E[TV1.enc(id)]?.c.transform?.pos) !== JSON.stringify(b.p)).map(([id, b]) => ({ id, hers: b.p, ours: E[TV1.enc(id)]?.c.transform?.pos }));
    out.rests = [Object.keys(sim.bodies).length > 0 && !bad.length, bad.slice(0, 3)];
    // every thing her sim does NOT hold stands where her instant fold has it (the instant fold owns it)
    const off = Object.entries<any>(st.entities).filter(([id, e]) => !sim.bodies[id] && !e.parent && JSON.stringify(E[TV1.enc(id)]?.c.transform?.pos) !== JSON.stringify(e.pos ?? [0, 0, 0])).map(([id]) => id);
    out.others = [!off.length, off.slice(0, 5)];
    // @11: her flights are plain logged writes: no launch, no digest; every flight of hers rests on the record; the world
    // runs today's eidosim from her epoch on; the sim layer reads the history without a disagreement
    const flown = t.lines.filter((e: any) => e.kind === "sim").length;
    const sf = simFold(t.lines, endOf(t.lines), { models: {} });
    out.carrier = [t.r.sim && !flown && !sf.checks.disagree.length && t.r.sim.rests === t.r.sim.launches && (launches < 0 || t.r.sim.launches === launches)
      && (!t.r.sim.engine || t.r.sim.engine.engine === DEFAULT_ENGINE), { flown, checks: sf.checks, sim: t.r.sim }];
    out.strict = [t.back.status === "ok" && !t.back.diagnostics.some(([, c]: any) => String(c).startsWith("malformed")), t.back.diagnostics.slice(0, 3)];
    out.tier0 = [Array.isArray(t.lines[0].body.owners[0]) && t.lines[0].body.owners[0].length === 0, t.lines[0].body.owners];   // #260 rereview blocker 1: no founder
    out.stamp = [t.lines[1].body.from.translator === TV1.TRANSLATOR_SIM, t.lines[1].body.from.translator];
    // identities: every old actor's act (and the launch it caused) is an opaque directory id, never the old name
    const people = t.lines.filter((e: any) => (e.kind === "act" && e.verb === "imported") || (e.kind === "sim" && e.verb === "launch"));
    // (v1's own system actors keep their v1 spelling on this path, as before: "world" stays "world", "door" is "system")
    const named = people.filter((e: any) => !["system", "world", "sim"].includes(e.actor) && !isMinted(e.actor)).map((e: any) => e.actor);
    const launchBy = t.lines.filter((e: any) => e.kind === "sim" && e.verb === "launch").every((e: any) => e.actor === t.lines[e.cause]?.actor);
    out.identities = [!named.length && launchBy && people.some((e: any) => isMinted(e.actor) && t.dir.entry(e.actor)), { named: [...new Set(named)].slice(0, 5), launchBy }];
    // R 10-17: every model is its library path, with model-hash sha256:<its bytes> beside it where this host has them; a
    // collider's box rides as physics.shape
    const wrongModel = Object.entries<any>(st.entities).filter(([id, e]) => typeof e.lib === "string" && (E[TV1.enc(id)]?.c.model !== e.lib || (addresses[e.lib] && E[TV1.enc(id)]?.c["model-hash"] !== `sha256:${addresses[e.lib]}`))).map(([id]) => id);
    out.addresses = [Object.keys(addresses).length > 0 && !wrongModel.length, wrongModel.slice(0, 5)];
    const shapes = sim.boxes ? Object.entries<any>(st.entities).filter(([, e]) => typeof e.lib === "string" && sim.boxes[e.lib]) : [];
    const noShape = shapes.filter(([id, e]) => JSON.stringify(E[TV1.enc(id)]?.c.physics?.shape) !== JSON.stringify(sim.boxes[e.lib])).map(([id]) => id);
    out.shapes = [!sim.boxes || (shapes.length > 0 && !noShape.length), noShape.slice(0, 5)];
    // R 2026-10-08: a thing the v1 log punts is a dynamic collider, every other one static (the ruling itself: this fact
    // states it, it can't independently derive it)
    // per thing (the v1 fold's own identity), from the translator's one statement of the rule
    const lives = TV1.puntedLives(L), lt = TV1.lifeTracker(); for (const e of L) lt.step(e);
    const punted = (id: string) => lives.has(`${id}#${lt.of(id)}`);
    const wrongKind = shapes.filter(([id]) => E[TV1.enc(id)]?.c.physics?.kind !== (punted(id) ? "dynamic" : "static")).map(([id]) => id);
    out.kinds = [!sim.boxes || !wrongKind.length, wrongKind.slice(0, 5)];
    // the live host opens it (the code the cutover runs) and its own sim layer agrees with every logged rest
    const live: any = openLive(t.at, "new", { now: () => endOf(t.lines) + 1000, custodyFile: path.join(path.dirname(t.at), CUSTODY_FILE) });
    const ls = live.sim(); out.live = [!ls.checks.disagree.length && JSON.stringify(live.state().entities) === JSON.stringify(t.back.entities), ls.checks];
    return out;
  };
  const report = (id: string, what: string, f: Record<string, [boolean, unknown]>) => { const broken = Object.entries(f).filter(([, [p]]) => !p);
    ok(!broken.length, `${id} ${what}`, Object.fromEntries(broken.map(([k, [, why]]) => [k, why]))); };
  const fixtureLib = () => Object.fromEntries(["wall.glb", "deck.glb", "crate.glb"].map((p) => [p, Buffer.from(`a stand-in model for ${p} ${salt}`)]));
  const addrOf = (lib: Record<string, Buffer>) => Object.fromEntries(Object.entries(lib).map(([p, b]) => [p, shaHex(b)]));

  // EP1: her four fixtures, as the importer makes them
  for (const name of fs.readdirSync(FIX).filter((d) => fs.existsSync(path.join(FIX, d, "log.jsonl"))).sort()) {
    const L = parseLog(path.join(FIX, name, "log.jsonl")); const lib = fixtureLib();
    const t = importer(name, L, { lib });
    report("EP1", `${name}: a physics-epoch log translates through the importer, and every body rests where her sim rests (tier 0 empty, identities, model paths and their hashes, physics.shape; the authority's sim layer re-checks every rest)`, facts(t, L, { addresses: addrOf(lib), launches: L.filter((e: any) => e.verb === "punt").length }));
  }

  // EP2: LEAVING the epoch (PROTOCOL_v2 §3): the sequencer releases every live body with result-shaped `place` entries
  // (via epoch-release), then logs `epoch {sim: null}`; from then on a punt is v1's (an instant cause: nothing moves)
  { const L = parseLog(path.join(FIX, "eidosim-0.5", "log.jsonl")); const { sim } = hers(L); let seq = L.at(-1).seq, ts = L.at(-1).ts + 20_000;
    const X = [...L, ...Object.entries<any>(sim.bodies).map(([id, b]) => ({ seq: ++seq, ts: (ts += 10), actor: "world", verb: "place", args: { id, pos: b.p.slice(), yaw: b.yaw, via: "epoch-release" } })),
      { seq: ++seq, ts: (ts += 10), actor: "world", verb: "epoch", args: { sim: null } },
      { seq: ++seq, ts: (ts += 500), actor: "fixture", verb: "punt", args: { id: "ball", power: 8, dir: [1, 1, 0] } },
      { seq: ++seq, ts: (ts += 500), actor: "fixture", verb: "spawn", args: { id: "late", lib: "crate.glb", pos: [9, 0, 9], yaw: 0 } }];
    const lib = fixtureLib(); const t = importer("exit", X, { lib });
    const f: any = facts(t, X, { addresses: addrOf(lib), launches: 4 });
    delete f.rests;   // her sim holds nothing after the exit: `others` is the whole check (the instant fold owns everything)
    const W = t.back?.entities ?? {};
    f.released = [Object.entries<any>(sim.bodies).every(([id, b]) => JSON.stringify(W[id]?.c.transform?.pos) === JSON.stringify(b.p)), Object.keys(sim.bodies)];
    f.off = [!W["@world"]?.c["physics-engine"] && !Object.values<any>(W).some((e) => e.c.physics), { engine: W["@world"]?.c["physics-engine"], physics: Object.keys(W).filter((k) => W[k].c.physics) }];
    f.inert = [t.r.sim?.launches === 4, t.r.sim];   // her four flights; the punt after the exit is v1's instant cause: no flight
    f.layerOff = [t.lines.length > 0 && !simFold(t.lines, endOf(t.lines), { models: {} }).sim, null];
    report("EP2", "leaving the epoch (epoch {sim: null}) after the sequencer's epoch-release places: every body stands where it was released, physics is off (no engine, no shapes), and a later punt is inert", f);
    // …and with no release places (her sim drops its bodies at the exit): the instant fold owns them again, as in her fold
    const Y = X.filter((e: any) => e.args?.via !== "epoch-release"); const u = importer("exit-bare", Y, { lib });
    const g: any = facts(u, Y, { addresses: addrOf(lib), launches: 4 }); delete g.rests;
    report("EP2", "leaving the epoch with no release places: what her sim held goes back to the instant fold's word, as her composed fold has it", g); }

  // EP3: an epoch entered mid-log after thousands of instant-fold entries: the local Commons copy (commons-0927, 15k
  // entries, no epoch) with her eidosim-0.5 epoch and punts appended, their ids remapped onto real Commons things, models
  // addressed from this host's real library. The thousands before the epoch must come out exactly as they did without it.
  // The copy is the repo's own unless a host names its real one: a Commons-sized v1 log made here (deterministic: 40 things
  // on six stand-in library models, then ~3000 instant-fold entries of moves, components, says, removals and respawns), its
  // models stand-in bytes in the probe's scratch library. PROTOCOL_COMMONS=<commons-0927 log.jsonl> (models from
  // PROTOCOL_COMMONS_LIBRARY, else this server's library) runs it on the real one; without it, an OPTIONAL line says so.
  { const syntheticCommons = () => {
      const models = ["crate.glb", "ball.glb", "wall.glb", "deck.glb", "lamp.glb", "bench.glb"], lib: Record<string, Buffer> = {};
      for (const m of models) lib[m] = Buffer.from(`a stand-in model for ${m} (synthetic Commons)`);
      let seed = 0x9e3779b9; const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
      const r2 = (x: number) => Math.round(x * 100) / 100; let seq = -1, ts = 1785635177077; const L: any[] = [];
      const put = (actor: string, verb: string, args: any) => L.push({ seq: ++seq, ts: (ts += 1 + Math.floor(rnd() * 4000)), actor, verb, args });
      const people = ["founder", "helper", "visitor1", "visitor2", "visitor3"];
      put("world", "grant", { id: "founder", role: "owner", gen: true }); put("founder", "grant", { id: "helper", role: "builder" }); put("founder", "grant", { id: "*", gen: true });
      const things = Array.from({ length: 40 }, (_, i) => `thing_${String(i).padStart(2, "0")}`);
      for (const [i, id] of things.entries()) put(people[i % 2], "spawn", { id, lib: models[i % models.length], pos: [r2(rnd() * 60 - 30), 0, r2(rnd() * 60 - 30)], yaw: r2(rnd() * 6) });
      const alive = new Set(things);
      for (let k = 0; k < 3000; k++) { const who = people[Math.floor(rnd() * people.length)], id = things[Math.floor(rnd() * things.length)], x = rnd();
        if (!alive.has(id)) { put(who, "spawn", { id, lib: models[Math.floor(rnd() * models.length)], pos: [r2(rnd() * 60 - 30), 0, r2(rnd() * 60 - 30)], yaw: r2(rnd() * 6) }); alive.add(id); }
        else if (x < 0.45) put(who, "place", { id, pos: [r2(rnd() * 60 - 30), 0, r2(rnd() * 60 - 30)], yaw: r2(rnd() * 6) });
        else if (x < 0.6) put(who, "comp", { id, type: "label", data: `note ${k}` });
        else if (x < 0.95) put(who, "say", { text: `line ${k}` });
        else if (alive.size > 20) { put(who, "remove", { id }); alive.delete(id); } }
      return { C: L, lib }; };
    let C: any[], lib: Record<string, Buffer> = {}, libDir: string | null = null, src: string;
    if (process.env.PROTOCOL_COMMONS) { C = parseLog(process.env.PROTOCOL_COMMONS); libDir = process.env.PROTOCOL_COMMONS_LIBRARY ?? (await import("../../server/config.ts")).LIBRARY_DIR; src = "the Commons copy"; }
    else { ({ C, lib } = syntheticCommons()); src = "a synthetic Commons-sized copy"; console.log("OPTIONAL ep3-real-commons: EP3 ran on its synthetic Commons-sized log (set PROTOCOL_COMMONS=<a commons-0927 log.jsonl> and PROTOCOL_COMMONS_LIBRARY=<its library> for the real one)"); }
    const modelBytes = (l: string) => (libDir ? (fs.existsSync(path.join(libDir, l)) ? fs.readFileSync(path.join(libDir, l)) : null) : lib[l] ?? null);
    { const st: any = v1Empty(); for (const e of C) foldEntry(st, e);
      // library models only (a store/ path resolves under OPT_DIR, which the probe gives a scratch one)
      const libs = [...new Set(Object.values<any>(st.entities).map((e) => e.lib).filter((l) => typeof l === "string" && /\.glb$/i.test(l) && !l.startsWith("store/") && modelBytes(l)))];
      const pick = Object.entries<any>(st.entities).filter(([, e]) => typeof e.lib === "string" && libs.includes(e.lib) && !e.parent && !e.kind && Array.isArray(e.pos) && e.pos.every(Number.isFinite)).sort(([a], [b]) => (a < b ? -1 : 1));
      const byLib = new Map<string, string>(); for (const [id, e] of pick) if (!byLib.has(e.lib)) byLib.set(e.lib, id);
      const four = [...byLib.values()].slice(0, 4);
      if (four.length < 4) ok(false, `EP3 ${src} has four modelled things on distinct library models to punt`, four);
      else {
        const F = parseLog(path.join(FIX, "eidosim-0.5", "log.jsonl")); const ep = F.find((e: any) => e.verb === "epoch");
        const as: Record<string, string> = { crate: four[0], ball: four[1], wall: four[2], deck: four[3] };
        const libOf = (id: string) => st.entities[as[id]].lib;
        const box = ep.args.boxes; const at = st.entities[as.crate].pos;
        // her timing kept exactly (the sim's outcome depends on it): each entry lands the same ms after her epoch as in her log
        const base = C.at(-1).ts + 60_000 - ep.ts; let seq = C.at(-1).seq; const shift = (e: any) => ({ ...e, seq: ++seq, ts: e.ts + base });
        const tail = F.filter((e: any) => !["genesis", "spawn"].includes(e.verb) && e.seq !== 1).map((e: any) => {
          if (e.verb === "epoch") return shift({ ...e, actor: "world", args: { ...e.args, boxes: { [libOf("crate")]: box["crate.glb"], [libOf("ball")]: box["crate.glb"], [libOf("wall")]: box["wall.glb"], [libOf("deck")]: box["deck.glb"] } } });
          if (e.verb === "place") return shift({ ...e, actor: "mica", args: { ...e.args, id: as[e.args.id], pos: [at[0] + 2.2, at[1], at[2]] } });
          if (e.verb === "punt") return shift({ ...e, actor: e.args.id === "ball" ? "antra" : "janus", args: { ...e.args, id: as[e.args.id] } });
          return shift(e); });
        const X = [...C, ...tail];
        const addresses = Object.fromEntries(libs.map((l) => [l, shaHex(modelBytes(l)!)]));
        const t = importer("commons", X, libDir ? { libDir } : { lib });
        report("EP3", `an epoch entered after ${C.length} instant-fold entries (${src}, her epoch and punts on ${four.join(", ")}): every body rests where her sim rests, through the importer`, facts(t, X, { addresses, launches: tail.filter((e: any) => e.verb === "punt").length }));
        // the thousands before it: the pure translator over the copy alone and over the copy + epoch agree entry for entry
        // up to the epoch's act (the second entry, the translator's stamp, differs by design: @10 says the sim ran)
        const nonce = "ZXAzLXNhbWUtbm9uY2UtMDAw";   // one world id for both (the default nonce hashes the whole source)
        const a = TV1.translate(C, { nonce }).out, b = TV1.translate(X, { nonce }).out; const k = b.findIndex((e: any) => e.kind === "act" && e.body?.verb === "epoch");
        const same = k > 2 && b.slice(2, k).every((e: any, i: number) => JSON.stringify(e) === JSON.stringify(a[i + 2])) && JSON.stringify(a[0]) !== undefined;
        ok(same && a[1].body.from.translator === TV1.TRANSLATOR && b[1].body.from.translator === TV1.TRANSLATOR_SIM, `EP3 …and the ${k - 2} entries before the epoch are byte-for-byte what the copy alone translates to`, { k }); }

    } }

  // EP5 (review of b398d7e3 #3): an epoch is what HER sim made of it. Her own law → today's eidosim; an engine she didn't
  // carry (nothing flew) → that name with no build (nothing flies here either); an epoch she refused (tickMs 5: it never
  // started) → no physics at all, the epoch kept as a record
  { const B = [[-0.5, 0, -0.5], [0.5, 1, 0.5]];
    const log = (sim: string, tickMs: number) => [{ seq: 0, ts: 1000, actor: "world", verb: "genesis", args: { v: 3, dialect: "eidoverse-log" } },
      { seq: 1, ts: 1020, actor: "fx", verb: "epoch", args: { sim, tickMs, boxes: { "crate.glb": B } } },
      { seq: 2, ts: 1030, actor: "fx", verb: "spawn", args: { id: "crate", lib: "crate.glb", pos: [0, 0, 0], yaw: 0, box: B } },
      { seq: 3, ts: 1500, actor: "fx", verb: "punt", args: { id: "crate", power: 8, dir: [1, 0.3, 0] } }];
    const W5 = (L: any[]) => fold(readLog(TV1.translate(L, {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities["@world"]?.c ?? {};
    const own = W5(log("eidosim@0.5.0", 66)), other = W5(log("otherphys@2.0.0", 66)), refused = W5(log("eidosim@0.5.0", 5));
    // a LATER epoch she refuses (her 66 ms law runs on): today's eidosim at HER tick, not the refused one (review r4 #3)
    const later = W5([...log("eidosim@0.5.0", 66).slice(0, 3), { seq: 3, ts: 1040, actor: "fx", verb: "epoch", args: { sim: "eidosim@0.5.0", tickMs: 5 } },
      { seq: 4, ts: 1500, actor: "fx", verb: "punt", args: { id: "crate", power: 8, dir: [1, 0.3, 0] } }]);
    ok(later["physics-engine"]?.engine === DEFAULT_ENGINE && later["physics-engine"]?.tickMs === 66, "EP5 …and a later epoch she refused doesn't replace hers: today's eidosim at her 66 ms", later["physics-engine"]);
    // a spawn the v1 fold ignores (lib "") is no new thing: what was punted stays dynamic (review r4 #5)
    const noop = fold(readLog(TV1.translate([...log("eidosim@0.5.0", 66), { seq: 4, ts: 9000, actor: "fx", verb: "spawn", args: { id: "crate", lib: "" } }], {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities.crate?.c.physics;
    ok(noop?.kind === "dynamic", "EP4 a spawn the v1 fold ignores (lib \"\") makes no new thing: the punted crate stays dynamic", noop);
    // the v1 fold's own identity (fold.js bornOf): a same-lib re-spawn with no remove between is the same thing (review r5)
    const again = fold(readLog(TV1.translate([...log("eidosim@0.5.0", 66), { seq: 4, ts: 9000, actor: "fx", verb: "spawn", args: { id: "crate", lib: "crate.glb", pos: [3, 0, 3], yaw: 0, box: B } }], {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities.crate?.c.physics;
    ok(again?.kind === "dynamic", "EP4 a same-lib re-spawn with no remove between is the same thing (the v1 fold's own identity): still dynamic", again);
    // the v1 fold reads an id as a property key: remove {id: 7} removes "7" (review r6)
    const numid = fold(readLog(TV1.translate([...log("eidosim@0.5.0", 66), { seq: 4, ts: 9000, actor: "fx", verb: "remove", args: { id: 7 } },
      { seq: 5, ts: 9100, actor: "fx", verb: "spawn", args: { id: "7", lib: "crate.glb", pos: [3, 0, 3], yaw: 0, box: B } }].map((e: any) => (e.args?.id === "crate" ? { ...e, args: { ...e.args, id: "7" } } : e)), {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities["7"]?.c.physics;
    ok(numid?.kind === "static", "EP4 an id is a property key, as the v1 fold reads it: remove {id: 7} ends \"7\", and the next \"7\" is a new, static thing", numid);
    // a falsy id is no thing to the v1 fold's spawn (!a?.id): spawn {id: 0}, punt "0", then a real spawn "0" — that "0" was never punted (review r7)
    const zero = fold(readLog(TV1.translate([...log("eidosim@0.5.0", 66).slice(0, 2), { seq: 2, ts: 1030, actor: "fx", verb: "spawn", args: { id: 0, lib: "crate.glb", pos: [0, 0, 0], yaw: 0, box: B } },
      { seq: 3, ts: 1500, actor: "fx", verb: "punt", args: { id: "0", power: 8, dir: [1, 0.3, 0] } },
      { seq: 4, ts: 9000, actor: "fx", verb: "spawn", args: { id: "0", lib: "crate.glb", pos: [3, 0, 3], yaw: 0, box: B } }], {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities["0"]?.c.physics;
    ok(zero?.kind === "static", "EP4 a spawn with a falsy id makes nothing (the v1 fold's rule): a punt before the real spawn of \"0\" isn't its punt", zero);
    // remove {id: null} deletes the thing named "null" in the v1 fold (entities[null]): the next "null" is new (review r8)
    const nul = fold(readLog(TV1.translate([...log("eidosim@0.5.0", 66)].map((e: any) => (e.args?.id === "crate" ? { ...e, args: { ...e.args, id: "null" } } : e)).concat([
      { seq: 4, ts: 9000, actor: "fx", verb: "remove", args: { id: null } }, { seq: 5, ts: 9100, actor: "fx", verb: "spawn", args: { id: "null", lib: "crate.glb", pos: [3, 0, 3], yaw: 0, box: B } }]), {}).out.map((e: any) => JSON.stringify(e)).join("\n"))).entities["null"]?.c.physics;
    ok(nul?.kind === "static", "EP4 remove {id: null} ends the thing named \"null\", as the v1 fold has it: the next is new and static", nul);
    ok(own["physics-engine"]?.engine === DEFAULT_ENGINE && other["physics-engine"]?.engine === "otherphys@2.0.0" && other["physics-engine"]?.build === null
      && !refused["physics-engine"] && refused["imported:epoch"]?.tickMs === 5,
      "EP5 her law becomes today's eidosim; an engine she didn't carry keeps its name and no build (nothing flies); an epoch she refused stays a record",
      { own: own["physics-engine"], other: other["physics-engine"], refused: { engine: refused["physics-engine"], record: refused["imported:epoch"] } }); }

  // EP4 (review of b398d7e3 #2 #4): an id removed and spawned again is a new thing: never punted, it's static. And her
  // physics is not anyone's act to take back: undo of an imported punt's act changes nothing (the rest is the sim's)
  { const F = parseLog(path.join(FIX, "eidosim-0.5", "log.jsonl")); const box = F.find((e: any) => e.verb === "epoch").args.boxes["crate.glb"];
    let seq = F.at(-1).seq, ts = F.at(-1).ts + 20_000;
    const X = [...F, { seq: ++seq, ts: (ts += 10), actor: "fixture", verb: "remove", args: { id: "crate" } },
      { seq: ++seq, ts: (ts += 10), actor: "fixture", verb: "spawn", args: { id: "crate", lib: "crate.glb", pos: [9, 0, -9], yaw: 0, box } }];
    const lib = fixtureLib(); const t = importer("respawn", X, { lib }); const W4 = t.back?.entities ?? {};
    ok(t.ok && W4.crate?.c.physics?.kind === "static" && W4.ball?.c.physics?.kind === "dynamic",
      "EP4 a punted thing removed and spawned again under its id is a new, static thing (what she punted stays dynamic)", { crate: W4.crate?.c.physics, ball: W4.ball?.c.physics, err: t.err });
    const G = [F[0], { seq: 0.5, ts: F[0].ts + 1, actor: "world", verb: "grant", args: { id: "fixture", role: "owner" } }, ...F.slice(1)];
    const u = importer("undo", G, { lib });
    const live: any = u.ok ? openLive(u.at, "new", { now: () => endOf(u.lines) + 1000, custodyFile: path.join(path.dirname(u.at), CUSTODY_FILE) }) : null;
    const punts = u.ok ? u.lines.map((e: any, i: number) => [e, i]).filter(([e]: any) => e.kind === "act" && e.body?.verb === "punt") : [];
    const { request } = await import("../../shared/protocol/authority.js");
    const answers = punts.map(([e, i]: any) => request(live, e.actor, "undo", { act: i, dry: true }));
    ok(punts.length === 4 && answers.every((r: any) => r.refused?.code === "nothing"),
      "EP4 …and undo of an imported punt's act changes nothing: where her sim rested it, and its kind, are no one's act", answers.map((r: any) => r.refused?.code ?? r.would)); }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[directory-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
