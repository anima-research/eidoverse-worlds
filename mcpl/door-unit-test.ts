// bun mcpl/door-unit-test.ts — door tools' own logic against a stand-in body (no world): anim's held frame, a ragdoll
// asked of someone else, move's fallback after a stopped walk
import { handleTool } from "./tools.ts";
import { WorldAgent } from "./agent.ts";
import { PURGED } from "../shared/protocol/fold.js";
let fails = 0;
const ok = (c: boolean, what: string, got?: unknown) => { if (!c) { fails++; console.log(`  FAIL ${what}`, got ?? ""); } else console.log(`  ok   ${what}`); };

// a hold between two keys holds each bone's key at or before it, and the reply says that's what it holds
{ const ag: any = { anims: [], setPose: () => {}, animBegan: () => {}, animEnded: () => {} };
  const out: any = await handleTool({ agent: ag } as any, "anim", { tracks: { hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }] }, mode: "hold", at: 0.5 });
  ok(!out.isError && /each bone's key at or before 0\.5 s \(else its first\), not a blend between keys/.test(out.content[0].text), "a held frame between keys says it holds the key at or before it", out.content[0].text); }

// a ragdoll asked of someone else leaves your own anims playing, whether they say yes or no
for (const refused of [true, false]) {
  const ended: string[] = []; let asked: unknown = null;
  const ag: any = { name: "me", lastRefusal: null as any, animEnded: (why: string) => ended.push(why), knockDown: () => ended.push("(fell)"),
    puppet: (to: string, p: unknown) => { asked = { to, p }; if (refused) ag.lastRefusal = { ts: Date.now(), text: "they said no" }; } };
  const out: any = await handleTool({ agent: ag } as any, "anim", { ragdoll: true, target: "u-other" });
  ok(JSON.stringify(asked) === JSON.stringify({ to: "u-other", p: { ragdoll: true } }) && ended.length === 0 && !!out.isError === refused,
    `anim {ragdoll, target} ${refused ? "refused" : "passed on"}: your own anims go on`, { ended, out });
}
{ const ended: string[] = [];
  const ag: any = { name: "me", animEnded: (why: string) => ended.push(why), knockDown: () => ended.push("(fell)") };
  await handleTool({ agent: ag } as any, "anim", { ragdoll: true });
  ok(ended[0] === "knocked over", "anim {ragdoll} on yourself ends your anims: you fell", ended); }

// a walk stopped while it waited for geometry ends move's tries; the fallback beside what holds the
// thing up would start the walk that was just stopped. A route refused still tries it (the control)
for (const why of ["superseded by a newer walk or a stop", "no route: the way there is sealed"]) {
  const walks: number[][] = [];
  const ag: any = { pos: { x: 0, z: 0 }, myOccupancy: null,
    destination: () => ({ x: 1, z: 1, y: 1, label: "cup", orBeside: { x: 2, z: 2, y: 0, label: "cup" } }),
    walkTo: async (x: number, z: number, _r: boolean, _t: number, _tol: number, _y: unknown, _n: unknown, receipt: any) => { walks.push([x, z]); receipt.refusal = why; return false; } };
  const out: any = await handleTool({ agent: ag } as any, "move", { to: "cup" });
  const stopped = why.startsWith("superseded");
  ok(walks.length === (stopped ? 1 : 2) && out.isError && out.content[0].text.includes(why),
    stopped ? "a stopped walk isn't tried again beside what holds it up, and says it was stopped" : "a refused route is tried again beside what holds it up", { walks, text: out.content[0].text });
}

// act's say {to} and body {to} name a person, so a thing sharing their name isn't sent in their place
{ const sent: any[] = [];
  const ag: any = { thingRef: (v: string) => v === "Mira" ? { id: "lamp-7f3a" } : {}, request: async (verb: string, args: any) => { sent.push([verb, args]); return { ok: true }; } };
  await handleTool({ agent: ag } as any, "act", { verb: "say", args: { text: "hi", to: "Mira" } });
  await handleTool({ agent: ag } as any, "act", { verb: "body", args: { to: "Mira", kind: "pose" } });
  await handleTool({ agent: ag } as any, "act", { verb: "delete", args: { id: "Mira" } });
  ok(sent[0][1].to === "Mira" && sent[1][1].to === "Mira", "act say {to} and body {to} keep the person's name", sent);
  ok(sent[2][1].id === "lamp-7f3a", "act delete {id} still resolves a thing's label (the control)", sent); }

// anim {bodyMode} beside stop or ragdoll runs them too, after declaring the mode
{ const calls: string[] = [];
  const ag: any = { anims: [{ name: "dance", kind: "clip" }], clip: "dance", myOccupancy: null, target: null, heldPose: null,
    restClip: () => "sit", bodyModeNow: () => ag.bodyMode, stopAnims: async (w: unknown) => { calls.push(`stop:${w}`); ag.anims = []; return ["dance"]; },
    animEnded: (why: string) => calls.push(`ended:${why}`), knockDown: () => calls.push("fell") };
  await handleTool({ agent: ag } as any, "anim", { bodyMode: "sit", stop: true });
  await handleTool({ agent: ag } as any, "anim", { bodyMode: "sit", ragdoll: true });
  ok(ag.bodyMode === "sit" && calls.includes("stop:null") && calls.includes("fell"), "bodyMode with stop stops, and with ragdoll falls", calls); }

// a held frame says what validation left out, as animate does
{ const ag: any = { anims: [], setPose: () => {}, animBegan: () => {}, animEnded: () => {} };
  const out: any = await handleTool({ agent: ag } as any, "anim", { tracks: { hips: [{ t: 0, q: [0, 0, 0, 1] }], notABone: [{ t: 0, q: [0, 0, 0, 1] }] }, mode: "hold" });
  ok(!out.isError && /notABone/.test(out.content[0].text), "a held frame names the bone it left out", out.content[0].text); }

// a new tracks loop stops the earlier one before it's sent; a loop animate refuses leaves it playing
for (const dur of [2, undefined]) {
  const calls: string[] = [];
  const ag: any = { anims: [{ name: "live", kind: "track" }], endTrackLoop: (why: string) => calls.push(`end:${why}`), animate: () => calls.push("animate"),
    animBegan: () => calls.push("began") };
  await handleTool({ agent: ag } as any, "anim", { tracks: { hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, 0, 0, 1] }] }, mode: "loop", dur });
  ok(dur ? calls.join(",") === "end:replaced,animate,began" : !calls.includes("end:replaced"),
    dur ? "a new loop ends the earlier one first, then plays" : "a loop refused for want of dur leaves the earlier one playing", calls);
}

