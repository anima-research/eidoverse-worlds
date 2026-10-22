// tools/protocol/reachgate-check.ts — touch consent on the REAL path (design review 10-15, "spec vs code" item 1). A reach
// streams as a descriptor inside the presence packet (shared/reachwire.js); the relay (server/messages.ts "pose") is the one
// place every packet passes, so that is where a hand on another body is held to that body's table: the real World, its real
// authority (consent verb, reach verb, the presence plane) and the real pose handler. Nothing here is a mock of the gate.
//   usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reachgate-check.ts
//   RG1  a stranger's hand on chest_front (Normal: strangers' intimate is nobody): stripped from the relayed packet, the rest
//        of the pose still relays, and the reacher is told why (once per cooldown, not per frame)
//   RG2  a stranger's hand on a shoulder (Normal: strangers' touch is ask): stripped, told how to ask
//   RG3  mutual friends (Normal friends: touch everyone, intimate ask): a shoulder relays, chest_front doesn't
//   RG4  a standing allow for touch: relayed
//   RG5  self-touch: relayed, whatever the point
//   RG6  a bare world point inside a stranger's torso: stripped; one in open air: relayed
//   RG7  a point in a stranger's own frame: inside them stripped, beside them relayed
//   RG8  a hand toward someone who isn't here: stripped (it would land on whoever arrives under the name)
//   RG9  an ask through the authority's reach verb, answered yes: relayed; the target closing touch ends it again
//   RG10 the target is never told about a stripped reach as a touch, and nothing is appended to the log
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
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

