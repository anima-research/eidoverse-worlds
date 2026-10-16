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

// RG1
{ const k = sly.got.length, kv = vic.got.length;
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
{ const k = sly.got.length;
  const out = reachTo(sly, { who: "Vic", point: "shoulder_l" });
  const r = refusals(sly, k);
  ok(out && !out.reach, "RG2 a stranger's hand on Vic's shoulder (Normal: touch ask) is stripped", out);
  ok(r.length === 1 && r[0].class === "touch" && /reach/.test(r[0].fix ?? ""), "RG2 …and Sly is told to ask through the reach request", r); }

// RG3
{ req(ann, "consent", { friend: bob.actorId }); req(bob, "consent", { friend: ann.actorId });
  const out = reachTo(ann, { who: "Bob", point: "shoulder_l" });
  ok(out?.reach?.rightHand?.t?.who === "Bob", "RG3 mutual friends: Ann's hand on Bob's shoulder relays", out);
  const out2 = reachTo(ann, { who: "Bob", point: "chest_front" });
  ok(out2 && !out2.reach, "RG3 …but chest_front (friends' intimate is ask) does not", out2); }

// RG4
{ const r = req(vic, "consent", { allow: sly.actorId, class: "touch" });
  ok(r?.ok, "(RG4 setup) Vic allows Sly touch", r);
  const out = reachTo(sly, { who: "Vic", point: "hand_r" });
  ok(out?.reach?.rightHand?.t?.point === "hand_r", "RG4 a standing allow: Sly's hand on Vic's hand relays", out);
  const out2 = reachTo(sly, { who: "Vic", point: "chest_front" });
  ok(out2 && !out2.reach, "RG4 …an allow for touch is not one for intimate", out2);
  req(vic, "consent", { deny: sly.actorId, class: "touch" }); }

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

// RG10 (everything above went through the relay only)
ok(w.log.head === head0, "RG10 nothing about a reach is appended to the log", w.log.live.entries.slice(head0 + 1).map((e) => e.verb));


// RG9 (Tom: a stranger Vic has no standing word about)
{ const r = req(tom, "reach", { who: vic.actorId, point: "upper_back" });
  ok(r?.ok && r.outcome === "asked", "(RG9 setup) Tom asks Vic through the authority's reach verb", r);
  const ans = req(vic, "consent", { answer: r.ask, yes: true });
  ok(ans?.ok && ans.yes, "(RG9 setup) Vic says yes", ans);
  const out = reachTo(tom, { who: "Vic", point: "upper_back" });
  ok(out?.reach?.rightHand?.t?.point === "upper_back", "RG9 a touch the authority's reach verb admitted (asked, yes) relays", out);
  req(vic, "consent", { set: { class: "touch", tier: "strangers", mode: "nobody" } });
  const k = tom.got.length;
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
  req(quin, "consent", { set: { class: "pose", tier: "strangers", mode: "ask" } });   // a change to another class
  ok(!!shoulder(pat)?.reach, "RG13c a change to an unrelated class of Quin's table leaves the touch she said yes to");
  req(quin, "consent", { set: { class: "touch", tier: "strangers", mode: "everyone" } });
  ok(!!shoulder(pat)?.reach, "(RG13 setup) Quin opens touch to everyone: relays");
  req(quin, "consent", { set: { class: "touch", tier: "strangers", mode: "ask" } });
  const out = shoulder(pat);
  ok(out && !out.reach, "RG13c Quin going everyone → ask ends the held touch (only nobody used to)", out);
  ok(grant(pat, quin), "(RG13 setup) another yes"); ok(!!shoulder(pat)?.reach, "(RG13 setup) relays");
  req(quin, "consent", { friend: pat.actorId }); req(pat, "consent", { friend: quin.actorId });   // friends: touch everyone
  req(quin, "consent", { set: { class: "touch", tier: "friends", mode: "ask" } });
  const out2 = shoulder(pat);
  ok(out2 && !out2.reach, "RG13c …and so does any other move of the cell off everyone (friends' touch everyone → ask)", out2); }

// ---- F5: every contact point can be asked for through the verb, classed as the relay classes it ----
{ const { CONTACT_POINTS } = await import("../../shared/contact.js");
  const fay = person("Fay", "f", [0, 0, 10]), gil = person("Gil", "g", [0.6, 0, 10]);
  req(gil, "consent", { allow: fay.actorId, class: "touch" });   // touch: everyone for Fay; intimate stays Normal's nobody
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
let tierNobody, perPerson, paused;
{ tierNobody = said();                                                       // Normal: strangers' intimate is nobody
  req(mo, "consent", { set: { class: "intimate", tier: "strangers", mode: "everyone" } }); req(mo, "consent", { set: { class: "pose", tier: "strangers", mode: "everyone" } });
  req(mo, "consent", { deny: lu.actorId, class: "intimate" }); req(mo, "consent", { deny: lu.actorId, class: "pose" });
  perPerson = said();
  req(mo, "consent", { pause: true }); paused = said(); req(mo, "consent", { pause: false });
  const same = (k) => tierNobody[k] === perPerson[k] && perPerson[k] === paused[k] && typeof paused[k] === "string";
  ok(same("verb") && same("verbFix"), "RL1 the reach verb's refusal is byte-identical for tier nobody, a per-person deny and a pause", { tierNobody, perPerson, paused });
  ok(same("relay") && same("relayFix"), "RL1 …so is what the relay tells a stripped reacher", { tierNobody, perPerson, paused });
  ok(same("pose"), "RL1 …and the body verb's (pose)", { tierNobody, perPerson, paused });
  ok(same("puppet") && paused.puppet === refusalWords("Mo", "pose"), "RL1 …and the relay's puppet path (posing someone: server/messages.ts bodyRefusal) says the one uniform sentence", { tierNobody, perPerson, paused, want: refusalWords("Mo", "pose") });
  ok(![tierNobody, perPerson, paused].some((s) => /paus|said no|strangers|friends|from Lu|u-l|from you|their consent/.test(JSON.stringify(s))), "RL1 …none of them mentions a pause, a per-person no, or a tier", paused);
  const att = rf(req(mo, "consent", {}))?.attempts ?? [];
  ok(att.some((a) => /paused/.test(a.why ?? "")) && att.some((a) => /said no/.test(a.why ?? "")) && att.some((a) => /strangers is nobody/.test(a.why ?? "")),
    "RL2 Mo's own attempt ring still records the real cause of each", att.map((a) => a.why)); }

// ---- (the clock moves on from here: asks are at most 2 a minute) ----
// RL3: an ask answered no and an ask nobody answered read the same to the asker, and the same as a refusal
{ req(mo, "consent", { set: { class: "intimate", tier: "strangers", mode: "ask" } });
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
    // AG1
    let k = msgs.length;
    const r1 = await call("reach", { who: "Vic", point: "chest_front" }); await sleep(600);
    ok(!seenReach(k, "chest_front"), "AG1 Vic receives no frame carrying the agent's hand on her chest_front", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-3));
    ok(/not shown/.test(T(r1)) && /intimate/.test(T(r1)) && !ag.reaches.has("rightHand"), "AG1 the reach reply says the hand was not shown and why, and the agent stops streaming it", { text: T(r1), reaches: [...ag.reaches.keys()] });
    // AG2
    const op = await vreq("consent", { set: { class: "touch", tier: "strangers", mode: "everyone" } });
    ok(op?.ok, "(AG2 setup) Vic opens touch to strangers", op);
    k = msgs.length;
    const r2 = await call("reach", { who: "Vic", point: "shoulder_l" }); await sleep(600);
    ok(seenReach(k, "shoulder_l"), "AG2 with touch open, the agent's hand on Vic's shoulder relays", msgs.slice(k).filter((m) => m.type === "frame" && m.poses?.Hep).map((m) => m.poses.Hep.reach).slice(-2));
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