// attach on a thing with no seat teaches a whole edit call, id and set
{ const ag: any = { socketRec: () => null, thingRef: () => ({ id: "crate-0a1b2c3d" }), foldRecord: () => ({}), socketsOf: () => [], mounts: new Map(),
    myOccupancy: null, name: "me", handle: (id: string) => id.slice(0, 10) };
  const out: any = await handleTool({ agent: ag } as any, "attach", { to: "crate" });
  ok(out.isError && out.content[0].text.includes(`edit {id: "crate-0a1b", set: {"sockets.seat|pos|1": 0.5}}`), "attach's no-seat refusal gives the whole edit call", out.content[0].text); }

// the door's seat lines name the door's way off, not a person's X, get up or jump
{ const { describeBody, bodyOf } = await import("../shared/sockbody.js");
  const script = describeBody("seat", bodyOf({ leaveBy: "script" }), { door: true }), any = describeBody("seat", bodyOf({}), { door: true });
  ok(/detach \{escape: true\}/.test(script) && !/hold X|get up|jump/.test(script + any) && /detach, or a move/.test(any), "the door's seat lines say detach", [script, any]);
  ok(/hold X/.test(describeBody("seat", bodyOf({ leaveBy: "script" }))), "a person's still says hold X (the control)"); }

// a sender who declares "agent" is tagged chat:from-agent again (hosts' wake rules read it); "ai" or no
// word gets no facet, and the word itself still rides along as declares
{ const { pingDelivery } = await import("./ping-wire.ts"); const { MCPL_ADVERTISEMENT, senderFacet } = await import("./declaration.ts");
  const P = (kind: string) => ({ ts: 1, kind, who: "digi", text: "touches your head_top (left hand)" }) as any;
  ok(["approach", "depart", "touch", "reach"].every((k) => pingDelivery(P(k), "agent")!.tags.includes("chat:from-agent")), "a declared agent's pings carry chat:from-agent");
  ok(!JSON.stringify([pingDelivery(P("touch"), "ai"), pingDelivery(P("touch"), null)]).includes("from-agent") && pingDelivery(P("touch"), "ai")!.declares === "ai", "\"ai\" or no word: no facet, the word as sent");
  ok(senderFacet("agent") === "chat:from-agent" && senderFacet("Agent") === null && senderFacet(null) === null, "senderFacet reads the word \"agent\" itself, nothing near it");
  ok(JSON.stringify(MCPL_ADVERTISEMENT).includes("chat:from-agent"), "the advertisement lists chat:from-agent among the core tags it emits"); }

