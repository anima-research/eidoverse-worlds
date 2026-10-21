// PROTOCOL §6 proofs 2 and 3: every 25d H1 / H2 / H4 attack, run as the SAME requests through the baseline door
// (lab commit 4f62913, the control arm: only with PROTOCOL_LAB, see common.ts) and through today's door. Each must succeed
// on the baseline and be refused (or harmless) now. Ported from the protocol lab's attack-check.js @ 11db981; only paths
// and the optional control changed. usage: bun tools/protocol/attack-check.ts
// @ts-nocheck — lab code, kept as written
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { scratch, labAt, controlNote } from "./common.ts";
import * as doorNow from "../../shared/protocol/authority.js";
import * as simNow from "../../shared/protocol/simlayer.js";
import { openWorld as openNow } from "../../server/filehost.ts";

const root = scratch("attack");
const B = labAt("4f62913", ["door.js", "fold.js", "simlayer.js", "catalogue.js", "toolspec.js", "legacy"], "attack");
const doors = { baseline: B ? { ...(await import(B + "authority.js")), sim: await import(B + "simlayer.js"), root: B } : null,
  now: { ...doorNow, openWorld: openNow, sim: simNow, root } };
let T = 1800000000000;
function session(d, name) {
  for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${d.root}worlds/${f}`, { force: true });
  const call = (actor, verb, args = {}) => { T += 100; process.env.PROTOCOL_NOW = String(T);
    try { return d.request(d.openWorld(d.root, name), actor, verb, args); } catch (e) { return { crashed: `${e.constructor.name}: ${e.message}`.slice(0, 120) }; } };
  return { call, world: () => d.openWorld(d.root, name), name, root: d.root };
}
const ok = (r) => r?.ok === true, crashed = (r) => !!r?.crashed, refused = (r) => r?.ok === false;
const show = (r) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 90)}`);
// a world: owner olive, builder bob, visitor vic (zed is a stranger)
function cast(s) {
  s.call("olive", "create-world", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
  // these attacks are set in a world whose strangers can't build: since R 10-21 a NEW world's newcomers build (starter
  // config), so the cast gates newcomers to player, as an owner would
  s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "player" } });
}
const look = (s, id) => s.call("olive", "inspect", { id });

