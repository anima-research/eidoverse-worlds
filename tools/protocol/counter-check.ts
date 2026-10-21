// tools/protocol/counter-check.ts — the "one deliberately boring component" (PR #208 review's twelve-line acceptance
// list, before a fishing rod): a COUNTER BUTTON through the real authority — publish/attach (PROTOCOL §4.1, §7),
// scripts on sponsor rights (§8), the capability algebra (§7a) — twelve named checks, C1…C12.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/counter-check.ts
//   RED=C5 bun tools/protocol/counter-check.ts      watch one check fail: a documented mutation of its setup or expectation
//
// The specimen: a thing with `label`, a `text` component showing the count, and `script:counter` whose `use` action
// `increment` raises the count and `reset` zeroes it (reactions {increment: {kind: 'script', who: 'builder'}, reset:
// {kind: 'script'}}). With no script the thing is a static labelled box showing the count: the `text` component IS the
// fallback (C10, C11 assert it).
//
// Harness: tools/blueprint-test.ts's pattern (a scratch world dir, identities with roles, requests through request(), the
// fold read back), over server/livehost.ts openLive rather than tools/protocol/scratchworld.ts's filehost, for two reasons
// the list needs: scripts run only with a sandbox (openLive's default is QuickJS, SANDBOX), and blobs are PER WORLD DIR
// there (<dir>/blobs, livehost.ts:52) where filehost's store is per ROOT (filehost.ts:26) — C2 is a test of exactly that.
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
import { request } from "../../shared/protocol/authority.js";
import { creatorOf } from "../../shared/protocol/authority/rights.js";
import { openLive } from "../../server/livehost.ts";
import { SANDBOX } from "../../shared/protocol/sandbox.js";

// the sandbox runs in-process here: this suite tests the protocol's rules around a script, not its isolation (scripts-check
// does that); the isolated path's first activation can wait on a warm process and read `unavailable`, which is a host fact
process.env.EIDO_SANDBOX ??= "inprocess";
const RED = process.env.RED ?? "";          // the check whose setup/expectation is deliberately broken this run
const red = (id: string) => RED === id;
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const J = JSON.stringify;
const code = (r: any) => (r?.ok ? "ok" : r?.refused?.code ?? "?");

// ---- the harness ----
const ROOT = scratch("counter");
let T = 1800000000000, N = 0;
function scratchLive(owner = "olive") {
  const name = `w${++N}`; const dir = path.join(ROOT, "worlds", name); fs.mkdirSync(dir, { recursive: true });
  const opts = { now: () => Number(process.env.PROTOCOL_NOW ?? T), scripts: SANDBOX, custodyFile: path.join(ROOT, "custody.json"), nameOf: () => null, kindOf: () => "human" };
  let w = openLive(dir, name, opts);
  const call = (verb: string, args: any = {}, actor = owner) => { T += 1000; process.env.PROTOCOL_NOW = String(T); return request(w, actor, verb, args); };
  const founded = call("create-world", { title: name });
  if (!founded.ok) throw new Error(`scratch world: refused: ${J(founded.refused)}`);
  return {
    name, dir, call,
    w: () => w,
    state: () => w.state(),
    entries: () => w.entries,
    c: (id: string) => w.state().entities[id]?.c ?? null,
    getBlob: (h: string) => w.getBlob(h),
    /** a server restart: the same directory opened again, nothing carried in memory (sweep.ts / grab-check reopen) */
    reopen: () => { w = openLive(dir, name, opts); return w; },
  };
}
const hashOf = (r: any) => r.notes?.find((n: any) => n.record)?.record ?? "";
const SCRIPT = `// the counter: increment raises the count shown on the sign, reset zeroes it
world.on("use", (e) => {
  const cur = world.get("self", "text") || {};
  const n = e.action === "reset" ? 0 : (Number(cur.text) || 0) + 1;
  world.set("self", "text", Object.assign({}, cur, { text: String(n) }));
});
`;
const BOX = { shape: "box", size: [0.4, 0.4, 0.4] };
const T0 = (pos: number[]) => ({ pos, q: [0, 0, 0, 1], scale: [1, 1, 1] });
const textOf = (W: any, id: string) => W.c(id)?.text?.text ?? null;
// the authority's duty budget for scripts is REAL time (activate: dutyLeft, 300 ms of every second for one world); activations
// sent back to back read `busy`, honestly. A use that runs the script waits its turn first.
const USE = (W: any, id: string, action: string, actor: string) => { Bun.sleepSync(400); return W.call("use", { id, action }, actor); };

