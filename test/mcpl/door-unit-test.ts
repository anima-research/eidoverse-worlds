// bun test/mcpl/door-unit-test.ts — door tools' own logic against a stand-in body (no world): anim's held frame, a ragdoll
// asked of someone else, move's fallback after a stopped walk
import { handleTool } from "../../mcpl/tools.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { REDACTED } from "../../shared/protocol/fold.js";
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
    puppet: (to: string, p: unknown) => { asked = { to, p }; if (refused) ag.lastRefusal = { ts: Date.now(), text: "u-other said no" }; } };
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

// house 6340433633: each attempt answered on its own (the rows above answered every one with one refusal): the first
// route refused, then the walk stopped during the fallback beside what holds it up: the tries end there (not the next
// spot beside), and the stop is what's said, not the first refusal
{ const walks: number[][] = []; const answers = ["no route: the way there is sealed", "superseded by a newer walk or a stop", "no route: never asked"];
  const ag: any = { pos: { x: 0, z: 0 }, myOccupancy: null,
    destination: () => ({ x: 1, z: 1, y: 1, label: "cup", orBeside: { x: 2, z: 2, y: 0, label: "cup", orBeside: { x: 3, z: 3, y: 0, label: "cup" } } }),
    walkTo: async (x: number, z: number, _r: boolean, _t: number, _tol: number, _y: unknown, _n: unknown, receipt: any) => { receipt.refusal = answers[walks.length]; walks.push([x, z]); return false; } };
  const out: any = await handleTool({ agent: ag } as any, "move", { to: "cup" });
  ok(walks.length === 2 && out.isError && out.content[0].text.includes("superseded") && !out.content[0].text.includes("sealed"),
    "a walk stopped during the fallback ends the tries, and the stop is what's said", { walks, text: out.content[0].text }); }

// act's say {to} and body {to} name a person, so a thing sharing their name isn't sent in their place
{ const sent: any[] = [];
  const ag: any = { thingRef: (v: string) => v === "Mira" ? { id: "lamp-7f3a" } : {}, request: async (verb: string, args: any) => { sent.push([verb, args]); return { ok: true }; } };
  await handleTool({ agent: ag } as any, "act", { verb: "say", args: { text: "hi", to: "Mira" } });
  await handleTool({ agent: ag } as any, "act", { verb: "body", args: { to: "Mira", kind: "pose" } });
  await handleTool({ agent: ag } as any, "act", { verb: "delete", args: { id: "Mira" } });
  ok(sent[0][1].to === "Mira" && sent[1][1].to === "Mira", "act say {to} and body {to} keep the person's name", sent);
  ok(sent[2][1].id === "lamp-7f3a", "act delete {id} still resolves a thing's label (the control)", sent);
  await handleTool({ agent: ag } as any, "act", { verb: "batch", args: { requests: [{ verb: "set", args: { id: "Mira", component: "label", value: "x" } }, { verb: "say", args: { text: "hi", to: "Mira" } }] } });
  ok(sent[3]?.[1]?.requests?.[0]?.args?.id === "lamp-7f3a" && sent[3][1].requests[1].args.to === "Mira", "act batch resolves each request's thing names as act does, a person's name kept", sent[3]); }

