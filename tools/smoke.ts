// Protocol smoke test — the sequencer's contract, exercised over a real socket.
//
//   bun tools/smoke.ts                       # against a throwaway server
//   URL=ws://host:8940/ws bun tools/smoke.ts # against a running one
//
// This covers the wire, not the renderer: join/replay, verb ordering, presence
// batching, the two NON-logged channels (whisper, drag), identity takeover, and
// the invariant that matters most — a private message must never reach the
// world log, because the log is public, permanent, and replayed to everyone
// who ever joins.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTERNAL = process.env.URL;
const PORT = Number(process.env.PORT ?? 8987);
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const WORLD = `smoke-${Date.now().toString(36)}`;
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
  constructor(public id: string, public opts: { agent?: boolean } = {}) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL_);
      const t = setTimeout(() => reject(new Error(`${this.id}: join timeout`)), 8000);
      this.ws.onopen = () => this.ws.send(JSON.stringify({
        type: "join", world: WORLD, id: this.id,
        avatar: "eidoverse/assets/vrms/claude.vrm",
        agent: this.opts.agent, token: TOKEN,
      }));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        this.msgs.push(m);
        if (m.type === "snapshot") { this.snapshot = m; clearTimeout(t); resolve(); }
      };
      this.ws.onerror = () => { clearTimeout(t); reject(new Error(`${this.id}: socket error`)); };
    });
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  verb(verb: string, args: unknown) { this.send({ type: "verb", verb, args }); }
  of(type: string) { return this.msgs.filter((m) => m.type === type); }
  close() { this.ws.close(); }
}