console.log("\ncounter button — the twelve checks (PR #208 review)");
const W = scratchLive();                                       // olive founds it: the owner
for (const [who, role] of [["bld-a", "builder"], ["bld-b", "builder"], ["vis", "player"]]) W.call("set", { id: "@world", component: `roles:${who}`, value: { role } });
// builders here own only what they made (roles.js: the built-in builder holds editOthers; the owner narrows it): C9's "separate authority"
if (!red("C9")) { const rd = W.call("set", { id: "@world", component: "role-defs", value: { builder: { can: { editOthers: false } } } }); if (!rd.ok) throw new Error(`role-defs: ${J(rd.refused)}`); }

// bld-a builds the specimen: a box with a label and a sign, then the script and its reactions (as the editor's new-script card
// sends them: upload {text} → {src}; one batch: script:<name> {src, scope, on} + reactions)
{ const mk = W.call("create", { id: "counter", components: { transform: T0([2, 0, 2]), mesh: BOX, label: "counter", text: { text: "0" } } }, "bld-a");
  if (!mk.ok) throw new Error(`the specimen: ${J(mk.refused)}`);
  const up = W.call("upload", { text: SCRIPT }, "bld-a"); if (!up.ok) throw new Error(`upload: ${J(up.refused)}`);
  const inst = W.call("batch", { ops: [
    { verb: "set", args: { id: "counter", component: "script:counter", value: { src: up.src, scope: { ids: "self", comps: ["text"] }, on: ["use"] } } },
    { verb: "set", args: { id: "counter", component: "reactions", value: { increment: { kind: "script", script: "counter", ...(red("C4") ? {} : { who: "builder" }) }, reset: { kind: "script", script: "counter" } } } },
  ] }, "bld-a");
  if (!inst.ok) throw new Error(`install: ${J(inst.refused)}`);
}
const SPEC_COMPS = Object.keys(W.c("counter")).sort();

// ---- C1 record published by an authenticated principal ----
let H = "";
{ if (red("C1")) W.call("set", { id: "@world", component: "roles:vis", value: { role: "builder" } });
  const v = W.call("publish", { from: "counter", name: "Counter" }, "vis");
  const b = W.call("publish", { from: "counter", name: "Counter" }, "bld-a"); H = hashOf(b);
  check("C1 publish by a builder succeeds and names a sha256: hash; by a visitor is refused (rights)",
    b.ok && /^sha256:[0-9a-f]{64}$/.test(H) && !!W.c("@world")[`blueprints:${H.slice(7)}`] && v.ok === false && v.refused?.code === "rights", J({ builder: code(b), hash: H, visitor: code(v), why: v.refused?.reason }));
  if (red("C1")) W.call("set", { id: "@world", component: "roles:vis", value: { role: "player" } });
}

// ---- C2 one world grants it, another cannot use it ----
{ const here = W.call("create", { id: "copy-a", from: H, at: { pos: [5, 0, 5] } }, "bld-a");
  const W2 = scratchLive();
  const there = (red("C2") ? W : W2).call("create", { id: "copy-x", from: H, at: { pos: [5, 0, 5] } });
  const blobThere = fs.existsSync(path.join(W2.dir, "blobs", `${H.replace(/[^a-z0-9]/g, "-")}.json`));
  check("C2 create {from: hash} succeeds in the publishing world; a second world that never received it refuses it not-found (blobs are per world dir: livehost.ts:52)",
    here.ok && !!W.c("copy-a") && there.ok === false && there.refused?.code === "not-found" && !blobThere, J({ here: code(here), there: code(there), why: there.refused?.reason, blobThere }));
}

