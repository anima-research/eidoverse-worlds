// Four gaps 26 left open (research note 34), as the SAME requests through the authority before this work (c9b4a67,
// extracted by git into .baseline-gaps/) and through today's. An attack must be accepted there and refused now; a
// guard (co-building, owner flows) must work in both. usage: bun gaps-check.js
//   G1  creator rights on keyed components (PROTOCOL §5): "the creator of this key, or an owner", a view over the log
//   G2  presence plausibility (L6, 25d M3): the authority's own track of each body; settlements check against it
//   G3  rate per actor (L7): every logged word, not only state writes
//   G4  two hands, one crate (25c L6 falsifier)
// Ported from the protocol lab's gaps-check.js @ 11db981; the "before" door (lab c9b4a67) is the control arm and runs only
// with PROTOCOL_LAB (see common.ts). usage: bun tools/protocol/gaps-check.ts
// @ts-nocheck — lab code, kept as written
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { scratch, labAt, controlNote } from "./common.ts";
import * as doorNow from "../../shared/protocol/authority.js";
import * as simNow from "../../shared/protocol/simlayer.js";
import { openWorld as openNow } from "../../server/filehost.ts";
import { fold as foldNow, readLog as readNow } from "../../shared/protocol/fold.js";
import { labClock } from "./clock.ts";

const root = scratch("gaps");
const BASE = "c9b4a67";
const B = labAt(BASE, ["door.js", "fold.js", "simlayer.js", "catalogue.js", "toolspec.js", "legacy"], "gaps");
const doors = { baseline: B ? { ...(await import(B + "authority.js")), root: B } : null, now: { ...doorNow, openWorld: openNow, root, sim: simNow } };
const nowFold = (buf) => foldNow(readNow(buf));
// a real WorldLog for G3h (delivery, not the authority's array): its config reads WORLDS_DIR at import, so it is pointed at
// scratch first, and checked (nothing above may have loaded server/config.ts with the checkout's own worlds/)
const WL_DIR = `${root}wl`; fs.mkdirSync(WL_DIR, { recursive: true }); process.env.WORLDS_DIR = WL_DIR; process.env.OPT_DIR ??= `${root}opt`; process.env.SKIP_OPT_SWEEP = "1";
const WL = await import("../../server/worldlog.ts"); const { WORLDS_DIR: WL_SEEN } = await import("../../server/config.ts");
if (WL_SEEN !== (await import("node:path")).resolve(WL_DIR)) throw new Error(`gaps G3h: server/config.ts was loaded before WORLDS_DIR pointed at scratch (${WL_SEEN})`);
let g3hRuns = 0;
const clock = labClock();
function session(d, name) {
  for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${d.root}worlds/${f}`, { force: true });
  // every call advances the authority's clock by `step` ms (default 100: a fast client)
  const call = (actor, verb, args = {}, step = 100) => { clock.advance(step);
    try { return d.request(d.openWorld(d.root, name), actor, verb, args); } catch (e) { return { crashed: `${e.constructor.name}: ${e.message}`.slice(0, 160) }; } };
  return { call, world: () => d.openWorld(d.root, name), name, root: d.root };
}
const ok = (r) => r?.ok === true, refused = (r) => r?.ok === false, code = (r) => r?.refused?.code;
const show = (r) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 80)}`);
const comp = (s, id, c) => s.call("olive", "inspect", { id }).components?.[c];
const posOf = (s, id) => JSON.stringify(s.call("olive", "inspect", { id }).world?.pos);
// owner olive, builders bob and ann, visitor vic
function cast(s) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["ann", "builder"], ["vic", "member"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
  s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "member" } });   // strangers can't build here (R 10-21: a new world's newcomers do)
}
const publishCrate = (s, who) => { s.call(who, "create", { id: `${who}-crate`, model: "crate", place: { at: [3, 3] } });
  const p = s.call(who, "publish", { from: `${who}-crate`, name: `${who}'s crate` }); return p.notes?.find((n) => n.record)?.record; };
const blueprintKey = (h) => `blueprints:${h.slice(7)}`;
const W0 = [0, 0, 0, 1], W90 = [0, 0.707, 0, 0.707];
const T0 = (pos, q = W0) => ({ pos, q, scale: [1, 1, 1] });