// anim {bodyMode} beside stop or ragdoll runs them too, after declaring the mode
{ const calls: string[] = [];
  const ag: any = { anims: [{ name: "dance", kind: "clip" }], clip: "dance", myOccupancy: null, target: null, heldPose: null,
    restClip: () => "sit", bodyModeNow: () => ag.bodyMode, stopAnims: async (w: unknown) => { calls.push(`stop:${w}:${ag.bodyMode}`); ag.anims = []; return ["dance"]; },
    animEnded: (why: string) => calls.push(`ended:${why}`), knockDown: () => calls.push(`fell:${ag.bodyMode}`) };
  await handleTool({ agent: ag } as any, "anim", { bodyMode: "sit", stop: true });
  await handleTool({ agent: ag } as any, "anim", { bodyMode: "sit", ragdoll: true });
  ok(ag.bodyMode === "sit" && calls.includes("stop:null:sit") && calls.includes("fell:sit"), "bodyMode with stop stops, and with ragdoll falls, each after the mode is declared", calls); }

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
// house 6340433633: the other refusal, a loop with dur but no usable track (every bone unknown), leaves it playing too
{ const calls: string[] = [];
  const ag: any = { anims: [{ name: "live", kind: "track" }], endTrackLoop: (why: string) => calls.push(`end:${why}`), animate: () => calls.push("animate"),
    animBegan: () => calls.push("began") };
  await handleTool({ agent: ag } as any, "anim", { tracks: { notABone: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, 0, 0, 1] }] }, mode: "loop", dur: 2 });
  ok(!calls.includes("end:replaced"), "a loop refused for want of a usable track leaves the earlier one playing", calls); }

// house 6340433633: the replacement through the agent's own endTrackLoop (it was stubbed): the renderers are sent the
// stop before the new loop, and only the tracks layer ends: a clip playing beside it goes on
{ const { WorldAgent } = await import("../../mcpl/agent.ts");
  const sent: string[] = []; const ag: any = Object.create(WorldAgent.prototype);
  Object.assign(ag, { name: "me", inbox: [], animStops: [], modeTracker: { declared: null, declare() {} }, joined: true, anims: [{ name: "live", kind: "track" }, { name: "dance", kind: "clip", clip: "dance" }],
    ws: { readyState: 1, send: (m: string) => sent.push(m) }, animate: () => sent.push("animate") });
  await handleTool({ agent: ag } as any, "anim", { tracks: { hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, 0, 0, 1] }] }, mode: "loop", dur: 2 });
  ok(sent[0] === JSON.stringify({ type: "anim", stop: true }) && sent.indexOf("animate") > 0, "a new loop sends the renderers its stop before the new one", sent);
  ok(ag.anims.some((a: any) => a.name === "dance") && ag.animStops.some((x: any) => x.name === "live" && x.why === "replaced") && !ag.animStops.some((x: any) => x.name === "dance"),
    "…and ends the tracks layer alone: the clip beside it goes on", { anims: ag.anims, stops: ag.animStops }); }

// house 6340433633: anim {stop} with folded wings waits for them to open; a tracks loop begun meanwhile plays in its own
// layer and takes no clip, so the rest clip still comes back (a clip begun meanwhile, the control, keeps its own)
for (const kind of ["track", "clip"]) {
  const { WorldAgent } = await import("../../mcpl/agent.ts"); const ag: any = Object.create(WorldAgent.prototype);
  Object.assign(ag, { name: "me", inbox: [], animStops: [], modeTracker: { declared: null, declare() {} }, joined: false, bodyEpoch: 0, heldPose: null,
    anims: [{ name: "fold", kind: "pose" }, { name: "dance", kind: "clip", clip: "dance" }], wingsFolded: true, clip: "dance",
    restClip: () => "idle-rest", bodyModeNow: () => "stand", stop() { this.clip = "idle"; },
    foldWings: async (fold: boolean) => { await Promise.resolve(); ag.wingsFolded = fold;
      ag.anims.push(kind === "track" ? { name: "live", kind: "track" } : { name: "wave", kind: "clip", clip: "wave" }); if (kind === "clip") ag.clip = "wave"; return { ok: true, text: "" }; } });
  await ag.stopAnims(null);
  ok(kind === "track" ? ag.clip === "idle-rest" : ag.clip === "wave",
    kind === "track" ? "anim {stop}: a tracks loop begun while the wings opened doesn't keep the rest clip from coming back" : "…a clip begun meanwhile keeps its own (the control)", { clip: ag.clip, anims: ag.anims }); }