const attacks = [
  { id: "H1a", what: "lock bypass: delete a locked thing's transform", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [2, 2] } }); s.call("olive", "set", { id: "statue", component: "lock", value: true });
      const set = s.call("bob", "set", { id: "statue", component: "transform", value: { pos: [0, 0, 0] } });
      return { set, attack: s.call("bob", "delete", { id: "statue", component: "transform" }) }; },
    baseBad: (o) => refused(o.set) && ok(o.attack), nowGood: (o) => refused(o.set) && o.attack.refused?.code === "locked" },
  { id: "H1b", what: "lock bypass: delete a locked thing's model", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [2, 2] } }); s.call("olive", "set", { id: "statue", component: "lock", value: true });
      return { attack: s.call("bob", "delete", { id: "statue", component: "model" }) }; },
    baseBad: (o) => ok(o.attack), nowGood: (o) => o.attack.refused?.code === "locked" },
  // H1c was "pin bypass: set motion {type:'spin'} on a pinned thing", refused by the lab's pin. PROTOCOL §5 gave
  // `lock` v1's exact meaning, and v1's matrix (tools/locktest.ts) keeps motion open on a locked thing: a motion
  // animates it in place (today's are pendulum/spin/bob), it doesn't relocate it. So this is a guard now: it must work.
  // R 10-11 16:21: a lock now covers EVERYTHING on the thing (review C-S1-1): H1c is an attack again, refused.
  { id: "H1c", what: "motion {type:'spin'} on a locked thing (a lock covers every component, 10-11)", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [2, 2] } }); s.call("olive", "set", { id: "statue", component: "lock", value: true });
      return { open: s.call("bob", "set", { id: "statue", component: "motion", value: { type: "spin" } }), move: s.call("bob", "set", { id: "statue", component: "transform", value: { pos: [0, 0, 0] } }) }; },
    baseBad: (o) => ok(o.open), nowGood: (o) => o.open.refused?.code === "locked" && o.move.refused?.code === "locked" },
  { id: "H1d", what: "one change, two answers: `placer` refused by set, written by a visitor's use", run(s) { cast(s);
      s.call("bob", "create", { id: "bell", model: "bell", place: { at: [1, 1] } });
      const direct = s.call("bob", "set", { id: "bell", component: "placer", value: { who: "olive" } });
      s.call("bob", "set", { id: "bell", component: "reactions", value: { ring: { kind: "set", component: "placer", value: { who: "olive" } } } });
      const viaUse = s.call("vic", "use", { id: "bell", action: "ring" }); const i = look(s, "bell");
      return { direct, viaUse, madeBy: i.derived?.madeBy ?? i.components?.placer?.who }; },
    baseBad: (o) => refused(o.direct) && ok(o.viaUse) && o.madeBy === "olive", // the server-written "who made it" now lies
    nowGood: (o) => ok(o.direct) === ok(o.viaUse) && o.madeBy === "bob" }, // same answer either way; "who made it" is a view nobody can write
  { id: "H1e", what: "door DoS: a handler writes transform {pos:'stuck'}; then every look crashes", run(s) { cast(s);
      s.call("bob", "create", { id: "jam", model: "crate", place: { at: [3, 3] } });
      s.call("bob", "set", { id: "jam", component: "reactions", value: { jam: { kind: "set", component: "transform", value: { pos: "stuck" } } } });
      const attack = s.call("vic", "use", { id: "jam", action: "jam" });
      return { attack, lookAfter: s.call("zed", "look", {}), createAfter: s.call("bob", "create", { model: "crate", place: { at: [5, 5] } }) }; },
    baseBad: (o) => crashed(o.attack) && crashed(o.lookAfter) && crashed(o.createAfter),
    // the handler itself is refused when written now (shiplist R2: a handler's effect is checked at write), so the use
    // finds no 'jam' to do; either way nothing is written and every later read stands
    nowGood: (o) => ["shape", "no-action"].includes(o.attack.refused?.code) && ok(o.lookAfter) && ok(o.createAfter) },
  { id: "H1f", what: "a handler outlives its author's rights (bob demoted, vic still uses bob's handler on a thing bob can't touch now)", run(s) { cast(s);
      s.call("bob", "create", { id: "lever", model: "crate", place: { at: [4, 0] } });
      s.call("bob", "set", { id: "lever", component: "reactions", value: { yank: { kind: "set", component: "label", value: "yanked" } } });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      return { bobSet: s.call("bob", "set", { id: "lever", component: "label", value: "mine" }), attack: s.call("vic", "use", { id: "lever", action: "yank" }) }; },
    baseBad: (o) => refused(o.bobSet) && ok(o.attack), nowGood: (o) => refused(o.bobSet) && o.attack.refused?.code === "rights" },
  { id: "H1g", what: "undo ignores rank and locks: demoted bob undoes his move of a crate olive has since locked", run(s) { cast(s);
      s.call("bob", "create", { id: "crate-1", model: "crate", place: { at: [0, 0] } }); s.call("bob", "set", { id: "crate-1", component: "transform", value: { pos: [3, 0, 3] } });
      s.call("olive", "set", { id: "crate-1", component: "lock", value: true }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      const set = s.call("bob", "set", { id: "crate-1", component: "transform", value: { pos: [0, 0, 0] } });
      return { set, attack: s.call("bob", "undo", {}), pos: look(s, "crate-1").components?.transform?.pos }; },
    baseBad: (o) => refused(o.set) && ok(o.attack), nowGood: (o) => refused(o.set) && refused(o.attack) && JSON.stringify(o.pos) === "[3,0,3]" },
  { id: "H1h", what: "put checks rank and locks only at grab (time-of-check/time-of-use)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const grab = s.call("vic", "grab", { id: "ball" });
      s.call("olive", "set", { id: "ball", component: "lock", value: true }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      return { grab, attack: s.call("vic", "put", { id: "ball" }), pos: look(s, "ball").components?.transform?.pos }; },
    baseBad: (o) => ok(o.grab) && ok(o.attack), nowGood: (o) => ok(o.grab) && refused(o.attack) && JSON.stringify(o.pos) === "[0,0,0]" },
  { id: "H1h2", what: "…the same, split: only the role changes between grab and put (a builder holding a builder-only ball is demoted to player)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "builder" } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "builder" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "player" } });
      return { attack: s.call("vic", "put", { id: "ball" }) }; },
    baseBad: (o) => ok(o.attack), nowGood: (o) => o.attack.refused?.code === "rights" },
  { id: "H1h3", what: "…and only the lock changes between grab and put", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("olive", "set", { id: "ball", component: "lock", value: true });
      return { attack: s.call("vic", "put", { id: "ball" }) }; },
    baseBad: (o) => ok(o.attack), nowGood: (o) => o.attack.refused?.code === "locked" },
  { id: "H1i", what: "reserved ids through create-from: id '@x/../y'; and a dry run writes a blob", run(s) { cast(s);
      s.call("bob", "create", { id: "seed", model: "crate", place: { at: [6, 6] } }); const p = s.call("bob", "publish", { from: "seed", name: "seed" });
      const hash = p.notes?.find((n) => n.record)?.record; const store = () => fs.readdirSync(s.root + "store").length;
      const before = store(); const dry = s.call("bob", "create", { from: hash, id: "copy-1", dry: true }); const wrote = store() - before;
      return { attack: s.call("bob", "create", { from: hash, id: "@x/../y" }), dry, wrote }; },
    baseBad: (o) => ok(o.attack) && o.wrote > 0, nowGood: (o) => o.attack.refused?.code === "shape" && ok(o.dry) && o.wrote === 0 },
  { id: "L1low", what: "put of a thing that was deleted while held (an unhandled 500)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("olive", "delete", { id: "ball" });
      return { attack: s.call("vic", "put", { id: "ball" }) }; },
    baseBad: (o) => crashed(o.attack), nowGood: (o) => o.attack.refused?.code === "gone" },
  // ---- H4 (§2.3) ----
  { id: "H4a", what: "brick by undo: the owner undoes back past her cast (three grants and the newcomer gate); the next one would delete @world", run(s) { cast(s);
      const u = [1, 2, 3, 4].map(() => s.call("olive", "undo", {}));
      const newAct = s.world().entries.findIndex((e) => e.verb === "create-world" || e.args?.verb === "create-world"); // name the founding act explicitly, too
      return { u, explicit: s.call("olive", "undo", { act: newAct }), after: s.call("olive", "set", { id: "@world", component: "about", value: { name: "still mine" } }), renew: s.call("olive", "create-world", { title: "again" }) }; },
    baseBad: (o) => o.u.slice(0, 3).every(ok) && refused(o.after) && refused(o.renew),
    nowGood: (o) => ok(o.u[0]) && ok(o.u[1]) && ok(o.u[2]) && refused(o.u[3]) && o.explicit.refused?.code === "founding" && ok(o.after) },
  { id: "H4b", what: "@world deleted outright by its owner", run(s) { cast(s);
      return { attack: s.call("olive", "delete", { id: "@world" }), after: s.call("olive", "look", {}), bobBuild: s.call("bob", "create", { model: "crate", place: { at: [1, 1] } }) }; },
    baseBad: (o) => ok(o.attack) && refused(o.bobBuild), nowGood: (o) => o.attack.refused?.code === "world" && ok(o.bobBuild) },
  { id: "H4c", what: "open by absence: the only owner removes her role; then a stranger and a declared player can build", run(s) { cast(s);
      const attack = s.call("olive", "delete", { id: "@world", component: "roles:olive" });
      return { attack, zed: s.call("zed", "create", { model: "crate", place: { at: [2, 2] } }), vic: s.call("vic", "create", { model: "crate", place: { at: [3, 3] } }) }; },
    baseBad: (o) => ok(o.attack) && ok(o.zed) && ok(o.vic), nowGood: (o) => o.attack.refused?.code === "last-owner" && refused(o.zed) && refused(o.vic) },
  { id: "H4d", what: "open by absence, the other way: the only owner demotes herself to builder", run(s) { cast(s);
      const attack = s.call("olive", "set", { id: "@world", component: "roles:olive", value: { role: "builder" } });
      return { attack, zed: s.call("zed", "create", { model: "crate", place: { at: [2, 2] } }) }; },
    baseBad: (o) => ok(o.attack) && ok(o.zed), nowGood: (o) => o.attack.refused?.code === "last-owner" && refused(o.zed) },
  { id: "H4e", what: "hand-over done in the right order still works (add the new owner, then step down)", run(s) { cast(s);
      const add = s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
      const down = s.call("olive", "delete", { id: "@world", component: "roles:olive" });
      return { add, down, bobOwns: s.call("bob", "set", { id: "@world", component: "about", value: { name: "bob's now" } }) }; },
    baseBad: () => true, nowGood: (o) => ok(o.add) && ok(o.down) && ok(o.bobOwns), guard: true },
  // §7a: a use spends the rights of whoever set the handler. A handler that writes its own thing's reactions installs bob's
  // handler, not the invoker's, so a later use of the installed one still spends bob's rights.
  { id: "L7a", what: "a reaction written by a reaction keeps its author: the owner's use doesn't make the owner its author", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [3, 3] } });
      const setUp = s.call("bob", "set", { id: "box", component: "reactions", value: { evolve: { kind: "set", component: "reactions", value: { tag: { kind: "set", component: "label", value: "tagged" } } } } });
      const evolve = s.call("olive", "use", { id: "box", action: "evolve" });
      const tag = s.call("vic", "use", { id: "box", action: "tag" });
      const E = s.world().entries; const act = [...E].reverse().find((e) => e?.kind === "act" && e.verb === "use" && e.actor === "vic");
      return { setUp, evolve, tag, author: String(act?.body?.capability?.author ?? null) }; },
    baseBad: () => true, nowGood: (o) => ok(o.setUp) && ok(o.evolve) && ok(o.tag) && o.author === "bob" },
  // PROTOCOL §7a, "Revoke and the past": taking a permission away stops future acts, an undo through a handler included
  { id: "L7b", what: "undoing your own use through a handler whose who no longer admits you is refused", run(s) { cast(s);
      s.call("bob", "create", { id: "lever", model: "crate", place: { at: [-3, 3] } });
      s.call("bob", "set", { id: "lever", component: "reactions", value: { yank: { kind: "set", component: "label", value: "yanked", who: "visitor" } } });
      const use = s.call("vic", "use", { id: "lever", action: "yank" });
      const raise = s.call("bob", "set", { id: "lever", component: "reactions", value: { yank: { kind: "set", component: "label", value: "yanked", who: "builder" } } });
      return { use, raise, attack: s.call("vic", "undo", {}) }; },
    baseBad: () => true, nowGood: (o) => ok(o.use) && ok(o.raise) && refused(o.attack) },
];