const cases = [
  // ---------------- G1: keyed components ----------------
  { id: "G1a", what: "a builder overwrites another builder's library entry", run(s) { cast(s); const h = publishCrate(s, "bob");
      return { attack: s.call("ann", "set", { id: "@world", component: blueprintKey(h), value: { name: "ann's now", parts: 1 } }), name: comp(s, "@world", blueprintKey(h))?.name }; },
    baseBad: (o) => ok(o.attack) && o.name === "ann's now", nowGood: (o) => code(o.attack) === "rights" && o.name === "bob's crate" },
  { id: "G1b", what: "a builder deletes another builder's library entry", run(s) { cast(s); const h = publishCrate(s, "bob");
      return { attack: s.call("ann", "delete", { id: "@world", component: blueprintKey(h) }), still: !!comp(s, "@world", blueprintKey(h)) }; },
    baseBad: (o) => ok(o.attack) && !o.still, nowGood: (o) => code(o.attack) === "rights" && o.still },
  { id: "G1c", guard: true, what: "the creator renames and then deletes their own entry; an owner deletes someone else's", run(s) { cast(s);
      const h = publishCrate(s, "bob"), h2 = publishCrate(s, "ann");
      return { rename: s.call("bob", "set", { id: "@world", component: blueprintKey(h), value: { name: "bob's box", parts: 1 } }), del: s.call("bob", "delete", { id: "@world", component: blueprintKey(h) }),
        owner: s.call("olive", "delete", { id: "@world", component: blueprintKey(h2) }) }; },
    nowGood: (o) => ok(o.rename) && ok(o.del) && ok(o.owner) },
  { id: "G1d", what: "keyed instance on an ordinary thing: ann overwrites bob's `note:bob` (her own `note:ann` is fine)", run(s) { cast(s);
      s.call("bob", "create", { id: "board", model: "crate", place: { at: [1, 1] } }); s.call("bob", "set", { id: "board", component: "t/note:bob", value: "bob was here" });
      return { own: s.call("ann", "set", { id: "board", component: "t/note:ann", value: "and ann" }), attack: s.call("ann", "set", { id: "board", component: "t/note:bob", value: "bob is a fool" }) }; },
    baseBad: (o) => ok(o.own) && ok(o.attack), nowGood: (o) => ok(o.own) && code(o.attack) === "rights" },
  { id: "G1e", what: "creator is the key's CURRENT life: bob deletes his note, ann re-sets it, bob can no longer change it", run(s) { cast(s);
      s.call("bob", "create", { id: "board", model: "crate", place: { at: [1, 1] } }); s.call("bob", "set", { id: "board", component: "t/note:x", value: "bob's" });
      s.call("bob", "delete", { id: "board", component: "t/note:x" }); const annSets = s.call("ann", "set", { id: "board", component: "t/note:x", value: "ann's" });
      return { annSets, annAgain: s.call("ann", "set", { id: "board", component: "t/note:x", value: "ann's, edited" }), bob: s.call("bob", "set", { id: "board", component: "t/note:x", value: "bob's again" }) }; },
    baseBad: (o) => ok(o.annSets) && ok(o.bob), nowGood: (o) => ok(o.annSets) && ok(o.annAgain) && code(o.bob) === "rights" },
  { id: "G1f", what: "a handler's key belongs to the handler's AUTHOR, not to the visitor who pulled it", run(s) { cast(s);
      s.call("bob", "create", { id: "lever", model: "crate", place: { at: [2, 0] } });
      s.call("bob", "set", { id: "lever", component: "reactions", value: { tag: { kind: "set", component: "t/tag:pulled", value: true } } });
      const use = s.call("vic", "use", { id: "lever", action: "tag" });
      return { use, author: s.call("bob", "set", { id: "lever", component: "t/tag:pulled", value: false }), other: s.call("ann", "delete", { id: "lever", component: "t/tag:pulled" }) }; },
    baseBad: (o) => ok(o.use) && ok(o.author) && ok(o.other), nowGood: (o) => ok(o.use) && ok(o.author) && code(o.other) === "rights" },
  { id: "G1g", what: "a library entry's `by` was a stored copy of who published it, so it could lie; now it's a view", run(s) { cast(s); const h = publishCrate(s, "bob");
      s.call("bob", "set", { id: "@world", component: blueprintKey(h), value: { name: "bob's crate", by: "olive", parts: 1 } });
      return { by: s.call("vic", "find", { kind: "blueprint" }).blueprints?.find((b) => b.hash === h)?.by }; },
    baseBad: (o) => o.by === "olive", nowGood: (o) => o.by === "bob" },
  { id: "G1h", guard: true, what: "owner flows still work: a second owner edits roles the first owner wrote; hand-over in the right order", run(s) { cast(s);
      const add = s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "owner" } });
      const edit = s.call("ann", "set", { id: "@world", component: "roles:bob", value: { role: "member" } });
      const down = s.call("olive", "set", { id: "@world", component: "roles:olive", value: { role: "builder" } });
      const bobRole = s.call("bob", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
      return { add, edit, down, bobRole, founded: !!comp(s, "@world", "roles:olive") }; },
    nowGood: (o) => ok(o.add) && ok(o.edit) && ok(o.down) && code(o.bobRole) === "rights" && o.founded },

  // ---------------- G2: presence plausibility ----------------
  { id: "G2a", what: "25d M3 as ran: walk into a sealed room, grab, step 11 m in one move, put", run(s) { cast(s);
      for (const [id, p, q] of [["wall-n", [0, 0, -2], W0], ["wall-s", [0, 0, 2], W0], ["wall-w", [-2, 0, 0], W90], ["wall-e", [2, 0, 0], W90]])
        s.call("olive", "create", { id, model: "wall", components: { transform: T0(p, q) } });
      s.call("olive", "create", { id: "loot", model: "crate", components: { transform: T0([0, 0, 0]), physics: { kind: "dynamic", who: "member" } } });
      const arrive = s.call("vic", "move", { to: [0, 0, 4] }), enter = s.call("vic", "move", { to: [0, 0, 0.4] }), grab = s.call("vic", "grab", { id: "loot" });
      const leap = s.call("vic", "move", { to: [8, 0, 8] }), put = s.call("vic", "put", { id: "loot" });
      return { arrive, enter, grab, leap, put, loot: posOf(s, "loot") }; },
    baseBad: (o) => ok(o.enter) && ok(o.grab) && ok(o.leap) && ok(o.put) && o.loot === "[8,0,8]",
    nowGood: (o) => ok(o.arrive) && code(o.enter) === "solid" && code(o.grab) === "out-of-reach" && refused(o.put) && o.loot === "[0,0,0]" },
  { id: "G2b", what: "in the open: 11 m in 100 ms while holding, then a put 'in reach' of the teleported hand", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const grab = s.call("vic", "grab", { id: "ball" });
      const leap = s.call("vic", "move", { to: [8, 0, 8] }); const put = s.call("vic", "put", { id: "ball", pos: [8, 0, 8] });
      return { grab, leap, put, ball: posOf(s, "ball") }; },
    baseBad: (o) => ok(o.leap) && ok(o.put) && o.ball === "[8,0,8]", nowGood: (o) => ok(o.grab) && code(o.leap) === "too-fast" && code(o.put) === "out-of-reach" && o.ball !== "[8,0,8]" },
  { id: "G2c", what: "leave and re-arrive INSIDE the room, where the world declares a spawn (an arrival is presence; refused ones are never recorded either)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8], radius: 2 } });
      for (const [id, p, q] of [["wall-n", [0, 0, -2], W0], ["wall-s", [0, 0, 2], W0], ["wall-w", [-2, 0, 0], W90], ["wall-e", [2, 0, 0], W90]])
        s.call("olive", "create", { id, model: "wall", components: { transform: T0(p, q) } });
      s.call("vic", "move", { to: [0, 0, 8] }); s.call("vic", "leave", {});
      const arrive = s.call("vic", "move", { to: [0, 0, 0.4] });
      const ok8 = s.call("vic", "move", { to: [0.5, 0, 8] }); const tp = s.call("vic", "move", { to: [0, 0, 0.4], teleport: true });
      const L = s.world().entries; const all = L.filter((e) => e.kind === "act" && e.actor === "vic" && e.verb === "move"); const acts = all.filter((e) => !e.body?.refused);
      // round-2 R7 recorded refused requests, but a body's track is presence: a refused move (arrival and teleport included)
      // is never recorded (review 10-06 S0-3: a client indoors wrote one every ~3 s). The accepted arrivals are acts.
      return { arrive, ok8, tp, moveActs: acts.length, refusedActs: all.filter((e) => e.body?.refused).length, recorded: acts[0]?.body?.presence ?? null }; },
    // review 10-07 M3: an arrival is presence, never logged (it was an act with where from and to); only a teleport while present is
    baseBad: (o) => ok(o.arrive), nowGood: (o) => code(o.arrive) === "spawn" && ok(o.ok8) && code(o.tp) === "spawn" && o.moveActs === 0 && o.refusedActs === 0 && !o.recorded },
  { id: "G2d", guard: true, what: "walking at a plausible speed while carrying still works, and the put records no body position (review 10-07 M3)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const grab = s.call("vic", "grab", { id: "ball" });
      const walk = [1.5, 2.5, 3.5, 4.5, 5.5].map((z) => s.call("vic", "move", { to: [0, 0, z] }, 500));
      const put = s.call("vic", "put", { id: "ball" });
      const act = s.world().entries.at(-2);
      return { grab, walk, put, ball: posOf(s, "ball"), presence: act?.body?.presence ?? null }; },
    nowGood: (o) => ok(o.grab) && o.walk.every(ok) && ok(o.put) && o.ball === "[0,0,5.5]" && o.presence === null },
  { id: "G2e", guard: true, what: "teleport while holding something (the 11 m put by another word)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" });
      const tp = s.call("vic", "move", { to: [8, 0, 8], teleport: true }); const put = s.call("vic", "put", { id: "ball", pos: [8, 0, 8] });
      return { tp, put, ball: posOf(s, "ball") }; },
    baseBad: (o) => ok(o.put) && o.ball === "[8,0,8]", nowGood: (o) => code(o.tp) === "holding" && refused(o.put) && o.ball !== "[8,0,8]" },

  // ---------------- G3: rate ----------------
  { id: "G3a", guard: true, what: "60 sets inside 10 s are fine; the 61st is refused; the window slides", run(s) { cast(s);
      s.call("bob", "create", { id: "c", model: "crate", place: { at: [0, 0] } });
      const rs = Array.from({ length: 60 }, (_, i) => s.call("bob", "set", { id: "c", component: "label", value: `n${i}` }, 50));
      const r61 = s.call("bob", "set", { id: "c", component: "label", value: "61" }, 50);
      const other = s.call("ann", "set", { id: "c", component: "label", value: "ann" }, 50);
      const later = s.call("bob", "set", { id: "c", component: "label", value: "later" }, 10000);
      return { first60: rs.filter(ok).length, r61, other, later }; },
    nowGood: (o) => o.first60 === 59 && code(o.r61) === "rate" && ok(o.other) && ok(o.later) }, // 59 + the create = 60 acts
  { id: "G3b", what: "say is unmetered: 80 lines in 8 s, all logged (now: 20 says per 10 s, a budget of their own, round-2 R6)", run(s) { cast(s);
      const rs = Array.from({ length: 80 }, (_, i) => s.call("vic", "say", { text: `spam ${i}` }));
      return { accepted: rs.filter(ok).length, first: rs.findIndex(refused), code: code(rs.find(refused)) }; },
    baseBad: (o) => o.accepted === 80, nowGood: (o) => o.accepted === 20 && o.code === "rate" },
  { id: "G3c", what: "grab/throw is unmetered: 40 throws in 8 s = 80 acts + 80 sim entries", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.3] });
      let thrown = 0, stopped = null;
      for (let i = 0; i < 40 && !stopped; i++) { const g = s.call("vic", "grab", { id: "ball" }); const t = s.call("vic", "throw", { id: "ball", v: [0, 0.5, 0] });
        if (ok(t)) thrown++; else stopped = refused(g) ? g : t; }
      const L = s.world().entries; return { thrown, stopped: stopped ? show(stopped) : null, code: code(stopped), vicActs: L.filter((e) => e.kind === "act" && e.actor === "vic").length }; },
    baseBad: (o) => o.thrown === 40, nowGood: (o) => o.thrown < 40 && o.code === "rate" && o.vicActs <= 60 },
  { id: "G3d", guard: true, what: "a visitor's `use` counts against the visitor, not the handler's author", run(s) { cast(s);
      s.call("bob", "create", { id: "door", model: "door", components: { openable: { open: false } }, place: { at: [0, 0] } }); s.call("bob", "set", { id: "door", component: "reactions", value: { open: { kind: "toggle", component: "openable", field: "open" } } });
      const uses = Array.from({ length: 61 }, () => s.call("vic", "use", { id: "door", action: "open" }, 50));
      return { accepted: uses.filter(ok).length, last: uses.at(-1), bob: s.call("bob", "set", { id: "door", component: "label", value: "front" }, 50) }; },
    nowGood: (o) => o.accepted === 60 && code(o.last) === "rate" && ok(o.bob) },

  { id: "G3e", guard: true, what: "a holder at the rate limit still settles on leaving (a disconnect is the authority's duty, not a request)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.3] }); s.call("vic", "grab", { id: "ball" });
      const says = Array.from({ length: 70 }, (_, i) => s.call("vic", "say", { text: `${i}` }, 50));
      const left = s.call("vic", "leave", {}, 50);
      return { saysRefused: says.filter(refused).length, left: show(left), dropped: left.dropped?.[0]?.ok ?? null }; },
    nowGood: (o) => o.saysRefused > 0 && o.dropped === true },
  // ---------------- G4: two hands, one crate ----------------
  { id: "G4a", what: "snatch at a distance: ann carries the ball 5 m off; bob grabs it from where the LOG last had it", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("ann", "move", { to: [0, 0, 0.5] }); s.call("ann", "grab", { id: "ball" });
      for (const z of [2, 3.5, 5, 5.5]) s.call("ann", "move", { to: [0, 0, z] }, 500);
      s.call("bob", "move", { to: [0, 0, -0.5] }); const snatch = s.call("bob", "grab", { id: "ball" });
      return { snatch, annPut: s.call("ann", "put", { id: "ball" }) }; },
    baseBad: (o) => ok(o.snatch) && refused(o.annPut), nowGood: (o) => code(o.snatch) === "out-of-reach" && ok(o.annPut) },
  { id: "G4b", guard: true, what: "two bodies lean on an unheld engine crate: no log entry, no engine change (no unlogged impulse)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "cart", model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      const n0 = s.world().entries.length; const p0 = posOf(s, "cart");
      s.call("ann", "move", { to: [-0.6, 0, 0] }); s.call("bob", "move", { to: [0.6, 0, 0] });
      const push = [["ann", [-0.1, 0, 0]], ["bob", [0.1, 0, 0]], ["ann", [0.2, 0, 0]], ["bob", [-0.2, 0, 0]]].map(([w, to]) => s.call(w, "move", { to }, 300));
      s.call("ann", "wait", {}, 3000);
      const L = s.world().entries.slice(n0); return { push, newSimOrChange: L.filter((e) => e.kind === "sim" || e.kind === "change").length, moved: posOf(s, "cart") !== p0 }; },
    nowGood: (o) => o.newSimOrChange === 0 && !o.moved },
  { id: "G4c", guard: true, what: "co-building by turns: ann carries the crate 1 m, bob carries it 1 m more; both are on the record", run(s) { cast(s);
      s.call("olive", "create", { id: "cart", model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("ann", "move", { to: [0, 0, 0.8] }); const a1 = s.call("ann", "grab", { id: "cart" }); s.call("ann", "move", { to: [0, 0, 1.8] }, 500); const a2 = s.call("ann", "put", { id: "cart" });
      s.call("bob", "move", { to: [0, 0, 2.6] }); const b1 = s.call("bob", "grab", { id: "cart" }); s.call("bob", "move", { to: [0, 0, 3.6] }, 500); const b2 = s.call("bob", "put", { id: "cart" });
      const puts = s.world().entries.filter((e) => e.kind === "act" && e.verb === "put").map((e) => e.actor);
      return { a1, a2, b1, b2, cart: posOf(s, "cart"), puts }; },
    nowGood: (o) => [o.a1, o.a2, o.b1, o.b2].every(ok) && o.cart === "[0,0,3.6]" && JSON.stringify(o.puts) === '["ann","bob"]' },
  { id: "G4d", guard: true, what: "a shared carry: bob takes hold while ann holds (what the lab does: the latest grab wins, one hand only)", run(s) { cast(s);
      s.call("olive", "create", { id: "cart", model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("ann", "move", { to: [0, 0, 0.8] }); s.call("ann", "grab", { id: "cart" }); s.call("bob", "move", { to: [0, 0, 1.3] });
      const b = s.call("bob", "grab", { id: "cart" });
      return { bob: b, takenFrom: b.notes?.find((n) => n.takenFrom)?.takenFrom ?? null, annPut: s.call("ann", "put", { id: "cart" }) }; },
    nowGood: (o) => ok(o.bob) && o.takenFrom === "ann" && code(o.annPut) === "not-holding" },

  // ---------------- R: the fresh red team's findings (note 33), folded in ----------------
  { id: "R1", what: "33 F1: a builder rewrites a ball's transform and model while it flies", run(s) { phys(s);
      s.call("bob", "move", { to: [0, 0, 0.3] }); s.call("bob", "grab", { id: "ball-2" }); s.call("bob", "throw", { id: "ball-2", v: [0, 6, 0] });
      const tr = s.call("ann", "set", { id: "ball-2", component: "transform", value: { pos: [5, 0, 5] } }, 200);
      const mo = s.call("ann", "set", { id: "ball-2", component: "model", value: "crate" }, 100);
      s.call("ann", "wait", {}, 6000);
      return { tr, mo, rests: restIds(s) }; },
    baseBad: (o) => ok(o.tr) && ok(o.mo) && !o.rests.includes("ball-2"), nowGood: (o) => code(o.tr) === "in-flight" && code(o.mo) === "in-flight" && o.rests.includes("ball-2") },
  { id: "R2a", what: "33 F2: a lock set mid-flight; then a visitor's unrelated throw never rests, and an epoch cut is 'free'", run(s) { phys(s);
      s.call("bob", "move", { to: [-2, 0, 0.3] }); s.call("bob", "grab", { id: "ball-1" }); s.call("bob", "throw", { id: "ball-1", v: [0, 6, 0] });
      const pin = s.call("ann", "set", { id: "ball-1", component: "lock", value: true }, 100);
      s.call("vic", "move", { to: [2, 0, 0.3] }, 10000); s.call("vic", "grab", { id: "ball-3" }); s.call("vic", "throw", { id: "ball-3", v: [0, 4, 0] });
      const w = s.call("vic", "wait", {}, 20000); const cut = s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: 16 } });
      return { pin, cut, rests: restIds(s), waitSaw: (w.cameToRest ?? []).map((r) => r.id) }; },
    baseBad: (o) => ok(o.pin) && ok(o.cut) && !o.rests.includes("ball-3"), nowGood: (o) => code(o.pin) === "in-flight" && ok(o.cut) && o.rests.includes("ball-1") && o.rests.includes("ball-3") },
  { id: "R2b", what: "…the same stall by another road: the table under a held ball is locked while it's held, then the ball is thrown", run(s) { phys(s);
      s.call("olive", "create", { id: "tbl", model: "table", place: { at: [0, 3] } }); s.call("bob", "move", { to: [0, 0, 2.6] }, 1000);
      s.call("olive", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { on: "tbl" } });
      const g = s.call("bob", "grab", { id: "cup" }); const pin = s.call("olive", "set", { id: "tbl", component: "lock", value: true });
      const t = s.call("bob", "throw", { id: "cup", v: [0, 2, -1] });
      s.call("vic", "move", { to: [2, 0, 0.3] }, 1000); s.call("vic", "grab", { id: "ball-3" }); s.call("vic", "throw", { id: "ball-3", v: [0, 3, 0] });
      s.call("vic", "wait", {}, 8000); s.call("vic", "wait", {}, 100);
      return { g, pin, t, rests: restIds(s) }; },
    baseBad: (o) => ok(o.g) && ok(o.pin) && ok(o.t) && !o.rests.includes("cup") && !o.rests.includes("ball-3"), nowGood: (o) => ok(o.t) && o.rests.includes("cup") && o.rests.includes("ball-3") }, // PROTOCOL §5: holding suspends parent constraints until it settles, so the throw goes and both rest (the lab refused the throw instead: note 34 #11; either way nothing stalls)
  { id: "R2c", what: "…and by a third: the cup is thrown off the table, then the TABLE is locked while the cup flies (a flying thing keeps its logged parent)", run(s) { phys(s);
      s.call("olive", "create", { id: "tbl", model: "table", place: { at: [0, 3] } }); s.call("bob", "move", { to: [0, 0, 2.6] }, 1000);
      s.call("olive", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { on: "tbl" } });
      const g = s.call("bob", "grab", { id: "cup" }); const t = s.call("bob", "throw", { id: "cup", v: [0, 3, -1] });
      const pin = s.call("olive", "set", { id: "tbl", component: "lock", value: true }, 50);
      s.call("vic", "move", { to: [2, 0, 0.3] }, 50); s.call("vic", "grab", { id: "ball-3" }); s.call("vic", "throw", { id: "ball-3", v: [0, 3, 0] });
      s.call("vic", "wait", {}, 8000); const w = s.call("vic", "wait", {}, 100);
      return { g, t, pin, rests: restIds(s), unsettled: (w.unsettled ?? []).map((u) => u.id) }; },
    baseBad: (o) => ok(o.t) && ok(o.pin) && !o.rests.includes("cup") && !o.rests.includes("ball-3"), nowGood: (o) => ok(o.t) && ok(o.pin) && o.rests.includes("cup") && o.rests.includes("ball-3") && !o.unsettled.length },
  { id: "R3", what: "33 F3: a holder demoted to member still throws a builder-only ball (launch skipped admit)", run(s) { phys(s);
      s.call("olive", "set", { id: "ball-2", component: "physics", value: { kind: "dynamic", who: "builder" } });
      s.call("bob", "move", { to: [0, 0, 0.3] }); s.call("bob", "grab", { id: "ball-2" }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "member" } });
      const put = s.call("bob", "put", { id: "ball-2" }); const thr = s.call("bob", "throw", { id: "ball-2", v: [3, 2, 0] }); const drop = s.call("bob", "drop", { id: "ball-2" });
      s.call("olive", "wait", {}, 6000);
      return { put, thr, drop, rests: restIds(s) }; },
    baseBad: (o) => refused(o.put) && ok(o.thr), nowGood: (o) => code(o.put) === "rights" && code(o.thr) === "rights" && code(o.drop) === "rights" && !o.rests.includes("ball-2") },
  { id: "R3b", guard: true, what: "…and when that demoted holder leaves, the thing settles at the last ACCEPTED state, not in their hand (L6)", run(s) { phys(s);
      s.call("olive", "set", { id: "ball-2", component: "physics", value: { kind: "dynamic", who: "builder" } });
      s.call("bob", "move", { to: [0, 0, 0.3] }); s.call("bob", "grab", { id: "ball-2" }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "member" } });
      const left = s.call("bob", "leave", {}); s.call("olive", "wait", {}, 3000);
      const w = s.world(); const ret = w.entries.filter((e) => e.kind === "act" && e.actor === "system" && e.verb === "return-held").length;
      return { left: show(left), stillHeld: !!w.presence.holds["ball-2"], returnActs: ret, ball: posOf(s, "ball-2"), carriers: doors.now.sim.simFold(w.entries, w.now()).checks.disagree.length }; },
    nowGood: (o) => o.left === "ok" && !o.stillHeld && o.returnActs === 1 && o.ball === "[0,0,0]" && o.carriers === 0 },
  { id: "R4", what: "33 F4: the authority's clock steps back (NTP slew, VM restore): it writes a decreasing ts", run(s) { cast(s);
      const keep = clock.t; clock.t = 1000000; s.call("olive", "create", { id: "c", model: "crate", place: { at: [0, 0] } }); clock.t = keep;
      const L = s.world().entries; const dec = L.findIndex((e, i) => i > 1 && e.ts < L[i - 1].ts);
      const f = nowFold(fs.readFileSync(`${s.root}worlds/${s.name}.jsonl`)); return { decreasingAt: dec, malformed: f.diagnostics.filter(([, c]) => c.startsWith("malformed")).length, c: !!f.entities?.c }; },
    baseBad: (o) => o.decreasingAt > 0, nowGood: (o) => o.decreasingAt === -1 && o.malformed === 0 && o.c },
  { id: "R5", what: "33 C1: a visitor grabs a ball an owner's book rests on; the book is moved, stamped with the visitor", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "crate", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "book", model: "book", place: { at: [0, 0] } }); const before = posOf(s, "book");
      s.call("vic", "move", { to: [0, 0, 0.8] }); const g = s.call("vic", "grab", { id: "ball" });
      const L = s.world().entries; const moved = L.filter((e) => e.kind === "change" && e.actor === "vic" && JSON.stringify(e.body).includes('"book"')).length;
      return { before, g, after: posOf(s, "book"), stateByVicOnBook: moved }; },
    baseBad: (o) => ok(o.g) && o.stateByVicOnBook > 0, nowGood: (o) => code(o.g) === "rights" && o.stateByVicOnBook === 0 && o.after === o.before },
  { id: "R6a", what: "33 C2: a small request that expands past the 1 MiB entry cap: the act is logged, its result isn't", run(s) { cast(s);
      s.call("bob", "create", { id: "fat", model: "crate", components: { "lab/blob": "x".repeat(60000) }, place: { at: [0, 0] } });
      const h = s.call("bob", "publish", { from: "fat", name: "fat" }).notes?.find((n) => n.record)?.record;
      const n0 = s.world().entries.length;
      const r = s.call("bob", "batch", { ops: Array.from({ length: 20 }, (_, i) => ({ verb: "create", args: { from: h, id: `fat-${i}` } })) });
      const L = s.world().entries.slice(n0); return { r: show(r), newActs: L.filter((e) => e.kind === "act").length, newChanges: L.filter((e) => e.kind === "change").length,
        refusedAct: L.filter((e) => e.kind === "act" && e.body?.refused?.code === "too-big").length }; },
    // never an act that claims success with no result (33 C2); since round-2 R7 the refusal itself IS recorded, as an act
    // that says it was refused (its request cut to 2 KiB), with no state
    baseBad: (o) => o.newActs === 1 && o.newChanges === 0, nowGood: (o) => /refused too-big/.test(o.r) && o.newActs === 1 && o.refusedAct === 1 && o.newChanges === 0 },
  { id: "R6b", what: "33 C2: say with 1.1 MB of text throws inside the authority instead of refusing", run(s) { cast(s);
      const r = s.call("vic", "say", { text: "y".repeat(1100000) }); return { r: show(r) }; },
    baseBad: (o) => /CRASH/.test(o.r), nowGood: (o) => /refused too-big/.test(o.r) },
  // ---------------- review 10-14 night C0/C2: the byte budget is post-paid; say.to unvalidated; the body inbox unbounded ----------------
  { id: "G3f", guard: true, what: "say.to is a short identity, never a 100 KiB payload", run(s) { cast(s);
      const r = s.call("vic", "say", { text: "hi", to: "x".repeat(100000) }); return { r: show(r), code: code(r) }; },
    nowGood: (o) => o.code === "shape" },
  { id: "G3g", guard: true, what: "one 300 KiB batch in an empty window is over the 256 KiB budget: refused, not written", run(s) { cast(s);
      s.call("bob", "create", { id: "c", model: "crate", place: { at: [0, 0] } });
      const before = s.world().entries.length;
      const r = s.call("bob", "batch", { ops: Array.from({ length: 600 }, (_, i) => ({ verb: "set", args: { id: "c", component: "description", value: `${i} ` + "d".repeat(490) } })) }, 10000);
      return { r: show(r), code: code(r), written: s.world().entries.length - before }; },
    nowGood: (o) => o.code === "rate" && o.written === 0 },
  // H1 (holes review 10-15): the cap above kept the authority's array at 200, and forwardInbox forwarded by array LENGTH,
  // so a browser that never drains its queue stuck at 200 and heard nothing more, ever (every ask to it expired "silence is
  // no"). This row reads DELIVERY: a real WorldLog (server/worldlog.ts) with a toActor sink that never calls `inbox`.
  // Mutation (must go red): forward by msgs.length again in forwardInbox, or drop the `n` stamp in authority.js inboxPush.
  { id: "G3h", guard: true, what: "300 allowed body acts: at most 200 kept in the target's inbox, and all 300 reach their socket (a browser never drains it)", run() {
      const name = `g3h-${++g3hRuns}`; const { owner } = WL.foundWorld(`${WL_DIR}/${name}`, name, "olive");
      const log = new WL.WorldLog(name); const got = [];
      log.attach({ broadcast() {}, rightsChanged() {}, debug() {}, toActor(who, msg) { if (who === "bob" && msg?.type === "body-inbox") got.push(...msg.messages); return true; } });
      const call = (actor, verb, args = {}, step = 100) => { clock.advance(step); return log.requestSync(actor, verb, args); };
      for (const [who, role] of [["bob", "builder"], ["vic", "member"]]) call(owner, "set", { id: "@world", component: `roles:${who}`, value: { role } });
      call("bob", "move", { to: [0, 0, 0] }); call("vic", "move", { to: [0.5, 0, 0] });
      const allow = call("bob", "consent", { allow: "vic" });
      const rs = Array.from({ length: 300 }, () => call("vic", "body", { to: "bob", kind: "anim" }, 10));
      const kept = log.live.presence?.inbox?.bob?.length ?? 0, sent300 = got.length;
      // an agent that polls drains it; what comes after still reaches the socket
      const drained = call("bob", "inbox", {}).messages?.length ?? -1; call("vic", "body", { to: "bob", kind: "anim" }, 10);
      return { allow: show(allow), okCount: rs.filter(ok).length, kept, delivered: sent300, afterDrain: got.length - sent300, drained,
        acts: got.filter((m) => m.type === "body" && m.from === "vic").length }; },
    nowGood: (o) => o.allow === "ok" && o.okCount === 300 && o.kept <= 200 && o.kept > 0 && o.delivered === 300 && o.acts === 301 && o.drained === o.kept && o.afterDrain === 1 },
];
function phys(s) { cast(s); s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  for (const [i, x] of [[1, -2], [2, 0], [3, 2]]) s.call("olive", "create", { id: `ball-${i}`, model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [x, 0] } }); }
const restIds = (s) => doors.now.sim.restsOf(s.world().entries).map((r) => r.id);