// attach on a thing with no seat teaches a whole create call: a socket child of it
{ const ag: any = { socketRec: () => null, thingRef: () => ({ id: "crate-0a1b2c3d" }), foldRecord: () => ({}), socketsOf: () => [], mounts: new Map(),
    myOccupancy: null, name: "me", handle: (id: string) => id.slice(0, 10) };
  const out: any = await handleTool({ agent: ag } as any, "attach", { to: "crate" });
  ok(out.isError && out.content[0].text.includes(`act {verb: "create", args: {components: {parent: {to: "crate-0a1b"}, transform: {pos: [0, 0.5, 0]}, socket: {name: "seat"}, station: {}}}}`), "attach's no-seat refusal gives the whole create call (a socket child)", out.content[0].text); }

// the door's seat lines name the door's way off, not a person's X, get up or jump
{ const { describeBody, bodyOf } = await import("../../shared/sockbody.js");
  const script = describeBody("seat", bodyOf({ leaveBy: "script" }), { door: true }), any = describeBody("seat", bodyOf({}), { door: true });
  ok(/detach \{escape: true\}/.test(script) && !/hold X|get up|jump/.test(script + any) && /detach, or a move/.test(any), "the door's seat lines say detach", [script, any]);
  ok(/hold X/.test(describeBody("seat", bodyOf({ leaveBy: "script" }))), "a person's still says hold X (the control)"); }

// a sender who declares "agent" is tagged chat:from-agent again (hosts' wake rules read it); "ai" or no
// word gets no facet, and the word itself still rides along as declares
{ const { pingDelivery } = await import("../../mcpl/ping-wire.ts"); const { MCPL_ADVERTISEMENT, senderFacet } = await import("../../mcpl/declaration.ts");
  const P = (kind: string) => ({ ts: 1, kind, who: "digi", text: "touches your head_top (left hand)" }) as any;
  ok(["approach", "depart", "touch", "reach"].every((k) => pingDelivery(P(k), "agent")!.tags.includes("chat:from-agent")), "a declared agent's pings carry chat:from-agent");
  ok(!JSON.stringify([pingDelivery(P("touch"), "ai"), pingDelivery(P("touch"), null)]).includes("from-agent") && pingDelivery(P("touch"), "ai")!.declares === "ai", "\"ai\" or no word: no facet, the word as sent");
  ok(senderFacet("agent") === "chat:from-agent" && senderFacet("Agent") === null && senderFacet(null) === null, "senderFacet reads the word \"agent\" itself, nothing near it");
  // house 6340433633: the tag lists say and act are sent with (net-server.ts's onEvent reaches these through event-wire.ts eventTags)
  const { speechTags } = await import("../../mcpl/declaration.ts") as any; const has = (l: string[] | undefined, t: string) => !!l?.includes(t);
  const say = speechTags?.("say", "agent", false), knock = speechTags?.("say", "agent", true), act = speechTags?.("act", "agent"), plain = [speechTags?.("say", "ai", false), speechTags?.("act", null)];
  ok(has(say, "chat:from-agent") && has(say, "chat:ambient") && has(knock, "chat:from-agent") && has(knock, "chat:mention") && has(knock, "chat:addressed") && !has(knock, "chat:ambient")
    && has(act, "chat:from-agent") && has(act, "eidoverse:act") && has(act, "chat:ambient") && plain.every((l) => Array.isArray(l) && !has(l, "chat:from-agent")),
    "say (ambient and addressed) and act from a declared agent carry chat:from-agent; \"ai\" or no word, none", { say, knock, act, plain });
  ok(JSON.stringify(MCPL_ADVERTISEMENT).includes("chat:from-agent"), "the advertisement lists chat:from-agent among the core tags it emits"); }

