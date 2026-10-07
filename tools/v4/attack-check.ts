// PROTOCOL-v4 §6 proofs 2 and 3: every 25d H1 / H2 / H4 attack, run as the SAME requests through the baseline door
// (lab commit 4f62913, the control arm: only with V4_LAB, see common.ts) and through today's door. Each must succeed
// on the baseline and be refused (or harmless) now. Ported from code/v4-lab/attack-check.js @ 11db981; only paths
// and the optional control changed. usage: bun tools/v4/attack-check.ts
// @ts-nocheck — lab code, kept as written
import fs from "node:fs";
import { scratch, labAt, controlNote } from "./common.ts";
import * as doorNow from "../../shared/v4/door.js";
import * as simNow from "../../shared/v4/simlayer.js";
import { openWorld as openNow } from "../../server/v4/disk.ts";

const root = scratch("attack");
const B = labAt("4f62913", ["door.js", "fold.js", "simlayer.js", "catalogue.js", "toolspec.js", "legacy"], "attack");
const doors = { baseline: B ? { ...(await import(B + "door.js")), sim: await import(B + "simlayer.js"), root: B } : null,
  now: { ...doorNow, openWorld: openNow, sim: simNow, root } };
let T = 1800000000000;
function session(d, name) {
  for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${d.root}worlds/${f}`, { force: true });
  const call = (actor, tool, args = {}) => { T += 100; process.env.V4_NOW = String(T);
    try { return d.request(d.openWorld(d.root, name), actor, tool, args); } catch (e) { return { crashed: `${e.constructor.name}: ${e.message}`.slice(0, 120) }; } };
  return { call, world: () => d.openWorld(d.root, name), name, root: d.root };
}
const ok = (r) => r?.ok === true, crashed = (r) => !!r?.crashed, refused = (r) => r?.ok === false;
const show = (r) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 90)}`);
// a world: owner olive, builder bob, visitor vic (zed is a stranger)
function cast(s) {
  s.call("olive", "new", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
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
  // H1c was "pin bypass: set motion {type:'spin'} on a pinned thing", refused by the lab's pin. PROTOCOL-v4 §5 gave
  // `lock` v1's exact meaning, and v1's matrix (tools/locktest.ts) keeps motion open on a locked thing: a motion
  // animates it in place (v4's are pendulum/spin/bob), it doesn't relocate it. So this is a guard now: it must work.
  { id: "H1c", guard: true, what: "motion {type:'spin'} on a locked thing stays open, as in v1's lock matrix (§5; the lab's pin refused it)", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [2, 2] } }); s.call("olive", "set", { id: "statue", component: "lock", value: true });
      return { open: s.call("bob", "set", { id: "statue", component: "motion", value: { type: "spin" } }), move: s.call("bob", "set", { id: "statue", component: "transform", value: { pos: [0, 0, 0] } }) }; },
    baseBad: () => true, nowGood: (o) => ok(o.open) && o.move.refused?.code === "locked" },
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
      s.call("olive", "set", { id: "ball", component: "lock", value: true }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "none" } });
      return { grab, attack: s.call("vic", "put", { id: "ball" }), pos: look(s, "ball").components?.transform?.pos }; },
    baseBad: (o) => ok(o.grab) && ok(o.attack), nowGood: (o) => ok(o.grab) && refused(o.attack) && JSON.stringify(o.pos) === "[0,0,0]" },
  { id: "H1h2", what: "…the same, split: only the role changes between grab and put", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "none" } });
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
  { id: "H4a", what: "brick by undo: the owner undoes three times; #3 deletes @world", run(s) { cast(s);
      const u = [1, 2, 3].map(() => s.call("olive", "undo", {}));
      const newAct = s.world().entries.findIndex((e) => e.verb === "new" || e.args?.tool === "new"); // name the founding act explicitly, too
      return { u, explicit: s.call("olive", "undo", { act: newAct }), after: s.call("olive", "set", { id: "@world", component: "about", value: { name: "still mine" } }), renew: s.call("olive", "new", { title: "again" }) }; },
    baseBad: (o) => o.u.every(ok) && refused(o.after) && refused(o.renew),
    nowGood: (o) => ok(o.u[0]) && ok(o.u[1]) && refused(o.u[2]) && o.explicit.refused?.code === "founding" && ok(o.after) },
  { id: "H4b", what: "@world deleted outright by its owner", run(s) { cast(s);
      return { attack: s.call("olive", "delete", { id: "@world" }), after: s.call("olive", "look", {}), bobBuild: s.call("bob", "create", { model: "crate", place: { at: [1, 1] } }) }; },
    baseBad: (o) => ok(o.attack) && refused(o.bobBuild), nowGood: (o) => o.attack.refused?.code === "world" && ok(o.bobBuild) },
  { id: "H4c", what: "open by absence: the only owner removes her role; then a stranger and a declared visitor can build", run(s) { cast(s);
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
];

// A world whose log names no owner (an import, a hand-edited log): nobody is above visitor, whatever roles say.
function ownerless(d) {
  const name = "atk-ownerless"; for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${d.root}worlds/${f}`, { force: true });
  const s = session(d, name); s.call("olive", "new", { title: name }); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
  // rewrite the log so that olive's owner role was never there (same entries otherwise)
  const p = `${d.root}worlds/${name}.jsonl`; const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const e of lines) { for (const o of [e.args, ...(e.args?.ops ?? []).map((x) => x.args), e.body, ...(e.body?.ops ?? [])]) if (o) { if (o.components) delete o.components["roles:olive"]; if ((o.component ?? o.comp) === "roles:olive") { o.value = { role: "visitor" }; } } }
  fs.writeFileSync(p, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { bob: s.call("bob", "create", { model: "crate", place: { at: [1, 1] } }), zed: s.call("zed", "create", { model: "crate", place: { at: [2, 2] } }) };
}
attacks.push({ id: "H4f", what: "a log with no owner at all: roles:bob says builder, nobody owns", run: null,
  baseOut: () => ownerless(doors.baseline), nowOut: () => ownerless(doors.now),
  baseBad: (o) => ok(o.bob) && ok(o.zed), nowGood: (o) => o.bob.refused?.code === "rights" && o.zed.refused?.code === "rights" });

// ---- H2: the rest check verifies a copy, not the fact (P1a–d, P4), run on each door's own physics log ----
function physLog(d) {
  const s = session(d, "atk-phys"); T = 1800000000000;
  s.call("rowan", "new", { title: "p" }); s.call("rowan", "set", { id: "@world", component: "sim", value: { engine: "eidosim@0.5.0" } });
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

let bad = 0;
for (const a of attacks) {
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
const G = attacks.filter((a) => a.guard).length;
console.log(`${attacks.length + 5} attacks (${G} of them guards that must still work): ${bad ? `${bad} FAILED` : (B ? "every attack worked on the baseline (P1a: already caught there) and is refused or caught now; every guard works" : "every attack is refused or caught now (baseline not run); every guard works")}`);
process.exit(bad ? 1 : 0);