foundWorld(path.join(process.env.WORLDS_DIR, "touch"), "touch", "olive");
const w = new World("touch");
const A = (k) => "u-" + k.repeat(20);   // actor ids in the directory's shape
const people = {};
function person(id, key, at) {
  const c = { id, actorId: A(key), world: w, ws: null, lastPose: null, spectator: false, surface: "world", avatar: "", got: [] };
  c.ws = { send: (d) => c.got.push(JSON.parse(d)) };
  w.clients.add(c); people[id] = c;
  w.log.requestSync(c.actorId, "consent", { switch: "ask" });   // recut A2: the gate's mechanics run against "ask", set explicitly (the default is accept)
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

// RG1 (recut A2: one switch per body — the gate's mechanics are tested with Vic's switch set, never by leaning on a default)
{ const sw = req(vic, "consent", { switch: "refuse" }); ok(sw?.ok, "(RG1 setup) Vic sets her body to refuse", sw);
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
{ req(vic, "consent", { switch: "ask" }); const k = sly.got.length;
  const out = reachTo(sly, { who: "Vic", point: "shoulder_l" });
  const r = refusals(sly, k);
  ok(out && !out.reach, "RG2 a stranger's hand on Vic's shoulder (Vic: ask) is stripped", out);
  ok(r.length === 1 && r[0].class === "touch" && /reach/.test(r[0].fix ?? ""), "RG2 …and Sly is told to ask through the reach request", r); }

// RG3 RETIRED (recut A2, 10-20): it tested the friends tier, which is gone — mutual friends get the same switch as anyone.
// RG4
{ const r = req(vic, "consent", { allow: sly.actorId, class: "touch" });
  ok(r?.ok, "(RG4 setup) Vic allows Sly touch", r);
  const out = reachTo(sly, { who: "Vic", point: "hand_r" });
  ok(out?.reach?.rightHand?.t?.point === "hand_r", "RG4 a standing allow: Sly's hand on Vic's hand relays", out);
  const out2 = reachTo(sly, { who: "Vic", point: "chest_front" });
  ok(out2 && !out2.reach, "RG4 …an allow for touch is not one for intimate", out2);
  // RG25 (review of #260): a touch the table allowed (no ask, so no grant and no body-revoked) leaves Sly's
  // standing pose the moment Vic's table closes, and the server's re-hold isn't told to Sly as an attempt of his
  reachTo(sly, { who: "Vic", point: "hand_r" });
  const ks = sly.got.length;
  req(vic, "consent", { deny: sly.actorId, class: "touch" });
  ok(!sly.lastPose?.reach && w.dirty.has(sly.id) && !w.dirty.get(sly.id)?.reach, "RG25 a table-allowed touch leaves the standing pose and the next frame when the table closes", { last: sly.lastPose?.reach, dirty: w.dirty.get(sly.id)?.reach });
  ok(refusals(sly, ks).length === 0, "RG25 …without a refusal said to Sly for a packet he didn't send", sly.got.slice(ks)); }

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


// RG9 (Tom: a stranger Vic has no standing word about)
{ const r = req(tom, "reach", { who: vic.actorId, point: "upper_back" });
  ok(r?.ok && r.outcome === "asked", "(RG9 setup) Tom asks Vic through the authority's reach verb", r);
  const ans = req(vic, "consent", { answer: r.ask, yes: true });
  ok(ans?.ok && ans.yes, "(RG9 setup) Vic says yes", ans);
  const out = reachTo(tom, { who: "Vic", point: "upper_back" });
  ok(out?.reach?.rightHand?.t?.point === "upper_back", "RG9 a touch the authority's reach verb admitted (asked, yes) relays", out);
  const k = tom.got.length;   // from before the change: the revocation is what Tom hears, whenever it reaches him
  req(vic, "consent", { switch: "refuse" });
  // review of #260: the hand already resting on her leaves at once, from the pose joiners are handed and the
  // next frame, without Tom sending another packet
  ok(!tom.lastPose?.reach && w.dirty.has(tom.id) && !w.dirty.get(tom.id)?.reach, "RG24 …and the hand Tom already holds there leaves his standing pose and the next frame at once", { last: tom.lastPose?.reach, dirty: w.dirty.get(tom.id)?.reach });
  const heard = tom.got.slice(k).filter((m) => m.type === "body-inbox").flatMap((m) => m.messages);
  ok(heard.filter((m) => m.type === "body-revoked").length === 1 && heard.filter((m) => m.type === "reach-refused").length === 0, "RG24 …and Tom hears the revocation once, and no refusal for a packet he didn't send", heard);
  const out2 = reachTo(tom, { who: "Vic", point: "upper_back" });
  ok(out2 && !out2.reach, "RG9 …and Vic closing touch to nobody ends it at the relay too", out2);
  ok(refusals(tom, k).length + tom.got.slice(k).filter((m) => m.type === "body-inbox").flatMap((m) => m.messages).filter((m) => m.type === "body-revoked").length >= 1, "RG9 …and Tom hears it", tom.got.slice(k)); }

// ---- r2 holes review 10-15 F3: an ask answered yes is ONE touch, not a standing allow ----
const live = w.log.live, wall = live.now; let skew = 0; live.now = () => wall() + skew;   // restored after RG15
const rf = (r) => (r?.ok === false ? r.refused ?? r : r);
const shoulder = (c, who = "Quin") => reachTo(c, { who, point: "shoulder_l" });
const idle = (c) => pose(c, { p: c.lastPose?.p ?? [0, 0, 0], yaw: 0 });
function grant(asker, target, point = "shoulder_l") {
  skew += 61000;   // past the asker's 2-asks-a-minute
  const r = req(asker, "reach", { who: target.actorId, point });
  const ans = r?.ok && r.outcome === "asked" ? req(target, "consent", { answer: r.ask, yes: true }) : null;
  return !!ans?.ok && ans.yes === true;
}
const pat = person("Pat", "p", [10, 0, 0]), quin = person("Quin", "q", [10.6, 0, 0]);
// RG11 (a): letting go ends it
{ ok(grant(pat, quin), "(RG11 setup) Pat asks Quin for her shoulder; Quin says yes");
  idle(pat);   // a packet between the yes and the hand landing (the agent/browser is still streaming its idle pose)
  ok(shoulder(pat)?.reach?.rightHand?.t?.point === "shoulder_l", "RG11a the granted hand relays, even after a packet that came before it landed");
  ok(shoulder(pat)?.reach && shoulder(pat)?.reach, "RG11a …and keeps relaying while it is held, frame after frame");
  idle(pat);   // the hand let go
  const out = shoulder(pat);
  ok(out && !out.reach, "RG11a after Pat lets go, the same hand again is stripped: a yes was one touch", out); }
// RG12 (b): either person leaving ends it
{ ok(grant(pat, quin), "(RG12 setup) a fresh yes");
  ok(!!shoulder(pat)?.reach, "(RG12 setup) the hand relays");
  w.log.departed(pat.actorId); req(pat, "move", { to: [10, 0, 0] });   // Pat's connection left; Pat comes back
  const out = shoulder(pat);
  ok(out && !out.reach, "RG12b the reacher leaving ends the grant: back again, the hand is stripped", out);
  ok(grant(pat, quin), "(RG12 setup) another yes"); ok(!!shoulder(pat)?.reach, "(RG12 setup) relays");
  w.log.departed(quin.actorId); req(quin, "move", { to: [10.6, 0, 0] });
  const out2 = shoulder(pat);
  ok(out2 && !out2.reach, "RG12b the target leaving ends it too: when she is back, the held hand is stripped", out2); }
// RG13 (c): a change of mind is a revoke
{ ok(grant(pat, quin), "(RG13 setup) a fresh yes"); ok(!!shoulder(pat)?.reach, "(RG13 setup) relays");
  req(quin, "consent", { switch: "ask" });   // a change to another class
  ok(!!shoulder(pat)?.reach, "RG13c a change to an unrelated class of Quin's table leaves the touch she said yes to");
  req(quin, "consent", { switch: "accept" });
  ok(!!shoulder(pat)?.reach, "(RG13 setup) Quin opens touch to everyone: relays");
  req(quin, "consent", { switch: "ask" });
  const out = shoulder(pat);
  ok(out && !out.reach, "RG13c Quin going everyone → ask ends the held touch (only nobody used to)", out);
  ok(grant(pat, quin), "(RG13 setup) another yes"); ok(!!shoulder(pat)?.reach, "(RG13 setup) relays");
  }   // RG13c's friends-tier half RETIRED (recut A2): there is no friends cell to move

// ---- F5: every contact point can be asked for through the verb, classed as the relay classes it ----
{ const { CONTACT_POINTS } = await import("../../shared/contact.js");
  const fay = person("Fay", "f", [0, 0, 10]), gil = person("Gil", "g", [0.6, 0, 10]);
  req(gil, "consent", { switch: "refuse" }); req(gil, "consent", { allow: fay.actorId, class: "touch" });   // Gil refuses; a per-person allow opens touch for Fay, not intimate
  const bad = [];
  for (const point of Object.keys(CONTACT_POINTS)) {
    const v = rf(req(fay, "reach", { who: gil.actorId, point }));
    const verbCls = v?.ok ? v.class : v?.code === "consent" ? v.class : `refused ${v?.code}: ${v?.reason}`;
    const out = reachTo(fay, { who: "Gil", point }); idle(fay);
    const relayCls = out?.reach ? "touch" : "intimate";
    if (verbCls !== relayCls) bad.push({ point, verb: verbCls, relay: relayCls }); }
  ok(Object.keys(CONTACT_POINTS).length === 27 && bad.length === 0, "RG14 each of the 27 contact points can be asked for through the reach verb, and the verb's class is the relay's", bad); }

// ---- consent refusals don't say WHY to the asker (10-13 consent research; coordinator 10-15) ----
const lu = person("Lu", "l", [0, 0, -10]), mo = person("Mo", "m", [0.6, 0, -10]);
const ned = person("Ned", "n", [-0.6, 0, -10]), kit = person("Kit", "k", [0.3, 0, -9.5]);
const said = () => { const v = rf(req(lu, "reach", { who: mo.actorId, point: "chest_front" })); const g = w.log.reachAdmits(lu.actorId, mo.actorId, "intimate", { point: "chest_front" });
  const k = lu.got.length; MESSAGES["puppet"]({ c: lu, ws: lu.ws, now: Date.now(), expel: () => {} }, { type: "puppet", target: "Mo", pose: { head: [0, 0, 0, 1] } });
  const puppet = lu.got.slice(k).find((m) => m.type === "error")?.error;   // the relay's own puppet path (server/messages.ts bodyRefusal), not the authority's body verb
  return { verb: v?.reason, verbFix: v?.fix, relay: g.reason, relayFix: g.fix, pose: rf(req(lu, "body", { to: mo.actorId, kind: "pose" }))?.reason, puppet }; };
let tierNobody, perPerson;   // recut A2: the two ways to be refused are my switch (refuse) and a never for one person; a pause is gone (it was switch: refuse)
{ req(mo, "consent", { switch: "refuse" }); tierNobody = said();
  req(mo, "consent", { switch: "accept" });
  req(mo, "consent", { deny: lu.actorId, class: "intimate" }); req(mo, "consent", { deny: lu.actorId, class: "pose" });
  perPerson = said();
  const same = (k) => tierNobody[k] === perPerson[k] && typeof perPerson[k] === "string";
  ok(same("verb") && same("verbFix"), "RL1 the reach verb's refusal is byte-identical for a refuse switch and a per-person never", { tierNobody, perPerson });
  ok(same("relay") && same("relayFix"), "RL1 …so is what the relay tells a stripped reacher", { tierNobody, perPerson });
  ok(same("pose"), "RL1 …and the body verb's (pose)", { tierNobody, perPerson });
  ok(same("puppet") && perPerson.puppet === refusalWords("Mo", "pose"), "RL1 …and the relay's puppet path (posing someone: server/messages.ts bodyRefusal) says the one uniform sentence", { tierNobody, perPerson, want: refusalWords("Mo", "pose") });
  ok(![tierNobody, perPerson].some((s) => /refuse|said no|strangers|friends|from Lu|u-l|from you|their consent|set to/.test(JSON.stringify(s))), "RL1 …neither mentions the switch, a per-person no, or a tier", perPerson);
  const att = rf(req(mo, "consent", {}))?.attempts ?? [];
  ok(att.some((a) => /said no/.test(a.why ?? "")) && att.some((a) => /set to refuse/.test(a.why ?? "")),
    "RL2 Mo's own attempt ring still records the real cause of each", att.map((a) => a.why)); }

// RG23 (review of #260): pulling a nail (unpin) and a drag's stream are held to the target's displace consent
// like the grab is; the agent runtime applies an unpin on the word that the server checked it
{ req(vic, "consent", { switch: "refuse" });
  const drag = (m) => MESSAGES["bodydrag"]({ c: sly, ws: sly.ws, now: Date.now(), expel: () => {} }, { type: "bodydrag", target: "Vic", ...m });
  const kv = vic.got.length, ks = sly.got.length;
  drag({ unpin: { joint: "hand_l" } }); drag({ pose: { p: [0, 1, 0] } });
  const reached = vic.got.slice(kv).filter((m) => m.type === "bodydrag");
  ok(reached.length === 0, "RG23 with Vic's displace at deny, Sly's unpin and drag samples never reach her", reached);
  ok(sly.got.slice(ks).some((m) => m.type === "error"), "RG23 …and Sly is told the unpin was refused", sly.got.slice(ks));
  drag({ end: true });
  ok(vic.got.slice(kv).some((m) => m.type === "bodydrag" && m.end != null), "RG23 …an end still goes through", vic.got.slice(kv));
  // RG23b (house 6340433633 Q3): an unpin riding an end is checked too; the end goes through without it
  const kv2 = vic.got.length, ks2 = sly.got.length;
  drag({ end: true, unpin: { joint: "hand_l" } });
  const got2 = vic.got.slice(kv2).filter((m) => m.type === "bodydrag");
  ok(got2.length === 1 && got2[0].end != null && got2[0].unpin === undefined && sly.got.slice(ks2).some((m) => m.type === "error"),
    "RG23b an unpin sent with an end is refused like any unpin (Sly is told); the end still reaches Vic, without it", { got2, sly: sly.got.slice(ks2) }); }

// ---- (the clock moves on from here: asks are at most 2 a minute) ----
// RL3: an ask answered no and an ask nobody answered read the same to the asker, and the same as a refusal
{ req(mo, "consent", { switch: "ask" });
  const a1 = req(ned, "reach", { who: mo.actorId, point: "chest_front" }); req(ned, "inbox", {});
  req(mo, "consent", { answer: a1.ask, yes: false });
  const noWhy = (req(ned, "inbox", {}).messages ?? []).find((m) => m.type === "body-reply")?.why;
  const a2 = req(kit, "reach", { who: mo.actorId, point: "chest_front" }); req(kit, "inbox", {});
  skew += 21000; req(mo, "consent", {});   // any request expires asks past their 20 s
  const silentWhy = (req(kit, "inbox", {}).messages ?? []).find((m) => m.type === "body-reply")?.why;
  ok(a1?.outcome === "asked" && a2?.outcome === "asked" && typeof noWhy === "string" && noWhy === silentWhy && noWhy === tierNobody.verb,
    "RL3 'said no' and 'no answer' tell the asker the same words, and the same as a refusal", { noWhy, silentWhy, refusal: tierNobody.verb }); }
// RG15 (d): a TTL backstops all of the above
{ const rae = person("Rae", "r", [10, 0, 10]), zed = person("Zed", "z", [10.6, 0, 10]);
  ok(grant(rae, zed), "(RG15 setup) Rae asks Zed; Zed says yes");
  ok(!!shoulder(rae, "Zed")?.reach, "(RG15 setup) relays");
  skew += 9 * 60000; ok(!!shoulder(rae, "Zed")?.reach, "RG15d still held 9 min on: relays");
  skew += 60000 + 1000; const out = shoulder(rae, "Zed");
  ok(out && !out.reach, "RG15d past 10 min the grant has lapsed even though the hand never let go: stripped (ask again)", out); }
// RG16: a cached reach grant ends no later than the timed allowance it came from
{ const uma = person("Uma", "h", [-10, 0, -10]), val = person("Val", "j", [-10.6, 0, -10]);
  ok(req(uma, "consent", { allow: val.actorId, class: "touch", for: 60000 })?.ok === true, "(RG16 setup) Uma allows Val touch for a minute");
  const asked = req(val, "reach", { who: uma.actorId, point: "shoulder_l" });   // the reach verb delivers and caches the relay's grant
  ok(asked?.ok === true && !!shoulder(val, "Uma")?.reach, "RG16 within the minute Val's reach is delivered and the hand relays", asked);
  skew += 61000; const out = shoulder(val, "Uma");
  ok(out && !out.reach, "RG16 past the minute it is stripped: the grant ended with the allowance", out); }
// RG16b: a yes to an ask asked after an allowance ran out is that yes, not the old allowance's end (review of #260, house
// 6340433633 Q1: the cap read the stale allowance and ended the fresh yes at once)
{ const ola = person("Ola", "h2", [-14, 0, -14]), pim = person("Pim", "j2", [-14.6, 0, -14]);
  req(ola, "consent", { switch: "ask" });
  ok(req(ola, "consent", { allow: pim.actorId, class: "touch", for: 60000 })?.ok === true, "(RG16b setup) Ola allows Pim touch for a minute, and asks everyone else");
  ok(grant(pim, ola), "(RG16b setup) past that minute Pim's reach is an ask, and Ola says yes");
  const out = shoulder(pim, "Ola");
  ok(!!out?.reach, "RG16b the yes stands: the hand relays (the run-out allowance doesn't end it)", out); }
// RG17: an ask's id names it alone, even when another ask made in the same millisecond was answered first
{ const wes = person("Wes", "k", [-12, 0, -12]), xa = person("Xa", "l", [-12.6, 0, -12]), yo = person("Yo", "m", [-11.4, 0, -12]), zu = person("Zu", "n", [-12, 0, -11.4]);
  req(wes, "consent", { switch: "ask" });
  const t = live.now(); live.now = () => t;
  const a1 = req(xa, "reach", { who: wes.actorId, point: "shoulder_l" }), a2 = req(yo, "reach", { who: wes.actorId, point: "shoulder_l" });
  req(wes, "consent", { answer: a1?.ask, yes: false });
  const a3 = req(zu, "reach", { who: wes.actorId, point: "shoulder_l" });
  const waiting = (req(wes, "consent", {})?.asks ?? []).map((k) => k.from);
  live.now = () => wall() + skew;
  ok(a2?.outcome === "asked" && a3?.outcome === "asked" && a2.ask !== a3.ask && waiting.includes(yo.actorId) && waiting.includes(zu.actorId),
    "RG17 a new ask doesn't take the id of one still waiting", { a2: a2?.ask, a3: a3?.ask, waiting }); }
live.now = wall;

let skipped = null; const SKIP = Symbol("skip");
// ---- AG: an agent's reach through a real server (a real mcpl/agent.ts WorldAgent): the reply says what the world showed ----
//   AG1  a stranger agent's hand on a person's chest_front: no frame the person receives carries it, and the reach reply
//        says it wasn't shown and why (it used to say the hand was reaching)
//   AG2  once the person opens touch, a hand on their shoulder relays and the reply doesn't claim a refusal
{ const { ENGINE } = await import("./common.ts");
  const W = path.join(root, "ag"), OPT = path.join(root, "agopt"); fs.mkdirSync(W, { recursive: true }); fs.mkdirSync(OPT, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const env = (extra = {}) => ({ ...process.env, WORLDS_DIR: W, OPT_DIR: OPT, SKIP_OPT_SWEEP: "1", HOST: "127.0.0.1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", TRUST_NAMES: "1", EIDO_FLIGHT_REHEARSAL: "", SESSIONS_PATH: path.join(root, "sessions.json"), ...extra });
  const r0 = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "yard", "--owner", "Ann"], { cwd: ENGINE, env: env() });
  ok(r0.exitCode === 0, "(AG setup) found yard", r0.stderr.toString().slice(-300));
  let port = 9740; for (; port < 9840; port++) { try { const sv = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); sv.stop(true); break; } catch {} }
  const logf = path.join(root, "srv.log");
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: env({ PORT: String(port) }), stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  process.on("exit", () => { try { proc.kill(); } catch {} });
  let ag = null, vs = null;
  try {
    let up = false; for (let i = 0; i < 80 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(800) })).ok; } catch {} }
    ok(up, "(AG setup) the server is up");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs = [];
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.send(JSON.stringify({ type: "join", world: "yard", id: "Vic", avatar: "", replica: true }));
    for (let i = 0; i < 80 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
    let rn = 0; const vreq = async (verb, args = {}) => { const id = `q${++rn}`; ws.send(JSON.stringify({ type: "request", id, verb, args }));
      for (let i = 0; i < 80; i++) { const r = msgs.find((m) => m.type === "reply" && m.id === id); if (r) return r.reply; await sleep(50); } return { ok: false, timeout: true }; };
    vs = ws; if (!msgs.some((m) => m.type === "snapshot")) console.log("  (debug) Vic join:", JSON.stringify(msgs).slice(0, 400));
    const vicPose = () => ws.send(JSON.stringify({ type: "pose", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle" } }));
    vicPose();
    // the agent pulls client/lib/poseclips.js, whose @pixiv/three-vrm-animation not every checkout's node_modules has: then this
    // part says SKIP (counted in the tail line, never as a pass); NODE_PATH=<a node_modules that has it> runs it
    let WorldAgent, HANDLERS;
    try { ({ WorldAgent } = await import("../../mcpl/agent.ts")); ({ HANDLERS } = await import("../../mcpl/tools.ts")); }
    catch (e) { if (!/Cannot find module/.test(String(e))) throw e; skipped = String(e).replace(/^.*Cannot find module /, "").slice(0, 120); throw SKIP; }
    ag = new WorldAgent({ url: `ws://127.0.0.1:${port}/ws`, name: "Hep", world: "yard", avatar: "" });
    await ag.connect(); for (let i = 0; i < 60 && !ag.cut; i++) await sleep(50);
    for (let i = 0; i < 40 && !ag.actorIds.get("Vic"); i++) { vicPose(); await sleep(50); }
    ok(!!ag.actorIds.get("Vic"), "(AG setup) the agent knows Vic's identity");
    const call = (name, a = {}) => HANDLERS[name](ag, a, { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, name);
    const T = (r) => r?.content?.[0]?.text ?? "";
    const seenReach = (k, point) => msgs.slice(k).some((m) => m.type === "frame" && m.poses?.Hep?.reach && JSON.stringify(m.poses.Hep.reach).includes(point));
    // AG1 (recut A2: Vic sets her switch to refuse; touch for the agent alone is opened in AG2 by a per-person allow)
    const sw = await vreq("consent", { switch: "refuse" }); ok(sw?.ok, "(AG1 setup) Vic sets her body to refuse", sw);
    let k = msgs.length;
    const r1 = await call("reach", { who: "Vic", point: "chest_front" }); await sleep(600);
    ok(!seenReach(k, "chest_front"), "AG1 Vic receives no frame carrying the agent's hand on her chest_front", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-3));
    ok(/not shown/.test(T(r1)) && /intimate/.test(T(r1)) && !ag.reaches.has("rightHand"), "AG1 the reach reply says the hand was not shown and why, and the agent stops streaming it", { text: T(r1), reaches: [...ag.reaches.keys()] });
    // AG2
    const hep = (() => { for (const m of msgs) { if (m.id === "Hep" && typeof m.actorId === "string") return m.actorId;
      for (const p of m.present ?? []) if (p.id === "Hep" && typeof p.actorId === "string") return p.actorId; } return null; })();
    const op = await vreq("consent", { allow: hep, class: "touch" });
    ok(op?.ok, "(AG2 setup) Vic opens touch to the agent alone (a per-person allow; intimate stays refused)", { op, hep });
    k = msgs.length;
    const r2 = await call("reach", { who: "Vic", point: "shoulder_l" }); await sleep(600);
    ok(seenReach(k, "shoulder_l"), "AG2 with touch open to it, the agent's hand on Vic's shoulder relays", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-2));
    ok(!/not shown/.test(T(r2)) && ag.reaches.has("rightHand"), "AG2 …and the reply claims no refusal", T(r2));
    // AG3 (r2 holes F9): a refusal for one limb withdraws that limb, not a consented one on the same body
    await sleep(REACH_NOTE_MS + 500);   // the relay says a (reacher, target, class) refusal once per REACH_NOTE_MS: wait out AG1's
    k = msgs.length;
    const r3 = await call("reach", { limb: "leftHand", who: "Vic", point: "chest_front" }); await sleep(600);
    ok(/not shown/.test(T(r3)) && !ag.reaches.has("leftHand"), "(AG3 setup) the left hand on Vic's chest_front is refused and withdrawn", T(r3));
    ok(ag.reaches.has("rightHand") && seenReach(k, "shoulder_l"), "AG3 …and the right hand she consented to stays on her shoulder", { reaches: [...ag.reaches.keys()], text: T(r3) });
    // AG4: within REACH_NOTE_MS of that intimate refusal, a TOUCH-class point in Vic's own frame is not refused by memory of it
    k = msgs.length;
    const r4 = await call("reach", { limb: "leftHand", x: 0.24, y: 1.0, z: 0, space: "Vic" }); await sleep(600);
    ok(!/not shown/.test(T(r4)) && ag.reaches.has("leftHand") && seenReach(k, '"space":"Vic"'), "AG4 a point at Vic's side (touch, open) relays and the agent doesn't claim the earlier intimate refusal for it", { text: T(r4), reaches: [...ag.reaches.keys()] });
  } catch (e) { if (e !== SKIP) ok(false, "AG threw", String(e?.stack ?? e).slice(0, 600)); else console.log(`  SKIP AG1-AG2: the agent can't load here (${skipped}); NODE_PATH=<node_modules with it> runs them`); }
  try { ag?.close(); } catch {} try { vs?.close(); } catch {} try { proc.kill(); } catch {} }

console.log(`[reachgate-check] ${pass} passed, ${fail} failed${skipped ? ", AG skipped (agent can't load)" : ""}`); process.exit(fail ? 1 : 0);