// a ping's channel frame (ping-wire.ts): approach, reach and touch address you; depart is ambient and a system notice;
// a mention rides the say event; and the pending_pings lines
{ const { pingDelivery, pingLine } = await import("../../mcpl/ping-wire.ts"); const { CHAT, EIDO } = await import("../../mcpl/declaration.ts");
  const P = (kind: string, text?: string) => ({ ts: 1, kind, who: "digi", ...(text != null ? { text } : {}) }) as any;
  const a = pingDelivery(P("approach"), null)!;
  ok(a.tags.includes(CHAT.addressed) && a.tags.includes(EIDO.approach) && a.mentioned === true && !a.tags.includes(CHAT.ambient) && !a.tags.includes(CHAT.system)
    && a.text === "* digi walked up to you", "approach is addressed + mentioned, not ambient or system, worded 'walked up to you'", a);
  const d = pingDelivery(P("depart", "walked away"), null)!, n = pingDelivery(P("depart", "is no longer nearby"), null)!;
  ok(d.tags.includes(CHAT.ambient) && d.tags.includes(CHAT.system) && d.tags.includes(EIDO.depart) && !d.tags.includes(CHAT.addressed) && d.mentioned === undefined
    && d.text === "* digi walked away" && n.text === "* digi is no longer nearby", "depart is ambient + system, never addressed or mentioned, in the agent's own who-moved words", [d, n]);
  const r = pingDelivery(P("reach", "reaches toward your shoulder_l (right hand)"), null)!, t = pingDelivery(P("touch", "touches your head_top (left hand)"), "ai")!;
  ok(r.tags.includes(CHAT.addressed) && r.tags.includes(EIDO.reach) && r.mentioned === true && r.text === "* digi reaches toward your shoulder_l (right hand)"
    && t.tags.includes(CHAT.addressed) && t.tags.includes(EIDO.touch) && t.mentioned === true, "reach and touch are addressed + mentioned, worded by the agent", [r, t]);
  ok(r.declares === undefined && ![...r.tags, ...t.tags].some((x: string) => /from-/.test(x)), "an undeclared sender carries no declares, and no from- tag is read from a word", [r, t]);
  ok(pingDelivery(P("mention", "hi"), null) === null, "mention pings ride the say event, never this path");
  const lines = [pingLine(P("mention", "come look at this")), pingLine(P("approach")), pingLine(P("depart", "walked away")), pingLine(P("depart", "is no longer nearby")),
    pingLine(P("touch", "touches your head_top (left hand)"))];
  ok(JSON.stringify(lines) === JSON.stringify(["@ digi: come look at this", "≈ digi walked up to you", "≈ digi walked away", "≈ digi is no longer nearby",
    "≈ digi touches your head_top (left hand)"]), "the pending_pings lines: mention, approach, depart (both wordings), touch", lines); }

// edit pins what its plan read, taken before the plan awaits anything, so a change that lands
// meanwhile is refused as changed instead of overwritten
{ let comps: any = { label: "old" }; const sent: any[] = [];
  const ag: any = { thingRef: () => ({ id: "lamp-1" }), foldRecord: () => ({ id: "lamp-1", model: "lamp.glb", label: comps.label }), foldedIds: () => ["lamp-1"],
    componentsOf: (id: string) => id === "lamp-1" ? structuredClone(comps) : null, entities: new Map(), st: { entities: {} }, mounts: new Map(),
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
  ["a purged component", { "flags.label": "new" }, { label: REDACTED }, null],
] as const) {
  const sent: any[] = [];
  const ag: any = { thingRef: () => ({ id: "lamp-1" }), foldRecord: () => ({ id: "lamp-1", ...(comps as any) }), foldedIds: () => ["lamp-1"],
    componentsOf: () => ({ ...(comps as any) }), entities: new Map(), st: { entities: {} }, mounts: new Map(),
    modelBox: async () => null, worldFold: () => ({}), handle: (x: string) => x,
    sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "lamp-1", set });
  const pin = sent[0]?.extra?.expect ?? null;
  ok(sent.length === 1 && JSON.stringify(pin) === JSON.stringify(want), `edit pins ${what} ${want ? "to the value it read" : "not at all"}`, { pin, out: out.content?.[0]?.text }); }