let bad = 0;
for (const c of cases) {
  const ob = B ? c.run(session(doors.baseline, `gap-${c.id}`)) : { control: "skipped" };
  const on = c.run(session(doors.now, `gap-${c.id}`));
  let bb, ng; try { bb = c.guard || !B ? true : !!c.baseBad(ob); } catch { bb = false; } try { ng = !!c.nowGood(on); } catch { ng = false; }
  if (!bb || !ng) bad++;
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && ("ok" in x || "crashed" in x)) ? `[${v.map(show).join(" | ")}]` : v && typeof v === "object" && ("ok" in v || "crashed" in v) ? show(v) : JSON.stringify(v)}`).join("; ");
  console.log(`${bb && ng ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${c.guard ? " (guard: must work)" : ""}\n       before: ${fmt(ob)}${bb ? "" : "   <- attack NOT accepted before"}\n       now:    ${fmt(on)}${ng ? "" : "   <- NOT as required now"}`);
}
fs.rmSync(root, { recursive: true, force: true }); if (B) fs.rmSync(B, { recursive: true, force: true });
console.log(controlNote());
console.log(`${cases.length} cases (${cases.filter((c) => c.guard).length} guards): ${bad ? `${bad} FAILED` : (B ? "every attack was accepted before and is refused now; every guard works" : "every attack is refused now; every guard works (before-door not run)")}`);
process.exit(bad ? 1 : 0);
