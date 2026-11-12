// mcpl/tool-replies-test.ts — what the agent's tools and body say and send, pure (no server): one row per behaviour.
// finding (38, 41, 53, 62, 63, 92, 105, 106, 107), each red on aeaf71de5; bot-review rows 453/454/458/459/462, each red on 884ae7cef.
// run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun mcpl/tool-replies-test.ts
import { WorldAgent } from "./agent.ts";
import { handleTool } from "./tools.ts";
import { tryUntil } from "../tools/protocol/wait.ts";
let fails = 0; const ok = (c: boolean, what: string, d?: unknown) => { if (c) console.log("  ok", what); else { fails++; console.log("  FAIL", what, d === undefined ? "" : JSON.stringify(d).slice(0, 600)); } };
const textOf = (r: any) => String(r?.content?.[0]?.text ?? "");
const ctxOf = (agent: any): any => ({ agent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } });

// #38: an unresolved seat's notice names the exit that exists (detach), never a sit tool
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.mounts.set("me", { to: "gone" });
  const head = ag.look(0).split("\n")[0];
  ok(/position unknown/.test(head) && /detach/.test(head) && /escape: true/.test(head) && !/\bsit\b/.test(head), "38 an unresolved seat's notice says detach (escape if held), not sit", head); }

// #62: look reads a disabled collider as walk-through; an enabled one still collides
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  ag.entities.set("off", { id: "off", model: "zz/crate.glb", kind: "thing", pos: [1, 0, 1], yaw: 0, actor: "x", scale: 1, collider: { shape: "box", enabled: false } });
  ag.entities.set("on", { id: "on", model: "zz/crate.glb", kind: "thing", pos: [2, 0, 2], yaw: 0, actor: "x", scale: 1, collider: { shape: "box" } });
  const L = ag.look(0).split("\n"), off = L.find((l: string) => l.includes("[off]")) ?? "", on = L.find((l: string) => l.includes("[on]")) ?? "";
  ok(/walk-through/.test(off) && !/collides as/.test(off) && /collides as a box/.test(on), "62 look: a collider with enabled: false reads walk-through; an enabled one collides", { off, on }); }

// #41 (tool side): ban {global: true, days} sends the days with the server ban
{ const sent: any[] = []; const ag: any = { sendMod: (type: string, args: any) => sent.push({ type, ...args }), modOutcome: async () => "u-x is banned from all worlds" };
  await handleTool(ctxOf(ag), "act", { verb: "ban", args: { who: "Moss", days: 2, global: true } });
  ok(sent.length === 1 && sent[0].type === "server-ban" && sent[0].days === 2, "41 ban {global, days} sends days to the server", sent); }

// fake agent for create: things by label, requests captured
const creator = (reply: any = { ok: true, after: {} }) => { const sent: any[] = [];
  const ag: any = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, heightAt: () => 0, handle: (id: string) => id, worldBlueprints: () => ({}), foldRecord: () => null,
    thingRef: (v: string) => (v === "lamp" ? { id: "lamp-0123abcd" } : { id: v }), request: async (verb: string, args: any) => { sent.push({ verb, args }); return reply; } };
  return { ag, sent }; };

// #107: create at a 2D point keeps place's resolved targets
{ const { ag, sent } = creator(); await handleTool(ctxOf(ag), "create", { model: "zz/chair.glb", at: [0, 0], place: { facing: "lamp" } });
  const p = sent[0]?.args?.place;
  ok(p?.facing === "lamp-0123abcd" && JSON.stringify(p?.at) === "[0,0]", "107 create {model, at: [x, z], place: {facing: label}} sends the label's id", sent); }

// #92: a light created with nothing said of its intensity takes the registry's default (no 16 written)
{ const { ag, sent } = creator(); await handleTool(ctxOf(ag), "create", { components: { light: {} } });
  const li = sent[0]?.args?.components?.light;
  ok(!!li && li.intensity === undefined, "92 create {components: {light: {}}} writes no intensity of its own (materialize fills 25.93)", sent); }