// a host's Sockets card names its socket children: sockets.del deletes that child (by name or id), nothing else is pinned
{ const sent: any[] = [];
  const front = { parent: { to: "bus-1" }, socket: { name: "front" }, transform: { pos: [0, 1, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } };
  const recs: Record<string, any> = { "bus-1": { id: "bus-1", model: "bus.glb" }, "seat-1": { id: "seat-1", ...front } };
  const ag: any = { thingRef: () => ({ id: "bus-1" }), foldRecord: (id: string) => recs[id] ?? null, foldedIds: () => Object.keys(recs),
    componentsOf: (id: string) => id === "bus-1" ? {} : structuredClone(front), entities: new Map(), st: { entities: {} }, mounts: new Map(), worldFold: () => ({}),
    handle: (x: string) => x, modelBox: async () => null, sendOps: async (ops: any[], extra: any) => { sent.push({ ops, extra }); return { ok: true }; } };
  const out: any = await handleTool({ agent: ag } as any, "edit", { id: "bus-1", set: { "sockets.del": "front" } });
  ok(sent.length === 1 && JSON.stringify(sent[0].ops) === '[{"verb":"delete","args":{"id":"seat-1"}}]' && !sent[0].extra?.expect,
    "sockets.del sends a delete of that socket child, unpinned (a socket is a thing of its own)", { sent, out: out.content?.[0]?.text }); }

// the body's read for a pin keeps a purged component as the fold's REDACTED, so a pin can leave it out, and copies the rest
{ const fake: any = Object.create(WorldAgent.prototype);
  const tf = { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] };
  fake.replica = { st: { entities: { "bus-1": { c: { label: REDACTED, transform: tf } } } } };
  const c = fake.componentsOf("bus-1");
  ok(c.label === REDACTED && c.transform !== tf && JSON.stringify(c.transform) === JSON.stringify(tf), "componentsOf keeps a purged component as REDACTED and copies the rest", c); }

// face turns to a thing's world point, not a child's pos, which is local to its parent
for (const where of [{ pos: [10, 0, 10] }, { why: "its parent isn't here" }] as any[]) {
  const faced: number[][] = [];
  const ag: any = { people: new Map(), thingRef: () => ({ id: "cup-1" }), entities: new Map([["cup-1", { id: "cup-1", pos: [0.2, 0.9, 0.1] }]]),
    worldPointOf: () => where, face: (x: number, z: number) => faced.push([x, z]) };
  const out: any = await handleTool({ agent: ag } as any, "face", { target: "cup" });
  ok("pos" in where ? JSON.stringify(faced) === "[[10,10]]" && !out.isError : !faced.length && out.isError && out.content[0].text.includes(where.why),
    "pos" in where ? "face turns to a child's world point" : "face whose thing's point can't be worked out turns nowhere and says why", { faced, out: out.content[0].text }); }

