// The `caption` verb at the door, and the bot's receipts against it — a
// self-booted scratch sequencer with a scratch Archipelago issuer (the
// guard-principal recipe), real websockets, cookies for the vouched-for.
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
//      nothing); an old n likewise; `end` clears the bag and a second `end`
//      is refused; the bag is server-written (comp refused).
//   3. GENERATION OF THE THING — remove the screen: the deed's target is
//      gone; re-spawn the same id with another lib: the deed is stale
//      ("replaced"); the owner grants again and it works. A lock on the
//      screen does not gate captions (the deed is the authority).
//   4. RECEIPTS (WorldClient) — accept; disconnect BEFORE the receipt (resent
//      after reconnect, exactly once in the log); a lost echo (the ack
//      timeout resends, the door's dedupe reads as the receipt); no deed
//      (held, then flows after the grant).
//   5. THE DEED FOLLOWS THE SUB — granted while the subject is present with
//      a durable sub, it survives the subject's rename (same sub, new name)
//      and is not worn by an impostor under the old name.
//   6. THE LIVE LEG — the sequencer's generation decides who captions:
//      a same-identity rejoin (a takeover) continues, its session under a
//      rolled-back clock still takes over; a second deed-holder that joins
//      later supersedes the first, whose next line is refused and whose
//      rejoin (a newer leg) wins it back; the owner recovers with `end`.
//   7. A SEQUENCER RESTART — the bag's generation is in the log; the
//      sequencer stops (SIGTERM folds + flushes) and reopens the same world;
//      the reloaded fold carries the bag and the rights; the first captioner
//      of the new opening is not stranded (its generation is bound to the
//      opening's log seq, higher than anything a previous opening issued).
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from "node:crypto";
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

