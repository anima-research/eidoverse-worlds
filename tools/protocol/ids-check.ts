// tools/protocol/ids-check.ts — id hardening (R 10-17 00:46, STAGING-TODO "ID HARDENING" (1)–(5)). Every row was red first.
//   bun tools/protocol/ids-check.ts               every row
//   bun tools/protocol/ids-check.ts --only P1,D2  just those
// Rows:
//   O   opaque: a minted id is 26 base32 characters and nothing else — no slug that can go stale (health-potion-… become a plant)
//   W   writers never choose ids: a writer-supplied id on create (and create {from}, a batch's create) is refused, the fix named
//   P   placeholders: '$name' (JSON:API lid) is minted in-request, refs to it in the same request resolve, the reply maps it,
//       and it never reaches the log
//   Y   system acts keep ids verbatim (a fork's copy)
//   D   delete nulls incoming typed references in the same act, and the reply says what it cleared
//   L   lint reports a stored reference that names nothing
//   T   every field that holds an entity id is typed (imported-behavior.attach)
//   S   scripts: world.create mints opaque and takes no id (api 2); an api-1 act re-runs as it was minted
//   G   the fixture seam (fixtureIds) is reachable from tests only: no runtime file calls it (G1, static) and a process
//       that loads the server's and the agent door's code still refuses a chosen id (G2, at runtime)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE } from "./common.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const only = opt("only")?.split(",") ?? null;
const T = ENGINE;
const imp = async (p: string) => await import(path.join(T, p));
const FOLD = await imp("shared/protocol/fold.js"), D = await imp("shared/protocol/authority.js"), CAT = await imp("shared/protocol/componentspec.js");
const IDS = await imp("shared/protocol/ids.js");
const SD = await imp("tools/protocol/scratchworld.ts");
let pass = 0, fail = 0;
const ok = (id: string, cond: any, what: string, detail?: any) => {
  if (cond) { pass++; console.log(`  ok ${id} ${what}`); }
  else { fail++; console.log(`  FAIL ${id} ${what}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 700)}` : ""}`); } };
async function C(id: string, what: string, fn: () => any) {
  if (only && !only.includes(id)) return;
  try { const r = await fn(); if (Array.isArray(r)) ok(id, r[0], what, r[1]); else ok(id, r, what); }
  catch (e) { ok(id, false, what, `threw: ${e?.stack ?? e}`); }
}
const why = (r: any) => (r?.ok ? "ok" : `${r?.refused?.code}: ${r?.refused?.reason} | ${r?.refused?.fix}`);
const world = (tag = "ids") => SD.scratchWorld(tag);
const read = (p: string) => fs.readFileSync(path.join(T, p), "utf8");
const OPAQUE = /^[a-z2-7]{26}$/;
const made = (r: any) => (r?.refs ?? []).map((x: any) => x.id);
const logText = (W: any) => JSON.stringify(W.entries());
const hashOf = (pub: any) => { const k = Object.keys(pub?.after?.["@world"] ?? {}).find((x) => x.startsWith("blueprints:")); return k ? `sha256:${k.slice(11)}` : null; };
// these rows are about writers: the fixture seam is off here, whatever a helper did
D.fixtureIds?.(false);

// ---- O: opaque ----
await C("O1", "mintId has no slug: mintId('health-potion') is 26 base32 characters, nothing else", () => {
  const xs = Array.from({ length: 500 }, () => IDS.mintId("health-potion"));
  return [xs.every((x) => OPAQUE.test(x) && FOLD.isEntityId(x)) && new Set(xs).size === xs.length && !("slugOf" in IDS), xs.slice(0, 2)]; });
await C("O2", "the authority mints opaque ids: a create, a duplicate (and its parts), a blueprint copy (and its parts)", () => {
  const W = world();
  const a = W.call("create", { model: "crate", components: { label: "health potion" } });
  const kid = W.call("create", { model: "crate", components: { parent: { to: made(a)[0] }, label: "cork" } });
  const dup = W.call("create", { from: made(a)[0] });
  const pub = W.call("publish", { from: made(a)[0], name: "potion" });
  const cp = W.call("create", { from: hashOf(pub) });
  const all = [...made(a), ...made(kid), ...made(dup), ...made(cp)];
  return [a.ok && kid.ok && dup.ok && cp.ok && made(dup).length === 2 && made(cp).length === 2 && all.every((x) => OPAQUE.test(x)), [made(dup), made(cp), why(dup), JSON.stringify(pub).slice(0, 200), why(cp)]]; });

// ---- W: writers never choose ids ----
await C("W1", "create {id: 'table'} is refused, and the fix names the placeholder ('$table') and leaving id out", () => {
  const W = world(); const r = W.call("create", { id: "table", model: "crate" });
  return [!r.ok && r.refused.code === "shape" && /mint/.test(r.refused.reason) && /\$table/.test(r.refused.fix) && /leave id out/.test(r.refused.fix) && !W.state().entities.table, why(r)]; });
await C("W2", "a chosen id is refused on create {from} (duplicate and blueprint) and on a batch's create (the op is named)", () => {
  const W = world(); const a = W.call("create", { model: "crate" }); const src = made(a)[0];
  const dup = W.call("create", { from: src, id: "twin" });
  const pub = W.call("publish", { from: src, name: "p" }); const h = hashOf(pub);
  const bp = W.call("create", { from: h, id: "copy" });
  const b = W.call("batch", { ops: [{ verb: "create", args: { model: "crate" } }, { verb: "create", args: { id: "chair", model: "crate" } }] });
  return [!dup.ok && dup.refused.code === "shape" && !bp.ok && bp.refused.code === "shape" && !b.ok && b.refused.code === "shape" && /op 1/.test(b.refused.reason) && /\$chair/.test(b.refused.fix), [why(dup), why(bp), why(b)]]; });
await C("W3", "the person-shaped id refusal still holds through the system door (a fork's copy can't wear u-…)", () => {
  const W = world(); const w = SD.worldObject(W);
  const r = D.forkCopy(w, W.owner, { ops: [{ verb: "create", args: { id: "u-abcdefghijklmnopqrst", model: "crate" } }] });
  return [!r.ok && r.refused.code === "shape" && /person/.test(r.refused.reason), why(r)]; });

// ---- P: placeholders ----
await C("P1", "create {id: '$potion'} mints an opaque id; the reply's ids map names it; the log never holds '$potion'", () => {
  const W = world(); const r = W.call("create", { id: "$potion", model: "crate" });
  const id = r.ids?.$potion;
  return [r.ok && OPAQUE.test(id ?? "") && W.state().entities[id] && made(r).includes(id) && !logText(W).includes("$potion"), [why(r), r.ids]]; });
await C("P2", "one batch: refs to placeholders resolve (parent.to, place on, a set's id, a look-at target), in any op order", () => {
  const W = world();
  const r = W.call("batch", { ops: [
    { verb: "create", args: { id: "$table", model: "table" } },
    { verb: "create", args: { id: "$lamp", model: "crate", components: { parent: { to: "$table" } } } },
    { verb: "set", args: { id: "$lamp", component: "label", value: "the lamp" } },
    { verb: "create", args: { id: "$cup", model: "crate", components: { "look-at": { target: "$lamp" } } } },
    { verb: "place", args: { id: "$cup", on: "$table" } } ] });
  const m = r.ids ?? {}; const st = W.state().entities;
  return [r.ok && ["$table", "$lamp", "$cup"].every((k) => OPAQUE.test(m[k] ?? "")) && st[m.$lamp]?.c.parent?.to === m.$table && st[m.$lamp]?.c.label === "the lamp"
    && st[m.$cup]?.c["look-at"]?.target === m.$lamp && !/\$table|\$lamp|\$cup/.test(logText(W)), [why(r), m]]; });
await C("P3", "a placeholder defined twice in one request is refused; one used but never defined is refused by name", () => {
  const W = world();
  const twice = W.call("batch", { ops: [{ verb: "create", args: { id: "$a", model: "crate" } }, { verb: "create", args: { id: "$a", model: "crate" } }] });
  const undef = W.call("set", { id: "$nope", component: "label", value: "x" });
  return [!twice.ok && twice.refused.code === "shape" && /\$a/.test(twice.refused.reason) && !undef.ok && /\$nope/.test(undef.refused.reason) && /isn't defined|not defined/.test(undef.refused.reason), [why(twice), why(undef)]]; });
await C("P4", "a placeholder is request-local: '$potion' from one request means nothing in the next", () => {
  const W = world(); const a = W.call("create", { id: "$potion", model: "crate" });
  const b = W.call("set", { id: "$potion", component: "label", value: "x" });
  return [a.ok && !b.ok && /\$potion/.test(b.refused.reason), why(b)]; });
await C("P5", "a dry run maps its placeholders too (and writes nothing)", () => {
  const W = world(); const n = W.entries().length; const r = W.call("create", { id: "$x", model: "crate", dry: true });
  return [r.ok && r.dry && OPAQUE.test(r.ids?.$x ?? "") && W.entries().length === n, [why(r), r.ids]]; });
await C("P6", "text that merely looks like a placeholder is left alone ('$5' on a sign)", () => {
  const W = world(); const r = W.call("create", { model: "crate", components: { label: "$5" } });
  return [r.ok && W.state().entities[made(r)[0]]?.c.label === "$5", why(r)]; });
await C("P7", "a refused request with a placeholder leaves no '$name' in the log's record of the attempt", () => {
  const W = world(); const r = W.call("create", { id: "$x", model: "crate", components: { "no such": 1 } });
  return [!r.ok && !logText(W).includes("$x"), why(r)]; });

await C("P8", "a chosen id refused beside a placeholder in one batch: the attempt isn't recorded with its '$name' in it", () => {
  const W = world(); const r = W.call("batch", { ops: [{ verb: "create", args: { id: "$keep", model: "crate" } }, { verb: "create", args: { id: "chair", model: "crate" } }] });
  const plain = W.call("create", { id: "table", model: "crate" });   // a chosen id alone is an attempt like any other: recorded, as names and a code (engine-scars 6a, R 10-17 02:45: never its values)
  const att = W.entries().findLast((e: any) => e.kind === "act" && e.verb === "create");
  return [!r.ok && /op 1/.test(r.refused.reason) && !logText(W).includes("$keep") && !plain.ok && JSON.stringify(att?.body?.args) === '["id","model"]' && att?.body?.refused?.code === "shape" && !logText(W).includes('"table"'), [why(r), att?.body]]; });

// ---- Y: system acts keep ids ----
await C("Y1", "a fork's copy (the system door) writes the ids it is given, verbatim", () => {
  const W = world(); const w = SD.worldObject(W);
  const r = D.forkCopy(w, W.owner, { ops: [{ verb: "create", args: { id: "old-world-table-1", model: "crate" } }] });
  return [r.ok && !!W.state().entities["old-world-table-1"], why(r)]; });

// ---- D: delete nulls incoming references ----
await C("D1", "deleting a thing clears every typed reference to it in the same act (look-at, story marks, a reset's targets, home.parent), and the reply lists them", () => {
  const W = world();
  const b = made(W.call("create", { model: "crate", components: { label: "B" } }))[0];
  const c = made(W.call("create", { model: "crate", components: { label: "C" } }))[0];
  const a = made(W.call("create", { model: "crate", components: { "look-at": { target: b }, story: { title: "t", text: "x", marks: [b, c] } } }))[0];
  const btn = made(W.call("create", { model: "crate", components: { reactions: { reset: { kind: "reset", targets: [b, c] } } } }))[0];
  const h = W.call("set", { id: c, component: "home", value: { pos: [0, 0, 0], parent: { to: b } } });
  const r = W.call("delete", { id: b });
  const st = W.state().entities; const note = (r.notes ?? []).find((n) => n.cleared);
  const cleared = (note?.cleared ?? []).map((x) => x.from).sort();
  return [r.ok && h.ok && !st[a].c["look-at"] && JSON.stringify(st[a].c.story.marks) === JSON.stringify([c]) && JSON.stringify(st[btn].c.reactions.reset.targets) === JSON.stringify([c])
    && st[c].c.home && !st[c].c.home.parent && cleared.length >= 4 && cleared.some((x) => x.startsWith(`${a}.look-at`)) && cleared.some((x) => x.startsWith(`${btn}.reactions`)),
    [why(r), cleared, st[a]?.c, st[btn]?.c.reactions, st[c]?.c.home]]; });
await C("D2", "a reset whose every target is deleted loses that handler (it can't send nothing home); the note says so", () => {
  const W = world();
  const b = made(W.call("create", { model: "crate" }))[0];
  const btn = made(W.call("create", { model: "crate", components: { reactions: { reset: { kind: "reset", targets: [b] }, ring: { kind: "play" } } } }))[0];
  const r = W.call("delete", { id: b }); const rx = W.state().entities[btn].c.reactions;
  return [r.ok && rx && !rx.reset && rx.ring && JSON.stringify(r.notes ?? []).includes("reset"), [why(r), rx, r.notes]]; });
await C("D3", "references into deleted children are cleared too (a child goes with its parent)", () => {
  const W = world();
  const p = made(W.call("create", { model: "crate" }))[0];
  const k = made(W.call("create", { model: "crate", components: { parent: { to: p } } }))[0];
  const a = made(W.call("create", { model: "crate", components: { "look-at": { target: k } } }))[0];
  const r = W.call("delete", { id: p });
  return [r.ok && !W.state().entities[a].c["look-at"], [why(r), W.state().entities[a]?.c]]; });

await C("D4", "an undo that takes a thing away (the undo of its create) clears references to it too; so does a batch's delete", () => {
  const W = world();
  const mk = W.call("create", { model: "crate" }); const b = made(mk)[0];
  const a = made(W.call("create", { model: "crate", components: { "look-at": { target: b } } }))[0];
  const u = W.call("undo", { act: mk.act });
  const c = made(W.call("create", { model: "crate" }))[0];
  const d = made(W.call("create", { model: "crate", components: { story: { title: "t", text: "x", marks: [c] } } }))[0];
  const bt = W.call("batch", { ops: [{ verb: "delete", args: { id: c } }] });
  const st = W.state().entities;
  return [(!u.ok || (!st[b] && !st[a].c["look-at"])) && bt.ok && JSON.stringify(st[d].c.story.marks) === "[]", [why(u), st[a]?.c["look-at"], why(bt), st[d]?.c.story]]; });

// ---- L: lint ----
await C("L1", "lint reports a stored reference that names nothing (kind dangling, where, what it names)", () => {
  const W = world(); const w = SD.worldObject(W);
  // a dangling reference can't be written any more (every write checks its refs; a delete clears them), so the state an old
  // log or an import could leave is made by hand: the thing a watcher looks at is taken out of the folded state
  const r0 = D.forkCopy(w, W.owner, { ops: [{ verb: "create", args: { id: "gone-thing-9", model: "crate" } }, { verb: "create", args: { id: "watcher-1", model: "crate", components: { "look-at": { target: "gone-thing-9" } } } }] });
  delete W.state().entities["gone-thing-9"];
  const l = W.call("lint", {}); const d = (l.warnings ?? []).find((x) => x.kind === "dangling");
  return [r0.ok && l.ok && d && d.id === "watcher-1" && d.names === "gone-thing-9" && /look-at/.test(d.at), [why(r0), l.warnings]]; });

// ---- T: typed references ----
await C("T1", "imported-behavior.attach holds an entity id and is typed ref", () => {
  const f = CAT.COMPONENTS["imported-behavior"].fields.attach; return [f === "ref", f]; });

// ---- S: scripts ----
await C("S1", "the script API is 2: world.create mints an opaque id from the activation's seed; an api-1 re-run mints as it did", async () => {
  const SR = await imp("shared/protocol/scriptrules.js"); const SB = await imp("shared/protocol/sandbox.js");
  const st = { entities: { "@world": { born: 0, c: {} }, bell: { born: 1, c: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } } };
  const text = "world.on('use', () => { world.create({ model: 'crate', label: 'health potion' }); });";
  const seed = "ab".repeat(32); const base = { text, self: "bell", key: "script:s", event: { on: "use", who: "u-abcdefghijklmnopqrst" }, knobs: {}, now: 1, seed, st, reads: { near: [], count: [], names: [] }, limits: { wallMs: 10000 } };
  const r2 = await SB.runScript({ ...base, api: SR.API }); const r1 = await SB.runScript({ ...base, api: 1 });
  const id2 = r2.ops?.find((o) => o.verb === "create")?.id, id1 = r1.ops?.find((o) => o.verb === "create")?.id;
  return [SR.API === 2 && /^[a-z0-9-]+$/.test(id2 ?? "") && !/potion|crate/.test(id2) && /^crate-/.test(id1 ?? ""), [SR.API, id2, id1, r2.why, r1.why]]; });
await C("S2", "world.create(components, id) is refused at api 2: a script never chooses an id (it gets the minted one back)", async () => {
  const SR = await imp("shared/protocol/scriptrules.js"); const SB = await imp("shared/protocol/sandbox.js");
  const st = { entities: { "@world": { born: 0, c: {} }, bell: { born: 1, c: {} } } };
  const text = "world.on('use', () => { world.create({ model: 'crate' }, 'my-id'); });";
  const r = await SB.runScript({ text, self: "bell", key: "script:s", event: { on: "use" }, knobs: {}, now: 1, seed: "cd".repeat(32), st, reads: { near: [], count: [], names: [] }, limits: { wallMs: 10000 }, api: SR.API });
  return [SR.API === 2 && !(r.ops ?? []).some((o) => o.verb === "create") && /never chooses|mints/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 400)]; });

// ---- H: handles and names (R 10-17 (5); duplicate labels stay allowed, ambiguity is surfaced) ----
await C("H1", "resolveThing: an exact id, else a label (case and outer spaces ignored), else a unique id prefix of 4+", async () => {
  const TR = await imp("shared/thingref.js");
  const things = [{ id: "a7futnmnitnhrxbmcxvcjzhx3d", label: "Tower" }, { id: "a7fuzzzzzzzzzzzzzzzzzzzzzz", label: "shed" }, { id: "q2kkkkkkkkkkkkkkkkkkkkkkkk" }];
  const r = [TR.resolveThing("a7futnmnitnhrxbmcxvcjzhx3d", things), TR.resolveThing("  tower ", things), TR.resolveThing("q2kk", things), TR.resolveThing("a7fut", things), TR.resolveThing("q2k", things)];
  return [r[0].id === things[0].id && r[0].by === "id" && r[1].id === things[0].id && r[1].by === "label" && r[2].id === things[2].id && r[2].by === "prefix" && r[3].id === things[0].id && r[4].none, r]; });
await C("H2", "a label two things share, or a prefix two ids share, is refused with the candidates — never resolved to one", async () => {
  const TR = await imp("shared/thingref.js");
  const things = [{ id: "a7futnmnitnhrxbmcxvcjzhx3d", label: "Belfry" }, { id: "a7fuzzzzzzzzzzzzzzzzzzzzzz", label: "belfry" }];
  const l = TR.resolveThing("Belfry", things), p = TR.resolveThing("a7fu", things);
  return [l.ambiguous?.length === 2 && l.by === "label" && !("id" in l) && p.ambiguous?.length === 2 && p.by === "prefix", [l, p]]; });
await C("H3", "handleOf: the shortest unique prefix of 4+, lengthened until no other id starts with it; a short id is its own handle", async () => {
  const TR = await imp("shared/thingref.js");
  const ids = ["a7futnmnitnhrxbmcxvcjzhx3d", "a7fuzzzzzzzzzzzzzzzzzzzzzz", "q2kkkkkkkkkkkkkkkkkkkkkkkk", "tower"];
  const h = ids.map((x) => TR.handleOf(x, ids));
  return [JSON.stringify(h) === JSON.stringify(["a7fut", "a7fuz", "q2kk", "tower"]), h]; });
await C("H4", "labelTwins marks only the things whose label another shares (the Hierarchy's dim disambiguator)", async () => {
  const TR = await imp("shared/thingref.js");
  const t = TR.labelTwins([{ id: "a", label: "Chair" }, { id: "b", label: "chair " }, { id: "c", label: "table" }, { id: "d" }]);
  return [t.has("a") && t.has("b") && !t.has("c") && !t.has("d"), [...t]]; });
await C("H5", "the editor's Hierarchy hides ids (an unlabelled row says what it is), marks only sibling twins with a short handle; the inspector shows the id only on its toggle", () => {
  const ep = read("client/lib/editpanels.js");
  return [/shownName = \(id\) => nameOnly\(id\) \?\? \(kindHint/.test(ep) && /handleOf\(id, all\)/.test(ep) && /badges\.unshift\(tw\)/.test(ep) && /k: 'showid'/.test(ep) && /k: 'copyid'/.test(ep) && /let showId = false/.test(ep)
    && !/const labelOf = \(id\) => \{ const l = nameOnly\(id\); return l \? \(hopts\.ids \? `\$\{l\}  \(\$\{id\}\)` : l\) : id; \};/.test(ep), "editpanels"]; });

await C("H6", "a person's lock question names the locked thing by what they call it (its label, or what it is), never its opaque id", async () => {
  const RF = await imp("shared/protocol/refusal.js"); const id = "jyxc32e5nz242uonrboteprqbw";
  const r = { refused: { code: "locked", lock: id, by: "bob" } };
  const named = RF.lockBody(r, "kid", (x) => (x === id ? "“tbl”" : null)), bare = RF.lockBody(r, "kid");
  const ep = read("client/lib/editwrites.js");
  return [named === "It rides “tbl”, which is locked by bob." && bare.includes(id) && /lockBody\(r, req\.args\?\.id, thingName\)/.test(ep), [named, bare]]; });

// ---- G: the fixture seam ----
await C("G1", "fixtureIds (tests' fixtures seed known ids, like a fork's copy) is called from no runtime file", () => {
  const roots = ["server", "mcpl", "client/lib", "client/src", "shared"]; const hits = [];
  const walk = (d) => { if (!fs.existsSync(path.join(T, d))) return; for (const f of fs.readdirSync(path.join(T, d), { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== "node_modules") walk(p); continue; }
    if (!/\.(js|ts|mjs)$/.test(f.name) || /-test\.|-check\.|-probe\./.test(f.name)) continue;
    const s = read(p); if (/\bfixtureIds\b/.test(s) && p !== "shared/protocol/authority.js") hits.push(p); } };   // named at all (an import alias would dodge a call pattern)
  roots.forEach(walk);
  return [typeof D.fixtureIds === "function" && !hits.length, hits]; });

await C("G2", "at runtime, loading the server's and the agent door's own code never enables the seam: a fresh process that imports them refuses a chosen id", () => {
  const src = `
    await import(${JSON.stringify(path.join(T, "server/worldlog.ts"))}); await import(${JSON.stringify(path.join(T, "server/messages.ts"))});
    await import(${JSON.stringify(path.join(T, "mcpl/tools.ts"))}); await import(${JSON.stringify(path.join(T, "mcpl/agent.ts"))});
    const { request, liftWorld, LAB_CATALOGUE } = await import(${JSON.stringify(path.join(T, "shared/protocol/authority.js"))});
    const { openWorld } = await import(${JSON.stringify(path.join(T, "server/filehost.ts"))});
    const { scratch } = await import(${JSON.stringify(path.join(T, "tools/protocol/common.ts"))});
    process.env.PROTOCOL_NOW = "1800000000000"; const w = openWorld(scratch("g2"), "g2"); w.catalogue = LAB_CATALOGUE; liftWorld(w);
    request(w, "olive", "create-world", { title: "g2" }); process.env.PROTOCOL_NOW = "1800000001000";
    const r = request(w, "olive", "create", { id: "table", model: "table" });
    console.log("G2:" + JSON.stringify({ ok: r.ok, code: r.refused?.code, minted: /mint/.test(r.refused?.reason ?? "") }));`;
  const out = Bun.spawnSync(["bun", "-e", src], { cwd: T, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const line = out.stdout.toString().split("\n").find((l) => l.startsWith("G2:"));
  const v = line ? JSON.parse(line.slice(3)) : null;
  return [v && v.ok === false && v.code === "shape" && v.minted, line ?? out.stderr.toString().slice(-600)]; });

console.log(`ids: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