// A world whose log names no owner (an import, a hand-edited log): nobody is above visitor, whatever roles say.
function ownerless(d) {
  const name = "atk-ownerless"; for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${d.root}worlds/${f}`, { force: true });
  const s = session(d, name); s.call("olive", "create-world", { title: name }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  // rewrite the log so that olive's owner role was never there (same entries otherwise)
  const p = `${d.root}worlds/${name}.jsonl`; const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const e of lines) { for (const o of [e.args, ...(e.args?.ops ?? []).map((x) => x.args), e.body, ...(e.body?.ops ?? [])]) if (o) { if (o.components) delete o.components["roles:olive"]; if ((o.component ?? o.comp) === "roles:olive") { o.value = { role: "visitor" }; } } }
  fs.writeFileSync(p, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { bob: s.call("bob", "create", { model: "crate", place: { at: [1, 1] } }), zed: s.call("zed", "create", { model: "crate", place: { at: [2, 2] } }) };
}
attacks.push({ id: "H4f", what: "a log with no owner at all: roles:bob says builder, nobody owns", run: null,
  baseOut: () => ownerless(doors.baseline), nowOut: () => ownerless(doors.now),
  baseBad: (o) => ok(o.bob) && ok(o.zed), nowGood: (o) => o.bob.refused?.code === "rights" && o.zed.refused?.code === "rights" });

// ---- H2: the rest check verifies a copy, not the fact (P1a–d, P4), run on each server's own physics log ----
function physLog(d) {
  const s = session(d, "atk-phys"); T = 1800000000000;
  s.call("rowan", "create-world", { title: "p" }); s.call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  s.call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  s.call("rowan", "move", { to: [0, 0, -0.5] }); s.call("rowan", "grab", { id: "ball" }); s.call("rowan", "throw", { id: "ball", v: [0, 2, 3] });
  T += 6000; s.call("rowan", "wait", {});
  return s.world();
}
const forgeries = {
  baseline: (w) => { const L = w.entries; const i = L.findIndex((e) => e.args?.sim?.rest); const launch = L[i].cause; const c = () => JSON.parse(JSON.stringify(L));
    const fold = (X) => doors.baseline.sim.simFold(X, w.getBlob, w.now()).checks;
    const P1a = c(); P1a[i].args.ops = P1a[i].args.ops ?? [{ verb: P1a[i].verb, args: P1a[i].args }]; // edit both copies (test M's forger)
    for (const o of P1a[i].args.ops) if (o.args.component === "transform") o.args.value.pos = [15, 0, -15]; P1a[i].args.sim.at = [15, 0, -15];
    const P1b = c(); P1b[i] = { ...P1b[i], verb: "set", args: { id: "ball", component: "transform", value: { pos: [15, 0, -15], q: [0, 0, 0, 1], scale: [1, 1, 1] } } };
    const P1c = c(); P1c[i] = { ...P1b[i], actor: "rowan", cause: L[launch].cause };
    const P1d = c(); for (const o of P1d[i].args.ops ?? [{ args: P1d[i].args }]) if (o.args.component === "transform") o.args.value.pos = [15, 0, -15];
    const P4 = c(); P4[i].args.sim.at = [9, 9, 9];
    const caught = (k) => k.disagree.length > 0;
    return { P1a: caught(fold(P1a)), P1b: caught(fold(P1b)), P1c: caught(fold(P1c)), P1d: caught(fold(P1d)),
      P4: JSON.stringify(P4[i].args.sim.at) !== JSON.stringify(doors.baseline.sim.simFold(P4, w.getBlob, w.now()).st.entities.ball.c.transform.pos) }; },
  now: (w) => { const L = w.entries; const R = doors.now.sim.restsOf(L)[0]; const i = R.seq; const c = () => JSON.parse(JSON.stringify(L));
    const fold = (X) => doors.now.sim.simFold(X, w.now()).checks; const tv = (e) => (e.body.ops ?? [e.body]).find((o) => o.comp === "transform").value;
    const P1a = c(); tv(P1a[i]).pos = [15, 0, -15]; // there is only one copy now
    const P1b = c(); P1b[i] = { world: L[i].world, kind: "change", ts: L[i].ts, actor: "sim", cause: R.cause, verb: "set", body: { id: "ball", comp: "transform", value: { ...tv(L[i]), pos: [15, 0, -15] } } };
    const P1c = c(); P1c[i] = { ...P1b[i], actor: "rowan", cause: L[R.cause].cause };
    const caught = (k) => k.disagree.length > 0;
    const P4 = c(); tv(P4[i]).pos = [9, 9, 9];
    return { P1a: caught(fold(P1a)), P1b: caught(fold(P1b)), P1c: caught(fold(P1c)), P1d: caught(fold(P1a)), // P1d (edit the value, leave the annotation) IS P1a now
      P4: JSON.stringify(doors.now.sim.restsOf(P4)[0].at) !== JSON.stringify(doors.now.sim.simFold(P4, w.now()).st.entities.ball.c.transform.pos) }; },
};

// H5 (review 10-13): a refusal must not be a read oracle. expect (§3a) is checked before the handler, so before
// admit/rights/lacks/lockCheck, and a dry request is never logged — so whatever its refusal carries is readable by
// anyone, about anything, without a trace. The value itself must not be in it.
const oracles = [
  { id: "H5a", what: "read oracle: a stranger reads a locked sign's text from a dry expect refusal", run(s) { cast(s);
      const made = s.call("olive", "create", { id: "diary", model: "crate", place: { at: [3, 3] }, components: { text: { text: "Janus's Kept Kittycat" } } });
      const locked = s.call("olive", "set", { id: "diary", component: "lock", value: true });
      // zed holds no role at all. A wrong guess must say "changed", never what it actually is.
      const probe = s.call("zed", "set", { id: "diary", component: "text", value: { text: "guess" }, dry: true, expect: [{ id: "diary", component: "text", value: { text: "guess" } }] });
      return { made, locked, probe, leaked: JSON.stringify(probe?.refused ?? {}).includes("Kittycat") }; },
    // the setup is asserted: a probe of a thing that was never made leaks nothing and proves nothing
    baseBad: (o) => o.leaked === true, nowGood: (o) => ok(o.made) && ok(o.locked) && refused(o.probe) && o.leaked === false },
  { id: "H5c", what: "read oracle: the same, through set's `base` (a direct read, not even a guess)", run(s) { cast(s);
      const made = s.call("olive", "create", { id: "diary", model: "crate", place: { at: [3, 3] }, components: { text: { text: "Janus's Kept Kittycat" } } });
      // The base a stale refusal needs is free: inspect returns `versions` for every component, and history is
      // READ_ONLY + GHOST_OK. It must be genuinely OLD (the check is lt.seq > base), so read a version, change the
      // text, and ask with the version from before: zed never needs rights to learn the new value. The lock goes on
      // LAST — a locked thing refuses even its owner's edit, so locking first would make the setup, not the door, fail.
      const v = s.call("zed", "inspect", { id: "diary" });
      const base = v?.versions?.text;
      const changed = s.call("olive", "set", { id: "diary", component: "text", value: { text: "Janus's Kept Kittycat (v2)" } });
      const locked = s.call("olive", "set", { id: "diary", component: "lock", value: true });
      const probe = s.call("zed", "set", { id: "diary", component: "text", value: { text: "x" }, base, dry: true });
      return { made, locked, changed, stale: !!base, probe, leaked: JSON.stringify(probe?.refused ?? {}).includes("Kittycat") }; },
    // asserted: a probe with a CURRENT base never reaches the stale branch and proves nothing
    baseBad: (o) => o.leaked === true, nowGood: (o) => ok(o.made) && ok(o.locked) && ok(o.changed) && o.stale && refused(o.probe) && o.leaked === false },
  { id: "H5d", what: "a 32-deep parent chain refuses as a LIMIT, not as a loop (a guard: the message must tell the truth)", guard: true, run(s) { cast(s);
      // one batch: 40 creates, then 39 parentings. The engine's own walk (`ancestors`) stops at 32, so the 33rd
      // link is refused — it is a depth limit and nothing is a cycle, which "loop" used to claim.
      const made = s.call("olive", "batch", { ops: Array.from({ length: 40 }, (_, i) => ({ verb: "create", args: { id: "n" + i, model: "crate", components: { transform: { pos: [i * 3, 0, 0] } } } })) });
      const par = s.call("olive", "batch", { ops: Array.from({ length: 39 }, (_, i) => ({ verb: "set", args: { id: "n" + (i + 1), component: "parent", value: { to: "n" + i } } })) });
      // and a REAL cycle still says loop
      const cyc = s.call("olive", "set", { id: "n0", component: "parent", value: { to: "n0" } });
      return { made, par, cyc }; },
    nowGood: (o) => ok(o.made) && o.par.refused?.code === "deep" && !/loop/.test(String(o.par.refused?.reason)) && o.cyc.refused?.code === "loop" },
  { id: "H5b", what: "and the honest conflict signal still works (a guard)", guard: true, run(s) { cast(s);
      s.call("olive", "create", { id: "lamp", model: "crate", place: { at: [4, 4] } });
      s.call("bob", "set", { id: "lamp", component: "label", value: "bob was here" });
      const r = s.call("olive", "set", { id: "lamp", component: "label", value: "mine", expect: [{ id: "lamp", component: "label", value: "stale" }] });
      return { r, says: r?.refused?.code === "changed", names: r?.refused?.by === "bob" }; },
    nowGood: (o) => o.says && o.names },
];

let bad = 0;
for (const a of [...attacks, ...oracles]) {
  const ob = !B ? { control: "skipped" } : a.run ? a.run(session(doors.baseline, `atk-${a.id}`)) : a.baseOut();
  const on = a.run ? a.run(session(doors.now, `atk-${a.id}`)) : a.nowOut();
  const bb = a.guard || !B ? true : !!a.baseBad(ob); let ng; try { ng = !!a.nowGood(on); } catch { ng = false; }
  if (!bb || !ng) bad++;
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${Array.isArray(v) && v.every((x) => x && typeof x === "object") ? `[${v.map(show).join(" | ")}]` : v && typeof v === "object" && ("ok" in v || "crashed" in v) ? show(v) : JSON.stringify(v)}`).join("; ");
  console.log(`${bb && ng ? "ok  " : "FAIL"} ${a.id.padEnd(5)} ${a.what}${a.guard ? " (a guard: must still work)" : ""}\n       baseline: ${fmt(ob)}${bb ? "" : "   <- attack did NOT work on baseline"}\n       now:      ${fmt(on)}${ng ? "" : "   <- NOT refused now"}`);
}
{ const ob = B ? forgeries.baseline(physLog(doors.baseline)) : {}, on = forgeries.now(physLog(doors.now));
  for (const k of ["P1a", "P1b", "P1c", "P1d", "P4"]) {
    const baseBad = !B ? true : k === "P1a" ? ob[k] === true /* test M's case: caught already */ : k === "P4" ? ob[k] : !ob[k];
    const good = k === "P4" ? !on[k] : on[k];
    if (k !== "P1a" && !baseBad) bad++; if (!good) bad++;
    console.log(`${(k === "P1a" || baseBad) && good ? "ok  " : "FAIL"} H2-${k.padEnd(3)} ${{ P1a: "forged rest, both copies edited (test M's forger)", P1b: "forged position as a plain set caused by the launch", P1c: "forged position as the thrower's own result of the throw act", P1d: "only the applied value edited, the annotation left honest", P4: "only the annotation edited: the wait view and the world disagree" }[k]}
       baseline: ${k === "P4" ? (ob[k] ? "view says one thing, world another" : "agree") : ob[k] ? "caught" : "NOT caught (carriers agree with a forged world)"}
       now:      ${k === "P4" ? (on[k] ? "view and world disagree" : "one value: view and world agree") : on[k] ? "caught" : "NOT caught"}`); } }
fs.rmSync(root, { recursive: true, force: true }); if (B) fs.rmSync(B, { recursive: true, force: true });
console.log(controlNote());
const G = [...attacks, ...oracles].filter((a) => a.guard).length;
console.log(`${attacks.length + oracles.length + 5} attacks (${G} of them guards that must still work): ${bad ? `${bad} FAILED` : (B ? "every attack worked on the baseline (P1a: already caught there) and is refused or caught now; every guard works" : "every attack is refused or caught now (baseline not run); every guard works")}`);
process.exit(bad ? 1 : 0);
