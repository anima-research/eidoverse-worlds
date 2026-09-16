// The `caption` verb at the door, and the bot's receipts against it — a
// self-booted scratch sequencer, real websockets (the guard-principal
// recipe without the issuer: plain ids, first joiner owns).
//
//   bun tools/caption-verb-test.ts
//
//   1. THE DEED — a visitor without it is refused with the grant line; a
//      builder without it is refused too (captioning is not a building
//      right); the owner grants it for one entity (a missing entity, or `*`,
//      is refused at the grant); the captioner then writes and keeps a
//      visitor's verbs (say yes, spawn no); a deed for one screen is no deed
//      for another; the owner passes without one.
//   2. ONCE-NESS — a duplicate n is refused before append (the log grows by
//      nothing); an old n likewise; an earlier session is refused; a later
//      session takes over and starts fresh; `end` clears the bag and a
//      second `end` is refused; the bag is server-written (comp refused).
//   3. GENERATION — remove the screen: the deed's target is gone; re-spawn
//      the same id with another lib: the deed is stale ("replaced"); the
//      owner grants again and it works. A lock on the screen does not gate
//      captions (the deed is the authority).
//   4. RECEIPTS (WorldClient) — accept: pending drains to zero on the echo;
//      disconnect BEFORE the receipt: the line is resent after reconnect and
//      the log holds it exactly once (the door's dedupe reads as the
//      receipt); a lost echo: the ack timeout resends, once again exactly one
//      durable entry; no deed: held, then flows after the grant lands.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldClient } from "./captionbot/world.ts";

const PORT = Number(process.env.PORT ?? 8998);
const HTTP = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DOOR = "test-door";
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; captions: any[]; snap: any; verb(v: string, a: any): void; settle(ms?: number): Promise<void>; close(): void };
function open(joinMsg: Record<string, unknown>): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const s: Sock = { ws, msgs: [], errors: [], captions: [], snap: null, verb(v, a) { ws.send(JSON.stringify({ type: "verb", verb: v, args: a })); }, settle(ms = 300) { return sleep(ms); }, close() { try { ws.close(); } catch {} } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: DOOR, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); if (m.type === "log" && m.entry?.verb === "caption") s.captions.push(m.entry); if (m.type === "snapshot") { s.snap = m; resolve(s); } };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("no snapshot in 4s")), 4000);
  });
}
async function folded(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const ent = eye.snap.state.entities?.[id]; eye.close(); return ent;
}
const last = (s: Sock) => s.errors.at(-1) ?? "no error";
const S1 = "2026-09-16T20:00:00.000Z-s001", S2 = "2026-09-16T21:00:00.000Z-s002", S0 = "2026-09-16T19:00:00.000Z-s000";
const cap = (session: string, n: number, t0: number, text: string, extra: Record<string, unknown> = {}) => ({ id: "cinema", session, n, t0, t1: t0 + 1, text, ...extra });

const worldsDir = mkdtempSync(join(tmpdir(), "ew-caption-"));
const optDir = mkdtempSync(join(tmpdir(), "ew-caption-opt-"));
const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR, SKIP_OPT_SWEEP: "1", VERB_RATE: "60" },
  stdout: "ignore", stderr: "inherit",
});
for (let i = 0; i < 80; i++) { try { await fetch(`${HTTP}/authcfg`); break; } catch { await sleep(150); } }

