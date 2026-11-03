// mcpl/tool-replies-test.ts — what the agent's tools and body say and send, pure (no server): one row per bot review #260
// finding (38, 41, 53, 62, 63, 92, 105, 106, 107), each red on aeaf71de5.
// run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun mcpl/tool-replies-test.ts
import { WorldAgent } from "./agent.ts";
import { handleTool } from "./tools.ts";
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

// #41 (tool side): ban {global: true, days} sends the days with the global ban
{ const sent: any[] = []; const ag: any = { sendMod: (type: string, args: any) => sent.push({ type, ...args }), modOutcome: async () => "u-x is banned from all worlds" };
  await handleTool(ctxOf(ag), "act", { verb: "ban", args: { who: "Moss", days: 2, global: true } });
  ok(sent.length === 1 && sent[0].type === "global-ban" && sent[0].days === 2, "41 ban {global, days} sends days to the server", sent); }

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
  const all = Array.from({ length: 70 }, (_, i) => ({ seq: (i + 1) * 1000, ts: i, actor: "Bob", verb: "say", args: { text: `line ${i + 1}` } }));
  ag.lastSeq = 70000;
  // the server's paging (worldlog.ts readHistory): the newest `limit` after `after`, before `before`, hasMore when older remain
  ag.history = async ({ after = -Infinity, before = Infinity, limit = 50 }: any) => { const m = all.filter((e) => e.seq > after && e.seq < before);
    const page = m.slice(-limit); return { entries: page, oldestSeq: page[0]?.seq ?? null, hasMore: m.length > page.length }; };
  const ctx = ctxOf(ag); const one = textOf(await handleTool(ctx, "catch_up", {})), two = textOf(await handleTool(ctx, "catch_up", {}));
  ok(/^60 message/.test(one) && /line 1\n/.test(one) && /more remain/.test(one) && /^10 message/.test(two) && /line 61\n/.test(two) && /line 70$/.test(two),
    "63 70 lines: catch_up shows the first 60 and says more remain; the next shows the last 10", { one: one.slice(0, 120), two: two.slice(0, 120) }); }

// #105: a fall below the world ends the walk's promise now (false), not at its timeout
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); ag.replica = { st: { entities: { "@world": { c: {} } } } };
  let done: boolean | null = null; ag.target = { x: 5, z: 5 }; ag.walkDone = (v: boolean) => { done = v; };
  await ag.respawnFell();
  ok(done === false && ag.walkDone === null && ag.target === null, "105 respawnFell resolves the pending walk false at once", { done }); }

// #106: a say addressed to me (to) is a mention, so a closed channel still lets it through
{ const ag: any = new WorldAgent({ name: "me", world: "w" }); const ev: any[] = []; ag.onEvent = (e: any) => ev.push(e);
  ag.hearSay({ seq: 5000, ts: 1, actor: "Bob", args: { text: "Hello there", to: "me" } }, true);
  ag.hearSay({ seq: 6000, ts: 2, actor: "Bob", args: { text: "Hello there", to: "Ann" } }, true);
  const says = ev.filter((e) => e.kind === "say");
  ok(says.length === 2 && says[0].mention === true && says[1].mention === false, "106 say {to: me} is a mention; say {to: someone else} is not", says); }

console.log(`tool-replies-test: ${fails ? `${fails} failed` : "all ok"}`); process.exit(fails ? 1 : 0);