// #53: a request with no answer says it may have landed; the create tool doesn't call it refused
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.joined = true; ag.ws = { readyState: 1, send() {} };
  const t0 = Date.now(); const r = await ag.request("create", { model: "zz/x.glb" });
  const { ag: c } = creator(r); const out = textOf(await handleTool(ctxOf(c), "create", { model: "zz/x.glb", at: [1, 1] }));
  ok(Date.now() - t0 >= 7900 && r?.refused?.code === "timeout" && r?.refused?.mayHaveLanded === true && /may still/.test(out) && !/refused by the authority/.test(out),
    "53 an unanswered create reads 'may still land', never 'refused by the authority'", { r, out }); }

// #63: catch_up pages from the oldest unread; a full page moves the cursor only past what it showed
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  const all = Array.from({ length: 70 }, (_, i) => ({ seq: (i + 1) * 1000, ts: i, actor: "Bea", verb: "say", args: { text: `line ${i + 1}` } }));
  ag.lastSeq = 70000;
  // the server's paging (worldlog.ts readHistory): the newest `limit` after `after`, before `before`, hasMore when older remain
  ag.history = async ({ after = -Infinity, before = Infinity, limit = 50 }: any) => { const m = all.filter((e) => e.seq > after && e.seq < before);
    const page = m.slice(-limit); return { entries: page, oldestSeq: page[0]?.seq ?? null, hasMore: m.length > page.length }; };
  const ctx = ctxOf(ag); const one = textOf(await handleTool(ctx, "catch_up", {})), two = textOf(await handleTool(ctx, "catch_up", {}));
  ok(/^60 message/.test(one) && /line 1\n/.test(one) && /more remain/.test(one) && /^10 message/.test(two) && /line 61\n/.test(two) && /line 70$/.test(two),
    "63 70 lines: catch_up shows the first 60 and says more remain; the next shows the last 10", { one: one.slice(0, 120), two: two.slice(0, 120) }); }

// kudzu M6: catch_up {limit: 0} (or a limit that isn't a number) is a page of at least one line, never a throw
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  const all = Array.from({ length: 3 }, (_, i) => ({ seq: (i + 1) * 1000, ts: i, actor: "Bea", verb: "say", args: { text: `line ${i + 1}` } }));
  ag.lastSeq = 3000;
  ag.history = async ({ after = -Infinity, before = Infinity, limit = 50 }: any) => { const m = all.filter((e) => e.seq > after && e.seq < before);
    const page = m.slice(-limit); return { entries: page, oldestSeq: page[0]?.seq ?? null, hasMore: m.length > page.length }; };
  const outs: string[] = []; let threw: unknown = null;
  try { for (const limit of [0, -5, "x"]) outs.push(textOf(await handleTool(ctxOf(ag), "catch_up", { limit }))); } catch (e) { threw = String(e); }
  ok(threw === null && /^1 message/.test(outs[0]) && /^1 message/.test(outs[1]) && /^3 message/.test(outs[2]), "M6 catch_up {limit: 0 | -5 | 'x'}: one line, one line, the default page", { threw, outs: outs.map((o) => o.slice(0, 60)) }); }

// #27 (bot2): a history read that got no answer is not an empty final page — catch_up keeps its cursor and says so
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  const offline = await ag.history({ after: 0 });
  ag.lastSeq = 99000; ag.history = async () => ({ entries: [], oldestSeq: null, hasMore: false, failed: true });
  const ctx = ctxOf(ag); ctx.cursor.caughtUpTo = 5000; const r = await handleTool(ctx, "catch_up", {});
  ok(offline.failed === true && r?.isError === true && /seq 5000/.test(textOf(r)) && ctx.cursor.caughtUpTo === 5000,
    "27 an unanswered history read is an error that leaves the cursor where it was", { offline, r: textOf(r), cursor: ctx.cursor }); }

