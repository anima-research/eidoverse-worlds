// tools/protocol/reachgate-check.ts — touch consent on the REAL path (design review 10-15, "spec vs code" item 1). A reach
// streams as a descriptor inside the presence packet (shared/reachwire.js); the relay (server/messages.ts "pose") is the one
// place every packet passes, so that is where a hand on another body is held to that body's table: the real World, its real
// authority (consent verb, reach verb, the presence plane) and the real pose handler. Nothing here is a mock of the gate.
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reachgate-check.ts
//   RG1  a stranger's hand on chest_front (both gates off): stripped from the relayed packet, the rest of the pose still
//        relays, and the reacher is told why (once per cooldown, not per frame)
//   RG2  a stranger's hand on a shoulder (touch gate off): stripped, told it is theirs to open
//   RG4  a person on the allow list: relayed, every point (an allow is every class); on the block list: it leaves at once
//   RG5  self-touch: relayed, whatever the point
//   RG6  a bare world point inside a stranger's torso: stripped; one in open air: relayed
//   RG7  a point in a stranger's own frame: inside them stripped, beside them relayed
//   RG8  a hand toward someone who isn't here: stripped (it would land on whoever arrives under the name)
//   RG9  the target opens touch: the reach verb's touch relays; closing it ends it again
//   RG10 the target is never told about a stripped reach as a touch, and nothing is appended to the log
// The asks (RG11–RG13, RG15–RG17, RL3) went with the ask (R 10-28; branch archive/consent-ask keeps them).
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
import { tryUntil, pause } from "./wait.ts";
const root = scratch("reachgate");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
process.env.JOIN_TOKEN ??= "test-door";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const { foundWorld } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
const { MESSAGES } = await import("../../server/messages.ts");
const { REACH_NOTE_MS, refusalWords } = await import("../../shared/protocol/consent.js");
let pass = 0, fail = 0;
const ok = (c, what, d?) => { if (c) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}${d !== undefined ? " — " + JSON.stringify(d).slice(0, 500) : ""}`); } };

const OWNER = foundWorld(path.join(process.env.WORLDS_DIR, "touch"), "touch", "olive").owner;
const w = new World("touch");
const A = (k) => "u-" + k.repeat(20);   // actor ids in the directory's shape
const people = {};
function person(id, key, at) {
  const c = { id, actorId: A(key), world: w, ws: null, lastPose: null, spectator: false, surface: "world", avatar: "", got: [] };
  c.ws = { send: (d) => c.got.push(JSON.parse(d)) };
  w.clients.add(c); people[id] = c;
  w.log.requestSync(c.actorId, "consent", { touch: false });   // the gate's mechanics run against touch off, set explicitly (never by leaning on the default)
  const mv = w.log.requestSync(c.actorId, "move", { to: at }); if (!mv?.ok) console.log("  (debug) move", id, JSON.stringify(mv));   // the authority's body (the reach verb needs one)
  pose(c, { p: at, yaw: 0 });
  return c;
}
function pose(c, p) { w.dirty.delete(c.id); MESSAGES["pose"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { type: "pose", pose: structuredClone(p) }); return w.dirty.get(c.id); }
const reachTo = (c, t, extra = {}) => pose(c, { p: c.lastPose?.p ?? [0, 0, 0], yaw: 0, reach: { rightHand: { t } }, ...extra });
const refusals = (c, k = 0) => c.got.slice(k).filter((m) => m.type === "body-inbox").flatMap((m) => m.messages).filter((m) => m.type === "reach-refused");
const req = (c, verb, args) => w.log.requestSync(c.actorId, verb, args);

const vic = person("Vic", "v", [0, 0, 0]), sly = person("Sly", "s", [0.6, 0, 0]);
const tom = person("Tom", "t", [-0.6, 0, 0]);
const ann = person("Ann", "a", [5, 0, 0]), bob = person("Bob", "b", [5.6, 0, 0]);
const head0 = w.log.head;

// RG1 (Vic's gates set, never by leaning on a default)
{ const sw = req(vic, "consent", { move: false, touch: false }); ok(sw?.ok, "(RG1 setup) Vic turns both gates off", sw);
  const k = sly.got.length, kv = vic.got.length;
  const out = reachTo(sly, { who: "Vic", point: "chest_front" });
  ok(out && !out.reach, "RG1 a stranger's hand on Vic's chest_front is stripped from the relayed packet", out);
  ok(out && Array.isArray(out.p) && out.p[0] === 0.6 && sly.lastPose && !sly.lastPose.reach, "RG1 …the rest of the pose still relays, and what joiners are handed is stripped too", { out, last: sly.lastPose });
  const r = refusals(sly, k);
  ok(r.length === 1 && r[0].class === "intimate" && r[0].to === vic.actorId && /nobody|isn't taking/.test(r[0].why), "RG1 …and Sly is told why, through the body inbox", sly.got.slice(k));
  const k2 = sly.got.length;
  for (let i = 0; i < 5; i++) reachTo(sly, { who: "Vic", point: "chest_front" });
  ok(refusals(sly, k2).length === 0 && !reachTo(sly, { who: "Vic", point: "chest_front" })?.reach, "RG1 …once per cooldown, not once per frame (and every frame is still stripped)", sly.got.slice(k2));
  ok(!vic.got.slice(kv).some((m) => m.type === "body-inbox" && m.messages.some((x) => x.type === "body")), "RG10 Vic is never told she was touched", vic.got.slice(kv)); }

// RG2
{ req(vic, "consent", { move: true, touch: false }); const k = sly.got.length;
  const out = reachTo(sly, { who: "Vic", point: "shoulder_l" });
  const r = refusals(sly, k);
  ok(out && !out.reach, "RG2 a stranger's hand on Vic's shoulder (Vic: touch off, move on) is stripped", out);
  ok(r.length === 1 && r[0].class === "touch" && r[0].fix === "leave it be: it is theirs to open" && !/ask/.test(JSON.stringify(r[0])), "RG2 …and Sly is told it is Vic's to open (nothing asks)", r); }

// RG3 RETIRED (recut A2, 10-20): it tested the friends tier, which is gone.
// RG4
{ const r = req(vic, "consent", { allow: sly.actorId });
  ok(r?.ok, "(RG4 setup) Vic puts Sly on her allow list (her touch gate stays off)", r);
  const out = reachTo(sly, { who: "Vic", point: "hand_r" });
  ok(out?.reach?.rightHand?.t?.point === "hand_r", "RG4 an allowed person: Sly's hand on Vic's hand relays though her touch gate is off", out);
  const out2 = reachTo(sly, { who: "Vic", point: "chest_front" });
  ok(out2?.reach?.rightHand?.t?.point === "chest_front", "RG4 …an allow is every class: intimate too (R 10-28: always yes)", out2);
  const out3 = reachTo(tom, { who: "Vic", point: "hand_r" });
  ok(out3 && !out3.reach, "RG4 …and only for Sly: Tom's hand is still stripped", out3);
  // RG25 (review of #260): a touch the table allowed (no body-revoked: nothing was granted) leaves Sly's
  // standing pose the moment Vic's table closes, and the server's re-hold isn't told to Sly as an attempt of his
  reachTo(sly, { who: "Vic", point: "hand_r" });
  const ks = sly.got.length;
  req(vic, "consent", { block: sly.actorId });
  ok(!sly.lastPose?.reach && w.dirty.has(sly.id) && !w.dirty.get(sly.id)?.reach, "RG25 a table-allowed touch leaves the standing pose and the next frame when Vic blocks Sly", { last: sly.lastPose?.reach, dirty: w.dirty.get(sly.id)?.reach });
  ok(refusals(sly, ks).length === 0, "RG25 …without a refusal said to Sly for a packet he didn't send", sly.got.slice(ks));
  req(vic, "consent", { touch: true }); const out4 = reachTo(sly, { who: "Vic", point: "hand_r" });
  ok(out4 && !out4.reach, "RG4b a block beats Vic's touch gate on: Sly's hand is still stripped", out4);
  req(vic, "consent", { touch: false }); req(vic, "consent", { unlist: sly.actorId }); }

// RT (parity with main, localbody.js:371/:381: the target was told "X tried to knock you over"): a refused act on my body is
// said to ME once per asker per C.TRIED_NOTE_MS, in the body inbox, naming who and which gate; never more often
{ const told = (c, k) => c.got.slice(k).filter((m) => m.type === "body-inbox").flatMap((m) => m.messages).filter((m) => m.type === "body-refused");
  const rav = person("Rav", "rv", [0, 0, 20]), ike = person("Ike", "ik", [0.6, 0, 20]);
  req(rav, "consent", { move: false, touch: false }); const k = rav.got.length, ki = ike.got.length;
  MESSAGES["puppet"]({ c: ike, ws: ike.ws, now: Date.now(), expel: () => {} }, { type: "puppet", target: "Rav", ragdoll: true });
  const t1 = told(rav, k);
  ok(t1.length === 1 && t1[0].from === ike.actorId && t1[0].gate === "move" && t1[0].class === "shove", "RT1 Ike's refused knock-over is said to Rav, once: who, and that it was her move gate", rav.got.slice(k));
  for (let i = 0; i < 4; i++) MESSAGES["puppet"]({ c: ike, ws: ike.ws, now: Date.now(), expel: () => {} }, { type: "puppet", target: "Rav", ragdoll: true });
  reachTo(ike, { who: "Rav", point: "shoulder_l" }); req(ike, "body", { to: rav.actorId, kind: "pose" });
  ok(told(rav, k).length === 1, "RT2 …and not again from Ike within the cooldown, whatever he tries (more shoves, a hand, the body verb): it can't be spammed", told(rav, k));
  const k2 = rav.got.length; reachTo(tom, { who: "Rav", point: "shoulder_l" });
  const t3 = told(rav, k2);
  ok(t3.length === 1 && t3[0].from === tom.actorId && t3[0].gate === "touch", "RT3 another asker (Tom's refused hand) is said once of its own, as touch", rav.got.slice(k2));
  ok(told(ike, ki).length === 0 && !JSON.stringify(ike.got.slice(ki)).includes("body-refused"), "RT4 the asker is never sent the target's notice: none of Ike's tries above told him anything of Rav's", ike.got.slice(ki)); }

// RG5
{ const out = reachTo(sly, { who: "Sly", point: "chest_front" });
  ok(out?.reach?.rightHand?.t?.who === "Sly", "RG5 self-touch relays", out);
  const out2 = reachTo(sly, { p: [0, 1.2, 0.05], space: "self" });
  ok(out2?.reach?.rightHand?.t?.space === "self", "RG5 …a point in your own frame, inside you, too", out2); }

// RG6
{ const out = reachTo(sly, { p: [0.02, 1.2, 0.05] });
  ok(out && !out.reach, "RG6 a bare world point inside Vic's torso is stripped", out);
  const out2 = reachTo(sly, { p: [2.5, 1.2, 2.5] });
  ok(Array.isArray(out2?.reach?.rightHand?.t?.p), "RG6 …one in open air relays", out2);
  const out3 = reachTo(sly, { p: [-0.62, 1.2, 0.05], space: "self" });   // Sly stands at x 0.6, yaw 0: that is Vic's middle
  ok(out3 && !out3.reach, "RG6 …and a point in Sly's own frame that lands inside Vic is stripped", out3); }

// RG7
{ const out = reachTo(sly, { p: [0, 1.2, 0.05], space: "Vic" });
  ok(out && !out.reach, "RG7 a point in Vic's own frame, inside her, is stripped", out);
  const out2 = reachTo(sly, { p: [0, 1.2, 2], space: "Vic" });
  ok(out2?.reach?.rightHand?.t?.space === "Vic", "RG7 …one two metres in front of her relays", out2); }

// RG8
{ const out = reachTo(sly, { who: "Nobody", point: "chest_front" });
  ok(out && !out.reach, "RG8 a hand toward someone who isn't here is stripped", out); }

// RG21 (review of #260): a point in one body's frame is drawn where it lands in the world (reachnet.js resolves it
// in their frame), so a point given in Vic's frame that rests inside Tom is held to Tom's table
{ const out = reachTo(sly, { p: [-0.62, 1.2, 0.05], space: "Vic" });   // Vic stands at the origin, yaw 0: that is Tom's middle
  ok(out && !out.reach, "RG21 a point in Vic's frame that lands inside Tom is stripped", out);
  const out2 = reachTo(sly, { p: [0, 1.2, 2], space: "Vic" });
  ok(out2?.reach?.rightHand?.t?.space === "Vic", "RG21 …one in Vic's frame in open air still relays", out2); }

// RG22 (review of #260): receivers turn a body by its pose's q when it has one (remotes.js), so the gate does too.
// Sly at x 0.6, turned half round by q while yaw stays 0: her own +x is the world's -x, so [0.62, 1.2, 0.05] is Vic's middle
{ const out = reachTo(sly, { p: [0.62, 1.2, 0.05], space: "self" }, { q: [0, 1, 0, 0] });
  ok(out && !out.reach, "RG22 a point in Sly's own frame, turned by q, that lands inside Vic is stripped", out);
  pose(sly, { p: [0.6, 0, 0], yaw: 0 }); }

// RG10 (everything above went through the relay only)
ok(w.log.head === head0, "RG10 nothing about a reach is appended to the log", w.log.live.entries.slice(head0 + 1).map((e) => e.verb));


// RG9 (Tom: a stranger neither of Vic's lists names)
{ req(vic, "consent", { touch: true });
  const r = req(tom, "reach", { who: vic.actorId, point: "upper_back" });
  ok(r?.ok && r.outcome === "allowed", "(RG9 setup) Vic opens touch; Tom reaches for her through the authority's reach verb", r);
  const out = reachTo(tom, { who: "Vic", point: "upper_back" });
  ok(out?.reach?.rightHand?.t?.point === "upper_back", "RG9 a touch Vic's open gate admits relays", out);
  const k = tom.got.length;   // from before the change: the revocation is what Tom hears, whenever it reaches him
  req(vic, "consent", { touch: false });
  // review of #260: the hand already resting on her leaves at once, from the pose joiners are handed and the
  // next frame, without Tom sending another packet
  ok(!tom.lastPose?.reach && w.dirty.has(tom.id) && !w.dirty.get(tom.id)?.reach, "RG24 …and the hand Tom already holds there leaves his standing pose and the next frame at once", { last: tom.lastPose?.reach, dirty: w.dirty.get(tom.id)?.reach });
  const heard = tom.got.slice(k).filter((m) => m.type === "body-inbox").flatMap((m) => m.messages);
  ok(heard.filter((m) => m.type === "body-revoked").length === 1 && heard.filter((m) => m.type === "reach-refused").length === 0, "RG24 …and Tom hears the revocation once, and no refusal for a packet he didn't send", heard);
  const out2 = reachTo(tom, { who: "Vic", point: "upper_back" });
  ok(out2 && !out2.reach, "RG9 …and Vic closing touch ends it at the relay too", out2); }

const live = w.log.live, wall = live.now; let skew = 0; live.now = () => wall() + skew;   // restored after RG14
const rf = (r) => (r?.ok === false ? r.refused ?? r : r);
const shoulder = (c, who) => reachTo(c, { who, point: "shoulder_l" });
const idle = (c) => pose(c, { p: c.lastPose?.p ?? [0, 0, 0], yaw: 0 });
// ---- F5: every contact point is classed by the reach verb as the relay classes it ----
{ const { CONTACT_POINTS } = await import("../../shared/contact.js");
  const fay = person("Fay", "f", [0, 0, 10]), gil = person("Gil", "g", [0.6, 0, 10]);
  req(gil, "consent", { touch: false });   // every point refused, so both the verb and the relay say the class they judged
  const bad = [];
  for (const point of Object.keys(CONTACT_POINTS)) {
    const v = rf(req(fay, "reach", { who: gil.actorId, point }));
    const verbCls = v?.code === "consent" ? v.class : `not refused for consent: ${v?.code}: ${v?.reason}`;
    skew += REACH_NOTE_MS + 1; const k = fay.got.length;   // past the once-per-class note, so the relay says this point's class
    reachTo(fay, { who: "Gil", point }); idle(fay);
    const relayCls = refusals(fay, k)[0]?.class ?? "relayed";
    if (verbCls !== relayCls) bad.push({ point, verb: verbCls, relay: relayCls }); }
  ok(Object.keys(CONTACT_POINTS).length === 27 && bad.length === 0, "RG14 each of the 27 contact points: the reach verb's class is the relay's (one classifier)", bad); }
live.now = wall;

// ---- consent refusals don't say WHY to the asker (10-13 consent research; coordinator 10-15) ----
const lu = person("Lu", "l", [0, 0, -10]), mo = person("Mo", "m", [0.6, 0, -10]);
const ned = person("Ned", "n", [-0.6, 0, -10]), kit = person("Kit", "k", [0.3, 0, -9.5]);
const said = () => { const v = rf(req(lu, "reach", { who: mo.actorId, point: "chest_front" })); const g = w.log.reachAdmits(lu.actorId, mo.actorId, "intimate", { point: "chest_front" });
  const k = lu.got.length; MESSAGES["puppet"]({ c: lu, ws: lu.ws, now: Date.now(), expel: () => {} }, { type: "puppet", target: "Mo", pose: { head: [0, 0, 0, 1] } });
  const puppet = lu.got.slice(k).find((m) => m.type === "error")?.error;   // the relay's own puppet path (server/messages.ts bodyRefusal), not the authority's body verb
  return { verb: v?.reason, verbFix: v?.fix, relay: g.reason, relayFix: g.fix, pose: rf(req(lu, "body", { to: mo.actorId, kind: "pose" }))?.reason, puppet }; };
let tierNobody, perPerson;   // the two ways to be refused: a gate off, and a block
{ req(mo, "consent", { touch: false }); tierNobody = said();
  req(mo, "consent", { touch: true });
  req(mo, "consent", { block: lu.actorId });
  perPerson = said();
  const same = (k) => tierNobody[k] === perPerson[k] && typeof perPerson[k] === "string";
  ok(same("verb") && same("verbFix"), "RL1 the reach verb's refusal is byte-identical for a closed touch gate and a block", { tierNobody, perPerson });
  ok(same("relay") && same("relayFix"), "RL1 …so is what the relay tells a stripped reacher", { tierNobody, perPerson });
  ok(same("pose"), "RL1 …and the body verb's (pose)", { tierNobody, perPerson });
  ok(same("puppet") && perPerson.puppet === refusalWords("Mo", "pose"), "RL1 …and the relay's puppet path (posing someone: server/messages.ts bodyRefusal) says the one uniform sentence", { tierNobody, perPerson, want: refusalWords("Mo", "pose") });
  ok(![tierNobody, perPerson].some((s) => /gate|never allows|block|from Lu|u-l|from you|their consent|is off/.test(JSON.stringify(s))), "RL1 …neither mentions a gate or a block", perPerson);
  const att = rf(req(mo, "consent", {}))?.attempts ?? [];
  ok(att.some((a) => /never allows/.test(a.why ?? "")) && att.some((a) => /touch gate is off/.test(a.why ?? "")),
    "RL2 Mo's own attempt ring still records the real cause of each", att.map((a) => a.why)); }

// RG23 (review of #260): pulling a nail (unpin) and a drag's stream are held to the target's displace consent (her move
// gate) like the grab is; the agent runtime applies an unpin on the word that the server checked it
{ req(vic, "consent", { move: false });
  const drag = (m) => MESSAGES["bodydrag"]({ c: sly, ws: sly.ws, now: Date.now(), expel: () => {} }, { type: "bodydrag", target: "Vic", ...m });
  const kv = vic.got.length, ks = sly.got.length;
  drag({ unpin: { joint: "hand_l" } }); drag({ pose: { p: [0, 1, 0] } });
  const reached = vic.got.slice(kv).filter((m) => m.type === "bodydrag");
  ok(reached.length === 0, "RG23 with Vic's move gate off, Sly's unpin and drag samples never reach her", reached);
  ok(sly.got.slice(ks).some((m) => m.type === "error"), "RG23 …and Sly is told the unpin was refused", sly.got.slice(ks));
  drag({ end: true });
  ok(vic.got.slice(kv).some((m) => m.type === "bodydrag" && m.end != null), "RG23 …an end still goes through", vic.got.slice(kv));
  // RG23b (house 6340433633 Q3): an unpin riding an end is checked too; the end goes through without it
  const kv2 = vic.got.length, ks2 = sly.got.length;
  drag({ end: true, unpin: { joint: "hand_l" } });
  const got2 = vic.got.slice(kv2).filter((m) => m.type === "bodydrag");
  ok(got2.length === 1 && got2[0].end != null && got2[0].unpin === undefined && sly.got.slice(ks2).some((m) => m.type === "error"),
    "RG23b an unpin sent with an end is refused like any unpin (Sly is told); the end still reaches Vic, without it", { got2, sly: sly.got.slice(ks2) });
  // RG23c (review of the house fixes): a nail (pinAt) riding an end is the same act: refused, dropped, the end goes bare
  const kv3 = vic.got.length, ks3 = sly.got.length;
  drag({ end: true, pinAt: { joint: "head", at: [0, 1.9, 0] } });
  const got3 = vic.got.slice(kv3).filter((m) => m.type === "bodydrag");
  ok(got3.length === 1 && got3[0].end != null && got3[0].pinAt === undefined && sly.got.slice(ks3).some((m) => m.type === "error"),
    "RG23c a nail (pinAt) sent with an end is refused (Sly is told); the end still reaches Vic, without it", { got3, sly: sly.got.slice(ks3) }); }

{ const drag = (m) => MESSAGES["bodydrag"]({ c: sly, ws: sly.ws, now: Date.now(), expel: () => {} }, { type: "bodydrag", target: "Vic", ...m });
  const final = { end: true, pose: { hips: [0, 0, 0, 1] }, p: [8, 0, 0], yaw: 0.7, sim: { j: ["hips"], p: [8, 1, 0], v: [0, 1, 0] } };
  req(vic, "consent", { move: true });
  const kg = vic.got.length; drag({ grab: { joint: "hips" } });
  ok(vic.got.slice(kg).some((m) => m.type === "bodydrag" && m.grab?.joint === "hips"), "Vic allows Sly's grab before closing move", vic.got.slice(kg));
  const sample = { pose: { hips: [0, 0, 0, 1] }, p: [1, 0, 0], yaw: 0.2 };
  const ks = vic.got.length; drag(sample);
  const ongoing = vic.got.slice(ks).filter((m) => m.type === "bodydrag");
  ok(ongoing.length === 1 && ongoing[0].end === undefined
    && JSON.stringify(ongoing[0].pose) === JSON.stringify(sample.pose)
    && JSON.stringify(ongoing[0].p) === JSON.stringify(sample.p) && ongoing[0].yaw === sample.yaw,
    "An allowed ongoing drag sample reaches Vic without ending the drag", ongoing);
  const ka = vic.got.length; drag(final);
  const allowed = vic.got.slice(ka).find((m) => m.type === "bodydrag");
  ok(allowed?.end === true && JSON.stringify(allowed.pose) === JSON.stringify(final.pose)
    && JSON.stringify(allowed.p) === JSON.stringify(final.p) && allowed.yaw === final.yaw
    && JSON.stringify(allowed.sim) === JSON.stringify(final.sim), "An allowed release carries the final handover", allowed);
  req(vic, "consent", { move: false });
  for (const [name, release] of [["final sample", final], ["final sample and nail", { ...final, pinAt: { joint: "hips", at: [8, 1, 0] } }]]) {
    const k = vic.got.length; drag(release);
    const got = vic.got.slice(k).filter((m) => m.type === "bodydrag");
    ok(got.length === 1 && got[0].end === true && Object.keys(got[0]).sort().join(",") === "by,byActor,end,type",
      `Once Vic closes move, Sly's ${name} becomes a bare release`, got);
  }
  const kb = vic.got.length; drag({ end: true });
  const bare = vic.got.slice(kb).filter((m) => m.type === "bodydrag");
  ok(bare.length === 1 && bare[0].end === true && Object.keys(bare[0]).sort().join(",") === "by,byActor,end,type",
    "A bare release still reaches Vic while her move gate is closed", bare);
}