// edit pins what its plan read, taken before the plan awaits anything, so a change that lands
// meanwhile is refused as changed instead of overwritten
{ let comps: any = { label: "old" }; const sent: any[] = [];
  const ag: any = { thingRef: () => ({ id: "lamp-1" }), foldRecord: () => ({ id: "lamp-1", model: "lamp.glb", label: comps.label }), foldedIds: () => ["lamp-1"],
    componentsOf: (id: string) => id === "lamp-1" ? structuredClone(comps) : null, socketChildrenOf: () => ({}), entities: new Map(), st: { entities: {} }, mounts: new Map(),
    // the model's box is awaited while planning: someone else's label lands then
    modelBox: async () => { comps = { label: "someone else's" }; return null; }, worldFold: () => ({}), handle: (x: string) => x,
    sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "lamp-1", set: { "flags.label": "new" } });
  const pin = sent[0]?.extra?.expect;
  ok(JSON.stringify(pin) === JSON.stringify([{ id: "lamp-1", component: "label", value: "old" }]), "edit's write is pinned to the label it read", { pin, out: out.content?.[0]?.text }); }

// edit pins every component it touches, as the plan read it: an unset as well as a set (taking motion away), and
// never a purged one, which the authority counts equal to nothing (replacing a purged label could never go through)
for (const [what, set, comps, want] of [
  ["an unset", { "remove.motion": true }, { motion: { type: "spin", speed: 1 } }, [{ id: "lamp-1", component: "motion", value: { type: "spin", speed: 1 } }]],
  ["a purged component", { "flags.label": "new" }, { label: PURGED }, null],
] as const) {
  const sent: any[] = [];
  const ag: any = { thingRef: () => ({ id: "lamp-1" }), foldRecord: () => ({ id: "lamp-1", ...(comps as any) }), foldedIds: () => ["lamp-1"],
    componentsOf: () => ({ ...(comps as any) }), socketChildrenOf: () => ({}), entities: new Map(), st: { entities: {} }, mounts: new Map(),
    modelBox: async () => null, worldFold: () => ({}), handle: (x: string) => x,
    sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "lamp-1", set });
  const pin = sent[0]?.extra?.expect ?? null;
  ok(sent.length === 1 && JSON.stringify(pin) === JSON.stringify(want), `edit pins ${what} ${want ? "to the value it read" : "not at all"}`, { pin, out: out.content?.[0]?.text }); }

