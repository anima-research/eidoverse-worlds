// bun mcpl/door-unit-test.ts — door tools' own logic against a stand-in body (no world): anim's held frame, a ragdoll
// asked of someone else, move's fallback after a stopped walk
import { handleTool, frameOf } from "./tools.ts";
let fails = 0;
const ok = (c: boolean, what: string, got?: unknown) => { if (!c) { fails++; console.log(`  FAIL ${what}`, got ?? ""); } else console.log(`  ok   ${what}`); };
const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

// a hold between two keys shows the frame the client plays there, slerped, not the earlier key
const s = Math.SQRT1_2, tracks = { hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, s, 0, s] }] };   // 0° → 90° about y
const q45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
ok(near(frameOf(tracks, 0.5).hips, q45), "at 0.5 s, halfway between 0° and 90° holds 45°", frameOf(tracks, 0.5).hips);
ok(near(frameOf(tracks, 0).hips, [0, 0, 0, 1]) && near(frameOf(tracks, 1).hips, [0, s, 0, s]), "on a key, that key");
ok(near(frameOf(tracks, 7).hips, [0, s, 0, s]) && near(frameOf(tracks, null).hips, [0, s, 0, s]), "past the last key, or with no at, the last key");
ok(near(frameOf({ hips: [{ t: 1, q: [0, s, 0, s] }, { t: 2, q: [0, 0, 0, 1] }] }, 0.2).hips, [0, s, 0, s]), "before the first key, the first key");
ok(near(frameOf({ hips: [{ t: 1, q: [0, s, 0, s] }, { t: 0, q: [0, 0, 0, 1] }] }, 0.5).hips, q45), "keys out of order are sorted first");
// the shorter way round, as the client's slerp takes it: q and -q are one rotation
ok(near(frameOf({ hips: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, -s, 0, -s] }] }, 0.5).hips, q45), "q and -q slerp the short way");

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

console.log(`door-unit-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
