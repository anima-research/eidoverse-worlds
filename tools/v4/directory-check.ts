// tools/v4/directory-check.ts — the door directory (server/v4/directory.ts): who an identity is lives outside the log
// (§2.3), an id is reached only through an account, and typing someone's name yields nothing (round-2 review R1, R2).
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/v4/directory-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { directoryAt, isMinted } from "../../server/v4/directory.ts";
import { openLive } from "../../server/v4/live.ts";
import { request, actIndexOf, isBanned } from "../../shared/v4/door.js";

let pass = 0, fail = 0;
const ok = (c: unknown, what: string, why?: unknown) => { if (c) pass++; else { fail++; console.log(`  FAIL ${what}${why === undefined ? "" : ` — ${JSON.stringify(why).slice(0, 300)}`}`); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v4-dir-"));
const file = path.join(tmp, "worlds", ".v4-directory.json");

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
  const bot = d.resolve({ sub: "agent:rowan", name: "Rowan", agent: true });
  ok(d.entry(bot)?.kind === "agent", "D6 an agent's account makes an agent identity");
  const leg = d.legacy("Bea"); d.bind(leg, "human:discord:333");
  ok(d.resolve({ sub: "human:discord:333", name: "Bea" }) === leg, "D7 binding an account to a legacy identity lets that account wear it");
  let threw = false; try { d.bind(leg, "human:discord:111"); } catch { threw = true; }
  ok(threw, "D8 an account can't wear two identities");
  ok((fs.statSync(file).mode & 0o777) === 0o600, "D9 the directory file is 0600", (fs.statSync(file).mode & 0o777).toString(8));
  const again = directoryAt(file);
  ok(again.resolve({ sub: "human:discord:111", name: "Annie" }) === ann && again.nameOf(twin) === "Annie", "D10 it survives a reopen");
  ok(JSON.stringify(again.names([ann, twin, "u-nobody"])) === JSON.stringify({ [ann]: "Annie", [twin]: "Annie" }), "D11 names() gives display names only (never accounts), skipping unknown ids"); }

// ---- I: the door with directory ids (R2: a role is held by an id, never by a name) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "w"), "w", { now: () => (T += 100), custodyFile: path.join(tmp, "custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const owner = d.resolve({ sub: "human:discord:111", name: "Annie" });
  ok(request(w, owner, "new", { title: "w" }).ok, "I1 the owner founds a world as their id");
  ok(request(w, owner, "set", { id: "@world", component: "default-role", value: { role: "visitor" } }).ok, "I1b …strangers are visitors");
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
  const log = fs.readFileSync(path.join(tmp, "worlds", "w", "v4.jsonl"), "utf8");
  ok(!/Annie|discord/.test(log), "I6 nothing about the person (name, account) is in the log", null); }