const WORLD = `caption-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\ncaption verb — world "${WORLD}"\n`);
try {
  const ra = await open({ id: "ra", world: WORLD });        // first joiner owns
  await ra.settle();
  const bob = await open({ id: "bob", world: WORLD });      // builder by the owned-world default
  const eye = await open({ id: "eye", world: WORLD, spectate: true });   // counts every caption entry the world broadcasts
  ra.verb("spawn", { id: "cinema", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  ra.verb("spawn", { id: "kiosk", lib: "deco/kiosk.glb", pos: [3, 0, 0], yaw: 0 });
  ra.verb("grant", { id: "capbot", role: "visitor" });
  await ra.settle();
  const capbot = await open({ id: "capbot", world: WORLD });
  await capbot.settle();

  console.log("— 1. the deed —");
  let before = capbot.errors.length;
  capbot.verb("caption", cap(S1, 1, 0, "hello"));
  await capbot.settle();
  check("a visitor without the deed is refused, and told the grant line", capbot.errors.length === before + 1 && /caption deed/.test(last(capbot)) && /grant \{id: <your id>, caption: "cinema"\}/.test(last(capbot)), last(capbot));
  before = bob.errors.length;
  bob.verb("caption", cap(S1, 1, 0, "hello"));
  await bob.settle();
  check("a BUILDER without the deed is refused too — captioning is not a building right", bob.errors.length === before + 1 && /caption deed/.test(last(bob)), last(bob));
  before = ra.errors.length;
  ra.verb("grant", { id: "capbot", caption: "nothing-here" });
  await ra.settle();
  check("granting a deed for an entity that does not exist is refused at the grant", ra.errors.length === before + 1 && /exists here/.test(last(ra)), last(ra));
  ra.verb("grant", { id: "*", caption: "cinema" });
  await ra.settle();
  check("…and so is a deed for everyone", ra.errors.length === before + 2 && /one captioner/.test(last(ra)), last(ra));
  before = bob.errors.length;
  bob.verb("grant", { id: "capbot", caption: "cinema" });
  await bob.settle();
  check("a builder cannot grant the deed (grant is owner rank)", bob.errors.length === before + 1, last(bob));
  ra.verb("grant", { id: "capbot", caption: "cinema" });
  await ra.settle();
  const eyeAfter = await open({ id: "eye2", world: WORLD, spectate: true });
  check("the owner grants it: the roles map carries {id, born} for capbot", eyeAfter.snap.state.roles?.capbot?.caption?.id === "cinema" && typeof eyeAfter.snap.state.roles?.capbot?.caption?.born === "number" && eyeAfter.snap.state.roles?.capbot?.role === "visitor", JSON.stringify(eyeAfter.snap.state.roles?.capbot));
  eyeAfter.close();
  // rights are pushed live after a grant; the bot's own snapshot is stale, so re-join to read yourRights
  capbot.close(); await sleep(300);
  const bot = await open({ id: "capbot", world: WORLD });
  await bot.settle();
  check("the captioner's snapshot says so (yourRights.caption)", bot.snap.yourRights?.caption?.id === "cinema" && bot.snap.yourRights?.role === "visitor", JSON.stringify(bot.snap.yourRights));
  before = bot.errors.length;
  bot.verb("caption", cap(S1, 1, 0, "we light the first candle", { title: "Solstice" }));
  await bot.settle();
  let c = await folded(WORLD, "cinema");
  check("the captioner writes: one line, folded into the bag with session, n, title", bot.errors.length === before && c?.comp?.captions?.session === S1 && c?.comp?.captions?.n === 1 && c?.comp?.captions?.title === "Solstice" && c?.comp?.captions?.window?.length === 1, bot.errors.slice(before).join("; ") + " " + JSON.stringify(c?.comp?.captions));
  check("…and the world broadcast exactly one caption entry", eye.captions.length === 1, String(eye.captions.length));
  bot.verb("say", { text: "testing, testing" });
  bot.verb("spawn", { id: "rogue", lib: "deco/crate.glb", pos: [1, 0, 1], yaw: 0 });
  await bot.settle();
  check("the captioner keeps a visitor's verbs: say lands, spawn is refused by rank", bot.errors.length === before + 1 && /builder rights/.test(last(bot)) && !(await folded(WORLD, "rogue")), last(bot));
  before = bot.errors.length;
  bot.verb("caption", { ...cap(S1, 1, 0, "hello kiosk"), id: "kiosk" });
  await bot.settle();
  check("a deed for cinema is no deed for kiosk", bot.errors.length === before + 1 && /deed is for "cinema", not "kiosk"/.test(last(bot)), last(bot));
  before = ra.errors.length;
  ra.verb("caption", { ...cap(S1, 1, 0, "the owner may"), id: "kiosk" });
  await ra.settle();
  check("the owner captions anything without a deed", ra.errors.length === before && (await folded(WORLD, "kiosk"))?.comp?.captions?.n === 1, ra.errors.slice(before).join("; "));

  console.log("— 2. once-ness —");
  const n0 = eye.captions.length;
  before = bot.errors.length;
  bot.verb("caption", cap(S1, 1, 5, "a resend of line 1"));
  await bot.settle();
  check("a duplicate n is refused BEFORE append", bot.errors.length === before + 1 && /duplicate or out of order/.test(last(bot)), last(bot));
  bot.verb("caption", cap(S1, 3, 6, "skipping ahead is fine"));
  bot.verb("caption", cap(S1, 2, 7, "but going back is not"));
  await bot.settle();
  check("n may skip forward; an n at or below the high-water is refused", bot.errors.length === before + 2 && /n=2 is not after the folded high-water n=3/.test(last(bot)), last(bot));
  check("…the log grew by exactly the accepted line", eye.captions.length === n0 + 1, `${eye.captions.length - n0}`);
  bot.verb("caption", cap(S0, 1, 0, "a stale predecessor"));
  await bot.settle();
  check("an EARLIER session is refused", bot.errors.length === before + 3 && /earlier than the active session/.test(last(bot)), last(bot));
  bot.verb("caption", cap(S2, 1, 0, "a fresh attach"));
  await bot.settle();
  c = await folded(WORLD, "cinema");
  check("a LATER session takes over and starts a fresh window (n=1, one line, no inherited title)", bot.errors.length === before + 3 && c?.comp?.captions?.session === S2 && c?.comp?.captions?.n === 1 && c?.comp?.captions?.window?.length === 1 && c?.comp?.captions?.title === undefined, JSON.stringify(c?.comp?.captions));
  before = bob.errors.length;
  bob.verb("comp", { id: "cinema", type: "captions", data: { session: S2, n: 99, window: [] } });
  await bob.settle();
  check("the bag is server-written: a builder's comp {type: captions} is refused", bob.errors.length === before + 1 && /written by the caption verb/.test(last(bob)) && (await folded(WORLD, "cinema"))?.comp?.captions?.n === 1, last(bob));
  before = bot.errors.length;
  bot.verb("caption", { id: "cinema", session: S1, end: true });
  await bot.settle();
  check("an end for a session the screen has left is refused", bot.errors.length === before + 1 && /captioned under session/.test(last(bot)), last(bot));
  bot.verb("caption", { id: "cinema", session: S2, end: true });
  await bot.settle();
  check("an end for the current session clears the bag", bot.errors.length === before + 1 && (await folded(WORLD, "cinema"))?.comp?.captions === undefined);
  bot.verb("caption", { id: "cinema", session: S2, end: true });
  await bot.settle();
  check("a second end is refused (idempotent at the door, once in the log)", bot.errors.length === before + 2 && /no captions to end/.test(last(bot)), last(bot));

  console.log("— 3. generation —");
  ra.verb("comp", { id: "cinema", type: "lock", data: true });
  await ra.settle();
  before = bot.errors.length;
  bot.verb("caption", cap(S2, 2, 10, "a locked screen still captions"));
  await bot.settle();
  check("a lock on the screen does not gate captions (the deed is the authority)", bot.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions?.n === 2, bot.errors.slice(before).join("; "));
  ra.verb("comp", { id: "cinema", type: "lock", data: null });
  ra.verb("remove", { id: "cinema" });
  await ra.settle();
  bot.verb("caption", cap(S2, 3, 11, "into the void"));
  await bot.settle();
  check("the screen removed: the deed names nothing", bot.errors.length === before + 1 && /no longer exists/.test(last(bot)), last(bot));
  ra.verb("spawn", { id: "cinema", lib: "deco/other-screen.glb", pos: [0, 0, 0], yaw: 0 });
  await ra.settle();
  bot.verb("caption", cap(S2, 3, 11, "a different thing wearing the name"));
  await bot.settle();
  check("the id re-spawned as a different thing: the deed is stale, not transferred", bot.errors.length === before + 2 && /was replaced since the caption deed was granted/.test(last(bot)), last(bot));
  ra.verb("grant", { id: "capbot", caption: "cinema" });
  await ra.settle();
  bot.verb("caption", cap(S2, 3, 11, "granted again"));
  await bot.settle();
  check("granted again for the new object: it works", bot.errors.length === before + 2 && (await folded(WORLD, "cinema"))?.comp?.captions?.window?.[0]?.text === "granted again", bot.errors.slice(before + 2).join("; "));
  ra.verb("grant", { id: "capbot", caption: null });
  await ra.settle();
  bot.verb("caption", cap(S2, 4, 12, "after revocation"));
  await bot.settle();
  check("caption: null revokes", bot.errors.length === before + 3 && /caption deed/.test(last(bot)), last(bot));
  bot.close();

  console.log("— 4. receipts (WorldClient) —");
  ra.verb("remove", { id: "cinema" });
  ra.verb("spawn", { id: "cinema", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  await ra.settle();
  ra.verb("grant", { id: "capbot", caption: "cinema" });
  await ra.settle();
  const logs: string[] = [];
  const S3 = "2026-09-16T22:00:00.000Z-s003";
  const w = new WorldClient({ url: WS_URL, token: DOOR, world: WORLD, actor: "capbot", screenId: "cinema", title: "a film", session: S3, paceMs: 30, ackTimeoutMs: 400, deedRetryMs: 300, agent: false, log: (m) => logs.push(m) });
  w.connect();
  await sleep(400);
  const nA = eye.captions.length;
  w.caption({ t0: 0, t1: 1, text: "one" }); w.caption({ t0: 1, t1: 2, text: "two" }); w.caption({ t0: 2, t1: 3, text: "three" });
  await sleep(600);
  check("accept: three lines sent, three receipts, nothing pending", w.sent === 3 && w.acked === 3 && w.pendingCount === 0 && eye.captions.length === nA + 3, `sent=${w.sent} acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nA}`);
  check("…the title rode the first line only", eye.captions[nA].args.title === "a film" && eye.captions[nA + 1].args.title === undefined);
  // disconnect BEFORE the receipt: close the socket the instant the line goes out
  const nB = eye.captions.length;
  let cut = false;
  (w as any).opts.onSend = () => { if (!cut) { cut = true; (w as any).ws.close(); } };
  w.caption({ t0: 3, t1: 4, text: "four, sent into a closing socket" });
  await sleep(2600);   // reconnect is 1.5 s
  (w as any).opts.onSend = undefined;
  check("disconnect before the receipt: the line is resent after reconnect and lands EXACTLY once", w.acked === 4 && w.pendingCount === 0 && eye.captions.filter((e: any) => e.args.n === 4).length === 1, `acked=${w.acked} pending=${w.pendingCount} n4×${eye.captions.filter((e: any) => e.args.n === 4).length} logs=${JSON.stringify(logs.slice(-3))}`);
  check("…and the log grew by exactly one", eye.captions.length === nB + 1, `${eye.captions.length - nB}`);
  // a lost echo: swallow the next receipt so the ack timeout fires and resends
  const nC = eye.captions.length;
  const origEcho = (w as any).onEcho.bind(w);
  let swallowed = 0;
  (w as any).onEcho = (args: any) => { if (swallowed === 0) { swallowed++; return; } origEcho(args); };
  w.caption({ t0: 4, t1: 5, text: "five, whose receipt goes missing" });
  await sleep(1200);
  check("a lost receipt: the ack timeout resends, the door's dedupe answers, read as the receipt — one durable entry", swallowed === 1 && w.acked === 5 && w.pendingCount === 0 && eye.captions.length === nC + 1 && logs.some((l) => /no receipt for/.test(l)), `acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nC}`);
  // no deed: held, then flows once the owner grants
  ra.verb("grant", { id: "capbot", caption: null });
  await ra.settle();
  const nD = eye.captions.length;
  w.caption({ t0: 5, t1: 6, text: "six, without a deed" });
  await sleep(300);
  check("no deed: the line is HELD (not dropped), said once", w.pendingCount === 1 && w.acked === 5 && logs.some((l) => /⛔ held \(1 pending\)/.test(l)), `pending=${w.pendingCount} ${JSON.stringify(logs.slice(-2))}`);
  ra.verb("grant", { id: "capbot", caption: "cinema" });
  await ra.settle();
  await sleep(700);
  check("…and flows after the grant lands, exactly once", w.acked === 6 && w.pendingCount === 0 && eye.captions.length === nD + 1, `acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nD}`);
  w.end();
  await sleep(300);
  check("end is confirmed by its own echo and the bag is gone", w.acked === 7 && (await folded(WORLD, "cinema"))?.comp?.captions === undefined, `acked=${w.acked}`);
  check("no line was ever refused for good", w.refused === 0 && w.overflow === 0);
  w.close();
  for (const s of [ra, bob, eye]) s.close();
} finally {
  proc.kill();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