// ---- C3 the instance carries only hash + typed params/state ----
{ if (red("C3")) W.call("set", { id: "copy-a", component: "description", value: "a stray component" }, "bld-a");
  const c = W.c("copy-a"); const names = Object.keys(c).sort();
  const want = [...SPEC_COMPS, "copy-of"].sort();
  check("C3 the copy's components are exactly the subtree's plus copy-of; its script names a blob (sha256:), no code and no record body inlined",
    J(names) === J(want) && J(c["copy-of"]) === J({ from: H, key: "counter" }) && /^sha256:[0-9a-f]{64}$/.test(c["script:counter"]?.src) && !J(c).includes("world.on") && !J(c).includes('"parts"'),
    J({ names, want, copyOf: c["copy-of"], src: c["script:counter"]?.src }));
  if (red("C3")) W.call("delete", { id: "copy-a", component: "description" }, "bld-a");
}

// ---- C4 unauthorized trigger/effect refused ----
{ const before = textOf(W, "copy-a"); const n0 = W.entries().length;
  const r = W.call("use", { id: "copy-a", action: "increment" }, "vis");
  const changes = W.entries().slice(n0).filter((e: any) => e.kind === "change").length;
  check("C4 a visitor's use {action: 'increment'} is refused (rights: the handler's who: 'builder'); the count is unchanged in the fold and nothing changed",
    r.ok === false && r.refused?.code === "rights" && textOf(W, "copy-a") === before && before === "0" && changes === 0, J({ r: code(r), why: r.refused?.reason, before, after: textOf(W, "copy-a"), changes }));
}

// ---- C5 authorized use logs actor, cause and effect exactly once ----
{ const n0 = W.entries().length;
  const r = USE(W, "copy-a", "increment", "bld-a");
  if (red("C5")) USE(W, "copy-a", "increment", "bld-a");
  const E = W.entries().slice(n0).map((e: any, i: number) => ({ seq: n0 + i, kind: e.kind, actor: e.actor, verb: e.verb, cause: e.cause, body: e.body }));
  const use = E.filter((e) => e.kind === "act" && e.verb === "use"), scr = E.filter((e) => e.kind === "act" && e.verb === "script"), ch = E.filter((e) => e.kind === "change");
  // §8: the visitor's use is ITS act; the activation is one act (actor script:<entity>, cause = the use, naming the sponsor and
  // the trigger) plus ONE change caused by it. Three entries, each once; every cause chain ends at the person.
  check("C5 a builder's use lands as one use act (actor), one script act caused by it (sponsor + trigger named), and ONE change caused by that: three entries, nothing else",
    r.ok && r.script?.status === "ran" && E.length === 3 && use.length === 1 && use[0].actor === "bld-a" && scr.length === 1 && scr[0].actor === "script:copy-a" && scr[0].cause === use[0].seq
    && scr[0].body?.sponsor === "bld-a" && scr[0].body?.trigger?.actor === "bld-a" && ch.length === 1 && ch[0].actor === "script:copy-a" && ch[0].cause === scr[0].seq && textOf(W, "copy-a") === "1",
    J({ r: code(r), script: r.script, entries: E.map((e) => `${e.seq}:${e.kind}/${e.verb}@${e.actor}<-${e.cause ?? "-"}`), text: textOf(W, "copy-a") }));
}

// ---- C6 late join and text-tier perception agree ----
{ USE(W, "copy-a", "increment", "bld-a");   // → 2
  const target = red("C6") ? "counter" : "copy-a";
  const mine = W.call("inspect", { id: "copy-a" }, "bld-a");
  const late = W.call("inspect", { id: target }, "late-comer");      // an identity never seen before: no role, no history here
  const look = W.call("look", {}, "late-comer");
  const line = (look.things ?? []).find((t: any) => t.id === target);
  check("C6 a fresh identity joining after the increments reads the same count via inspect as the long-present one, and look's text says the same number",
    mine.ok && late.ok && mine.components?.text?.text === "2" && late.components?.text?.text === "2" && !!line && J(line).includes("«2»"), J({ mine: mine.components?.text?.text, late: late.components?.text?.text, line }));
}

