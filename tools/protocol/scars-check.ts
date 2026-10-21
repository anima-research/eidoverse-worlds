// tools/protocol/scars-check.ts — the engine-scars and consent-gaps fix pass (REVIEW-engine-scars-2026-10-17,
// REVIEW-consent-permissions-gaps-2026-10-17; R 10-17 02:45 "I like all of these rulings"). Every row was red first.
//   bun tools/protocol/scars-check.ts                 every row
//   bun tools/protocol/scars-check.ts --only L1,O2    just those
//   bun tools/protocol/scars-check.ts --tree <dir>    against another checkout's shared/ (a mutant)
//   bun tools/protocol/scars-check.ts --mutants       remove each fix in turn (a copy of shared/): its rows must go red; a
//                                                    no-op control mutation must stay green
// Rows:
//   L   a refused request is logged as its verb, its argument NAMES and its code; the values go to an in-memory ring
//   K   look: a viewer sees their own consent table and who touches them; nobody else's
//   O   sitting is consent, standing up is the exit (scars r8 M1): an edit by someone else that would move a seat
//       (transform, parent, motion) lands and lets each occupant go; the seat's own reaction or script is the occupant exemption; moving
//       your own seat is yours; a standing body never blocks an edit
//   Q   purge safety: an act body the authority reads back (READBACK) read through one accessor; a purged one is unknown,
//       and unknown never restamps an owner-chosen build, never flips a creator's rights, never crashes undo
//   G   the refusal-code registry: every code the authority can refuse with is registered (and every registered one used)
//   V   every verb has a VERBSPEC row
//   X   the spec pins: checkpoint reserved, the readback paragraph, §7a pre-avatar MUSTs, the names reserved, the ladder rule
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under shared/, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["a refused request logs its values again", "protocol/authority.js", "const body = { args: names.known, refused: { code } };", "const body = { args: names.known, request: args, refused: { code } };", ["L1"]],
  ["argument names not filtered to the verb's own", "protocol/authority.js", "const known = spec ? keys.filter((k) => k in spec.args || UNIVERSAL_ARGS.has(k)) : [];", "const known = keys;", ["L2"]],
  ["an invented verb's name is logged", "protocol/authority.js", "const asVerb = Object.hasOwn(VERBS, verb) || Object.hasOwn(RESERVED_VERBS, verb) ? verb : \"unknown-verb\";", "const asVerb = verb;", ["L4"]],
  ["presence verbs' refusals are logged", "protocol/authority.js", "    if (PRESENCE_VERBS.has(verb)) return;", "", ["L5"]],
  ["the refusal ring", "protocol/authority.js", "  ring.push(rec); if (ring.length > REFUSAL_RING) ring.splice(0, ring.length - REFUSAL_RING);", "", ["L3"]],
  ["look shows everyone's table", "protocol/authority/blueprints.js", "...(id === actor ? { shield: shieldOf(P, id) } : {}),", "shield: shieldOf(P, id),", ["K1"]],
  ["look shows who touches whom", "protocol/authority/blueprints.js", ".filter(([k, r]) => r.to === id && (id === actor || k === actor)).map(([k]) => k) }));", ".filter(([k, r]) => r.to === id).map(([k]) => k) }));", ["K2"]],
  ["edits unseat no one", "protocol/authority/gate.js", "const vacate = CTX.forking || who.lifting ? [] : vacatesFor(w, st, who, norm);", "const vacate = [];", ["O1", "O2", "O7", "O8"]],
  ["only the first occupant is let go", "protocol/authority/occupants.js", "for (const r of occupants) { if (out.has(r)) continue;", "for (const r of occupants) { if (out.size) break;", ["O7"]],
  ["the seat's own motion unseats", "protocol/authority/occupants.js", "      if (own && rootOf(s.to) === own && unchangedSinceSat(s.since)) continue;", "", ["O3"]],
  ["moving your own seat unseats you", "protocol/authority/occupants.js", "const occupants = Object.keys(w.presence.occupants ?? {}).filter((k) => k !== who.actor);", "const occupants = Object.keys(w.presence.occupants ?? {});", ["O4"]],
  ["restamp reads a purged cause act", "protocol/authority/physics.js", "if (b === null) return true;   // a purged cause: unknown chooser, so never restamped", "if (b === null) return false;", ["Q1"]],
  ["entryBy reads a purged cause act", "protocol/authority/rights.js", "if (b === null) return { seq: e.seq, by, rights: null };", "if (b === null) return { seq: e.seq, by, rights: by };", ["Q2"]],
  ["readback ignores the purge index", "protocol/authority/storage.js", "if (purgedSeqs(w).has(seq)) return null;", "", ["Q3"]],
  ["an unregistered refusal code", "protocol/authority/scriptrun.js", "refuse(\"stale\", `${a.id}.${key}", "refuse(\"stale-x\", `${a.id}.${key}", ["G1"]],
  ["a verb without a row", "protocol/verbspec.js", "  inbox: {", "  inbox_gone: {", ["V1"]],
  ["a reserved request is just unknown", "protocol/authority.js", "if (!h && Object.hasOwn(RESERVED_VERBS, verb)) refuse(\"reserved\"", "if (false) refuse(\"reserved\"", ["X4"]],
  ["CONTROL (no-op: must stay green)", "protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/scars-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyShared(tag: string) { const d = scratch(tag); fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true });
  fs.cpSync(path.join(ENGINE, "spec"), path.join(d, "spec"), { recursive: true }); fs.cpSync(path.join(ENGINE, "docs"), path.join(d, "docs"), { recursive: true }); return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyShared("scarmut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[scars-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);   // the fixtures below seed the ids they read (R 10-17: a writer never chooses one; ids-check covers the refusal)
const F = await import(TREE + "shared/protocol/fold.js");
const C = await import(TREE + "shared/protocol/consent.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("scars");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `s${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, reopen: () => { w = openWorld(name); return w; }, entries: () => W().entries };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const lastAct = (s: any) => s.entries().findLast((e: any) => e.kind === "act");
// owner olive, builder bob, visitor vic
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "player"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
const SEAT = { sockets: { seat: { pos: [0, 0.45, 0], body: { action: "sit" } } } };
const read = (p: string) => fs.readFileSync(path.join(TREE, p), "utf8");

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- L: a refused request in the log ----------------
  { id: "L1", what: "a refused set is logged as verb + argument names + code: the value a visitor typed is nowhere in the log", run(s) { cast(s);
      s.call("olive", "create", { id: "lamp", model: "crate", place: { at: [0, 0] } });
      const r = s.call("vic", "set", { id: "lamp", component: "label", value: "my phone is 555-0100" });
      const a = lastAct(s);
      return { r: code(r), verb: a?.verb, body: a?.body, log: JSON.stringify(s.entries()).includes("555-0100") }; },
    good: (o) => o.r === "rights" && o.verb === "set" && JSON.stringify(o.body?.args) === '["component","id","value"]' && o.body?.refused?.code === "rights" && !("request" in (o.body ?? {})) && !o.log },
  { id: "L2", what: "…argument names are the verb's own (VERBSPEC): a name the verb doesn't take is counted, never written (a key is text too)", run(s) { cast(s);
      const r = s.call("vic", "set", { id: "nothing", component: "label", value: 1, "call me on 555-0100": true });
      const a = lastAct(s);
      return { r: code(r), body: a?.body, log: JSON.stringify(s.entries()).includes("555-0100") }; },
    good: (o) => o.r === "unknown-arg" && JSON.stringify(o.body?.args) === '["component","id","value"]' && o.body?.unknownArgs === 1 && !o.log },
  { id: "L3", what: "…the values go to the authority's in-memory ring (never persisted), capped", run(s) { cast(s);
      s.call("olive", "create", { id: "lamp", model: "crate", place: { at: [0, 0] } });
      s.call("vic", "set", { id: "lamp", component: "label", value: "hello there" });
      const ring = D.refusalRing ? D.refusalRing(s.w()) : [];
      const big = s.call("vic", "set", { id: "lamp", component: "label", value: "x".repeat(5000) }); const ring2 = D.refusalRing ? D.refusalRing(s.w()) : [];
      return { last: ring.at(-1), bigLen: JSON.stringify(ring2.at(-1) ?? {}).length, reopened: D.refusalRing ? D.refusalRing(s.reopen()).length : -1, big: code(big) }; },
    good: (o) => o.last?.verb === "set" && o.last?.actor === "vic" && o.last?.code === "rights" && /hello there/.test(o.last?.args ?? "") && o.bigLen < 2600 && o.reopened === 0 },
  { id: "L4", what: "…an invented verb is recorded as `unknown-verb` with no arguments at all: its name is the visitor's text, so it goes to the ring only (scars r8 M3)", run(s) { cast(s);
      const r = s.call("vic", "call-me-on-5550100", { secret: "555-0100" }); const a = lastAct(s);
      const ring = D.refusalRing ? D.refusalRing(s.w()) : [];
      return { r: code(r), verb: a?.verb, body: a?.body, log: JSON.stringify(s.entries()).includes("5550100") || JSON.stringify(s.entries()).includes("555-0100"), ring: ring.at(-1)?.verb }; },
    good: (o) => o.r === "unknown-verb" && o.verb === "unknown-verb" && JSON.stringify(o.body?.args) === "[]" && o.body?.unknownArgs === 1 && !o.log && o.ring === "call-me-on-5550100" },
  { id: "L5", what: "a refused touch, body effect or consent write is never logged (presence: consent is never appended, scars r8 M3); a refused edit still is", run(s) { cast(s);
      s.call("bob", "move", { to: [0, 0, 0] }); s.call("vic", "move", { to: [0.5, 0, 0] }); s.call("bob", "consent", { switch: "refuse" });   // recut A2: default is accept
      const n0 = s.entries().length;
      const b = s.call("vic", "body", { to: "bob", kind: "shove" });
      const r = s.call("vic", "reach", { who: "bob", point: "shoulder_l" });
      const c = s.call("vic", "consent", { of: "bob", allow: "vic", class: "touch" });
      const n1 = s.entries().length;
      s.call("olive", "create", { id: "lamp", model: "crate", place: { at: [5, 0] } }); const n2 = s.entries().length;
      const e = s.call("vic", "set", { id: "lamp", component: "label", value: "x" });
      return { b: show(b), r: show(r), c: show(c), wrote: n1 - n0, edit: code(e), editLogged: s.entries().length - n2 }; },
    good: (o) => /^refused/.test(o.b) && /^refused/.test(o.c) && o.wrote === 0 && o.edit === "rights" && o.editLogged === 1 },
  // ---------------- K: look ----------------
  { id: "K1", what: "look: vic sees his own consent switch, and nobody else's (bob's refuse stays bob's)", run(s) { cast(s);
      s.call("bob", "move", { to: [0, 0, 0] }); s.call("vic", "move", { to: [1, 0, 0] }); s.call("bob", "consent", { switch: "refuse" });
      const L = s.call("vic", "look", {}); const me = L.bodies?.find((b: any) => b.id === "vic"), him = L.bodies?.find((b: any) => b.id === "bob");
      return { me, him }; },
    good: (o) => o.me?.shield && "switch" in o.me.shield && !!o.him && !("shield" in o.him) && !JSON.stringify(o.him).includes("refuse") },
  { id: "K2", what: "look: who touches whom is the toucher's and the touched's own: a third person sees none of it", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "player" } });
      s.call("bob", "move", { to: [0, 0, 0] }); s.call("vic", "move", { to: [0.5, 0, 0] }); s.call("ann", "move", { to: [3, 0, 0] });
      s.call("bob", "consent", { allow: "vic", class: "touch" }); const t = s.call("vic", "reach", { who: "bob", point: "shoulder_l" });
      const seen = (who: string) => s.call(who, "look", {}).bodies?.find((b: any) => b.id === "bob")?.touchedBy ?? [];
      return { t: show(t), bob: seen("bob"), vic: seen("vic"), ann: seen("ann") }; },
    good: (o) => o.t === "ok" && JSON.stringify(o.bob) === '["vic"]' && JSON.stringify(o.vic) === '["vic"]' && JSON.stringify(o.ann) === "[]" },
  // ---------------- O: an edit that would move a seat (scars r8 M1: sitting is consent, standing up is the exit) ----------------
  { id: "O1", what: "bob sits on a chair: the owner's place, set transform and set parent of it all land, and each lets bob go (vacated, standing where he was, told in his inbox and the reply's notes)", run(s) { cast(s);
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT, place: { at: [4, 0] } });
      s.call("olive", "create", { id: "rug", model: "crate", place: { at: [9, 0] } });
      const sitThen = (f: () => any) => { s.call("bob", "move", { to: [4, 0, -0.6] }); const sit = s.call("bob", "use", { id: "chair", action: "sit" }); const r = f(); return { sit: sit.ok, r: show(r), seated: !!s.w().presence.occupants?.bob, note: (r.notes ?? []).some((n: any) => n.who === "bob" && n.vacated) }; };
      const pl = sitThen(() => s.call("olive", "place", { id: "chair", at: [4, 0.01] }));
      const tr = sitThen(() => s.call("olive", "set", { id: "chair", component: "transform", value: { pos: [4, 0, 0.02] } }));
      const pa = sitThen(() => s.call("olive", "set", { id: "chair", component: "parent", value: { to: "rug" } }));
      const inbox = s.call("bob", "inbox", {}).messages ?? [];
      return { pl, tr, pa, told: inbox.filter((m: any) => m.type === "vacated" && m.by === "olive").length }; },
    good: (o) => [o.pl, o.tr, o.pa].every((x) => x.sit && x.r === "ok" && !x.seated && x.note) && o.told === 3 },
  { id: "O2", what: "…a motion on the chair, or on the table it hangs from (a parent moves its children), lands and lets bob go the same way", run(s) { cast(s);
      s.call("olive", "create", { id: "table", model: "table", place: { at: [4, 0] } });
      s.call("olive", "create", { id: "chair", model: "chair", components: { ...SEAT, parent: { to: "table" }, transform: { pos: [0, 0, 1.2] } } });
      s.call("bob", "move", { to: [4, 0, 0.6] }); const sit = s.call("bob", "use", { id: "chair", action: "sit" });
      const m1 = s.call("olive", "set", { id: "chair", component: "motion", value: { type: "spin", axis: [0, 1, 0], speed: 1 } }); const s1 = !!s.w().presence.occupants?.bob;
      s.call("bob", "use", { id: "chair", action: "sit" });
      const m2 = s.call("olive", "set", { id: "table", component: "motion:orbit", value: { type: "orbit", radius: 3, period: 4 } }); const s2 = !!s.w().presence.occupants?.bob;
      return { sit: show(sit), m1: show(m1), m2: show(m2), s1, s2 }; },
    good: (o) => o.sit === "ok" && o.m1 === "ok" && o.m2 === "ok" && !o.s1 && !o.s2 },
  { id: "O3", what: "vic starts the carousel bob sits on (a use of the carousel's own reaction, which writes its motion): it lands and bob stays seated — the seat's own motion is what he sat down for (a swing's push, where a world carries the impulse kind, is the same rule)", run(s) { cast(s);
      const mk = s.call("olive", "create", { id: "carousel", model: "chair", components: { ...SEAT, transform: { pos: [4, 0, 0] }, reactions: { start: { kind: "set", component: "motion", value: { type: "spin", axis: [0, 1, 0], speed: 0.5 } } } } }); if (!mk.ok) return { mk: show(mk) };
      s.call("bob", "move", { to: [4, 0, -0.6] }); const sit = s.call("bob", "use", { id: "carousel", action: "sit" });
      s.call("vic", "move", { to: [4, 0, -1.5] }); const go = s.call("vic", "use", { id: "carousel", action: "start" });
      return { sit: show(sit), go: show(go), motion: s.w().state().entities.carousel.c.motion?.type, seated: !!s.w().presence.occupants?.bob }; },
    good: (o) => o.sit === "ok" && o.go === "ok" && o.motion === "spin" && o.seated },
  { id: "O4", what: "…bob may move the chair he sits on himself and stays seated, and anyone may edit what doesn't move it (a label) without unseating him", run(s) { cast(s);
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT, place: { at: [4, 0] } });
      s.call("bob", "move", { to: [4, 0, -0.6] }); s.call("bob", "use", { id: "chair", action: "sit" });
      const lab = s.call("olive", "set", { id: "chair", component: "label", value: "the good chair" }); const s1 = !!s.w().presence.occupants?.bob;
      const own = s.call("bob", "place", { id: "chair", at: [5, 0] }); const s2 = !!s.w().presence.occupants?.bob;
      return { lab: show(lab), own: show(own), s1, s2 }; },
    good: (o) => o.lab === "ok" && o.own === "ok" && o.s1 && o.s2 },
  { id: "O5", what: "bob stands on a deck: the owner's set transform of the deck lands (a standing body never blocks an edit: a visitor can't freeze a stage)", run(s) { cast(s);
      s.call("olive", "create", { id: "deck", model: "crate", components: { transform: { pos: [8, 0, 0], scale: [3, 0.5, 3] } } });
      s.call("olive", "create", { id: "box", model: "crate", place: { at: [-6, 0] } });
      s.call("bob", "move", { to: [8, 0.3, 0], teleport: true });
      const d = s.call("olive", "set", { id: "deck", component: "transform", value: { pos: [8, 30, 0], scale: [3, 0.5, 3] } });
      const b = s.call("olive", "set", { id: "box", component: "transform", value: { pos: [-6, 0, 2] } });
      return { d: show(d), b: show(b) }; },
    good: (o) => o.d === "ok" && o.b === "ok" },
  { id: "O6", what: "…and the owner's undo of an earlier move of that deck lands too", run(s) { cast(s);
      s.call("olive", "create", { id: "deck", model: "crate", components: { transform: { pos: [8, 0, 0], scale: [3, 0.5, 3] } } });
      const mv = s.call("olive", "set", { id: "deck", component: "transform", value: { pos: [10, 0, 0], scale: [3, 0.5, 3] } });
      s.call("bob", "move", { to: [10, 0.3, 0], teleport: true });
      const u = s.call("olive", "undo", {});
      return { mv: show(mv), u: show(u) }; },
    good: (o) => o.mv === "ok" && o.u === "ok" },
  { id: "O7", what: "bob and vic sit on a two-seat bench: the owner's move of it lets BOTH go, not just the first occupant found (holes r8 M2)", run(s) { cast(s);
      const BENCH = { sockets: { a: { pos: [-0.5, 0.45, 0], body: { action: "sit" } }, b: { pos: [0.5, 0.45, 0], body: { action: "sit" } } } };
      s.call("olive", "create", { id: "bench", model: "chair", components: BENCH, place: { at: [4, 0] } });
      s.call("bob", "move", { to: [3.6, 0, -0.6] }); const b = s.call("bob", "use", { id: "bench", action: "sit" });
      s.call("vic", "move", { to: [4.4, 0, -0.6] }); const v = s.call("vic", "use", { id: "bench", action: "sit" });
      const both = Object.keys(s.w().presence.occupants ?? {}).sort().join(",");
      const r = s.call("olive", "set", { id: "bench", component: "transform", value: { pos: [4, 40, 0] } });
      const unseated = (r.notes ?? []).filter((n: any) => n.vacated).map((n: any) => n.who).sort().join(",");
      return { b: show(b), v: show(v), both, r: show(r), left: Object.keys(s.w().presence.occupants ?? {}).join(","), unseated }; },
    good: (o) => o.b === "ok" && o.v === "ok" && o.both === "bob,vic" && o.r === "ok" && o.left === "" && o.unseated === "bob,vic" },
  { id: "O8", what: "a reaction on ANOTHER thing that moves the seat (a reset button across the room sending the chair home) is someone else's edit: it lands and lets the occupant go", run(s) { cast(s);
      s.call("olive", "create", { id: "chair", model: "chair", components: { ...SEAT, home: { pos: [4, 0, 0] } }, place: { at: [6, 0] } });
      s.call("olive", "create", { id: "button", model: "crate", components: { reactions: { reset: { kind: "reset", targets: ["chair"] } } }, place: { at: [-6, 0] } });
      s.call("bob", "move", { to: [6, 0, -0.6] }); const sit = s.call("bob", "use", { id: "chair", action: "sit" });
      s.call("vic", "move", { to: [-6, 0, -1] }); const r = s.call("vic", "use", { id: "button", action: "reset" });
      return { sit: show(sit), r: show(r), at: s.w().state().entities.chair.c.transform?.pos, seated: !!s.w().presence.occupants?.bob }; },
    good: (o) => o.sit === "ok" && o.r === "ok" && o.at?.[0] === 4 && !o.seated },
  // ---------------- Q: purge vs readback ----------------
  { id: "Q1", what: "an owner named the engine's build; its cause act's body is purged (in memory, and as the stored {commit} stub): the server never restamps it", run(s) { cast(s);
      const OLD = "be543899cfedf430";
      const set = s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", build: OLD } });
      const actSeq = s.entries().findLastIndex((e: any) => e.kind === "act" && e.verb === "set");
      const w = s.w(); T += 100; process.env.PROTOCOL_NOW = String(T); w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: actSeq }] } });
      s.reopen(); s.call("olive", "look", {});
      const restamp1 = s.entries().filter((e: any) => e.verb === "restamp-engine").length;
      const w2 = s.reopen(); w2.entries[actSeq].body = { commit: "0".repeat(64) }; s.call("olive", "look", {});
      const restamp2 = s.entries().filter((e: any) => e.verb === "restamp-engine").length;
      const spec = s.w().state().entities["@world"].c["physics-engine"];
      return { set: show(set), restamp1, restamp2, build: spec.build }; },
    good: (o) => o.set === "ok" && o.restamp1 === 0 && o.restamp2 === 0 && o.build === "be543899cfedf430" },
  { id: "Q2", what: "a thing a use handler wrote is its author's (creatorOf.rights); with the use act's body purged the rights are unknown (null), never the visitor who pulled the lever", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { reactions: { on: { kind: "set", component: "t/lit", value: { on: true } } } }, place: { at: [0, 0] } });
      const u = s.call("vic", "use", { id: "lamp", action: "on" });
      const before = D.creatorOf(s.w(), "lamp", "t/lit")?.rights;
      const useSeq = s.entries().findLastIndex((e: any) => e.kind === "act" && e.verb === "use");
      const w = s.reopen(); w.entries[useSeq].body = { commit: "0".repeat(64) };
      const stub = D.creatorOf(w, "lamp", "t/lit");
      const w2 = s.reopen(); T += 100; process.env.PROTOCOL_NOW = String(T); w2.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: useSeq }] } });
      const idx = D.creatorOf(s.w(), "lamp", "t/lit");
      return { u: show(u), before, stub: stub ? stub.rights : "none", idx: idx ? idx.rights : "none" }; },
    good: (o) => o.u === "ok" && o.before === "bob" && o.stub === null && o.idx === null },
  { id: "Q3", what: "undo after an undo's body is purged: no crash, and the chain reads the purged undo as unknown, the same way the index does", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", place: { at: [0, 0] } });
      s.call("bob", "set", { id: "lamp", component: "label", value: "one" });
      const u1 = s.call("bob", "undo", {}); const uSeq = s.entries().findLastIndex((e: any) => e.kind === "act" && e.verb === "undo");
      const w = s.w(); T += 100; process.env.PROTOCOL_NOW = String(T); w.append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: uSeq }] } });
      const mem = s.call("bob", "undo", {}); const after1 = s.w().state().entities.lamp?.c.label ?? null;
      const w2 = s.reopen(); w2.entries[uSeq].body = { commit: "0".repeat(64) };
      const stub = s.call("bob", "undo", {});
      return { u1: show(u1), mem: show(mem), stub: show(stub), after1, readback: D.readback ? [D.readback(s.w(), uSeq), D.readback(w, uSeq)] : "absent" }; },
    good: (o) => o.u1 === "ok" && !/CRASH/.test(o.mem) && !/CRASH/.test(o.stub) && Array.isArray(o.readback) && o.readback[0] === null && o.readback[1] === null },
  // ---------------- G: refusal codes ----------------
  { id: "G1", what: "every code the authority refuses with is registered (REFUSAL_CODES: code, meaning, when), every registered code is used, and no request in this suite met an unregistered one", run: () => ({}), good: () => false },
  // ---------------- V: verbs ----------------
  { id: "V1", what: "every verb the authority answers has a VERBSPEC row (names and types; help is generated from it)", run() {
      const names = D.VERB_NAMES ?? []; const V = (globalThis as any).__VS?.VERBSPEC ?? {};
      return { n: names.length, rowless: names.filter((v: string) => !V[v]), extra: Object.keys(V).filter((v) => !names.includes(v) && v !== "*") }; },
    // the floor catches an empty or broken verb list, not a count: recut B4 removed ghost/unghost (51 → 49)
    good: (o) => o.n >= 40 && !o.rowless.length && !o.extra.length },
  // ---------------- X: the spec, the registry, the ladder ----------------
  { id: "X1", what: "checkpoint: the name is reserved (gov.py refuses it by name), PROTOCOL §2 pins no unexercised shape", run() {
      const spec = read("spec/PROTOCOL.md"), gov = read("spec/conformance/gov.py");
      return { oldShape: spec.includes("`body {at: <seq>, head, digest}`"), reserved: /`checkpoint`\s+field[\s\S]{0,200}name is\s+reserved/.test(spec), gov: /RESERVED_GOV = \{"checkpoint"\}/.test(gov) && gov.includes('"checkpoint is reserved"') }; },
    good: (o) => !o.oldShape && o.reserved && o.gov },
  { id: "X2", what: "readback: PROTOCOL §1 names where the authority reads old acts and that a purged one is unknown; READBACK lists each reader with its unknown rule", run() {
      const spec = read("spec/PROTOCOL.md"); const RB = (globalThis as any).__VC?.READBACK ?? {};
      return { para: /\*\*Where the authority reads old acts \(readback\)\.\*\*/.test(spec) && /treats a purged body as \*\*unknown\*\*/.test(spec),
        purge12: /act body the authority reads back, §1, may be purged/.test(spec), rows: Object.keys(RB), whole: Object.values(RB).every((r: any) => r.fields?.length && r.where && r.unknown) }; },
    good: (o) => o.para && o.purge12 && ["act:undo", "act:use", "act:script", "act:sculpt", "act:*", "sim:launch"].every((k) => o.rows.includes(k)) && o.whole },
  { id: "X3", what: "PROTOCOL §7a: the avatar guard rails are MUSTs before avatars (owner stamped at wear, one predicate, every path, the precedence ladder, the grant, the wearer's log); body ownership is a rule under its own heading, and the old word 'sealed' is gone (R 10-17)", run() {
      const spec = read("spec/PROTOCOL.md"); const sec = spec.slice(spec.indexOf("## 7a."), spec.indexOf("## 8."));
      return { b: ["B1.", "B2.", "B3.", "B4.", "B5.", "B6."].filter((x) => !sec.includes(`**${x}`)), ladder: sec.includes("consent > body owner and grantees > world"),
        stamped: /stamped by the authority at wear/.test(sec) && /MUST NOT be derived from the log's history/.test(sec), grant: sec.includes("`edit-grant:<identity> {until?,"),
        wearer: /stored in the wearer's log, never the world's/.test(sec), sealed: sec.includes("### Body ownership (avatars)") && !/sealed/i.test(sec), oldIntended: sec.includes("(*intended*; the avatar design, not in this PR)") }; },
    good: (o) => !o.b.length && o.ladder && o.stamped && o.grant && o.wearer && o.sealed && !o.oldIntended },
  { id: "X4", what: "the names the guard rails use are held: body-owner, edit-grant, avatar-deny reserved in the registry; the request arrive {wearing} refused as reserved; the refusal code body registered", async run(s) { cast(s);
      const CS = await import(TREE + "shared/protocol/componentspec.js"); const VS = (globalThis as any).__VS; const RC = (globalThis as any).__REG?.REFUSAL_CODES ?? {};
      const arrive = s.call("vic", "arrive", { wearing: { avatar: "x", hash: "sha256:" + "0".repeat(64) } });
      const squat = s.call("olive", "set", { id: "@world", component: "avatar-deny", value: { ids: ["u-x"] } });
      return { comps: ["body-owner", "edit-grant", "avatar-deny"].map((n) => CS.statusOf?.(n) ?? null), arrive: code(arrive), wearing: !!VS?.RESERVED_VERBS?.arrive?.args?.wearing, body: !!RC.body?.reserved, squat: code(squat) }; },
    good: (o) => JSON.stringify(o.comps) === '["reserved","reserved","reserved"]' && o.arrive === "reserved" && o.wearing && o.body && o.squat === "reserved" },
  { id: "X5", what: "COMPONENT-LADDER: anything needing its own transform, lock, rights, refs or children is a child entity, not a key suffix", run() {
      return { rule: read("docs/COMPONENT-LADDER.md").includes("**anything that needs its own transform, lock, rights, references or children is a child entity, not a key suffix.**") }; },
    good: (o) => o.rule },
  { id: "X6", what: "PROTOCOL §7 and §8 say what a refused act and a script act keep: argument names and a code; presence reads as counts, body effects without consent", run() {
      const spec = read("spec/PROTOCOL.md");
      return { refused: spec.includes("`{args:\n<the names of the arguments the verb takes>, refused: {code}}`") || /refused: \{code\}\}`/.test(spec) && /never holds a value/.test(spec),
        oldRefused: spec.includes("(`{code, reason, fix}`) and nothing else is written"), reads: /never who was near or what anyone\s+is called/.test(spec), look: /`look` shows each viewer their own switch/.test(spec) }; },
    good: (o) => o.refused && !o.oldRefused && o.reads && o.look },
];
// G1 (static): scan the files the authority's refusals come from, then the registry; built after the cases list so the
// scan reads the TREE under test (a mutant's copy)
{
  const g = cases.find((c) => c.id === "G1")!;
  g.run = () => {
    const REG = (globalThis as any).__REG; if (!REG?.REFUSAL_CODES) return { reg: false };
    const files = ["shared/protocol/authority.js", ...fs.readdirSync(path.join(TREE, "shared/protocol/authority")).map((f) => `shared/protocol/authority/${f}`),
      ...REG.REFUSAL_SOURCES];
    const used = new Map<string, string>(); const dynamic: string[] = [];
    for (const f of files) { const src = read(f);
      for (const m of src.matchAll(/\brefuse\("([a-z0-9-]+)"/g)) used.set(m[1], f);
      for (const m of src.matchAll(/\bcode: "([a-z0-9-]+)"/g)) used.set(m[1], f);
      for (const m of src.matchAll(/\brefuse\(([a-zA-Z_][\w.?]*)[,)]/g)) if (f.endsWith("authority.js") || f.startsWith("shared/protocol/authority/")) dynamic.push(m[1]); }
    const reg = new Set(Object.keys(REG.REFUSAL_CODES));
    const missing = [...used.keys()].filter((c) => !reg.has(c) && !REG.NOT_REFUSALS.includes(c));
    const unused = [...reg].filter((c) => !used.has(c) && !REG.REFUSAL_CODES[c].reserved);
    const badRow = Object.entries(REG.REFUSAL_CODES).filter(([, r]: any) => !(typeof r?.meaning === "string" && r.meaning && typeof r?.when === "string" && r.when)).map(([k]) => k);
    const dynUnknown = [...new Set(dynamic)].filter((d) => !REG.DYNAMIC_REFUSALS.includes(d));
    return { reg: true, missing, unused, badRow, dynUnknown, n: reg.size, unseen: [...D.unregisteredCodes?.() ?? ["(no runtime hook)"]] };
  };
  g.good = (o) => o.reg && !o.missing.length && !o.unused.length && !o.badRow.length && !o.dynUnknown.length && o.n >= 100 && !o.unseen.length;
}

let pass = 0, fail = 0;
try { (globalThis as any).__REG = await import(TREE + "shared/protocol/refusalcodes.js"); } catch { /* G1 says so */ }
(globalThis as any).__VS = await import(TREE + "shared/protocol/verbspec.js");
(globalThis as any).__VC = await import(TREE + "shared/protocol/verbclasses.js");
for (const c of [...cases.filter((x) => x.id !== "G1"), ...cases.filter((x) => x.id === "G1")]) {   // G1 last: it reads what every other row met
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[scars-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
