// Arrival snapshot -> WorldAgent -> shared MCPL look, plus the served guide.
// Run: bun tools/briefing-test.ts
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAgentGuide, joinBriefing, agentGuideResponse } from "../server/briefing.ts";
import { resolveBriefing, AGENT_GUIDE } from "../shared/briefing.js";
import { sequencerGuideURL } from "../mcpl/briefing-door.ts";
import { scratchSequencer, mkCheck, sleep, ROOT } from "./harness.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { handleTool, TOOLS } from "../mcpl/tools.ts";

process.env.WORLD_TOKEN = "";
process.env.AGENT_BODY_ENGINE = "verlet";
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), "briefing-"));
const agents: WorldAgent[] = [], sockets: WebSocket[] = [];
let h: Awaited<ReturnType<typeof scratchSequencer>> | undefined;
let fake: ReturnType<typeof Bun.serve> | undefined, mounted: ReturnType<typeof Bun.serve> | undefined;
let stdio: ReturnType<typeof Bun.spawn> | undefined;
let completed = false;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const look = async (agent: WorldAgent) => {
  const reply = await handleTool({ agent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "look", {});
  const line = reply.content[0].text.split("\n").find((s: string) => s.startsWith("Briefing (door guidance): "));
  return line ? JSON.parse(line.slice("Briefing (door guidance): ".length)) : null;
};
/** What console.warn says while `fn` runs: the operator's log of a degraded answer. */
async function warned<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { return { value: await fn(), lines }; } finally { console.warn = warn; }
}
async function until(fn: () => boolean) {
  const end = Date.now() + 6000;
  while (!fn()) { if (Date.now() > end) throw new Error("briefing condition timed out"); await sleep(20); }
}
try {
  const file = join(scratch, "guide.txt");
  writeFileSync(file, "same guide\n");
  const first = readAgentGuide(file);
  utimesSync(file, new Date(0), new Date(0));
  check("identical bytes keep their version despite mtime changes", first.version === readAgentGuide(file).version);
  writeFileSync(file, "next guide\n");
  utimesSync(file, new Date(0), new Date(0));
  check("same-size edit with identical mtime changes the version", first.version !== readAgentGuide(file).version);
  check("version hashes the exact served bytes", first.version === hash(first.body));
  const missing = join(scratch, "missing-guide.txt");
  const { value: unavailable, lines: joinLog } = await warned(() => joinBriefing(missing));
  check("missing guide preserves arrival with an explicit unavailable hint", unavailable.docs.length === 0 && unavailable.motd.endsWith(" This world's guide is unavailable."));
  check("a join without its guide logs why, naming the file", joinLog.length === 1 && joinLog[0].includes("ENOENT") && joinLog[0].includes(missing));
  const { value: missingResponse, lines: routeLog } = await warned(() => agentGuideResponse(new Request("http://world/agents.md"), missing));
  check("missing guide HTTP read returns an uncached failure", missingResponse.status === 503 && missingResponse.headers.get("cache-control") === "no-store");
  check("the 503 logs why, naming the file", routeLog.length === 1 && routeLog[0].includes("503") && routeLog[0].includes("ENOENT") && routeLog[0].includes(missing));
  const conditional = (tag: string) => agentGuideResponse(new Request("http://world/agents.md", { headers: { "if-none-match": tag } }), file).status;
  const guideVersion = readAgentGuide(file).version;
  check("the version a join advertised, sent back as given, revalidates (304)", conditional(guideVersion) === 304);
  check("so do its quoted and weak forms, and a list holding it", conditional(`"${guideVersion}"`) === 304 && conditional(`W/"${guideVersion}"`) === 304 && conditional(`"other", "${guideVersion}"`) === 304);
  check("If-None-Match: * answers 304", conditional("*") === 304);
  check("another version reads the whole guide", conditional(`"sha256:other"`) === 200 && conditional("sha256:other") === 200);
  check("missing legacy briefing is optional", resolveBriefing(undefined, "http://localhost/") === null);
  const parsed = resolveBriefing({ motd: "hello", docs: [null, {}, { title: "bad", url: "javascript:alert(1)", version: "x" },
    { title: "broken", url: "http://[", version: "x" }, { title: "secret", url: "https://u:p@world.example/agents.md", version: "x" },
    { title: "guide", url: "/agents.md", version: "v1" }] }, "https://world.example/");
  check("relative links resolve; a non-http, unparseable or credentialed pointer stays out, and the others survive",
    parsed?.docs.length === 1 && parsed.docs[0].url === "https://world.example/agents.md");
  check("a pointer left out is never silent: the motd says why", parsed?.motd === "hello 3 guides' addresses are unknown on this connection (not http(s), malformed, credentials).");
  const originless = resolveBriefing({ motd: "hello", docs: [{ title: "guide", url: AGENT_GUIDE, version: "v1" }] }, null);
  check("a reader with no origin to resolve against says so instead of a URL", originless?.docs.length === 0 && originless.motd === "hello The guide's address is unknown on this connection (no origin).");
  check("the advertised pointer resolves under a mount prefix, as the door derives it",
    resolveBriefing({ motd: "", docs: [{ title: "guide", url: AGENT_GUIDE, version: "v1" }] }, "http://world.example/prefix/")?.docs[0].url === sequencerGuideURL("ws://world.example/prefix/ws").href);

  h = await scratchSequencer("briefing", { portFrom: 9660, serverEnv: {
    EIDOVERSE_DIR: join(scratch, "library"), OPT_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1",
  } });
  const snapshot: any = await new Promise((resolve, reject) => {
    const ws = new WebSocket(h!.BASE.replace("http", "ws") + "/ws"); sockets.push(ws);
    const timer = setTimeout(() => reject(new Error("raw join timed out")), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "briefing", id: "arrival", avatar: "" }));
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { clearTimeout(timer); resolve(m); }
      if (m.type === "error") { clearTimeout(timer); reject(new Error(m.error)); }
    };
  });
  check("real join includes MCPL guidance and one versioned document", snapshot.briefing?.motd.includes("MCPL") && snapshot.briefing.docs.length === 1);
  const doc = snapshot.briefing.docs[0];
  check("the join advertises the guide relative to the sequencer's base", doc.url === AGENT_GUIDE);
  const response = await fetch(new URL(doc.url, h.BASE));
  const body = new Uint8Array(await response.arrayBuffer());
  check("advertised guide is reachable and its bytes match the version", response.ok && hash(body) === doc.version);
  check("guide response carries the same ETag and revalidates", response.headers.get("etag") === `"${doc.version}"` && response.headers.get("cache-control") === "no-cache");
  const cached = await fetch(h.BASE + "/AGENTS.md", { headers: { "if-none-match": `W/"${doc.version}"` } });
  check("case-insensitive guide route supports conditional reads", cached.status === 304 && (await cached.text()) === "");
  const head = await fetch(h.BASE + "/agents.md", { method: "HEAD" });
  check("HEAD carries version without the document body", head.ok && head.headers.get("etag") === `"${doc.version}"` && (await head.text()) === "");
  const agent = new WorldAgent({ name: "reader", avatar: "", world: "briefing", url: h.BASE.replace("http", "ws") + "/ws" }); agents.push(agent);
  await agent.connect();
  const offered = await look(agent);
  check("shared look tool exposes the actual snapshot with absolute URL", offered?.docs[0].version === doc.version && offered.docs[0].url === h.BASE + "/agents.md");
  check("repeated look preserves guidance without treating delivery as a read", JSON.stringify(await look(agent)) === JSON.stringify(offered));
  check("the look tool's description offers the briefing", TOOLS.find(t => t.name === "look")!.description.includes("content versions"));
  const history: any = await agent.history({ limit: 100 });
  const entries = Array.isArray(history) ? history : history?.entries;
  check("briefing does not create a world-log entry, in a log actually read", Array.isArray(entries) && entries.length > 0
    && !JSON.stringify(history).includes("sha256:") && !JSON.stringify(history).includes("briefing\":"));

  // The stdio door: its own process, over its own wire, shows the same line.
  stdio = Bun.spawn([process.execPath, join(ROOT, "mcpl", "server.ts")], {
    cwd: join(ROOT, "mcpl"),
    env: { ...process.env, WORLD_URL: h.BASE.replace("http", "ws") + "/ws", WORLD_NAME: "briefing", AGENT_NAME: "stdio-reader", AGENT_AVATAR: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const stdioReplies = new Map<number, any>();
  void (async () => {
    let buf = "";
    for await (const chunk of stdio!.stdout as ReadableStream<Uint8Array>) {
      buf += new TextDecoder().decode(chunk);
      for (let nl; (nl = buf.indexOf("\n")) >= 0; buf = buf.slice(nl + 1)) {
        try { const m = JSON.parse(buf.slice(0, nl)); if (m.id != null) stdioReplies.set(m.id, m); } catch { /* not a frame */ }
      }
    }
  })();
  let stdioId = 0;
  const stdioCall = async (method: string, params: unknown) => {
    const id = ++stdioId;
    (stdio!.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const end = Date.now() + 30000;
    while (!stdioReplies.has(id)) { if (Date.now() > end) throw new Error(`stdio ${method} timed out`); await sleep(20); }
    return stdioReplies.get(id);
  };
  await stdioCall("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "briefing-test", version: "0" } });
  (stdio.stdin as import("bun").FileSink).write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const stdioLook: string = (await stdioCall("tools/call", { name: "look", arguments: {} })).result?.content?.[0]?.text ?? "";
  const stdioLine = stdioLook.split("\n").find(l => l.startsWith("Briefing (door guidance): "));
  const stdioBriefing = stdioLine ? JSON.parse(stdioLine.slice("Briefing (door guidance): ".length)) : null;
  check("the stdio door's look shows the briefing, at the sequencer's guide", stdioBriefing?.docs[0]?.url === h.BASE + "/agents.md" && stdioBriefing.docs[0].version === doc.version);

  // A sequencer mounted under a prefix: the local body's look and the door's
  // proxy derive one guide URL from one WORLD_URL.
  mounted = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) { if (new URL(req.url).pathname === "/prefix/ws" && server.upgrade(req)) return; return Response.json([]); },
    websocket: { message(ws, msg) {
      if (JSON.parse(String(msg)).type !== "join") return;
      ws.send(JSON.stringify({ type: "snapshot", gen: 1, entries: [], present: [], state: {}, throughSeq: -1,
        briefing: { motd: "mounted", docs: [{ title: "guide", url: AGENT_GUIDE, version: "m" }] } }));
    } },
  });
  const mountedURL = `ws://127.0.0.1:${mounted.port}/prefix/ws?token=private-test`;
  const mountedReader = new WorldAgent({ name: "mounted-reader", avatar: "", world: "empty", url: mountedURL }); agents.push(mountedReader);
  await mountedReader.connect();
  check("a prefixed local WORLD_URL keeps its mount in the guide URL, as the door's proxy does",
    (await look(mountedReader))?.docs[0].url === `http://127.0.0.1:${mounted.port}/prefix/agents.md`
    && sequencerGuideURL(mountedURL).href === `http://127.0.0.1:${mounted.port}/prefix/agents.md`);
  const doorless = new WorldAgent({ name: "doorless-reader", avatar: "", world: "empty", url: mountedURL, briefingBase: null }); agents.push(doorless);
  await doorless.connect();
  check("a network session with no reader-facing origin says the address is unknown, instead of dropping it",
    JSON.stringify(await look(doorless)) === JSON.stringify({ motd: "mounted The guide's address is unknown on this connection (no origin).", docs: [] }));

  // A controllable older/newer door exercises actual automatic reconnects.
  // The consumer can compare versions; the body neither fetches nor wakes.
  let current: any = { motd: "offered reading", docs: [{ title: "guide", url: "/guide", version: "one" }] };
  let peer: any, joins = 0, guideFetches = 0;
  fake = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) {
      const u = new URL(req.url);
      if (u.pathname === "/ws" && server.upgrade(req)) return;
      if (u.pathname === "/guide") guideFetches++;
      return Response.json([]);
    },
    websocket: { message(ws, msg) {
      if (JSON.parse(String(msg)).type !== "join") return;
      peer = ws; joins++;
      ws.send(JSON.stringify({ type: "snapshot", gen: joins, entries: [], present: [], state: {}, throughSeq: -1, ...(current ? { briefing: current } : {}) }));
    } },
  });
  const client = new WorldAgent({ name: "reconnect-reader", avatar: "", world: "empty", url: `ws://127.0.0.1:${fake.port}/ws?token=private-test` }); agents.push(client);
  let events = 0, pings = 0;
  client.onEvent = () => { events++; }; client.onPing = () => { pings++; };
  await client.connect();
  const old = await look(client);
  check("briefing URLs exclude transport query credentials", !JSON.stringify(old).includes("private-test"));
  peer.close(); await until(() => !client.joined);
  check("between connections, look offers no briefing", await look(client) === null);
  await until(() => joins === 2 && client.joined);
  check("reconnect with identical guidance preserves content version", (await look(client)).docs[0].version === "one");
  current = { ...current, docs: [{ ...current.docs[0], version: "two" }] };
  peer.close(); await until(() => joins === 3 && client.joined);
  check("reconnect exposes changed document version", (await look(client)).docs[0].version === "two");
  current = undefined; peer.close(); await until(() => joins === 4 && client.joined);
  check("older server clears previous briefing rather than retaining stale guidance", await look(client) === null);
  current = { motd: "no docs array" }; peer.close(); await until(() => joins === 5 && client.joined);
  check("a briefing without a docs array still arrives, and shows none", client.joined && await look(client) === null);
  check("offered guidance leaves reading and wakes to the consumer", guideFetches === 0 && pings === 0 && events === 0 && client.pings.length === 0);
  current = { motd: "offered reading", docs: [{ title: "guide", url: "/guide", version: "three" }] };
  peer.close(); await until(() => joins === 6 && client.joined);
  client.close();
  check("a closed body offers no briefing", await look(client) === null);
  completed = true;
} finally {
  for (const a of agents) a.close();
  for (const ws of sockets) ws.close();
  fake?.stop(true);
  mounted?.stop(true);
  stdio?.kill();
  await h?.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