// ---- C7 server restart does not rerun old actions ----
{ const n0 = W.entries().length; const t0 = textOf(W, "copy-a"); const scripts0 = W.entries().filter((e: any) => e.kind === "act" && e.verb === "script").length;
  W.reopen();
  if (red("C7")) USE(W, "copy-a", "increment", "bld-a");
  const scripts1 = W.entries().filter((e: any) => e.kind === "act" && e.verb === "script").length;
  check("C7 the world dir closed and reopened: the count equals the logged value and the entry count is unchanged — nothing re-executed",
    W.entries().length === n0 && textOf(W, "copy-a") === t0 && t0 === "2" && scripts1 === scripts0, J({ n0, n1: W.entries().length, t0, t1: textOf(W, "copy-a"), scripts0, scripts1 }));
}

// ---- C8 same hash means same meaning ----
{ const again = hashOf(W.call("publish", { from: "counter", name: "Counter" }, "bld-a"));
  W.call("set", { id: "counter", component: "label", value: "counter!" }, "bld-a");
  const moved = hashOf(W.call("publish", { from: "counter", name: "Counter" }, "bld-a"));
  W.call("set", { id: "counter", component: "label", value: "counter" }, "bld-a");
  const back = hashOf(W.call("publish", { from: "counter", name: "Counter" }, "bld-a"));
  check("C8 publishing the same subtree twice gives the same hash; one changed byte of the label gives a different one; restored, the first again",
    again === H && moved !== H && /^sha256:/.test(moved) && (red("C8") ? moved === H : back === H), J({ H, again, moved, back }));
}

// ---- C9 fork has explicit parent and separate authority ----
{ const mk = W.call("create", { id: "copy-b", from: H, at: { pos: [8, 0, 8] } }, "bld-b");
  const owner = creatorOf(W.w(), "copy-b");
  const own = W.call("set", { id: "copy-b", component: "label", value: "B's counter" }, "bld-b");
  const theirs = W.call("set", { id: "copy-a", component: "label", value: "not yours" }, "bld-b");
  check("C9 a copy made by builder B from A's blueprint is B's (creatorOf); B may edit their copy and may not edit A's (editOthers); copy-of names the hash",
    mk.ok && owner?.rights === "bld-b" && own.ok && theirs.ok === false && theirs.refused?.code === "rights" && theirs.refused?.needs === "editOthers" && W.c("copy-b")?.["copy-of"]?.from === H && W.c("copy-a")?.label === "counter",
    J({ mk: code(mk), owner, own: code(own), theirs: code(theirs), why: theirs.refused?.reason, copyOf: W.c("copy-b")?.["copy-of"] }));
}

// ---- C10 revoke changes to fallback without deleting history ----
{ const n0 = W.entries().length; const t0 = textOf(W, "copy-a");
  const del = red("C10") ? W.call("delete", { id: "copy-a" }, "bld-a") : W.call("delete", { id: "copy-a", component: "script:counter" }, "bld-a");
  const after = W.call("use", { id: "copy-a", action: "increment" }, "bld-a");   // no script: the thing is static
  const hist = W.call("history", { id: "copy-a", limit: 50 }, "bld-a");
  const scriptRows = (hist.entries ?? []).filter((h: any) => h.by === "script:copy-a" && h.changed?.includes("text"));
  const insp = W.call("inspect", { id: "copy-a" }, "late-comer");
  check("C10 deleting script:counter leaves the thing standing with its text count visible (the fallback); a use now finds no handler; the prior use acts are still in history {id}",
    del.ok && !!W.c("copy-a") && textOf(W, "copy-a") === t0 && t0 === "2" && !("script:counter" in (W.c("copy-a") ?? {})) && after.ok === false && after.refused?.code === "no-handler"
    && scriptRows.length === 2 && insp.ok && J(insp).includes("«2»") && W.entries().length === n0 + 3,
    J({ del: code(del), stands: !!W.c("copy-a"), text: textOf(W, "copy-a"), after: code(after), why: after.refused?.reason, scriptRows: scriptRows.map((h: any) => h.seq) }));
}