// a sockets write is a write of the host's socket children (the door retires the ones the map doesn't name), so edit pins
// each child the plan read, its parent included (a child moved to another host meanwhile isn't this host's to rewrite), and a
// child added or taken away while the plan awaited the model's box stops it: no pin can name a child the plan never saw
for (const change of ["none", "added", "taken"] as const) {
  const added = change !== "none";
  const sent: any[] = [];
  const front = { parent: { to: "bus-1" }, socket: { name: "front" }, transform: { pos: [0, 1, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const kids: Record<string, any> = { "seat-1": front };
  const recs: Record<string, any> = { "bus-1": { id: "bus-1", model: "bus.glb" }, "seat-1": { id: "seat-1", ...front } };
  const ag: any = { thingRef: () => ({ id: "bus-1" }), foldRecord: (id: string) => recs[id] ?? null, foldedIds: () => Object.keys(recs),
    componentsOf: (id: string) => id === "bus-1" ? {} : structuredClone(kids[id] ?? null), socketChildrenOf: () => structuredClone(kids),
    entities: new Map(), st: { entities: {} }, mounts: new Map(), worldFold: () => ({}), handle: (x: string) => x,
    // the model's box is awaited while planning: someone else's socket lands then
    modelBox: async () => {
      if (change === "added") kids["seat-2"] = { parent: { to: "bus-1" }, socket: { name: "back" }, transform: front.transform };
      if (change === "taken") delete kids["seat-1"];
      return null; },
    sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "bus-1", set: { "sockets.del": "front" } });
  const pin = sent[0]?.extra?.expect ?? null;
  ok(added
    ? !sent.length && out.isError && /sockets changed while the edit was being prepared/.test(out.content[0].text)
    : sent.length === 1 && JSON.stringify(pin) === JSON.stringify([{ id: "bus-1", component: "sockets" },
        { id: "seat-1", component: "parent", value: { to: "bus-1" } }, { id: "seat-1", component: "socket", value: { name: "front" } },
        { id: "seat-1", component: "transform", value: front.transform }, { id: "seat-1", component: "station" }]),
    added ? `a socket ${change} while edit planned stops the sockets write: nothing is sent` : "a sockets write pins each socket child it read, its parent included", { sent, pin, out: out.content?.[0]?.text }); }

// more socket children than one request can pin (the authority takes 256 expect entries) is refused here, in words that say
// what to do instead, not sent to be refused for its shape; a write of exactly 256 pins goes (four host components and 63
// children of four pins each)
async function socketsEdit(children: number, set: Record<string, unknown>) {
  const sent: any[] = []; const kids: Record<string, any> = {}; const recs: Record<string, any> = { "bus-1": { id: "bus-1" } };
  for (let i = 0; i < children; i++) { const c = { parent: { to: "bus-1" }, socket: { name: `s${i}` }, transform: { pos: [i, 1, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } };
    kids[`seat-${i}`] = c; recs[`seat-${i}`] = { id: `seat-${i}`, ...c }; }
  const ag: any = { thingRef: () => ({ id: "bus-1" }), foldRecord: (id: string) => recs[id] ?? null, foldedIds: () => Object.keys(recs),
    componentsOf: (id: string) => id === "bus-1" ? {} : structuredClone(kids[id] ?? null), socketChildrenOf: () => structuredClone(kids),
    entities: new Map(), st: { entities: {} }, mounts: new Map(), worldFold: () => ({}), handle: (x: string) => x, modelBox: async () => null,
    sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "bus-1", set });
  return { sent, out };
}
{ const over = await socketsEdit(90, { "sockets.del": "s0" });
  ok(!over.sent.length && over.out.isError && /more sockets than one edit can pin \(361 pins; a request carries at most 256\)/.test(over.out.content[0].text),
    "a sockets write with more children than a request can pin is refused here, saying edit them one at a time", { sent: over.sent.length, out: over.out.content?.[0]?.text });
  const four = { "sockets.del": "s0", "flags.label": "zz bus", "flags.lock": true, "flags.hidden": true };
  const at = await socketsEdit(63, four);
  ok(at.sent.length === 1 && at.sent[0].extra.expect.length === 256, "a sockets write of exactly 256 pins is sent", { pins: at.sent[0]?.extra?.expect?.length, out: at.out.content?.[0]?.text });
  const past = await socketsEdit(64, four);
  ok(!past.sent.length && /\(260 pins; a request carries at most 256\)/.test(past.out.content?.[0]?.text ?? ""), "one child more is refused", { sent: past.sent.length, out: past.out.content?.[0]?.text }); }

// the body's read for a pin keeps a purged component as the fold's PURGED, so a pin can leave it out, and copies the rest;
// a host's socket children are the things parented to it with a socket, as the door's liftOps counts them (isSocketC)
{ const fake: any = Object.create(WorldAgent.prototype);
  const tf = { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] };
  fake.replica = { st: { entities: {
    "bus-1": { c: { label: PURGED, transform: tf } },
    "seat-1": { c: { parent: { to: "bus-1" }, socket: { name: "front" } } },
    "seat-2": { c: { parent: { to: "bus-1" }, socket: PURGED } },
    "cup-1": { c: { parent: { to: "bus-1" }, transform: tf } },
    "seat-9": { c: { parent: { to: "car-1" }, socket: { name: "back" } } } } } };
  const c = fake.componentsOf("bus-1");
  ok(c.label === PURGED && c.transform !== tf && JSON.stringify(c.transform) === JSON.stringify(tf), "componentsOf keeps a purged component as PURGED and copies the rest", c);
  const kids = fake.socketChildrenOf("bus-1");
  ok(JSON.stringify(Object.keys(kids)) === '["seat-1"]', "socketChildrenOf counts a child parented with a socket, not a purged socket, a plain child or another host's", kids);
  ok(JSON.stringify(kids["seat-1"]) === JSON.stringify({ parent: { to: "bus-1" }, socket: { name: "front" } }) && kids["seat-1"].socket !== fake.replica.st.entities["seat-1"].c.socket,
    "socketChildrenOf gives each child's components as componentsOf reads them, copied", kids); }

// face turns to a thing's world point, not a child's pos, which is local to its parent
for (const where of [{ pos: [10, 0, 10] }, { why: "its parent isn't here" }] as any[]) {
  const faced: number[][] = [];
  const ag: any = { people: new Map(), thingRef: () => ({ id: "cup-1" }), entities: new Map([["cup-1", { id: "cup-1", pos: [0.2, 0.9, 0.1] }]]),
    worldPointOf: () => where, face: (x: number, z: number) => faced.push([x, z]) };
  const out: any = await handleTool({ agent: ag } as any, "face", { target: "cup" });
  ok("pos" in where ? JSON.stringify(faced) === "[[10,10]]" && !out.isError : !faced.length && out.isError && out.content[0].text.includes(where.why),
    "pos" in where ? "face turns to a child's world point" : "face whose thing's point can't be worked out turns nowhere and says why", { faced, out: out.content[0].text }); }

console.log(`door-unit-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