// act {verb: "use"}: the visitor's use is logged (ok), but when the script it sets off didn't run (refused, failed, …) the
// tool says so with isError, as for any refusal; a script that ran, ran and changed nothing, or would run (a dry use) is no error
for (const [status, err] of [["ran", false], ["nothing", false], ["would-run", false], ["refused", true], ["failed", true], ["unavailable", true], ["paused", true]] as [string, boolean][]) {
  const ag: any = { thingRef: (v: string) => ({ id: v }), request: async () => ({ ok: true, act: 7, recorded: true, script: { script: "script:bell", id: "bell", status, ...(err ? { code: "scope", why: "no" } : {}) } }) };
  const out: any = await handleTool({ agent: ag } as any, "act", { verb: "use", args: { id: "bell", action: "ring" } });
  ok(!!out.isError === err && /"status": "/.test(out.content[0].text), `act use whose script ${status}: ${err ? "isError" : "no error"}`, out); }
// house 6340433633: on a socket that rides a model part, face and beside-thing say a retry won't help and a point near it will
{ const { effectiveWorldTransform } = await import("../../mcpl/effective.ts"); const { AgentPlaces } = await import("../../mcpl/agent-places.ts");
  const v: any = { entity: (id: string) => (id === "cup-1" ? { pos: [0, 0, 0], socket: { name: "grip", part: "arm" } } : id === "robot" ? { pos: [0, 0, 0] } : undefined), mount: (id: string) => (id === "cup-1" ? { to: "robot" } : undefined) };
  const r: any = effectiveWorldTransform("cup-1", v, 0);
  const faced: number[][] = [];
  const ag: any = { people: new Map(), thingRef: () => ({ id: "cup-1" }), entities: new Map([["cup-1", { id: "cup-1", pos: [0, 0, 0] }]]), worldPointOf: () => ({ why: r.why }), face: (x: number, z: number) => faced.push([x, z]) };
  const out: any = await handleTool({ agent: ag } as any, "face", { target: "cup" });
  const b: any = Object.create(AgentPlaces.prototype); Object.assign(b, { a: { pos: { x: 5, y: 0, z: 5 }, replica: null, worldPointOf: () => ({ why: r.why }), refName: (id: string) => id } });
  const beside = b.besideThing({ id: "cup-1", pos: [0, 0, 0] });
  const says = (t: string) => /part geometry unavailable here/.test(t) && /asking again won't change that/.test(t) && /face \{x, z\}|move \{to: \[x, z\]\}/.test(t);
  ok(!r.ok && !faced.length && out.isError && says(out.content[0].text) && says(beside.refusal ?? ""), "on a part-riding socket, face and beside say a retry won't help and coordinates near it will", { face: out.content[0].text, beside }); }

// a world server that takes the request and never answers: the door's read is bounded (tools.ts HTTP_READ_MS), and the
// tool answers as a failed call instead of hanging the agent's turn
{ const { HTTP_READ_MS } = await import("../../mcpl/tools.ts"); const { pause } = await import("../gate/wait.ts");
  let hits = 0; const hung = Bun.serve({ port: 0, fetch: () => { hits++; return new Promise<Response>(() => {}); } });
  const ag: any = { httpBase: `http://127.0.0.1:${hung.port}`, readHeaders: {} };
  const t0 = Date.now();
  const call = (name: string, args: any) => Promise.race([handleTool({ agent: ag } as any, name, args), pause(`the hang guard: past the read bound and its slack, ${name} hung`, HTTP_READ_MS + 5_000).then(() => "hung")]);
  const slow = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { headers: { "content-type": "application/json" } }) });
  const agSlow: any = { httpBase: `http://127.0.0.1:${slow.port}`, readHeaders: {}, world: "w" };
  const measured = Promise.race([handleTool({ agent: agSlow } as any, "measure", { lib: "x.glb" }), pause("the hang guard: measure hung", HTTP_READ_MS + 5_000).then(() => "hung")]);
  const [out, sheet, models]: any[] = await Promise.all([call("set_avatar", { avatar: "x" }), call("library", { kind: "avatars" }), call("library", { kind: "models" })]);
  ok(Number.isFinite(HTTP_READ_MS) && out !== "hung" && out.isError && hits >= 1 && Date.now() - t0 >= HTTP_READ_MS - 500 && Date.now() - t0 < HTTP_READ_MS + 5_000, "a world server that never answers: set_avatar asks, waits out the read bound and fails, it doesn't hang", { out, hits, ms: Date.now() - t0 });
  // the timeout is said in words, not as AbortSignal's bare "The operation timed out."
  const said = (o: any) => o !== "hung" && o?.isError && /didn't send .* within \d+ s; calling again may work/.test(o.content?.[0]?.text ?? "") && !/operation timed out/i.test(o.content?.[0]?.text ?? "");
  ok(said(out) && said(sheet) && said(models), "…and set_avatar and the library's sheets say the server didn't answer in time, and that a retry may work", [out, sheet, models].map((o) => o?.content?.[0]?.text ?? o));
  const m: any = await measured;
  ok(said(m) && /^measure: nothing was measured/.test(m.content[0].text), "…and measure, whose answer's body stalls after the headers, says the server didn't send it in time (not 'isn't geometry')", m?.content?.[0]?.text ?? m);
  hung.stop(true); slow.stop(true); }

console.log(`door-unit-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