// ---- C11 missing registry/network still opens the world in fallback ----
{ const key = `blueprints:${H.slice(7)}`; const n0 = W.entries().length;
  const del = red("C11") ? { ok: true, skipped: true } : W.call("delete", { id: "@world", component: key });   // olive, the owner (the key is bld-a's)
  W.reopen();
  const st = W.state();
  const mk = W.call("create", { id: "copy-c", from: H, at: { pos: [1, 0, 1] } }, "bld-a");
  const hist = W.call("history", { id: "copy-a", limit: 50 }, "bld-a");
  const insp = W.call("inspect", { id: "copy-a" }, "late-comer");
  // the record's BYTES remain in the dir's blob store (a blob is purged by deleting its file, §12); what makes a hash usable here
  // is @world.blueprints:<hash> (isPublished, authority.js:2340), so the refusal reads `not-published` — the registry entry is gone
  check("C11 the blueprint record deleted from @world and the world reopened: it opens, the copy stands with its text, a new create {from} of that hash is refused (not-published: the registry has no such key), history intact",
    del.ok && st.status === "ok" && !(key in st.entities["@world"].c) && !!W.c("copy-a") && textOf(W, "copy-a") === "2" && mk.ok === false && ["not-found", "not-published"].includes(mk.refused?.code)
    && (hist.entries ?? []).some((h: any) => h.by === "script:copy-a") && insp.ok && W.entries().length === n0 + (del.skipped ? 0 : 2) + 1,   // the delete: its act + its change; the refused create: its act (§7: a refusal is an act carrying it)
    J({ del: code(del), status: st.status, keyGone: !(key in st.entities["@world"].c), text: textOf(W, "copy-a"), mk: code(mk), why: mk.refused?.reason, entries: [n0, W.entries().length] }));
}

// ---- C12 owner, invoker and affected participant rights are independently tested ----
{ // copy-b's script was installed by the copy (bld-b made it): its sponsor is bld-b. A visitor may not write the sign by hand…
  const byHand = W.call("set", { id: "copy-b", component: "text", value: { text: "0" } }, "vis");
  USE(W, "copy-b", "increment", "bld-b");   // → 1, so a reset is a change
  const n0 = W.entries().length;
  // …but their use of `reset` (open to all) runs the script with the SPONSOR's rights: the act names sponsor bld-b, trigger vis
  const invoker = red("C12") ? "bld-b" : "vis";
  const r = USE(W, "copy-b", "reset", invoker);
  const scr = W.entries().slice(n0).find((e: any) => e.kind === "act" && e.verb === "script"); const ch = W.entries().slice(n0).find((e: any) => e.kind === "change");
  const notMine = W.call("delete", { id: "copy-a" }, "bld-b");      // bld-b didn't make copy-a
  const mine = W.call("delete", { id: "copy-b" }, "bld-b");         // bld-b made copy-b
  check("C12 a non-owner builder may not delete another's copy; its owner may; a visitor's use runs with the SPONSOR's rights (act names sponsor ≠ trigger) where the visitor's own set is refused",
    byHand.ok === false && byHand.refused?.code === "rights" && r.ok && r.script?.status === "ran" && scr?.body?.sponsor === "bld-b" && scr?.body?.trigger?.actor !== scr?.body?.sponsor && scr?.body?.trigger?.actor === "vis"
    && ch?.actor === "script:copy-b" && notMine.ok === false && notMine.refused?.code === "rights" && mine.ok && !W.c("copy-b"),
    J({ byHand: code(byHand), r: code(r), script: r.script, sponsor: scr?.body?.sponsor, trigger: scr?.body?.trigger, change: ch?.actor, notMine: code(notMine), mine: code(mine) }));
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed${RED ? `  (RED=${RED}: that check is expected red)` : ""}`);
process.exit(failed ? 1 : 0);