// RG16c (review of the house fixes): a touch the allow list admitted is let go: once its hand has landed and leaves, it is
// no longer under way (touchedBy, and no body-revoked later for a hand that isn't there)
{ const rho = person("Rho", "h3", [-16, 0, -16]), sam = person("Sam", "j3", [-16.6, 0, -16]);
  req(rho, "consent", { allow: sam.actorId });
  ok(req(sam, "reach", { who: rho.actorId, point: "shoulder_l" })?.ok === true && !!shoulder(sam, "Rho")?.reach, "(RG16c setup) Rho allows Sam; Sam's hand lands and relays");
  const during = !!live.presence.reaches?.[sam.actorId];
  idle(sam);
  ok(during && !live.presence.reaches?.[sam.actorId], "RG16c after Sam lets go, the allowed touch is no longer under way", { during, after: live.presence.reaches?.[sam.actorId] }); }
// RR (R 10-28 13:44, "lift caps in general"): the relay forwards a puppet or a grab from any distance unless the world sets a
// range (@world.body-default.range, m); consent still decides
{ const P = await import("../../shared/protocol/physconst.js");
  const una = person("Una", "un", [40, 0, 40]), far = person("Fen", "fe", [70, 0, 40]);   // 30 m apart
  req(una, "consent", { move: true, touch: true });
  const puppet = (m) => { const k = una.got.length, kf = far.got.length; MESSAGES["puppet"]({ c: far, ws: far.ws, now: Date.now(), expel: () => {} }, { type: "puppet", target: "Una", ...m });
    return { got: una.got.slice(k).filter((x) => x.type === "puppet").length, err: far.got.slice(kf).find((x) => x.type === "error")?.error ?? null }; };
  const g = (m) => { const k = una.got.length; MESSAGES["bodydrag"]({ c: far, ws: far.ws, now: Date.now(), expel: () => {} }, { type: "bodydrag", target: "Una", grab: { joint: "hips" } }); return una.got.slice(k).filter((x) => x.type === "bodydrag").length; };
  const a = puppet({ ragdoll: true }), b = puppet({ pose: { head: [0, 0, 0, 1] } });
  ok(P.BODY_RANGE === null && a.got === 1 && b.got === 1 && g() === 1, "RR1 no range by default: Fen's knock-over, pose and grab reach Una from 30 m (her consent allows them)", { a, b, range: P.BODY_RANGE });
  const set = w.log.requestSync(OWNER, "set", { id: "@world", component: "body-default", value: { range: 5 } });
  const c = puppet({ ragdoll: true }), d = puppet({ pose: { head: [0, 0, 0, 1] } });
  ok(set?.ok && c.got === 0 && /30\.0 m away/.test(c.err ?? "") && /5 m/.test(c.err ?? "") && d.got === 0 && g() === 0, "RR2 a world that sets range 5 refuses them from 30 m, saying how far and the world's range", { set, c, d });
  pose(far, { p: [44, 0, 40], yaw: 0 });
  ok(puppet({ ragdoll: true }).got === 1, "RR3 …and forwards them within it");
  req(una, "consent", { move: false }); ok(puppet({ ragdoll: true }).got === 0, "RR4 …where consent still decides");
  w.log.requestSync(OWNER, "set", { id: "@world", component: "body-default", value: {} }); }