// ---- scratch issuer (authtest.ts's recipe) ----
const pair = generateKeyPairSync("ed25519");
const spki = createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }) as Buffer;
const ISSUER_ID = `ed25519:${spki.subarray(spki.length - 32).toString("base64url")}`;
const ISS = "id.test";
let jtiN = 0;
function mint(sub: string, name: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iss: ISS, sub, kind: "human", name, aud: "eidoverse", scopes: ["worlds:join", "worlds:spectate"], iat: now, exp: now + 600, jti: `t${jtiN++}` };
  const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(`aid1.${seg}`), pair.privateKey);
  return `aid1.${seg}.${sig.toString("base64url")}`;
}
async function cookieFor(sub: string, name: string): Promise<string> {
  const r = await fetch(`${HTTP}/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: mint(sub, name) }) });
  const cookie = /ew_sess=[a-f0-9]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
  if (!cookie) throw new Error(`auth ${r.status}: ${await r.text()}`);
  return cookie;
}

type Sock = { ws: WebSocket; msgs: any[]; errors: string[]; captions: any[]; snap: any; closed: boolean; verb(v: string, a: any): void; settle(ms?: number): Promise<void>; close(): void };
function open(joinMsg: Record<string, unknown>, cookie = ""): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, cookie ? ({ headers: { cookie } } as any) : undefined);
    const s: Sock = { ws, msgs: [], errors: [], captions: [], snap: null, closed: false, verb(v, a) { ws.send(JSON.stringify({ type: "verb", verb: v, args: a })); }, settle(ms = 300) { return sleep(ms); }, close() { try { ws.close(); } catch {} } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: DOOR, ...joinMsg }));
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.msgs.push(m); if (m.type === "error") s.errors.push(m.error); if (m.type === "log" && m.entry?.verb === "caption") s.captions.push(m.entry); if (m.type === "snapshot") { s.snap = m; resolve(s); } };
    ws.onclose = () => { s.closed = true; };
    ws.onerror = (e) => reject(e);
    setTimeout(() => reject(new Error("no snapshot in 4s")), 4000);
  });
}
async function folded(world: string, id: string): Promise<any> {
  const eye = await open({ id: `eye-${Math.random().toString(36).slice(2, 6)}`, world, spectate: true });
  const ent = eye.snap.state.entities?.[id]; eye.close(); return ent;
}
const last = (s: Sock) => s.errors.at(-1) ?? "no error";
const S1 = "2026-09-16T20:00:00.000Z-s001", S2 = "2026-09-16T21:00:00.000Z-s002", S_BACK = "2026-09-16T01:00:00.000Z-back";
const cap = (session: string, n: number, t0: number, text: string, extra: Record<string, unknown> = {}) => ({ id: "cinema", session, n, t0, t1: t0 + 1, text, ...extra });

const worldsDir = mkdtempSync(join(tmpdir(), "ew-caption-"));
const optDir = mkdtempSync(join(tmpdir(), "ew-caption-opt-"));
function boot() {
  return Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "server", "server.ts")], {
    env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, OPT_DIR: optDir, JOIN_TOKEN: DOOR, SKIP_OPT_SWEEP: "1", VERB_RATE: "60", HN_ISSUER_KEY: ISSUER_ID, HN_ISS: ISS, HN_REQUIRE_LOGIN: "0" },
    stdout: "ignore", stderr: "inherit",
  });
}
async function up() { for (let i = 0; i < 80; i++) { try { await fetch(`${HTTP}/authcfg`); return; } catch { await sleep(150); } } throw new Error("server never came up"); }
let proc = boot();
await up();

const WORLD = `caption-${Math.random().toString(36).slice(2, 8)}`;
console.log(`\ncaption verb — world "${WORLD}"\n`);
try {
  const SUB_RA = "human:discord:9001", SUB_CAP = "human:discord:9002", SUB_BOB = "human:discord:9003", SUB_ZED = "human:discord:9004";
  let ra = await open({ id: "ra", world: WORLD }, await cookieFor(SUB_RA, "Ra"));        // first joiner owns
  await ra.settle();
  const bob = await open({ id: "bob", world: WORLD }, await cookieFor(SUB_BOB, "Bob"));   // builder by the owned-world default
  let eye = await open({ id: "eye", world: WORLD, spectate: true });   // counts every caption entry the world broadcasts
  ra.verb("spawn", { id: "cinema", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  ra.verb("spawn", { id: "kiosk", lib: "deco/kiosk.glb", pos: [3, 0, 0], yaw: 0 });
  await ra.settle();
  // the door names a vouched-for joiner after the token, so read names from snapshots
  const RA = ra.snap.you as string, BOB = bob.snap.you as string;
  let capbot = await open({ id: "capbot", world: WORLD }, await cookieFor(SUB_CAP, "Capbot"));
  await capbot.settle();
  const CAP = capbot.snap.you as string;
  ra.verb("grant", { id: CAP, role: "visitor" });
  await ra.settle();

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
  ra.verb("grant", { id: CAP, caption: "nothing-here" });
  await ra.settle();
  check("granting a deed for an entity that does not exist is refused at the grant", ra.errors.length === before + 1 && /exists here/.test(last(ra)), last(ra));
  ra.verb("grant", { id: "*", caption: "cinema" });
  await ra.settle();
  check("…and so is a deed for everyone", ra.errors.length === before + 2 && /one captioner/.test(last(ra)), last(ra));
  before = bob.errors.length;
  bob.verb("grant", { id: CAP, caption: "cinema" });
  await bob.settle();
  check("a builder cannot grant the deed (grant is owner rank)", bob.errors.length === before + 1, last(bob));
  ra.verb("grant", { id: CAP, caption: "cinema" });
  await ra.settle();
  const eyeAfter = await open({ id: "eye2", world: WORLD, spectate: true });
  check("the owner grants it: the roles map carries {id, born} for the captioner, bound to its sub", eyeAfter.snap.state.roles?.[CAP]?.caption?.id === "cinema" && typeof eyeAfter.snap.state.roles?.[CAP]?.caption?.born === "number" && eyeAfter.snap.state.roles?.[CAP]?.role === "visitor" && eyeAfter.snap.state.roles?.[CAP]?.sub === SUB_CAP, JSON.stringify(eyeAfter.snap.state.roles?.[CAP]));
  eyeAfter.close();
  capbot.close(); await sleep(300);
  capbot = await open({ id: "capbot", world: WORLD }, await cookieFor(SUB_CAP, "Capbot"));
  await capbot.settle();
  check("the captioner's snapshot says so (yourRights.caption)", capbot.snap.yourRights?.caption?.id === "cinema" && capbot.snap.yourRights?.role === "visitor", JSON.stringify(capbot.snap.yourRights));
  before = capbot.errors.length;
  capbot.verb("caption", cap(S1, 1, 0, "we light the first candle", { title: "Solstice", gen: 999 }));
  await capbot.settle();
  let c = await folded(WORLD, "cinema");
  check("the captioner writes: one line, folded into the bag with session, n, title — and the SERVER's generation, not the client's 999", capbot.errors.length === before && c?.comp?.captions?.session === S1 && c?.comp?.captions?.n === 1 && c?.comp?.captions?.title === "Solstice" && c?.comp?.captions?.window?.length === 1 && Number.isInteger(c?.comp?.captions?.gen) && c.comp.captions.gen !== 999 && c.comp.captions.gen > 0, capbot.errors.slice(before).join("; ") + " " + JSON.stringify(c?.comp?.captions));
  const GEN_A = c.comp.captions.gen as number;
  check("…and the world broadcast exactly one caption entry, stamped", eye.captions.length === 1 && eye.captions[0].args.gen === GEN_A, String(eye.captions.length));
  capbot.verb("say", { text: "testing, testing" });
  capbot.verb("spawn", { id: "rogue", lib: "deco/crate.glb", pos: [1, 0, 1], yaw: 0 });
  await capbot.settle();
  check("the captioner keeps a visitor's verbs: say lands, spawn is refused by rank", capbot.errors.length === before + 1 && /builder rights/.test(last(capbot)) && !(await folded(WORLD, "rogue")), last(capbot));
  before = capbot.errors.length;
  capbot.verb("caption", { ...cap(S1, 1, 0, "hello kiosk"), id: "kiosk" });
  await capbot.settle();
  check("a deed for cinema is no deed for kiosk", capbot.errors.length === before + 1 && /deed is for "cinema", not "kiosk"/.test(last(capbot)), last(capbot));
  before = ra.errors.length;
  ra.verb("caption", { ...cap(S1, 1, 0, "the owner may"), id: "kiosk" });
  await ra.settle();
  check("the owner captions anything without a deed", ra.errors.length === before && (await folded(WORLD, "kiosk"))?.comp?.captions?.n === 1, ra.errors.slice(before).join("; "));

  console.log("— 2. once-ness —");
  const n0 = eye.captions.length;
  before = capbot.errors.length;
  capbot.verb("caption", cap(S1, 1, 5, "a resend of line 1"));
  await capbot.settle();
  check("a duplicate n is refused BEFORE append", capbot.errors.length === before + 1 && /duplicate or out of order/.test(last(capbot)), last(capbot));
  capbot.verb("caption", cap(S1, 3, 6, "skipping ahead is fine"));
  capbot.verb("caption", cap(S1, 2, 7, "but going back is not"));
  await capbot.settle();
  check("n may skip forward; an n at or below the high-water is refused", capbot.errors.length === before + 2 && /n=2 is not after the folded high-water n=3/.test(last(capbot)), last(capbot));
  check("…the log grew by exactly the accepted line", eye.captions.length === n0 + 1, `${eye.captions.length - n0}`);
  capbot.verb("caption", cap(S2, 1, 0, "a fresh attach: the same leg, a new clock"));
  await capbot.settle();
  c = await folded(WORLD, "cinema");
  check("a new session from the live leg starts a fresh window (n=1, one line, no inherited title)", capbot.errors.length === before + 2 && c?.comp?.captions?.session === S2 && c?.comp?.captions?.n === 1 && c?.comp?.captions?.window?.length === 1 && c?.comp?.captions?.title === undefined, JSON.stringify(c?.comp?.captions));
  before = bob.errors.length;
  bob.verb("comp", { id: "cinema", type: "captions", data: { session: S2, n: 99, window: [] } });
  await bob.settle();
  check("the bag is server-written: a builder's comp {type: captions} is refused", bob.errors.length === before + 1 && /written by the caption verb/.test(last(bob)) && (await folded(WORLD, "cinema"))?.comp?.captions?.n === 1, last(bob));
  before = capbot.errors.length;
  capbot.verb("caption", { id: "cinema", session: S1, end: true });
  await capbot.settle();
  check("an end for a session the screen has left is refused", capbot.errors.length === before + 1 && /captioned under session/.test(last(capbot)), last(capbot));
  capbot.verb("caption", { id: "cinema", session: S2, end: true });
  await capbot.settle();
  check("an end for the current session clears the bag", capbot.errors.length === before + 1 && (await folded(WORLD, "cinema"))?.comp?.captions === undefined);
  capbot.verb("caption", { id: "cinema", session: S2, end: true });
  await capbot.settle();
  check("a second end is refused (idempotent at the door, once in the log)", capbot.errors.length === before + 2 && /no captions to end/.test(last(capbot)), last(capbot));

  console.log("— 3. generation of the thing —");
  ra.verb("comp", { id: "cinema", type: "lock", data: true });
  await ra.settle();
  before = capbot.errors.length;
  capbot.verb("caption", cap(S2, 2, 10, "a locked screen still captions"));
  await capbot.settle();
  check("a lock on the screen does not gate captions (the deed is the authority)", capbot.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions?.n === 2, capbot.errors.slice(before).join("; "));
  ra.verb("comp", { id: "cinema", type: "lock", data: null });
  ra.verb("remove", { id: "cinema" });
  await ra.settle();
  capbot.verb("caption", cap(S2, 3, 11, "into the void"));
  await capbot.settle();
  check("the screen removed: the deed names nothing", capbot.errors.length === before + 1 && /no longer exists/.test(last(capbot)), last(capbot));
  ra.verb("spawn", { id: "cinema", lib: "deco/other-screen.glb", pos: [0, 0, 0], yaw: 0 });
  await ra.settle();
  capbot.verb("caption", cap(S2, 3, 11, "a different thing wearing the name"));
  await capbot.settle();
  check("the id re-spawned as a different thing: the deed is stale, not transferred", capbot.errors.length === before + 2 && /was replaced since the caption deed was granted/.test(last(capbot)), last(capbot));
  ra.verb("grant", { id: CAP, caption: "cinema" });
  await ra.settle();
  capbot.verb("caption", cap(S2, 3, 11, "granted again"));
  await capbot.settle();
  check("granted again for the new object: it works", capbot.errors.length === before + 2 && (await folded(WORLD, "cinema"))?.comp?.captions?.window?.[0]?.text === "granted again", capbot.errors.slice(before + 2).join("; "));
  ra.verb("grant", { id: CAP, caption: null });
  await ra.settle();
  capbot.verb("caption", cap(S2, 4, 12, "after revocation"));
  await capbot.settle();
  check("caption: null revokes", capbot.errors.length === before + 3 && /caption deed/.test(last(capbot)), last(capbot));

  console.log("— 5. the deed follows the sub —");
  ra.verb("grant", { id: CAP, caption: "cinema" });
  await ra.settle();
  capbot.close(); await sleep(300);
  const renamed = await open({ id: "captioner-two", world: WORLD }, await cookieFor(SUB_CAP, "Captioner Two"));   // same sub, a new name
  await renamed.settle();
  const RENAMED = renamed.snap.you as string;
  check("…the renamed captioner really wears a different display name", RENAMED !== CAP && RENAMED !== "capbot", `${CAP} → ${RENAMED}`);
  check("its snapshot carries the deed under the new name (rightsIn found the grant by sub)", renamed.snap.yourRights?.caption?.id === "cinema" && renamed.snap.yourRights?.role === "visitor", JSON.stringify(renamed.snap.yourRights));
  before = renamed.errors.length;
  renamed.verb("caption", cap(S2, 4, 12, "same subject, new name"));
  await renamed.settle();
  check("…and it captions", renamed.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions?.n === 4, renamed.errors.slice(before).join("; "));
  const impostor = await open({ id: "capbot", world: WORLD }, await cookieFor(SUB_ZED, "Capbot"));   // the OLD name, another subject
  await impostor.settle();
  check("an impostor under the old name has no deed and the wildcard's rank", impostor.snap.yourRights?.caption === undefined && impostor.snap.yourRights?.role === "builder", JSON.stringify(impostor.snap.yourRights));
  before = impostor.errors.length;
  impostor.verb("caption", cap(S2, 5, 13, "wearing the nameplate"));
  await impostor.settle();
  check("…and is refused", impostor.errors.length === before + 1 && /caption deed/.test(last(impostor)), last(impostor));
  impostor.close();
  // a regrant under the NEW name continues the subject's record and retires the old one
  ra.verb("grant", { id: RENAMED, caption: "kiosk" });
  await ra.settle();
  const eyeR = await open({ id: "eye3", world: WORLD, spectate: true });
  check("a regrant under the new name: one record for the subject, under the new name, with the new deed", eyeR.snap.state.roles?.[CAP] === undefined && eyeR.snap.state.roles?.[RENAMED]?.caption?.id === "kiosk" && eyeR.snap.state.roles?.[RENAMED]?.sub === SUB_CAP && Object.values(eyeR.snap.state.roles ?? {}).filter((r: any) => r.sub === SUB_CAP).length === 1, JSON.stringify(eyeR.snap.state.roles));
  eyeR.close();
  before = renamed.errors.length;
  renamed.verb("caption", cap(S2, 5, 13, "cinema, under the old deed"));
  renamed.verb("caption", { ...cap(S2, 1, 0, "kiosk, under the new deed"), id: "kiosk" });
  await renamed.settle();
  check("…the obsolete deed does not win: cinema refused, kiosk accepted", renamed.errors.length === before + 1 && /deed is for "kiosk", not "cinema"/.test(last(renamed)) && (await folded(WORLD, "kiosk"))?.comp?.captions?.window?.at(-1)?.text === "kiosk, under the new deed", renamed.errors.slice(before).join("; "));
  ra.verb("grant", { id: RENAMED, caption: "cinema" });
  await ra.settle();

  console.log("— 6. the live leg —");
  c = await folded(WORLD, "cinema");
  const GEN_R = c.comp.captions.gen as number;
  check("the bag records the live leg's generation", Number.isInteger(GEN_R) && GEN_R > GEN_A, String(GEN_R));
  // a same-identity rejoin is a TAKEOVER: the server retires the old leg
  const rejoin = await open({ id: "captioner-two", world: WORLD }, await cookieFor(SUB_CAP, "Captioner Two"));
  await rejoin.settle(500);
  check("a same-identity rejoin retires the old leg (the server's takeover)", renamed.closed === true, `old closed=${renamed.closed}`);
  before = rejoin.errors.length;
  rejoin.verb("caption", cap(S_BACK, 1, 0, "restarted under a rolled-back clock"));
  await rejoin.settle();
  c = await folded(WORLD, "cinema");
  check("the rejoined leg takes over with an EARLIER-looking session: the door reads its generation, not its clock", rejoin.errors.length === before && c?.comp?.captions?.session === S_BACK && c?.comp?.captions?.gen > GEN_R && c?.comp?.captions?.window?.length === 1, rejoin.errors.slice(before).join("; ") + " " + JSON.stringify(c?.comp?.captions));
  const GEN_B = c.comp.captions.gen as number;
  // a SECOND captioner (another identity) with its own deed joins later: it supersedes
  ra.verb("grant", { id: BOB, caption: "cinema" });
  await ra.settle();
  bob.close(); await sleep(300);
  const bob2 = await open({ id: "bob", world: WORLD }, await cookieFor(SUB_BOB, "Bob"));   // a newer leg than the rejoined captioner
  await bob2.settle();
  before = bob2.errors.length;
  bob2.verb("caption", cap(S2, 1, 0, "a second captioner, joined later"));
  await bob2.settle();
  c = await folded(WORLD, "cinema");
  check("a later-joined deed-holder supersedes: its line is taken and the bag follows its generation", bob2.errors.length === before && c?.comp?.captions?.gen > GEN_B && c?.comp?.captions?.session === S2, bob2.errors.slice(before).join("; ") + " " + JSON.stringify(c?.comp?.captions));
  before = rejoin.errors.length;
  rejoin.verb("caption", cap(S_BACK, 2, 1, "the earlier leg, still connected"));
  await rejoin.settle();
  check("the earlier leg's next line is refused as superseded, whatever its session", rejoin.errors.length === before + 1 && /superseded captioner/.test(last(rejoin)) && /generation/.test(last(rejoin)), last(rejoin));
  rejoin.verb("caption", { id: "cinema", session: S_BACK, end: true });
  await rejoin.settle();
  check("…and so is its end", rejoin.errors.length === before + 2 && /superseded/.test(last(rejoin)), last(rejoin));
  rejoin.close(); await sleep(300);
  const rejoin2 = await open({ id: "captioner-two", world: WORLD }, await cookieFor(SUB_CAP, "Captioner Two"));   // newer than bob2
  await rejoin2.settle();
  before = rejoin2.errors.length;
  rejoin2.verb("caption", cap(S1, 1, 0, "back, as the newest leg"));
  await rejoin2.settle();
  check("its rejoin is a newer leg and wins the screen back", rejoin2.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions?.session === S1, rejoin2.errors.slice(before).join("; "));
  before = bob2.errors.length;
  bob2.verb("caption", cap(S2, 2, 1, "bob, now the older leg"));
  await bob2.settle();
  check("…and the other is now the superseded one", bob2.errors.length === before + 1 && /superseded/.test(last(bob2)), last(bob2));
  // owner recovery: end clears whatever leg holds it; the next caption starts fresh from anyone with a deed
  before = ra.errors.length;
  ra.verb("caption", { id: "cinema", session: S1, end: true });
  await ra.settle();
  check("the owner ends it regardless of generation", ra.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions === undefined, ra.errors.slice(before).join("; "));
  before = bob2.errors.length;
  bob2.verb("caption", cap(S2, 3, 2, "after the owner's end, the older leg may start again"));
  await bob2.settle();
  check("after the owner's end there is no generation to be behind: any deed-holder starts fresh", bob2.errors.length === before && (await folded(WORLD, "cinema"))?.comp?.captions?.window?.length === 1, bob2.errors.slice(before).join("; "));
  ra.verb("grant", { id: BOB, caption: null });
  ra.verb("caption", { id: "cinema", session: S2, end: true });
  await ra.settle();
  bob2.close(); rejoin2.close();

  console.log("— 7. a sequencer restart —");
  // the bag holds a generation from THIS opening; the sequencer stops
  // (SIGTERM folds and flushes), reopens the same world dir, and the first
  // captioner of the new opening must not be stranded behind it
  ra.verb("grant", { id: RENAMED, caption: "cinema" });
  await ra.settle();
  const rejoin3 = await open({ id: "captioner-two", world: WORLD }, await cookieFor(SUB_CAP, "Captioner Two"));
  await rejoin3.settle();
  rejoin3.verb("caption", cap(S1, 1, 0, "before the restart"));
  await rejoin3.settle();
  c = await folded(WORLD, "cinema");
  const GEN_PRE = c.comp.captions.gen as number;
  check("before: the bag carries this opening's generation", Number.isInteger(GEN_PRE) && GEN_PRE > 0, String(GEN_PRE));
  proc.kill("SIGTERM");
  await proc.exited;
  check("the sequencer stopped", rejoin3.closed === true || ra.closed === true, `closed rejoin3=${rejoin3.closed} ra=${ra.closed}`);
  proc = boot();
  await up();
  const ra2 = await open({ id: "ra", world: WORLD }, await cookieFor(SUB_RA, "Ra"));
  const eye2 = await open({ id: "eye", world: WORLD, spectate: true });
  await ra2.settle();
  check("after: the world reloaded with the bag and the rights intact", eye2.snap.state.entities?.cinema?.comp?.captions?.gen === GEN_PRE && eye2.snap.state.roles?.[RENAMED]?.caption?.id === "cinema", JSON.stringify({ bag: eye2.snap.state.entities?.cinema?.comp?.captions, deed: eye2.snap.state.roles?.[RENAMED]?.caption }));
  const post = await open({ id: "captioner-two", world: WORLD }, await cookieFor(SUB_CAP, "Captioner Two"));
  await post.settle();
  check("the renamed captioner's deed survived the restart (rightsIn through the reloaded fold)", post.snap.yourRights?.caption?.id === "cinema", JSON.stringify(post.snap.yourRights));
  before = post.errors.length;
  post.verb("caption", cap(S1, 2, 1, "after the restart, continuing the session"));
  await post.settle();
  c = await folded(WORLD, "cinema");
  check("the first captioner of the new opening is NOT stranded: its generation is higher than the bag's, the session continues", post.errors.length === before && c?.comp?.captions?.gen > GEN_PRE && c?.comp?.captions?.n === 2 && c?.comp?.captions?.window?.length === 2, post.errors.slice(before).join("; ") + " " + JSON.stringify({ pre: GEN_PRE, now: c?.comp?.captions?.gen, n: c?.comp?.captions?.n }));
  check("…and the new generation is not a small process counter (it is bound to the opening's log seq)", c.comp.captions.gen >= 1_000_000, String(c.comp.captions.gen));
  ra2.verb("caption", { id: "cinema", session: S1, end: true });
  await ra2.settle();
  ra2.verb("grant", { id: RENAMED, caption: null });
  await ra2.settle();
  post.close(); ra2.close();
  // the receipts section runs against the reopened sequencer
  ra = await open({ id: "ra", world: WORLD }, await cookieFor(SUB_RA, "Ra"));
  eye = eye2;
  await ra.settle();

  console.log("— 4. receipts (WorldClient) —");
  ra.verb("remove", { id: "cinema" });
  ra.verb("spawn", { id: "cinema", lib: "deco/screen.glb", pos: [0, 0, 0], yaw: 0 });
  await ra.settle();
  ra.verb("grant", { id: "wclient", role: "visitor" });
  await ra.settle();
  const logs: string[] = [];
  const S3 = "2026-09-16T22:00:00.000Z-s003";
  const w = new WorldClient({ url: WS_URL, token: DOOR, world: WORLD, actor: "wclient", screenId: "cinema", title: "a film", session: S3, paceMs: 30, ackTimeoutMs: 400, deedRetryMs: 300, agent: false, log: (m) => logs.push(m) });
  w.connect();
  await sleep(400);
  ra.verb("grant", { id: "wclient", caption: "cinema" });
  await ra.settle();
  const nA = eye.captions.length;
  w.caption({ t0: 0, t1: 1, text: "one" }); w.caption({ t0: 1, t1: 2, text: "two" }); w.caption({ t0: 2, t1: 3, text: "three" });
  await sleep(600);
  check("accept: three lines sent, three receipts, nothing pending", w.sent === 3 && w.acked === 3 && w.pendingCount === 0 && eye.captions.length === nA + 3, `sent=${w.sent} acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nA} ${JSON.stringify(logs.slice(-2))}`);
  check("…the title rode the first line only", eye.captions[nA].args.title === "a film" && eye.captions[nA + 1].args.title === undefined);
  const nB = eye.captions.length;
  let cut = false;
  (w as any).opts.onSend = () => { if (!cut) { cut = true; (w as any).ws.close(); } };
  w.caption({ t0: 3, t1: 4, text: "four, sent into a closing socket" });
  await sleep(2600);   // reconnect is 1.5 s; the rejoin is a newer leg, which continues the session
  (w as any).opts.onSend = undefined;
  check("disconnect before the receipt: the line is resent after reconnect (a newer leg, same session) and lands EXACTLY once", w.acked === 4 && w.pendingCount === 0 && eye.captions.filter((e: any) => e.actor === "wclient" && e.args.session === S3 && e.args.n === 4).length === 1, `acked=${w.acked} pending=${w.pendingCount} n4=${JSON.stringify(eye.captions.filter((e: any) => e.actor === "wclient" && e.args.n === 4).map((e: any) => ({ gen: e.args.gen, session: e.args.session, seq: e.seq, actor: e.actor })))} logs=${JSON.stringify(logs.slice(-3))}`);
  check("…and the log grew by exactly one", eye.captions.length === nB + 1, `${eye.captions.length - nB}`);
  const nC = eye.captions.length;
  const origEcho = (w as any).onEcho.bind(w);
  let swallowed = 0;
  (w as any).onEcho = (args: any) => { if (swallowed === 0) { swallowed++; return; } origEcho(args); };
  w.caption({ t0: 4, t1: 5, text: "five, whose receipt goes missing" });
  await sleep(1200);
  check("a lost receipt: the ack timeout resends, the door's dedupe answers, read as the receipt — one durable entry", swallowed === 1 && w.acked === 5 && w.pendingCount === 0 && eye.captions.length === nC + 1 && logs.some((l) => /no receipt for/.test(l)), `acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nC}`);
  ra.verb("grant", { id: "wclient", caption: null });
  await ra.settle();
  const nD = eye.captions.length;
  w.caption({ t0: 5, t1: 6, text: "six, without a deed" });
  await sleep(300);
  check("no deed: the line is HELD (not dropped), said once", w.pendingCount === 1 && w.acked === 5 && logs.some((l) => /⛔ held \(1 pending\)/.test(l)), `pending=${w.pendingCount} ${JSON.stringify(logs.slice(-2))}`);
  ra.verb("grant", { id: "wclient", caption: "cinema" });
  await ra.settle();
  await sleep(700);
  check("…and flows after the grant lands, exactly once", w.acked === 6 && w.pendingCount === 0 && eye.captions.length === nD + 1, `acked=${w.acked} pending=${w.pendingCount} log+${eye.captions.length - nD}`);
  w.end();
  await sleep(300);
  check("end is confirmed by its own echo and the bag is gone", w.acked === 7 && (await folded(WORLD, "cinema"))?.comp?.captions === undefined, `acked=${w.acked}`);
  check("no line was ever refused for good", w.refused === 0 && w.overflow === 0);
  w.close();
  for (const s of [ra, eye]) s.close();
} finally {
  proc.kill();
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