// ---- K: keys (round-2 R4, R5) ----
{ let T = 1800000000000; const d = directoryAt(file); const cust = path.join(tmp, "k-custody.json");
  const w: any = openLive(path.join(tmp, "worlds", "k"), "k", { now: () => (T += 100), custodyFile: cust, nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const me = d.resolve({ sub: "human:discord:555", name: "Kay" });
  ok(request(w, me, "new", { title: "k" }).ok, "K0 found a world");
  const g = w.entries[0].body;
  ok(JSON.stringify(g.owners[0]) === "[]" && g.owners[1]?.length === 1 && g.owners[1][0] !== g.sequencer,
    "K1 a founded world's genesis: tier 0 empty (custodial default, §2.4), the operator's governance key in tier 1, never the sequencer's key", g);
  const other: any = openLive(path.join(tmp, "worlds", "k"), "k", { now: () => (T += 100), custodyFile: path.join(tmp, "other-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const wr = request(other, me, "set", { id: "@world", component: "about", value: { name: "x", text: "" } });
  ok(!wr.ok && wr.refused?.code === "custody", "K2 a door that doesn't hold the world's sequencer key refuses to write (it would sign lines the verifier calls forged)", wr.refused);
  ok(request(other, me, "look", {}).ok, "K3 …but reads still work"); }
{ const { translateV1World } = await import("./import-v1/world.ts");
  const W = path.join(tmp, "tw"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } },
    { seq: 1, ts: 2, actor: "Ann", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const a = translateV1World(path.join(W, "old"), path.join(W, "a")), b = translateV1World(path.join(W, "old"), path.join(W, "b"));
  const ga = JSON.parse(fs.readFileSync(path.join(W, "a", "v4.jsonl"), "utf8").split("\n")[0]).body;
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
  const own = d.resolve({ sub: "human:discord:777", name: "Bo" }); request(w, own, "new", { title: "b" });
  request(w, own, "set", { id: "@world", component: "default-role", value: { role: "builder" } });
  const big = request(w, own, "say", { text: "x".repeat(9000) });
  ok(big.refused?.code === "too-big", "B1 a say is at most 8 KiB of text", big.refused);
  // the flood is big VALUES, not chat (20 says of 8 KiB stay under the cap): 60 KiB labels, well under 60 entries
  request(w, own, "create", { id: "slab", model: "crate", place: { at: [4, 4] } });
  const n0 = w.entries.length; let said = 0, stop: any = null;
  for (let i = 0; i < 40 && !stop; i++) { const r: any = request(w, own, "set", { id: "slab", component: "label", value: `${i}` + "y".repeat(60000) }); if (r.ok) said++; else stop = r.refused; }
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
  ok(!ref.ok && rec.length === 1 && rec[0].kind === "act" && rec[0].actor === anon && rec[0].body?.refused?.code === ref.refused?.code && rec[0].body?.request?.id === "@world",
    "B4 a refused write is recorded: an act with the request as sent and {refused: {code}}, no state", rec.map((e: any) => [e.kind, e.body]));
  const m1 = w.entries.length;
  request(w, anon, "delete", { id: "@world", dry: true }); request(w, anon, "inspect", { id: "nope" }); request(w, anon, "frobnicate", {});
  ok(w.entries.length === m1 + 1 && w.entries.at(-1).body?.refused?.code === "unknown-tool", "B5 dry runs and reads aren't recorded; an unknown tool is (it's what was tried)", w.entries.slice(m1).map((e: any) => e.body?.refused));
  const huge: any = request(w, anon, "set", { id: "nope", component: "label", value: "q".repeat(5000) });
  ok(!huge.ok && w.entries.at(-1).body?.request?.truncated === true, "B6 a recorded request over 2 KiB is cut to its size", w.entries.at(-1).body?.request);
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
  const me = d.resolve({ sub: "human:discord:888", name: "Sam" }); request(w, me, "new", { title: "s" });
  request(w, me, "create", { id: "cube", model: "crate", place: { at: [1, 1] } });
  const set = (component: string, value: unknown) => request(w, me, "set", { id: "cube", component, value }) as any;
  const typo = set("ligth", { intensity: 5 });
  ok(typo.refused?.code === "schema" && typo.refused?.didYouMean?.[0] === "light", "S1 a near-miss of a registered name is a typo: refused, did you mean light", typo.refused);
  ok(set("heart", { takes: 1 }).ok && set("inscription", { text: "hi" }).ok, "S2 a world's own invention (heart, inscription) is admitted");
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
  const q = (who: string, tool: string, a: any = {}) => request(w, who, tool, a) as any;
  q(ann, "new", { title: "u" });
  for (const [id, role] of [[dee, "owner"], [bob, "builder"], [cy, "builder"], [vic, "visitor"]]) q(ann, "set", { id: "@world", component: `roles:${id}`, value: { role } });
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

// ---- W: the sky panel in a v4 world (it couldn't write at all: fromv1 had no 'sky' / 'weather') ----
{ let T = 1800000000000; const d = directoryAt(file); const { worldEditOps } = await import("../../shared/worldentity.js");
  const w: any = openLive(path.join(tmp, "worlds", "wx"), "wx", { now: () => (T += 1000), custodyFile: path.join(tmp, "wx-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const own = d.resolve({ sub: "human:discord:w1", name: "Wyn" }), vis = d.resolve({ sub: "human:discord:w2", name: "Val" });
  request(w, own, "new", { title: "wx" }); request(w, own, "set", { id: "@world", component: `roles:${vis}`, value: { role: "visitor" } });
  const panel = { hours: 18, rate: 2, clouds: "cumulus", weather: "clear", sun: 1.2, fill: 0.4, world: "earth", clock: "authored" };
  const m: any = { tool: "sky", args: panel };   // what the sky panel sends (client/lib/skypanel.js)
  const we: any = worldEditOps({ sky: null, terrain: null, grass: null }, { "weather.state": "rain" }, { now: T });
  ok(we.ops.length === 1 && we.ops[0].tool === "weather" && we.ops[0].args.weather === "rain", "W1 edit @world plans the door's own tools (weather), never a v1 verb", we);
  const r: any = request(w, own, m.tool, m.args); const sky = w.state().entities["@world"].c.sky;
  ok(r.ok && sky.hours === 18 && sky.world === "earth" && Number.isInteger(sky.ts) && !("seq" in sky) && !("by" in sky), "W2 sky sets the sky, stamped with the door's clock, with no echo of who (R8)", [r.refused, sky]);
  const r2: any = request(w, own, "weather", { weather: "rain" }); const sky2 = w.state().entities["@world"].c.sky;
  ok(r2.ok && sky2.weather === "rain" && sky2.clouds === "cumulus" && sky2.world === "earth", "W3 weather merges onto the standing sky", [r2.refused, sky2]);
  ok(request(w, vis, "sky", panel).refused?.code === "rights", "W4 a visitor can't set the world's sky"); }

// ---- RB: an owner's rollback, undo {actor, since} (round-2 R11) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "rb"), "rb", { now: () => (T += 1000), custodyFile: path.join(tmp, "rb-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const P = (n: string) => d.resolve({ sub: `human:discord:rb-${n}`, name: n });
  const own = P("ola"), mal = P("mal"), car = P("car");
  const q = (who: string, tool: string, a: any = {}) => request(w, who, tool, a) as any;
  q(own, "new", { title: "rb" }); for (const id of [mal, car]) q(own, "set", { id: "@world", component: `roles:${id}`, value: { role: "builder" } });
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

// ---- XB: a v1 ban survives translation as a ban the door enforces (component review, world-settings #3: it became a
// state key the door never reads, so a translated world quietly unbanned everyone) ----
{ const { translateV1World } = await import("./import-v1/world.ts");
  const W = path.join(tmp, "xb"); fs.mkdirSync(path.join(W, "old"), { recursive: true });
  fs.writeFileSync(path.join(W, "old", "log.jsonl"), [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Ann: { role: "owner" } } } },
    { seq: 1, ts: 2, actor: "Ann", verb: "ban", args: { id: "Mallory", reason: "spam" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  translateV1World(path.join(W, "old"), path.join(W, "new"));
  const w: any = openLive(path.join(W, "new"), "new", { now: () => 1800000000000 });
  const at = Object.keys(w.state().entities["@world"].c).find((k) => k.startsWith("bans:")); const who = at?.slice(5);
  ok(!!who && isBanned(w, who) && w.mod.some((m: any) => m.verb === "ban" && m.who === who && m.reason === "spam"), "XB1 a v1 ban is a ban the door enforces after translation (filed in the moderator log, reason kept)", [at, w.mod]); }

// ---- V: a visitor undoes their own use, under the use's capability (round-2 R11) ----
{ let T = 1800000000000; const d = directoryAt(file);
  const w: any = openLive(path.join(tmp, "worlds", "vu"), "vu", { now: () => (T += 1000), custodyFile: path.join(tmp, "vu-custody.json"), nameOf: d.nameOf, kindOf: (id: string) => d.entry(id)?.kind ?? null });
  const own = d.resolve({ sub: "human:discord:vu1", name: "Oda" }), vis = d.resolve({ sub: "human:discord:vu2", name: "Vee" });
  request(w, own, "new", { title: "vu" }); request(w, own, "set", { id: "@world", component: `roles:${vis}`, value: { role: "visitor" } });
  request(w, own, "create", { id: "gate", model: "door", components: { door: { open: false }, reactions: { open: { kind: "toggle", component: "door", field: "open" } } }, place: { at: [0, 4] } });
  const u: any = request(w, vis, "use", { id: "gate", action: "open" });
  ok(u.ok && w.state().entities.gate.c.door.open === true, "V1 a visitor opens the gate through its handler", u.refused);
  const back: any = request(w, vis, "undo", {});
  ok(back.ok && w.state().entities.gate.c.door.open === false, "V2 …and can undo that, under the same handler (not builder rank)", back.refused);
  request(w, vis, "use", { id: "gate", action: "open" }); request(w, own, "delete", { id: "gate", component: "reactions" });
  ok(request(w, vis, "undo", {}).refused?.code === "rights", "V3 with the handler gone, the capability is gone: the visitor's undo is refused on rank (asked again now, not at use time)"); }

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[directory-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