// #296: a flight-recorder read that got no answer (not joined, or nothing within 8 s) is `failed`, and world_debug says so
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  const offline = await ag.worldDebug({ limit: 5 }), r = await handleTool(ctxOf(ag), "world_debug", {});
  const sent: any[] = [];
  ag.joined = true; ag.ws = { readyState: 1, send(x: string) { sent.push(JSON.parse(x)); } };
  const realSetTimeout = globalThis.setTimeout, waits: (number | undefined)[] = [];   // the 8 s is pinned: the timeout must be asked for at 8000 ms (bot #15)
  globalThis.setTimeout = ((fn: any, ms?: number, ...x: any[]) => (waits.push(ms), realSetTimeout(fn, ms === 8000 ? 0 : ms, ...x))) as any;
  let late: any, lateTool: any;
  try { late = await ag.worldDebug({ limit: 5 }); lateTool = await handleTool(ctxOf(ag), "world_debug", {}); } finally { globalThis.setTimeout = realSetTimeout; }
  ok(offline.failed === true && late?.failed === true && sent.length === 2 && sent.every((m) => m.type === "debug") && waits.filter((w) => w === 8000).length === 2,
    "296 worldDebug with no answer (offline, the 8 s timeout after a sent request) is failed, not an empty recorder", { offline, late, sent, waits });
  ok([r, lateTool].every((x) => x?.isError === true && /didn't answer/.test(textOf(x)) && !/empty/.test(textOf(x))),
    "296 world_debug with no answer is an error that says the world didn't answer", [r, lateTool].map(textOf));
  // (control) the real worldDebug, answered on the wire with an empty recorder (bot #14: not a stand-in for worldDebug)
  ag.ws.send = (x: string) => { const q = JSON.parse(x); queueMicrotask(() => ag.pendingDebug.get(q.reqId)?.({ type: "debug", reqId: q.reqId, events: [] })); };
  const empty = await handleTool(ctxOf(ag), "world_debug", {});
  ok(!empty?.isError && /flight recorder is empty/.test(textOf(empty)), "(control) 296 an answered empty recorder reads empty", textOf(empty)); }

// #296: missedSince (the door's missed-mention replay) passes an unanswered history read on as failed, not as nothing said
{ const ag: any = new WorldAgent({ name: "me", world: "w" });
  const offline = await ag.missedSince(5000);
  ag.history = async () => ({ entries: [{ seq: 6000, ts: 0, actor: "Bea", verb: "say", args: { text: "hi me" } }], oldestSeq: 6000, hasMore: false });
  const answered = await ag.missedSince(5000);
  ok(offline?.failed === true && offline.said?.length === 0 && !answered.failed && answered.said?.[0]?.seq === 6000,
    "296 missedSince with no answer is failed; with one, the says", { offline, answered }); }

// #105 (bot2): the cursor after an exhausted read is a seq the read covered, not a say that arrived while it ran
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.lastSeq = 10000;
  ag.history = async () => { ag.lastSeq = 11000; return { entries: [{ seq: 2000, ts: 0, actor: "Bea", verb: "say", args: { text: "hi" } }], oldestSeq: 2000, hasMore: false }; };
  const ctx = ctxOf(ag); await handleTool(ctx, "catch_up", {});
  ok(ctx.cursor.caughtUpTo === 10000, "105 a say arriving mid-read stays unread: the cursor is the lastSeq from before the read", ctx.cursor); }

// #65 (bot2): past the 100-page cap, catch_up says which older says were not read, instead of calling the newest 20,000 the oldest
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.lastSeq = 30_000_000; let pages = 0;
  ag.history = async ({ before = 30_000_000 }: any) => { pages++; const page = Array.from({ length: 200 }, (_, i) => ({ seq: before - 200 * 1000 + i * 1000, ts: 0, actor: "Bea", verb: "say", args: { text: "x" } }));
    return { entries: page, oldestSeq: page[0].seq, hasMore: true }; };
  const ctx = ctxOf(ag); const out = textOf(await handleTool(ctx, "catch_up", { limit: 1 }));
  ok(pages === 100 && /not read/.test(out) && /world_history/.test(out) && /more remain/.test(out), "65 a run longer than 100 pages is named as unread older speech, with the way to read it", out.slice(-240)); }

