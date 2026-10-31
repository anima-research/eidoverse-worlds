// Protocol smoke test — the sequencer's contract, exercised over a real socket.
//
//   bun tools/smoke.ts                       # against a throwaway server
//   URL=ws://host:8940/ws WORLD=<name> bun tools/smoke.ts   # against a running one (see below)
//
// This covers the wire, not the renderer: join and the cut, door requests and
// their order, presence batching, the NON-logged channels (drag, typing),
// identity takeover, and speech's rule (R 10-18): the world's log keeps every
// say, people receive speech only for the time they were present (no backscroll
// on join), and only the owner, server operators, and anyone holding readChat
// read the master log back. There is no private channel: whisper was removed (a whisper is
// refused as `removed`, reaches nobody and never the log).
//
// The world speaks the protocol (shared/protocol/authority.js): a join says `replica: true`,
// the snapshot carries the authority's cut (`cut`) and the chat window (`state`), every
// write is a request {type: "request", id, verb, args} answered by `reply`,
// and what the door wrote reaches every client as `log` entries. A world is
// founded by its operator (bun tools/protocol/world.ts found); joining never founds one.
// Against a running server, the worlds WORLD, WORLD-hist, WORLD-noise,
// WORLD-ground, WORLD-light and WORLD-pose must exist, owned by the names this
// suite joins as (alice, groundskeeper, lampsmith; on a TRUST_NAMES=1 server).

import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "./harness.ts";
import { idAliases } from "./protocol/idalias.ts";
const IDS = idAliases();

const EXTERNAL = process.env.URL;
// a FREE port, never a fixed default: 8987 is a live sequencer on this host, and a fixed port lets a suite talk to
// whatever already answers there instead of the server it started (the 72/85 ghost, below)
const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(9300);
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const WORLD = process.env.WORLD ?? `smoke-${Date.now().toString(36)}`;
const worldsDir = mkdtempSync(join(tmpdir(), "ew-smoke-"));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a minimal client ------------------------------------------------------

class Client {
  ws!: WebSocket;
  msgs: any[] = [];
  snapshot: any = null;
  private waiters = new Map<string, (r: any) => void>();
  private n = 0;
  constructor(public id: string, public opts: { agent?: boolean; world?: string } = {}) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_);
      const t = setTimeout(() => reject(new Error(`${this.id}: join timeout`)), 8000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({
        type: "join", world: this.opts.world ?? WORLD, id: this.id,
        avatar: "eidoverse/assets/vrms/claude.vrm",
        ...(this.opts.agent ? { declares: "agent" } : {}), token: TOKEN, replica: true,
      }));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        this.msgs.push(m);
        if (m.type === "snapshot") { this.snapshot = m; clearTimeout(t); resolve(); }
        if (m.type === "error" && !this.snapshot) { clearTimeout(t); reject(new Error(`${this.id}: ${m.error}`)); }
        if (m.type === "reply") { const f = this.waiters.get(m.id); if (f) { this.waiters.delete(m.id); f(m); } }
      };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error(`${this.id}: socket error`)); };
    });
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  /** one door request, answered by its reply ({ok, reply}) */
  req(verb: string, args: unknown = {}): Promise<any> {
    const id = `${this.id}-${++this.n}`;
    return new Promise((res) => {
      this.waiters.set(id, (m: any) => { IDS.back(m?.reply); res(m); });   // R 10-17: names ride as placeholders and minted ids
      this.send({ type: "request", id, verb, args: IDS.out(verb, args) });
      setTimeout(() => { if (this.waiters.delete(id)) res({ ok: false, reply: { refused: { code: "timeout" } } }); }, 6000);
    });
  }
  of(type: string) { return this.msgs.filter((m) => m.type === type); }
  /** the door's entries this client was sent, numbered */
  entries() { return this.of("log").flatMap((m) => m.entries.map((e: any, i: number) => ({ seq: m.from + i, ...e }))); }
  says() { return this.entries().filter((e) => e.kind === "say"); }
  get me() { return this.snapshot?.cut?.you as string | undefined; }
  close() { this.ws.close(); }
}
const joined = async (id: string, world = WORLD, opts: { agent?: boolean } = {}) => { const c = new Client(id, { ...opts, world }); await c.connect(); return c; };