let skipped = null; const SKIP = Symbol("skip");
// ---- AG: an agent's reach through a real server (a real mcpl/agent.ts WorldAgent): the reply says what the world showed ----
//   AG1  a stranger agent's hand on a person's chest_front: no frame the person receives carries it, and the reach reply
//        says it wasn't shown and why (it used to say the hand was reaching)
//   AG2  once the person opens touch, a hand on their shoulder relays and the reply doesn't claim a refusal
{ const { ENGINE } = await import("./common.ts");
  const W = path.join(root, "ag"), OPT = path.join(root, "agopt"); fs.mkdirSync(W, { recursive: true }); fs.mkdirSync(OPT, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", SERVER_OPERATORS: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
  const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
  ok(r0.exitCode === 0, "(AG setup) found yard", r0.stderr.toString().slice(-300));
  let port = 9740; for (; port < 9840; port++) { try { const sv = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); sv.stop(true); break; } catch {} }
  const logf = path.join(root, "srv.log");
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  process.on("exit", () => { try { proc.kill(); } catch {} });
  let ag = null, vs = null;
  try {
    const up = !!(await tryUntil("the server answers /version", async () => (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok, { ms: 76_000, step: 150 }));
    ok(up, "(AG setup) the server is up");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.send(JSON.stringify({ type: "join", world: "yard", id: "Vic", avatar: "", replica: true }));
    await tryUntil("Vic's join is answered", () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 4000, step: 50 });
    let rn = 0; const vreq = async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      const r = await tryUntil(`the reply to Vic's ${verb}`, () => msgs.find((m) => m.type === "reply" && m.id === id), { ms: 4000, step: 50 }); return r ? r.reply : { ok: false, timeout: true }; };
    vs = ws; if (!msgs.some((m) => m.type === "snapshot")) console.log("  (debug) Vic join:", JSON.stringify(msgs).slice(0, 400));
    const vicPose = () => ws.send(JSON.stringify({ type: "pose", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle" } }));
    vicPose();
    // the agent pulls client/lib/poseclips.js, whose @pixiv/three-vrm-animation not every checkout's node_modules has: then this
    // part says SKIP (counted in the tail line, never as a pass); NODE_PATH=<a node_modules that has it> runs it
    let WorldAgent, HANDLERS;
    try { ({ WorldAgent } = await import("../../mcpl/agent.ts")); ({ HANDLERS } = await import("../../mcpl/tools.ts")); }
    catch (e) { if (!/Cannot find module/.test(String(e))) throw e; skipped = String(e).replace(/^.*Cannot find module /, "").slice(0, 120); throw SKIP; }
    ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
    await ag.connect(); await tryUntil("the agent has its cut", () => ag.cut, { ms: 3000, step: 50 });
    await tryUntil("the agent knows Vic's identity", () => ag.actorIds.get("Vic") || (vicPose(), false), { ms: 2000, step: 50 });
    ok(!!ag.actorIds.get("Vic"), "(AG setup) the agent knows Vic's identity");
    const call = (name, a = {}) => HANDLERS[name](ag, a, { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name);
    const T = (r) => r?.content?.[0]?.text ?? "";
    const seenReach = (k, point) => msgs.slice(k).some((m) => m.type === "frame" && m.poses?.Hep?.reach && JSON.stringify(m.poses.Hep.reach).includes(point));
    // AG1 (Vic's touch gate off; the agent alone is let in by her allow list in AG2)
    const sw = await vreq("consent", { touch: false }); ok(sw?.ok, "(AG1 setup) Vic turns her touch gate off", sw);
    let k = msgs.length;
    const r1 = await call("reach", { who: "Vic", point: "chest_front" }); await pause("a relayed hand on Vic's chest has had its time to arrive (none must)", 600);
    ok(!seenReach(k, "chest_front"), "AG1 Vic receives no frame carrying the agent's hand on her chest_front", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-3));
    ok(/not shown/.test(T(r1)) && /intimate/.test(T(r1)) && !ag.reaches.has("rightHand"), "AG1 the reach reply says the hand was not shown and why, and the agent stops streaming it", { text: T(r1), reaches: [...ag.reaches.keys()] });
    // AG2
    const hep = (() => { for (const m of msgs) { if (m.id === "Hep" && typeof m.actorId === "string") return m.actorId;
      for (const p of m.present ?? []) if (p.id === "Hep" && typeof p.actorId === "string") return p.actorId; } return null; })();
    const op = await vreq("consent", { allow: hep });
    ok(op?.ok, "(AG2 setup) Vic puts the agent on her allow list", { op, hep });
    k = msgs.length;
    const r2 = await call("reach", { who: "Vic", point: "shoulder_l" }); await tryUntil("Vic receives the agent's hand on her shoulder", () => seenReach(k, "shoulder_l"), { ms: 3000 });
    ok(seenReach(k, "shoulder_l"), "AG2 allowed by name, the agent's hand on Vic's shoulder relays", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-2));
    ok(!/not shown/.test(T(r2)) && ag.reaches.has("rightHand"), "AG2 …and the reply claims no refusal", T(r2));
    // AG3, AG4 RETIRED (R 10-28): they held one limb refused (intimate) beside one allowed (touch) on the same body; an allow
    // is now every class and both points are behind one gate, so one body can't refuse one hand and take the other
  } catch (e) { if (e !== SKIP) ok(false, "AG threw", String(e?.stack ?? e).slice(0, 600)); else console.log(`  SKIP AG1-AG2: the agent can't load here (${skipped}); NODE_PATH=<node_modules with it> runs them`); }
  try { ag?.close(); } catch {} try { vs?.close(); } catch {} try { proc.kill(); } catch {} }

console.log(`[reachgate-check] ${pass} passed, ${fail} failed${skipped ? ", AG skipped (agent can't load)" : ""}`); process.exit(fail ? 1 : 0);