// #28 (bot2): move {to: "?"} measures from where the body IS — its seat's composed position, as look() does
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.pos = { x: 0, y: 0, z: 0 };
  const thing = (id: string, pos: number[]) => ag.entities.set(id, { id, model: `zz/${id}.glb`, kind: "thing", pos, yaw: 0, actor: "x", scale: 1, places: { spot: { at: [0, 0, 0] } } });
  thing("near", [1, 0, 1]); thing("far", [99, 0, 99]);
  const standing = ag.placeList().split("\n")[1] ?? "";
  ag.mounts.set("me", { to: "ferry.seat" }); const eff0 = ag.eff.bind(ag); ag.eff = (id: string, t: number) => (id === "me" ? { ok: true, pos: [100, 0, 100], moving: null, seat: { state: "profiled" } } : eff0(id, t));
  const seated = ag.placeList().split("\n")[1] ?? "";
  ok(/near\/spot/.test(standing) && /far\/spot/.test(seated) && /\(1\.4 m/.test(seated), "28 seated far from where it boarded, the body's nearest place is the one by its seat", { standing, seated }); }

// #106 (bot2): anim {bodyMode, name} with a bad name changes nothing — the name is checked before the mode is declared
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); const before = ag.bodyMode;
  const r = await handleTool(ctxOf(ag), "anim", { bodyMode: "fly", name: "bad name" });
  ok(r?.isError === true && ag.bodyMode === before, "106 a refused anim name leaves the body-mode as it was", { before, after: ag.bodyMode, r: textOf(r) }); }

// #83 (bot2): a moderation reply's persistence warning reaches the agent's result
{ const ag: any = { request: async () => ({ ok: true, logged: "the moderator log", warning: "NOT persisted: .bans.json unwritable" }) };
  const out = textOf(await handleTool(ctxOf(ag), "act", { verb: "ban", args: { who: "u-aaaaaaaaaaaaaaaaaaaa" } }));
  ok(/done/.test(out) && /NOT persisted/.test(out), "83 ban: done, and the world's 'NOT persisted' warning with it", out); }

// #105: a fall below the world ends the walk's promise now (false), not at its timeout
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.replica = { st: { entities: { "@world": { c: {} } } } };
  let done: boolean | null = null; ag.target = { x: 5, z: 5 }; ag.walkDone = (v: boolean) => { done = v; };
  await ag.respawnFell();
  ok(done === false && ag.walkDone === null && ag.target === null, "105 respawnFell resolves the pending walk false at once", { done }); }

// #106: a say addressed to me (to) is a mention, so a closed channel still lets it through
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); const ev: any[] = []; ag.onEvent = (e: any) => ev.push(e);
  ag.hearSay({ seq: 5000, ts: 1, actor: "Bea", args: { text: "Hello there", to: "me" } }, true);
  ag.hearSay({ seq: 6000, ts: 2, actor: "Bea", args: { text: "Hello there", to: "Ann" } }, true);
  const says = ev.filter((e) => e.kind === "say");
  ok(says.length === 2 && says[0].mention === true && says[1].mention === false, "106 say {to: me} is a mention; say {to: someone else} is not", says); }


// bot #458: land {to: [null, 2]} is refused (Number(null) is 0, which used to pass)
{ const ag: any = { flight: null }; const r = await handleTool(ctxOf(ag), "act", { verb: "land", args: { to: [null, 2] } });
  ok(r?.isError === true && /land needs to/.test(textOf(r)), "458 land {to: [null, 2]} is refused, not landed at x=0", textOf(r)); }