// ---- server ----------------------------------------------------------------

const SUFFIXES = ["", "-hist", "-noise", "-ground", "-light", "-pose"];
let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (EXTERNAL) return;
  // every world this suite visits, founded before boot (the founder joins by that name and is its owner)
  foundWorlds(worldsDir, [WORLD, `${WORLD}-hist`, `${WORLD}-noise`, `${WORLD}-pose`], "alice");
  foundWorlds(worldsDir, [`${WORLD}-ground`], "groundskeeper");
  foundWorlds(worldsDir, [`${WORLD}-light`], "lampsmith");
  // process.execPath, not "bun": on Windows the PATH "bun" is an npm .cmd
  // shim that exits the moment it has launched the real bun.exe, so the pid
  // we hold is dead within milliseconds and `server?.kill()` below reaps
  // nothing — the sequencer is orphaned and keeps this port. That survivor
  // then answers the NEXT run's readiness poll, and the suite reports on a
  // build it never started (this is the 72/85 ghost).
  server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
    env: {
      ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1",
      // a typed name is that name's local account here, so a founder who joins by name is the owner
      TRUST_NAMES: "1",
      // lift the presence-message rate limit that exists to stop griefers rather than test harnesses
      MSG_RATE: "5000",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/avatars`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

/** The world's log on disk (world.jsonl): one JSON line per entry. Empty for an external server. */
const logLines = (world = WORLD) => {
  const p = join(worldsDir, world, "world.jsonl");
  if (!existsSync(p)) return [] as any[];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const logText = (world = WORLD) => { const p = join(worldsDir, world, "world.jsonl"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };

// ---- the run ---------------------------------------------------------------

try {
  console.log(`\nsmoke: ${URL_}  world=${WORLD}\n`);

  // Parse every client module before anything else. A syntax error in one of
  // them takes the whole client down with a blank page, and `node --check` on
  // the files you THINK you edited will happily miss it — which is exactly how
  // a stray duplicate `const` shipped once.
  {
    const dir = join(import.meta.dir, "..", "client");
    const files = [join(dir, "main.js")];
    for (const f of readdirSync(join(dir, "lib"))) {
      if (f.endsWith(".js")) files.push(join(dir, "lib", f));
    }
    const t = new Bun.Transpiler({ loader: "js" });
    let bad = 0;
    for (const f of files) {
      try { t.scan(readFileSync(f, "utf8")); }
      catch (e) { bad++; check(`parses: ${f.split("/").slice(-2).join("/")}`, false, (e as Error).message); }
    }
    check(`all ${files.length} client modules parse`, bad === 0);
  }

  await startServer();

  // --- join + snapshot: the door's cut
  const alice = await joined("alice");
  check("join returns a snapshot", !!alice.snapshot);
  check("snapshot names you", alice.snapshot.you === "alice", alice.snapshot.you);
  check("the snapshot is a cut (version, head, the fold's state) and carries no history",
    alice.snapshot.cut?.dialect === "eidoverse-log" && alice.snapshot.cut?.v === 4 && Number.isInteger(alice.snapshot.cut?.head) && !!alice.snapshot.cut?.state && !("entries" in alice.snapshot),
    JSON.stringify(Object.keys(alice.snapshot.cut ?? {})));
  check("you are told your identity: an opaque directory id, not your name", /^u-[a-z2-7]{20}$/.test(alice.me ?? ""), alice.me);
  check("the founder, joining by name, is the world's owner", alice.snapshot.yourRights?.role === "owner", JSON.stringify(alice.snapshot.yourRights));
  const head0 = alice.snapshot.cut.head;

  // --- door requests are answered, ordered, echoed, and persisted
  const r1 = await alice.req("create", { id: "box1", components: { transform: { pos: [1, 0, 2] } } });
  const r2 = await alice.req("set", { id: "box1", component: "transform", value: { pos: [5, 0, 5] }, merge: true });
  const r3 = await alice.req("say", { text: "hello world" });
  await sleep(300);
  check("each request is answered (reply ok)", r1.ok && r2.ok && r3.ok, JSON.stringify([r1.reply?.refused, r2.reply?.refused, r3.reply?.refused]));
  const echoed = alice.entries();
  check("what the door wrote echoes back to its author as log entries", echoed.length >= 3 && echoed.some((e) => e.kind === "say" && e.body?.text === "hello world"), `${echoed.length} entries`);
  check("log positions are dense and ordered, right after the join's head",
    echoed.every((e, i) => e.seq === head0 + 1 + i), echoed.map((e) => e.seq).join(","));
  check("entries carry their actor (the author's identity)", echoed.every((e) => e.actor === alice.me), JSON.stringify([...new Set(echoed.map((e) => e.actor))]));
  const disk0 = logLines();
  check("the log is on disk, entry for entry", EXTERNAL ? true : disk0.length === head0 + 1 + echoed.length, `${disk0.length} lines`);

  // --- a second body sees the world by its cut
  const bob = await joined("bob", WORLD, { agent: true });
  check("a late joiner's cut holds the world as it is now (box1 where it was moved)",
    JSON.stringify(bob.snapshot.cut.state?.[IDS.of("box1")]?.c?.transform?.v?.pos) === "[5,0,5]",
    JSON.stringify(Object.keys(bob.snapshot.cut.state ?? {})));
  check("a late joiner gets no chat from before it arrived (arrival-only: no window, no count)", JSON.stringify(bob.snapshot.state?.recentChat) === "[]" && bob.snapshot.state?.chatTotal === 0, JSON.stringify(bob.snapshot.state));
  check("late joiner sees who is present", bob.snapshot.present.some((p: any) => p.id === "alice"));
  await sleep(300);
  check("arrival is announced to those already here", alice.of("arrive").some((m) => m.id === "bob"));
  check("a declared agent body is relayed as declared", alice.of("arrive").find((m) => m.id === "bob")?.declares === "agent");
  const quiet = () => logLines().length;
  const n0 = quiet();

  // --- presence is batched and never logged
  bob.send({ type: "pose", pose: { p: [3, 0, 3], yaw: 1, speed: 0, clip: "idle" } });
  await sleep(300);
  const frames = alice.of("frame");
  check("poses arrive as batched stage frames", frames.length > 0);
  check("frames carry a server timestamp", frames.every((f) => typeof f.t === "number"));
  check("poses are never written to the log", quiet() === n0);

  // --- whisper was removed (R 10-18): refused as `removed`, delivered to nobody, held for nobody, never logged
  bob.send({ type: "whisper", to: "alice", text: "a private thing" });
  await sleep(300);
  check("a whisper is refused as removed, in words", bob.of("error").some((m) => m.refused?.code === "removed" && /removed/.test(String(m.error))), JSON.stringify(bob.of("error")));
  check("…and reaches nobody", !alice.of("whisper").length && !JSON.stringify(alice.msgs).includes("a private thing"));
  check("…and never the world log", !logText().includes("a private thing"));
  bob.send({ type: "whisper", to: "carol", text: "held for later" });
  await sleep(200);
  const carol = await joined("carol");
  await sleep(400);
  check("a whisper to someone absent is held for nobody", !carol.of("whisper").length && !JSON.stringify(carol.msgs).includes("held for later") && !logText().includes("held for later"));

  // --- drag is transient too
  alice.send({ type: "drag", id: IDS.of("box1"), pos: [9, 0, 9], yaw: 0.5 });
  await sleep(250);
  check("drag relays to others", bob.of("drag").some((m) => m.id === IDS.of("box1")));
  check("drag is never logged", quiet() === n0);

  // --- typing is pure presence
  alice.send({ type: "typing", to: null });
  await sleep(200);
  check("typing relays to others", bob.of("typing").some((m) => m.id === "alice"));
  check("typing is never logged", quiet() === n0);

  // --- typing STATE: a whitelisted social glyph rides presence; anything
  // else is stripped so presence stays presence (media PR)
  alice.send({ type: "typing", to: null, state: "mic" });
  await sleep(220);
  check("whitelisted typing state relays", bob.of("typing").some((m) => m.state === "mic"));
  alice.send({ type: "typing", to: null, state: "<script>alert(1)</script>" });
  await sleep(220);
  check("unlisted typing state is stripped, message still relays",
    bob.of("typing").filter((m) => m.id === "alice").length >= 3 &&
    !bob.of("typing").some((m) => typeof m.state === "string" && m.state.includes("<")));

  // --- rtc: RETIRED (#104 phase-1 cutover). The lane must be closed.
  alice.send({ type: "rtc", to: "bob", payload: { sdp: "offer-ish" } });
  await sleep(220);
  check("the retired rtc lane relays NOTHING", !bob.of("rtc").length);
  check("...and is never logged", quiet() === n0);
  check("...and answers no error (unknown types fall to silence)", !alice.of("error").length, JSON.stringify(alice.of("error")));

  // --- refusals
  const bad = await alice.req("obliterate", { everything: true });
  check("an unknown verb is refused, to the asker, by name", bad.ok === false && bad.reply?.refused?.code === "unknown-verb", JSON.stringify(bad.reply));
  // a world founded since R 10-21 makes newcomers builders; the owner sets them back to members (strangers read, builders
  // build) so a visitor's create has something to refuse (#260 house I442)
  const dr = await alice.req("set", { id: "@world", component: "default-role", value: { role: "member" } });
  check("the owner makes newcomers members", dr.ok === true, JSON.stringify(dr.reply));
  const nR = quiet();
  const bobSees = await bob.req("create", { id: "bobs", components: { transform: { pos: [0, 0, 0] } } });
  check("a visitor's create is refused (the door's roles: strangers read, builders build)", bobSees.ok === false && bobSees.reply?.refused?.code === "rights", JSON.stringify(bobSees.reply));
  await sleep(200);
  const refusedActs = logLines().slice(nR);
  check("a refused write changes no state: the log gained only the door's records of refused acts (and at least one)",
    refusedActs.length > 0 && refusedActs.every((e: any) => e.kind === "act" && e.body?.refused), JSON.stringify(refusedActs).slice(0, 300));
  const n1 = quiet();

  // --- one body per identity
  const alice2 = await joined("alice");
  await sleep(400);
  check("re-arriving as an existing identity takes the session over",
    alice2.snapshot?.you === "alice" && alice2.me === alice.me, JSON.stringify([alice2.snapshot?.you, alice2.me, alice.me]));

  // --- a joiner gets the world, not its history: the cut, however long the log
  {
    const fw = `${WORLD}-pose`;   // a scratch world for building (the main world's log is being counted above)
    const builder = await joined("alice", fw);
    const ops = (f: (i: number) => any) => Array.from({ length: 60 }, (_, i) => f(i));
    const c1 = await builder.req("batch", { ops: ops((i) => ({ verb: "create", args: { id: `f${i}`, components: { transform: { pos: [i, 0, 0] } } } })) });
    const c2 = await builder.req("batch", { ops: ops((i) => ({ verb: "set", args: { id: `f${i}`, component: "transform", value: { pos: [i, 0, 5] }, merge: true } })) });
    const c3 = await builder.req("batch", { ops: Array.from({ length: 30 }, (_, i) => ({ verb: "delete", args: { id: `f${i}` } })) });
    check("sixty things built, moved, and half removed, as three batches", c1.ok && c2.ok && c3.ok, JSON.stringify([c1.reply?.refused, c2.reply?.refused, c3.reply?.refused]));
    await sleep(300);
    const late = await joined("latecomer", fw);
    const st = late.snapshot.cut?.state ?? {};
    // ids are minted (R 10-17): the suite's names f0..f59 read as theirs through IDS
    const mine = new Set(Array.from({ length: 60 }, (_, i) => IDS.of(`f${i}`)));
    const things = Object.keys(st).filter((k) => mine.has(k));
    check("the cut survives removals", things.length === 30, `${things.length} things`);
    const f31 = st[IDS.of("f31")]?.c?.transform?.v?.pos;
    check("the cut holds the LATEST transforms", f31?.[2] === 5, JSON.stringify(f31));
    check("a joiner is not handed the history (no entries; the cut's head says where it stands)",
      !("entries" in late.snapshot) && late.snapshot.cut.head >= 4, `head ${late.snapshot.cut.head}`);
    check("the full history stays on disk", EXTERNAL ? true : logLines(fw).length === late.snapshot.cut.head + 1, `${logLines(fw).length} lines, head ${late.snapshot.cut.head}`);
    builder.close(); late.close();
  }

  // --- history is reachable, for people and agents alike
  {
    const hw = `${WORLD}-hist`;
    // 120 lines from six speakers: the door limits each speaker to 20 says per 10 s (a flood is refused at the door)
    const talkers = await Promise.all(Array.from({ length: 6 }, (_, k) => joined(`talker${k}`, hw)));
    for (let i = 0; i < 120; i++) await talkers[i % 6].req("say", { text: `line ${i}` });
    await sleep(300);

    // speech is arrival-only (R 10-18): an arrival is handed none of it and reads none of it back; the owner (alice) reads
    // the master log, whenever she arrives
    const arrival = await joined("arrival", hw);
    const owner = await joined("alice", hw);
    const recent = arrival.snapshot.state?.recentChat ?? [];
    check("an arrival gets no chat from before it came (no window, no count)", recent.length === 0 && arrival.snapshot.state?.chatTotal === 0, `${recent.length} / ${arrival.snapshot.state?.chatTotal}`);
    check("the owner's join replays nothing either, and counts what the master log holds", JSON.stringify(owner.snapshot.state?.recentChat) === "[]" && owner.snapshot.state?.chatTotal === 120, JSON.stringify(owner.snapshot.state));

    const askAs = (who: Client) => (o: any) => new Promise<any>((res) => {
      const reqId = `t${Math.random()}`;
      const h = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "history" && m.reqId === reqId) { who.ws.removeEventListener("message", h as any); res(m); }
      };
      who.ws.addEventListener("message", h as any);
      who.send({ type: "history", reqId, ...o });
    });
    const text = (e: any) => e?.args?.text ?? e?.text;
    const early = await askAs(arrival)({ limit: 300, verbs: ["say"] });
    check("an arrival's history holds nothing said before it came", early.entries.length === 0 && !early.hasMore, `${early.entries.length}`);
    const ask = askAs(owner);

    const page1 = await ask({ limit: 25, verbs: ["say"] });
    check("history returns a bounded page", page1.entries.length === 25, `${page1.entries.length}`);
    check("history comes back in world order", page1.entries.every((e: any, i: number) => i === 0 || e.seq > page1.entries[i - 1].seq));
    const page2 = await ask({ limit: 25, before: page1.oldestSeq, verbs: ["say"] });
    check("paging reaches further back", page2.entries.length === 25 && page2.oldestSeq < page1.oldestSeq, `${page2.oldestSeq} < ${page1.oldestSeq}`);
    check("paging does not repeat itself", !page2.entries.some((e: any) => page1.entries.some((f: any) => f.seq === e.seq)));
    const all = await ask({ limit: 300, verbs: ["say"] });
    check("the whole conversation is reachable", all.entries.length === 120, `${all.entries.length} of 120`);
    check("history reaches the first line said", text(all.entries[0]) === "line 0", JSON.stringify(all.entries[0]));
    const sinceMid = await ask({ after: all.entries[99].seq, verbs: ["say"], limit: 100 });
    check("an admin can ask only for what it missed", sinceMid.entries.length === 20 && text(sinceMid.entries[0]) === "line 100", `${sinceMid.entries.length} since`);
    await owner.req("say", { text: "while you were here" }); await sleep(300);   // (each talker spent its 20 says)
    const later = await askAs(arrival)({ limit: 300, verbs: ["say"] });
    check("what is said while an arrival is present reads back in its history, and only that", later.entries.map(text).join("|") === "while you were here", JSON.stringify(later.entries.map(text)));
    for (const t of talkers) t.close(); arrival.close(); owner.close();
  }

  // --- a loud speaker must not erase the room
  {
    const nw = `${WORLD}-noise`;
    const human = await joined("human", nw);
    const bot = await joined("bot", nw);
    await human.req("say", { text: "is anyone actually here?" });
    const floods = await Promise.all(Array.from({ length: 60 }, (_, i) => bot.req("say", { text: `telemetry ${i}` })));
    const okN = floods.filter((r) => r.ok).length;
    check("a flood is cut off at the door (20 says per 10 s per speaker), and told why",
      okN === 20 && floods.filter((r) => !r.ok).every((r) => r.reply?.refused?.code === "rate"), `${okN} accepted; ${JSON.stringify(floods.find((r) => !r.ok)?.reply?.refused)}`);
    await sleep(300);
    const arrival = await joined("arrival2", nw);
    // (the window's fairness — a flood can't erase the other speakers — reached a joiner until speech became arrival-only,
    // R 10-18; a joiner is now handed no window at all)
    check("a joiner after a flood is handed none of it", JSON.stringify(arrival.snapshot.state?.recentChat) === "[]" && arrival.snapshot.state?.chatTotal === 0, JSON.stringify(arrival.snapshot.state));
    human.close(); bot.close(); arrival.close();
  }

  // --- ground: terrain & grass are @world's; grass can be mowed
  {
    const gw = `${WORLD}-ground`;
    const owner = await joined("groundskeeper", gw);
    const t = await owner.req("set", { id: "@world", component: "terrain", value: { seed: 7, size: 160, amplitude: 2.6, flatRadius: 16, layers: [{ color: "#4a5d33", repeat: 16 }] } });
    const g = await owner.req("set", { id: "@world", component: "grass", value: { width: 90, depth: 80, spacing: 0.26, perCell: 4, color: 0x3a5a2c } });
    check("the owner sets terrain and grass on @world", t.ok && g.ok, JSON.stringify([t.reply?.refused, g.reply?.refused]));
    const w = (c: Client) => c.snapshot.cut?.state?.["@world"]?.c ?? {};
    const a = await joined("g-after", gw);
    check("terrain is in a joiner's cut", w(a).terrain?.v?.amplitude === 2.6, JSON.stringify(w(a).terrain));
    check("grass is in a joiner's cut", w(a).grass?.v?.width === 90 && w(a).grass?.v?.depth === 80, JSON.stringify(w(a).grass));   // spacing and perCell are not grass fields now (the door drops them)
    const m = await owner.req("delete", { id: "@world", component: "grass" });
    const b = await joined("g-mowed", gw);
    check("mowing grass (delete @world grass) clears it", m.ok && !w(b).grass, JSON.stringify([m.reply?.refused, w(b).grass]));
    check("mowing leaves the terrain standing", w(b).terrain?.v?.amplitude === 2.6);
    const v = await (await joined("g-visitor", gw)).req("set", { id: "@world", component: "terrain", value: { amplitude: 9 } });
    check("a visitor can't reshape the ground", v.ok === false && v.reply?.refused?.code === "rights", JSON.stringify(v.reply));
    owner.close(); a.close(); b.close();
  }

  // --- lights are authored things: a light component, moved and removed like any thing
  {
    const lw = `${WORLD}-light`;
    const owner = await joined("lampsmith", lw);
    const c = await owner.req("create", { id: "lamp1", components: { transform: { pos: [3, 1.5, -2] }, light: { color: 0xffcc88, intensity: 20, range: 12 } } });
    const p = await owner.req("set", { id: "lamp1", component: "transform", value: { pos: [5, 1.5, -2] }, merge: true });
    check("a light is created and moved through the door", c.ok && p.ok, JSON.stringify([c.reply?.refused, p.reply?.refused]));
    const late = await joined("lightlate", lw);
    const key = IDS.of("lamp1");
    const ent = late.snapshot.cut.state[key]?.c ?? {};
    check("a light is a thing with a light component (no model)", !!ent.light && !ent.model, JSON.stringify(ent));
    check("a light carries its colour and intensity", ent.light?.v?.color === 0xffcc88 && ent.light?.v?.intensity === 20, JSON.stringify(ent.light));
    check("a light moves like any thing (latest transform)", ent.transform?.v?.pos?.[0] === 5, JSON.stringify(ent.transform));
    const d = await owner.req("delete", { id: "lamp1" });
    const after = await joined("lightlater", lw);
    check("removing a light drops it from the world", d.ok && !Object.keys(after.snapshot.cut.state).some((k) => k.endsWith("lamp1")));
    owner.close(); late.close(); after.close();
  }

  // --- poses & one-off animations: presence, relayed, never history
  {
    const pw = `${WORLD}-pose`;
    const poser = await joined("poser", pw);
    const watcher = await joined("watcher", pw);
    const before = logLines(pw).length;
    await sleep(200);

    // a held pose rides the pose packet
    const bones = { leftUpperArm: [0, 0, 0.4, 0.9], rightUpperArm: [0, 0, -0.4, 0.9] };
    poser.send({ type: "pose", pose: { p: [0, 0, 0], yaw: 0, speed: 0, clip: "idle", pose: bones } });
    await sleep(300);
    const frameWithPose = watcher.of("frame").find((f) => f.poses?.poser?.pose);
    check("a held pose reaches another client through presence",
      !!frameWithPose && !!frameWithPose.poses.poser.pose.leftUpperArm,
      JSON.stringify(frameWithPose?.poses?.poser?.pose ?? null));

    // a one-off animation relays as its own message
    poser.send({ type: "anim", dur: 1.5, tracks: { head: [{ t: 0, q: [0, 0, 0, 1] }, { t: 1, q: [0, 0.2, 0, 0.97] }] } });
    await sleep(300);
    check("a one-off animation relays to others", watcher.of("anim").some((m) => m.id === "poser" && m.dur === 1.5));

    // a puppet is ROUTED to the target only. The relay acts on a body only when it knows where both bodies stand, within
    // reach (server/messages.ts bodyRefusal), so the watcher publishes where it is first (#260 house I127)
    watcher.send({ type: "pose", pose: { p: [1, 0, 0], yaw: 0, speed: 0, clip: "idle" } });
    await sleep(200);
    poser.send({ type: "puppet", target: "watcher", pose: { spine: [0, 0, 0.2, 0.98] } });
    await sleep(300);
    check("a puppet reaches its target", watcher.of("puppet").some((m) => m.by === "poser"));
    check("a puppet is NOT broadcast to everyone", poser.of("puppet").length === 0);
    poser.send({ type: "puppet", target: "ghost", pose: {} });
    await sleep(200);
    check("posing an absent target is refused", poser.of("error").some((m) => String(m.error).includes("ghost")));

    // a ragdoll request routes to the target like any puppet
    poser.send({ type: "puppet", target: "watcher", ragdoll: true });
    await sleep(250);
    check("a ragdoll request routes to its target", watcher.of("puppet").some((m) => m.by === "poser" && m.ragdoll === true));
    check("a ragdoll request is never broadcast", poser.of("puppet").length === 0);

    // an oversized animation is refused, not stored
    poser.send({ type: "anim", dur: 1, tracks: { x: Array.from({ length: 5000 }, (_, i) => ({ t: i, q: [0, 0, 0, 1] })) } });
    await sleep(200);
    check("an oversized animation is refused", poser.of("error").some((m) => /too large/.test(String(m.error))));

    // a typing signal relays to others (the "composing" indicator), never to the sender
    poser.send({ type: "typing", to: null });
    await sleep(250);
    check("a typing signal reaches other clients", watcher.of("typing").some((m) => m.id === "poser"));
    check("a typing signal is not echoed to the sender", poser.of("typing").every((m) => m.id !== "poser"));

    check("no pose, animation or puppet is ever written to the log", logLines(pw).length === before, `${before} → ${logLines(pw).length}`);
    poser.close(); watcher.close();
  }

  // --- the world remembers where you stood
  bob.send({ type: "pose", pose: { p: [7, 0, 8], yaw: 2, speed: 0, clip: "idle" } });
  await sleep(200);
  bob.close();
  await sleep(400);
  const bob2 = await joined("bob", WORLD, { agent: true });
  check("the world remembers where you fell asleep", Math.abs((bob2.snapshot.restore?.p?.[0] ?? 0) - 7) < 0.01, JSON.stringify(bob2.snapshot.restore));

  // --- spoken-say protocol: display metadata is validated, never trusted
  // (`t0` reorders every client's visible history, so the door clamps it
  // to a bounded utterance window and only inside spoken:true + utt)
  const sp = await joined("speaker", WORLD, { agent: true });
  const said = () => sp.says().at(-1)?.body;

  await sp.req("say", { text: "honest utterance", spoken: true, utt: 3, t0: Date.now() - 4000 });
  await sleep(200);
  let e = said();
  check("spoken say keeps spoken/utt and a recent t0",
    e?.spoken === true && e?.utt === 3 && Math.abs(e.t0 - (Date.now() - 4000)) < 2000, JSON.stringify(e));

  await sp.req("say", { text: "time traveler", spoken: true, utt: 4, t0: 12345 });
  await sleep(200);
  e = said();
  check("absurd t0 is clamped into the utterance window, not honored",
    Number.isFinite(e?.t0) && e.t0 >= Date.now() - 301_000 && e.t0 <= Date.now(), String(e?.t0));

  await sp.req("say", { text: "plain chat", t0: 12345, utt: 9 });
  await sleep(200);
  e = said();
  check("ordinary say cannot smuggle display metadata",
    e?.text === "plain chat" && e?.t0 === undefined && e?.utt === undefined && e?.spoken === undefined, JSON.stringify(e));

  await sp.req("say", { text: "bad utt", spoken: true, utt: "DROP TABLE", t0: Date.now() });
  await sleep(200);
  e = said();
  check("non-numeric utt voids the spoken protocol for that say",
    e?.text === "bad utt" && e?.spoken === undefined && e?.utt === undefined && e?.t0 === undefined, JSON.stringify(e));

  sp.send({ type: "caption", text: "cap", utt: { evil: true } });
  await sleep(200);
  const cap = alice2.of("caption").at(-1);
  check("caption utt is bounded to a safe non-negative integer", cap === undefined || cap.utt === 0, JSON.stringify(cap?.utt));
  check("none of the main world's presence traffic reached its log (only the door's entries did)",
    EXTERNAL ? true : logLines().length >= n1 && !logText().includes("a private thing") && !logText().includes("offer-ish"));

  sp.close();
  for (const c of [alice, alice2, carol, bob2]) c.close();
} catch (e) {
  fail++;
  console.log(`\n\x1b[31mFATAL\x1b[0m ${(e as Error).message}\n${(e as Error).stack}`);
} finally {
  server?.kill();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