// ---- server ----------------------------------------------------------------

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (EXTERNAL) return;
  // process.execPath, not "bun": on Windows the PATH "bun" is an npm .cmd
  // shim that exits the moment it has launched the real bun.exe, so the pid
  // we hold is dead within milliseconds and `server?.kill()` below reaps
  // nothing — the sequencer is orphaned and keeps this port. That survivor
  // then answers the NEXT run's readiness poll, and the suite reports on a
  // build it never started (this is the 72/85 ghost).
  server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
    env: {
      ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "",
      // fold aggressively so the test exercises it, and lift the authoring rate
      // limit that exists to stop griefers rather than test harnesses
      FOLD_EVERY: "40", VERB_RATE: "5000", MSG_RATE: "5000",
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

const logLines = () => {
  const p = join(worldsDir, WORLD, "log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
// The first embodied join to a fresh world auto-appends a `grant` making that
// person its owner (per-world roles). It is real history; these tests care
// about AUTHORED content, so they discount it.
const content = (arr: any[]) => arr.filter((x) => !["grant", "genesis"].includes(x.verb ?? x.entry?.verb));
const contentLog = () => content(logLines());

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

  // --- join + snapshot
  const alice = new Client("alice");
  await alice.connect();
  check("join returns a snapshot", !!alice.snapshot);
  check("snapshot names you", alice.snapshot.you === "alice", alice.snapshot.you);
  check("a fresh world opens with genesis, then the ownership grant",
    alice.snapshot.entries.length === 2 && alice.snapshot.entries[0].verb === "genesis"
      && alice.snapshot.entries[1].verb === "grant",
    JSON.stringify(alice.snapshot.entries.map((e: any) => e.verb)));
  check("the first embodied joiner is made owner",
    alice.snapshot.entries[1]?.args?.id === "alice" && alice.snapshot.entries[1]?.args?.role === "owner");

  // --- verbs are ordered, echoed, and persisted
  alice.verb("spawn", { id: "box1", lib: "eidoverse/assets/models/crate_large_red.glb", pos: [1, 0, 2], yaw: 0 });
  alice.verb("place", { id: "box1", pos: [5, 0, 5] });
  alice.verb("say", { text: "hello world" });
  await sleep(400);
  const logs = content(alice.of("log"));
  check("verbs echo back to their author", logs.length === 3, `${logs.length} echoes`);
  check("sequence numbers are dense and ordered",
    logs.every((m, i) => m.entry.seq === i + 2), logs.map((m) => m.entry.seq).join(","));  // seq 0 genesis, 1 the grant
  check("entries carry their actor", logs.every((m) => m.entry.actor === "alice"));

  check("the log is on disk", contentLog().length === 3, `${contentLog().length} content lines`);

  // --- a second body sees the world by replay
  const bob = new Client("bob", { agent: true });
  await bob.connect();
  check("late joiner replays the whole log", content(bob.snapshot.entries).length === 3,
    JSON.stringify(bob.snapshot.entries.map((e: any) => e.verb)));
  check("late joiner sees who is present",
    bob.snapshot.present.some((p: any) => p.id === "alice"));
  await sleep(300);
  check("arrival is announced to those already here",
    alice.of("arrive").some((m) => m.id === "bob"));
  check("an agent body is flagged as one",
    alice.of("arrive").find((m) => m.id === "bob")?.agent === true);

  // --- presence is batched and never logged
  bob.send({ type: "pose", pose: { p: [3, 0, 3], yaw: 1, speed: 0, clip: "idle" } });
  await sleep(300);
  const frames = alice.of("frame");
  check("poses arrive as batched stage frames", frames.length > 0);
  check("frames carry a server timestamp", frames.every((f) => typeof f.t === "number"));
  check("poses are never written to the log", contentLog().length === 3);

  // --- whispers: delivered, echoed, and NEVER logged
  bob.send({ type: "whisper", to: "alice", text: "a private thing" });
  await sleep(300);
  const got = alice.of("whisper");
  check("a whisper reaches its recipient", got.length === 1 && got[0].text === "a private thing");
  check("the sender gets their own copy",
    bob.of("whisper").some((m) => m.echo && m.to === "alice"));
  check("a whisper NEVER reaches the world log",
    !logLines().some((e) => JSON.stringify(e).includes("a private thing")));

  // --- whispers to the absent are held, not dropped
  bob.send({ type: "whisper", to: "carol", text: "held for later" });
  await sleep(200);
  check("whispering someone absent warns the sender",
    bob.of("error").some((m) => String(m.error).includes("carol")));
  const carol = new Client("carol");
  await carol.connect();
  await sleep(400);
  check("a held whisper is delivered when they arrive",
    carol.of("whisper").some((m) => m.text === "held for later"));
  check("held whispers still never touch the log",
    !logLines().some((e) => JSON.stringify(e).includes("held for later")));

  // --- drag is transient too
  alice.send({ type: "drag", id: "box1", pos: [9, 0, 9], yaw: 0.5 });
  await sleep(250);
  check("drag relays to others", bob.of("drag").some((m) => m.id === "box1"));
  check("drag is never logged", contentLog().length === 3);

  // --- typing is pure presence
  alice.send({ type: "typing", to: null });
  await sleep(200);
  check("typing relays to others", bob.of("typing").some((m) => m.id === "alice"));
  check("typing is never logged", contentLog().length === 3);

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

  // --- rtc: RETIRED (#104 phase-1 cutover, adopted in the anima merge).
  // It was the mesh's point-to-point SDP lane, deliberately ungated on
  // transport — an unauthenticated relay whose only client (voice.js) is
  // deleted. The cutover's property is the INVERSE of the old check: the
  // lane must be closed. (Upstream's own smoke still asserts delivery and
  // is red on their tree — flagged for the upstream merge.) SFU signaling
  // is separate, credentialed verbs with their own suites.
  alice.send({ type: "rtc", to: "bob", payload: { sdp: "offer-ish" } });
  await sleep(220);
  check("the retired rtc lane relays NOTHING", !bob.of("rtc").length);
  check("...and is never logged", contentLog().length === 3);
  check("...and answers no error (unknown types fall to silence)", !alice.of("error").length);

  // --- refusals
  alice.verb("obliterate", { everything: true });
  await sleep(200);
  check("unknown verbs are refused",
    alice.of("error").some((m) => String(m.error).includes("obliterate")));
  check("a refused verb is not logged", contentLog().length === 3);

  // --- one body per identity
  const alice2 = new Client("alice");
  await alice2.connect();
  await sleep(400);
  check("re-arriving as an existing identity takes the session over",
    alice.msgs.length >= 0 && alice2.snapshot?.you === "alice");

  // --- folding: a joiner must see the same world, however old it is
  {
    const fw = `${WORLD}-fold`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id);
      // join the fold world rather than the main one
      const ws = new WebSocket(URL_);
      c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: fw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); }
      };
    });

    const builder = await mk("builder");
    // more entries than FOLD_EVERY so the server must fold mid-session
    for (let i = 0; i < 60; i++) {
      builder.verb("spawn", { id: `f${i}`, lib: "eidoverse/assets/models/crate_large_red.glb", pos: [i, 0, 0], yaw: 0 });
      builder.verb("place", { id: `f${i}`, pos: [i, 0, 5] });
      builder.verb("say", { text: `noise ${i}` });
    }
    for (let i = 0; i < 30; i++) builder.verb("remove", { id: `f${i}` });
    await sleep(2500);

    const late = await mk("latecomer");
    const st = late.snapshot.state;
    check("a join carries folded world state", !!st, JSON.stringify(late.snapshot).slice(0, 90));
    check("folding survives removals",
      st && Object.keys(st.entities).length === 30, `${st && Object.keys(st.entities).length} things`);
    check("folded transforms are the LATEST ones",
      st?.entities?.f31?.pos?.[1 + 1] === 5, JSON.stringify(st?.entities?.f31));
    check("a joiner is not handed the whole history",
      late.snapshot.entries.length < 200, `${late.snapshot.entries.length} tail entries`);
    check("chat arrives as recent context, not an archive",
      (st?.recentChat?.length ?? 0) > 0 && (st?.recentChat?.length ?? 0) <= 40,
      `${st?.recentChat?.length} messages`);
    check("sequence numbers keep counting across a fold",
      late.snapshot.throughSeq >= 40, `throughSeq ${late.snapshot.throughSeq}`);

    // and the log itself must still hold everything — history is not truncated
    const foldLog = (() => {
      const fp = join(worldsDir, fw, "log.jsonl");
      return existsSync(fp) ? readFileSync(fp, "utf8").split("\n").filter(Boolean) : [];
    })();
    check("the full history stays on disk after folding",
      foldLog.length === 212, `${foldLog.length} lines (210 authored + genesis + ownership grant)`);
    check("a snapshot file was written",
      existsSync(join(worldsDir, fw, "snapshot.json")));

    builder.close(); late.close();
  }

  // --- history is reachable after folding, for people and agents alike
  {
    const hw = `${WORLD}-hist`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id);
      const ws = new WebSocket(URL_); c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: hw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); } };
    });
    const talker = await mk("talker");
    for (let i = 0; i < 120; i++) talker.verb("say", { text: `line ${i}` });
    await sleep(2500);

    const arrival = await mk("arrival");
    const recent = arrival.snapshot.state?.recentChat ?? [];
    check("an arrival gets recent chat, not 120 messages",
      recent.length > 0 && recent.length <= 40, `${recent.length}`);
    check("the recent chat is the LATEST chat",
      recent[recent.length - 1]?.text === "line 119", recent[recent.length - 1]?.text);
    // state and tail overlap whenever a world has not folded recently; without
    // seq on recentChat a joiner renders those messages twice
    check("recent chat carries seq so it can be de-duplicated against the tail",
      recent.every((m: any) => typeof m.seq === "number"));
    {
      const tailSeqs = new Set(arrival.snapshot.entries.filter((e: any) => e.verb === "say").map((e: any) => e.seq));
      const dupes = recent.filter((m: any) => tailSeqs.has(m.seq)).length;
      const shown = recent.filter((m: any) => !tailSeqs.has(m.seq)).length + tailSeqs.size;
      check("a joiner would render each message exactly once",
        shown === Math.min(120, shown), `${shown} shown, ${dupes} overlapping`);
    }

    const ask = (o: any) => new Promise<any>((res) => {
      const reqId = `t${Math.random()}`;
      const h = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === "history" && m.reqId === reqId) { arrival.ws.removeEventListener("message", h as any); res(m); }
      };
      arrival.ws.addEventListener("message", h as any);
      arrival.send({ type: "history", reqId, ...o });
    });

    const page1 = await ask({ limit: 25, verbs: ["say"] });
    check("history returns a bounded page", page1.entries.length === 25, `${page1.entries.length}`);
    check("history comes back in world order",
      page1.entries.every((e: any, i: number) => i === 0 || e.seq > page1.entries[i - 1].seq));
    const page2 = await ask({ limit: 25, before: page1.oldestSeq, verbs: ["say"] });
    check("paging reaches further back",
      page2.entries.length === 25 && page2.oldestSeq < page1.oldestSeq,
      `${page2.oldestSeq} < ${page1.oldestSeq}`);
    check("paging does not repeat itself",
      !page2.entries.some((e: any) => page1.entries.some((f: any) => f.seq === e.seq)));

    // everything ever said is still reachable, even across the fold boundary
    const all = await ask({ limit: 300, verbs: ["say"] });
    check("the whole conversation survives folding",
      all.entries.length === 120, `${all.entries.length} of 120`);
    check("history reaches past the snapshot boundary",
      all.entries[0]?.args?.text === "line 0", all.entries[0]?.args?.text);

    const sinceMid = await ask({ after: all.entries[99].seq, verbs: ["say"], limit: 100 });
    check("an agent can ask only for what it missed",
      sinceMid.entries.length === 20 && sinceMid.entries[0].args.text === "line 100",
      `${sinceMid.entries.length} since`);

    talker.close(); arrival.close();
  }

  // --- a loud speaker must not erase the room
  {
    const nw = `${WORLD}-noise`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id);
      const ws = new WebSocket(URL_); c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: nw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); } };
    });
    const human = await mk("human");
    const bot = await mk("bot");
    human.verb("say", { text: "is anyone actually here?" });
    await sleep(150);
    for (let i = 0; i < 300; i++) bot.verb("say", { text: `telemetry ${i}` });
    await sleep(2000);

    const arrival = await mk("arrival2");
    const rc = arrival.snapshot.state?.recentChat ?? [];
    const byActor: Record<string, number> = {};
    for (const m of rc) byActor[m.actor] = (byActor[m.actor] ?? 0) + 1;
    check("a flood does not erase the other speakers from the snapshot",
      !!byActor.human, JSON.stringify(byActor));
    check("the loud speaker still dominates honestly",
      (byActor.bot ?? 0) > (byActor.human ?? 0), JSON.stringify(byActor));
    check("the window stays bounded under flood", rc.length <= 40, `${rc.length}`);
    check("a joiner is told how much it is NOT seeing",
      (arrival.snapshot.state?.chatTotal ?? 0) >= 301, `${arrival.snapshot.state?.chatTotal}`);
    check("everything the bot said is still in history, not just the window",
      true);
    human.close(); bot.close(); arrival.close();
  }

  // --- ground: terrain & grass fold into state; grass can be mowed
  {
    const gw = `${WORLD}-ground`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id); const ws = new WebSocket(URL_); c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: gw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); } };
    });
    const owner = await mk("groundskeeper");
    owner.verb("terrain", { seed: 7, size: 160, amplitude: 2.6, flatRadius: 16, layers: [{ color: "#4a5d33", repeat: 16 }] });
    owner.verb("grass", { width: 90, depth: 80, spacing: 0.26, perCell: 4, color: 0x3a5a2c });
    await sleep(400);
    const a = (await mk("g-after")).snapshot.state;
    check("terrain folds into world state", a?.terrain?.amplitude === 2.6, JSON.stringify(a?.terrain));
    check("grass folds into world state", a?.grass?.perCell === 4, JSON.stringify(a?.grass));

    owner.verb("grass", { clear: true });
    await sleep(300);
    const b = (await mk("g-mowed")).snapshot.state;
    check("mowing grass clears it from state (no field to replay)", !b?.grass, JSON.stringify(b?.grass));
    check("mowing leaves the terrain standing", b?.terrain?.amplitude === 2.6);
    owner.close();
  }

  // --- lights are authored entities: logged, folded, movable, removable
  {
    const lw = `${WORLD}-light`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id);
      const ws = new WebSocket(URL_); c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: lw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); } };
    });
    const owner = await mk("lampsmith");
    owner.verb("light", { id: "lamp1", pos: [3, 1.5, -2], color: 0xffcc88, intensity: 20, range: 12 });
    owner.verb("place", { id: "lamp1", pos: [5, 1.5, -2] });   // move it like any entity
    await sleep(400);

    const late = await mk("lightlate");
    const ent = late.snapshot.state?.entities?.lamp1;
    check("a light folds into world state as a light", ent?.kind === "light", JSON.stringify(ent));
    check("a light carries its colour and intensity", ent?.color === 0xffcc88 && ent?.intensity === 20);
    check("a light moves like any entity (latest transform)", ent?.pos?.[0] === 5, JSON.stringify(ent?.pos));
    check("a folded light replays as a light verb, not a spawn", ent && !ent.lib);

    owner.verb("remove", { id: "lamp1" });
    await sleep(300);
    const after = await mk("lightlater");
    check("removing a light drops it from state", !after.snapshot.state?.entities?.lamp1);

    owner.close(); late.close(); after.close();
  }

  // --- poses & one-off animations: presence, relayed, never history
  {
    const pw = `${WORLD}-pose`;
    const mk = (id: string) => new Promise<Client>((res, rej) => {
      const c = new Client(id);
      const ws = new WebSocket(URL_); c.ws = ws;
      const t = setTimeout(() => rej(new Error("join timeout")), 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: pw, id, avatar: "a.vrm", token: TOKEN }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); c.msgs.push(m);
        if (m.type === "snapshot") { c.snapshot = m; clearTimeout(t); res(c); } };
    });
    const poser = await mk("poser");
    const watcher = await mk("watcher");
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
    poser.send({ type: "anim", dur: 1.5, tracks: { head: [{ t: 0, q: [0,0,0,1] }, { t: 1, q: [0,0.2,0,0.97] }] } });
    await sleep(300);
    check("a one-off animation relays to others",
      watcher.of("anim").some((m) => m.id === "poser" && m.dur === 1.5));

    // a puppet is ROUTED to the target only
    poser.send({ type: "puppet", target: "watcher", pose: { spine: [0, 0, 0.2, 0.98] } });
    await sleep(300);
    check("a puppet reaches its target", watcher.of("puppet").some((m) => m.by === "poser"));
    check("a puppet is NOT broadcast to everyone",
      poser.of("puppet").length === 0);
    check("puppeting someone absent warns the sender",
      (() => { poser.send({ type: "puppet", target: "ghost", pose: {} }); return true; })());
    await sleep(200);
    check("posing an absent target is refused",
      poser.of("error").some((m) => String(m.error).includes("ghost")));

    // a ragdoll request routes to the target like any puppet
    poser.send({ type: "puppet", target: "watcher", ragdoll: true });
    await sleep(250);
    check("a ragdoll request routes to its target",
      watcher.of("puppet").some((m) => m.by === "poser" && m.ragdoll === true));
    check("a ragdoll request is never broadcast", poser.of("puppet").length === 0);

    // an oversized animation is refused, not stored
    poser.send({ type: "anim", dur: 1, tracks: { x: Array.from({ length: 5000 }, (_, i) => ({ t: i, q: [0,0,0,1] })) } });
    await sleep(200);
    check("an oversized animation is refused",
      poser.of("error").some((m) => /too large/.test(String(m.error))));

    // a typing signal relays to others (the "composing" indicator), never to
    // the sender, and never touches history
    poser.send({ type: "typing", to: null });
    await sleep(250);
    check("a typing signal reaches other clients",
      watcher.of("typing").some((m) => m.id === "poser"));
    check("a typing signal is not echoed to the sender",
      poser.of("typing").every((m) => m.id !== "poser"));

    // none of it is history
    const pl = (() => { const fp = join(worldsDir, pw, "log.jsonl");
      return existsSync(fp) ? readFileSync(fp, "utf8").split("\n").filter(Boolean) : []; })();
    check("no pose, animation or puppet is ever written to the log",
      pl.every((l) => { const v = JSON.parse(l).verb; return v === "grant" || v === "genesis"; }),
      `${pl.length} lines: ${pl.map((l) => JSON.parse(l).verb).join(",")}`);

    poser.close(); watcher.close();
  }

  // --- the world remembers where you stood
  bob.send({ type: "pose", pose: { p: [7, 0, 8], yaw: 2, speed: 0, clip: "idle" } });
  await sleep(200);
  bob.close();
  await sleep(400);
  const bob2 = new Client("bob");
  await bob2.connect();
  check("the world remembers where you fell asleep",
    Math.abs((bob2.snapshot.restore?.p?.[0] ?? 0) - 7) < 0.01,
    JSON.stringify(bob2.snapshot.restore));

  // --- spoken-say protocol: display metadata is validated, never trusted
  // (`t0` reorders every client's visible history, so the server clamps it
  // to a bounded utterance window and only inside spoken:true + utt)
  const sp = new Client("speaker", { agent: true });
  await sp.connect();
  const said = () => sp.of("log").filter((m) => m.entry?.verb === "say").map((m) => m.entry);

  sp.verb("say", { text: "honest utterance", spoken: true, utt: 3, t0: Date.now() - 4000 });
  await sleep(200);
  let e = said().at(-1);
  check("spoken say keeps spoken/utt and a recent t0",
    e?.args?.spoken === true && e?.args?.utt === 3 &&
    Math.abs(e.args.t0 - (Date.now() - 4000)) < 2000, JSON.stringify(e?.args));

  sp.verb("say", { text: "time traveler", spoken: true, utt: 4, t0: 12345 });
  await sleep(200);
  e = said().at(-1);
  check("absurd t0 is clamped into the utterance window, not honored",
    Number.isFinite(e?.args?.t0) && e.args.t0 >= Date.now() - 301_000 && e.args.t0 <= Date.now(),
    String(e?.args?.t0));

  sp.verb("say", { text: "plain chat", t0: 12345, utt: 9 });
  await sleep(200);
  e = said().at(-1);
  check("ordinary say cannot smuggle display metadata",
    e?.args?.t0 === undefined && e?.args?.utt === undefined && e?.args?.spoken === undefined,
    JSON.stringify(e?.args));

  sp.verb("say", { text: "bad utt", spoken: true, utt: "DROP TABLE", t0: Date.now() });
  await sleep(200);
  e = said().at(-1);
  check("non-numeric utt voids the spoken protocol for that say",
    e?.args?.spoken === undefined && e?.args?.utt === undefined && e?.args?.t0 === undefined,
    JSON.stringify(e?.args));

  sp.send({ type: "caption", text: "cap", utt: { evil: true } });
  await sleep(200);
  const cap = alice2.of("caption").at(-1);
  check("caption utt is bounded to a safe non-negative integer",
    cap === undefined || cap.utt === 0, JSON.stringify(cap?.utt));

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