// bot #454: move {to: "?"} is a listing, so a seat that holds you still answers it
{ const ag: any = { myOccupancy: { to: "swing" }, mayVacate: () => false, socketName: () => "the swing", placeList: (f: string) => `named places here${f}: none` };
  const r = await handleTool(ctxOf(ag), "move", { to: "?" });
  ok(!r?.isError && /^named places here/.test(textOf(r)), "454 move {to: \"?\"} lists places from a seat that holds you", textOf(r)); }

// bot #459: a malformed anim call (name AND joints) declares no body-mode
{ const ag: any = { bodyMode: "stand", anims: [], target: null, clip: "idle" };
  const r = await handleTool(ctxOf(ag), "anim", { bodyMode: "sit", name: "wave", joints: {} });
  ok(r?.isError === true && ag.bodyMode === "stand", "459 anim {bodyMode, name, joints} is refused and leaves the body-mode as it was", { text: textOf(r), bodyMode: ag.bodyMode }); }

// bot #462: a shove's refusal is the one naming its target; an unrelated error meanwhile is not read as the shove's
{ const mk = (err: string) => { const ag: any = { joined: false, people: new Map(), pos: { x: 0, y: 0, z: 0 }, lastRefusal: null, puppet() { ag.lastRefusal = { ts: Date.now(), text: err }; } }; return ag; };
  const other = await handleTool(ctxOf(mk("insufficient rank for that")), "act", { verb: "shove", args: { target: "Moss" } });
  const mine = await handleTool(ctxOf(mk("Moss isn't taking shove right now")), "act", { verb: "shove", args: { target: "Moss" } });
  ok(!other?.isError && /you shove Moss/.test(textOf(other)) && mine?.isError === true && /shove refused/.test(textOf(mine)),
    "462 shove reads only a refusal that names its target", { other: textOf(other), mine: textOf(mine) }); }

// bot #453: the track moved the body to the spawn before the first step: the legs are planned again from there
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.joined = true; ag.ws = { readyState: 1, send() {} };
  ag.replica = { st: { entities: { "@world": { c: { spawn: { pos: [20, 0, 20] } } } } } };
  let asked = 0; ag.request = async (verb: string, args: any) => (verb !== "move" ? { ok: true } : ++asked === 1 ? { refused: { code: "spawn" } } : { ok: true, at: args.to });
  const plannedFrom: number[] = []; const plan0 = ag.planWalk.bind(ag); ag.planWalk = (...a: any[]) => { plannedFrom.push(ag.pos.x); return plan0(...a); };
  const walk = ag.walkTo(2, 2); await tryUntil("the walk replanned from the spawn", () => plannedFrom.length >= 2, { ms: 3000 });
  const still = !!ag.walkDone; ag.stop(); await walk;
  ok(still && JSON.stringify(plannedFrom) === "[0,20]" && /spawn/.test(ag.lastWalkNote ?? ""), "453 a walk arriving at the spawn is planned again from the spawn", { plannedFrom, note: ag.lastWalkNote, still }); }

// bot #462: every targeted presence call (pose {clear}, a ragdoll, a tracks anim) still reports its target's refusal
{ const mk = () => { const ag: any = { name: "me", lastRefusal: null, animEnded() {}, puppet(to: string) { ag.lastRefusal = { ts: Date.now(), text: `${to} isn't taking pose right now` }; } }; return ag; };
  const outs = [await handleTool(ctxOf(mk()), "anim", { stop: true, target: "Moss" }), await handleTool(ctxOf(mk()), "anim", { ragdoll: true, target: "Moss" }),
    await handleTool(ctxOf(mk()), "anim", { tracks: { hips: [{ t: 0, q: [0, 0, 0, 1] }] }, dur: 1, target: "Moss" })];
  ok(outs.every((r) => r?.isError === true && /refused/.test(textOf(r))), "462 stop, ragdoll and tracks on a target each report its refusal", outs.map(textOf)); }

console.log(`tool-replies-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
