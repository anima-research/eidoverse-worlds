import { mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAgentGuide, joinBriefing, agentGuideResponse } from "../server/briefing.ts";
import { resolveBriefing, briefingLines, AGENT_GUIDE } from "../shared/briefing.js";
import { helloOf } from "../shared/protocol/hello.js";
import { scratchSequencer, freePort, mkCheck, ROOT } from "./harness.ts";
import { until, tryUntil } from "./protocol/wait.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { handleTool } from "../mcpl/tools.ts";

process.env.WORLD_TOKEN = "";
process.env.AGENT_BODY_ENGINE = "verlet";
delete process.env.HN_NATIVE_ORIGIN;
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), "briefing-"));
const agents: WorldAgent[] = [], sockets: WebSocket[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
let h: Awaited<ReturnType<typeof scratchSequencer>> | undefined, hPublic: Awaited<ReturnType<typeof scratchSequencer>> | undefined;
let completed = false;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const lookText = async (agent: WorldAgent): Promise<string> =>
  (await handleTool({ agent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "look", {})).content[0].text;
const guideLines = (text: string) => text.split("\n").filter(s => s.startsWith("Agent guide: "));
async function warned<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [], warn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { return { value: await fn(), lines }; } finally { console.warn = warn; }
}
const registry = { "briefing-reader-token": { id: "door-reader", name: "Door reader", worlds: ["*"], create: true } };
let tokenPath = "";

try {
  const file = join(scratch, "guide.txt");
  writeFileSync(file, "same guide\n");
  const first = readAgentGuide(file);
  utimesSync(file, new Date(0), new Date(0));
  check("identical bytes keep their version whatever their mtime", first.version === readAgentGuide(file).version);
  writeFileSync(file, "next guide\n");
  utimesSync(file, new Date(0), new Date(0));
  check("a same-size edit at the same mtime changes the version", first.version !== readAgentGuide(file).version);
  check("the version is the sha256 of the bytes served", first.version === hash(first.body));
  const missing = join(scratch, "missing-guide.txt");
  const { value: unavailable, lines: joinLog } = await warned(() => joinBriefing(missing));
  check("a join without its guide still gets a briefing, with no document, saying the guide is unavailable",
    unavailable.docs.length === 0 && unavailable.motd.endsWith(" This world's guide is unavailable."));
  check("and the operator's log says why, naming the file", joinLog.length === 1 && joinLog[0].includes("ENOENT") && joinLog[0].includes(missing));
  const { value: missingResponse, lines: routeLog } = await warned(() => agentGuideResponse(new Request("http://world/agents.md"), missing));
  check("an unreadable guide answers 503, not to be cached", missingResponse.status === 503 && missingResponse.headers.get("cache-control") === "no-store");
  check("and the 503 is logged with why, naming the file", routeLog.length === 1 && routeLog[0].includes("503") && routeLog[0].includes("ENOENT") && routeLog[0].includes(missing));
  const conditional = (tag: string) => agentGuideResponse(new Request("http://world/agents.md", { headers: { "if-none-match": tag } }), file).status;
  const guideVersion = readAgentGuide(file).version;
  check("the version as a join gives it revalidates (304)", conditional(guideVersion) === 304);
  check("so do its quoted and weak forms, and a list holding it", conditional(`"${guideVersion}"`) === 304 && conditional(`W/"${guideVersion}"`) === 304 && conditional(`"other", "${guideVersion}"`) === 304);
  check("If-None-Match: * answers 304", conditional("*") === 304);
  check("another version reads the whole guide", conditional(`"sha256:other"`) === 200 && conditional("sha256:other") === 200);
  check("a quoted \"*\" is an entity tag, not the wildcard, and reads the whole guide", conditional(`"*"`) === 200);
  writeFileSync(file, "guide one\n");
  const joinedOne = joinBriefing(file).docs[0]?.version, servedOne = agentGuideResponse(new Request("http://world/agents.md"), file).headers.get("etag");
  writeFileSync(file, "guide two\n");
  const joinedTwo = joinBriefing(file).docs[0]?.version, servedTwo = agentGuideResponse(new Request("http://world/agents.md"), file).headers.get("etag");
  check("each join and each read of the route reads the guide afresh, so an edit between two names the new version",
    joinedOne !== joinedTwo && servedOne !== servedTwo && servedTwo === `"${joinedTwo}"`);

  const urlAt = (origin: string | undefined) => joinBriefing(file, origin).docs[0]?.url;
  check("a server with a public origin names the guide there, by its origin alone",
    urlAt("https://world.example") === "https://world.example/agents.md" && urlAt("https://world.example/") === "https://world.example/agents.md"
      && urlAt("http://world.example:8941/sub/") === "http://world.example:8941/agents.md");
  check("without one, or with one that isn't an http(s) origin, the guide's url is relative to the sequencer",
    [undefined, "", "not a url", "ftp://world.example"].every(origin => urlAt(origin) === AGENT_GUIDE));

  const lines = (value: unknown, base: string | null) => briefingLines(resolveBriefing(value, base));
  check("no briefing (an older sequencer) gives no line", lines(undefined, "http://localhost/").length === 0 && lines({ motd: "no docs array" }, "http://localhost/").length === 0);
  check("a briefing with no document says none is offered", JSON.stringify(lines({ motd: "m", docs: [] }, "http://w.example/")) === JSON.stringify(["Agent guide: none offered on this connection"]));
  check("a resolvable guide is one line with its absolute url and version",
    JSON.stringify(lines({ motd: "m", docs: [{ title: "t", url: AGENT_GUIDE, version: "v1" }] }, "https://w.example/")) === JSON.stringify(["Agent guide: https://w.example/agents.md, version v1 when you joined"]));
  check("a document needs only its url and version for its line, with no motd or title",
    JSON.stringify(lines({ docs: [{ url: AGENT_GUIDE, version: "v1" }] }, "https://w.example/")) === JSON.stringify(["Agent guide: https://w.example/agents.md, version v1 when you joined"]));
  check("a reader with no origin gives the version and says the address is unknown, and why",
    JSON.stringify(lines({ motd: "m", docs: [{ title: "t", url: AGENT_GUIDE, version: "v1" }] }, null)) === JSON.stringify(["Agent guide: version v1 when you joined; its address is unknown on this connection (the world's server has no public origin set)"]));
  const mixed = lines({ motd: "m", docs: [null, {}, { title: "bad", url: "javascript:alert(1)", version: "a" }, { title: "broken", url: "http://[", version: "b" },
    { title: "secret", url: "https://u:p@w.example/agents.md", version: "c" }, { title: "guide", url: "/agents.md", version: "d" }] }, "https://w.example/");
  check("a non-http, unparseable or credentialed pointer is never a url, and each says why; a malformed entry is skipped",
    JSON.stringify(mixed) === JSON.stringify(["Agent guide: https://w.example/agents.md, version d when you joined",
      "Agent guide: version a when you joined; its address is unknown on this connection (not http(s))",
      "Agent guide: version b when you joined; its address is unknown on this connection (malformed)",
      "Agent guide: version c when you joined; its address is unknown on this connection (credentials)"]), JSON.stringify(mixed));

  tokenPath = join(scratch, "tokens.json");
  writeFileSync(tokenPath, JSON.stringify(registry));
  const serverEnv: Record<string, string> = { EIDOVERSE_DIR: join(scratch, "library"), OPT_DIR: join(scratch, "opt"), SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", HN_REQUIRE_LOGIN: "0", HN_ISSUER_KEY: "", HN_NATIVE_ORIGIN: "", AGENT_TOKENS_PATH: tokenPath };
  h = await scratchSequencer("briefing", { portFrom: 9660, worlds: ["briefing", "annex"], serverEnv });
  const WS = h.BASE.replace("http", "ws") + "/ws";
  const capture = new WorldAgent({ name: "capture", avatar: "", world: "briefing", url: WS });
  const snapshot: any = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS); sockets.push(ws);
    const timer = setTimeout(() => reject(new Error("raw join timed out")), 8000);
    ws.onopen = () => ws.send(JSON.stringify((capture as any).joinMsg()));
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { clearTimeout(timer); resolve(m); }
      if (m.type === "error") { clearTimeout(timer); reject(new Error(m.error)); }
    };
  });
  check("a join carries the briefing: a motd naming MCPL and one document", typeof snapshot.briefing?.motd === "string" && snapshot.briefing.motd.includes("MCPL") && snapshot.briefing.docs?.length === 1);
  const doc = snapshot.briefing.docs[0];
  check("the document's url is relative to the sequencer's base", doc.url === AGENT_GUIDE);
  const response = await fetch(new URL(doc.url, h.BASE + "/"));
  const body = new Uint8Array(await response.arrayBuffer());
  check("the guide it names is served, and its bytes hash to the join's version", response.ok && hash(body) === doc.version);
  check("and the bytes served are the checkout's AGENTS.md", Buffer.compare(Buffer.from(body), readFileSync(join(ROOT, "AGENTS.md"))) === 0);
  check("the guide's ETag is that version, quoted, and it revalidates", response.headers.get("etag") === `"${doc.version}"` && response.headers.get("cache-control") === "no-cache");
  const cached = await fetch(h.BASE + "/AGENTS.md", { headers: { "if-none-match": `W/"${doc.version}"` } });
  check("either spelling of the route answers a conditional read", cached.status === 304 && (await cached.text()) === "");
  const head = await fetch(h.BASE + "/agents.md", { method: "HEAD" });
  check("HEAD carries the version without the body", head.ok && head.headers.get("etag") === `"${doc.version}"` && (await head.text()) === "");

  const local = new WorldAgent({ name: "reader", avatar: "", world: "briefing", url: WS }); agents.push(local);
  await local.connect();
  const localLines = guideLines(await lookText(local));
  check("the local body's look names the guide at the sequencer's base, with the join's version",
    JSON.stringify(localLines) === JSON.stringify([`Agent guide: ${h.BASE}/agents.md, version ${doc.version} when you joined`]), JSON.stringify(localLines));
  check("a second look says the same, and reading is left to the host", JSON.stringify(guideLines(await lookText(local))) === JSON.stringify(localLines));

  const strip = ({ briefing: _b, ...rest }: any) => rest;
  const base = strip(snapshot);
  let current: any = { motd: "offered", docs: [{ title: "guide", url: AGENT_GUIDE, version: "one" }] };
  let peer: any, joins = 0, guideFetches = 0, holdNextJoin = false, heldJoin: (() => void) | null = null;
  const fake = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(req, server) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/ws") && server.upgrade(req)) return;
      if (u.pathname.toLowerCase().endsWith("/agents.md")) guideFetches++;
      return Response.json([]);
    },
    websocket: { message(ws, msg) {
      if (JSON.parse(String(msg)).type !== "join") return;
      peer = ws; joins++;
      const answer = () => ws.send(JSON.stringify({ ...base, ...(current === undefined ? {} : { briefing: current }) }));
      if (holdNextJoin) { holdNextJoin = false; heldJoin = answer; } else answer();
    } },
  }); servers.push(fake);
  const mounted = new WorldAgent({ name: "mounted-reader", avatar: "", world: "briefing", url: `ws://127.0.0.1:${fake.port}/prefix/ws?token=private-test` }); agents.push(mounted);
  await mounted.connect();
  const mountedLines = guideLines(await lookText(mounted));
  check("a sequencer under a path keeps its prefix in the guide's url, and the transport's query stays out",
    JSON.stringify(mountedLines) === JSON.stringify([`Agent guide: http://127.0.0.1:${fake.port}/prefix/agents.md, version one when you joined`]), JSON.stringify(mountedLines));
  mounted.close();
  check("a closed body names no guide", guideLines(await lookText(mounted)).length === 0);

  let pings = 0;
  const client = new WorldAgent({ name: "reconnect-reader", avatar: "", world: "briefing", url: `ws://127.0.0.1:${fake.port}/ws` }); agents.push(client);
  client.onPing = () => { pings++; };
  await client.connect();
  const joinsBefore = joins;
  const beforeClose = guideLines(await lookText(client));
  holdNextJoin = true;
  peer.close();
  const release = await until("the body asks to join again", () => heldJoin);
  check("between connections, look names no guide, where it named one before", beforeClose.length === 1 && guideLines(await lookText(client)).length === 0,
    JSON.stringify(beforeClose));
  heldJoin = null; release();
  await until("the body rejoins", () => joins === joinsBefore + 1 && client.joined);
  check("a rejoin with the same guidance names the same version", guideLines(await lookText(client))[0]?.endsWith("version one when you joined"));
  current = { ...current, docs: [{ ...current.docs[0], version: "two" }] };
  peer.close(); await until("the body rejoins after an edit", () => joins === joinsBefore + 2 && client.joined);
  check("a rejoin after the guide changed names the new version", guideLines(await lookText(client))[0]?.endsWith("version two when you joined"));
  current = undefined;
  peer.close(); await until("the body rejoins a sequencer with no briefing", () => joins === joinsBefore + 3 && client.joined);
  check("a rejoin to a sequencer that sends no briefing names no guide, not the old one", guideLines(await lookText(client)).length === 0);
  current = { motd: "unavailable", docs: [] };
  peer.close(); await until("the body rejoins a sequencer whose guide is unavailable", () => joins === joinsBefore + 4 && client.joined);
  check("a rejoin whose briefing offers no document says so", JSON.stringify(guideLines(await lookText(client))) === JSON.stringify(["Agent guide: none offered on this connection"]));
  check("the body neither fetches the guide nor wakes its host for it", guideFetches === 0 && pings === 0);
  current = { motd: "offered", docs: [{ title: "guide", url: AGENT_GUIDE, version: "one" }] };
  peer.close(); await until("the body rejoins before a refused snapshot", () => joins === joinsBefore + 5 && client.joined);
  const beforeRefusal = guideLines(await lookText(client));
  const { state: _state, ...stateless } = base;
  peer.send(JSON.stringify({ ...stateless, briefing: { motd: "refused", docs: [{ title: "guide", url: AGENT_GUIDE, version: "refused" }] } }));
  const refusedCleared = await tryUntil("the body refuses a snapshot with no world state", async () => guideLines(await lookText(client)).length === 0, { ms: 5000 });
  check("a later snapshot the body refuses, as a resync's could be, leaves no guide line, neither the old one nor its own",
    beforeRefusal.length === 1 && refusedCleared !== undefined && client.joined, JSON.stringify([beforeRefusal, guideLines(await lookText(client)), client.joined]));
  const dialectReader = new WorldAgent({ name: "dialect-reader", avatar: "", world: "briefing", url: `ws://127.0.0.1:${fake.port}/ws` }); agents.push(dialectReader);
  await dialectReader.connect();
  const beforeDialect = guideLines(await lookText(dialectReader));
  peer.send(JSON.stringify({ ...base, dialect: "another-dialect", briefing: { motd: "refused", docs: [{ title: "guide", url: AGENT_GUIDE, version: "refused" }] } }));
  const dialectCleared = await tryUntil("the body refuses a snapshot in a dialect it doesn't read", async () => guideLines(await lookText(dialectReader)).length === 0, { ms: 5000 });
  check("so does a later snapshot in a dialect the body doesn't read",
    beforeDialect.length === 1 && dialectCleared !== undefined && dialectReader.joined, JSON.stringify([beforeDialect, guideLines(await lookText(dialectReader)), dialectReader.joined]));

  const examplePath = join(h.SCRATCH, "tokens.example.json");
  writeFileSync(examplePath, "{}");
  hPublic = await scratchSequencer("briefing-public", { portFrom: h.PORT + 300, worlds: ["briefing", "annex"], serverEnv: { ...serverEnv, HN_NATIVE_ORIGIN: "https://world.example" } });
  const publicWS = hPublic.BASE.replace("http", "ws") + "/ws";
  const publicSnapshot: any = await new Promise((resolve, reject) => {
    const ws = new WebSocket(publicWS); sockets.push(ws);
    const timer = setTimeout(() => reject(new Error("raw join timed out")), 8000);
    ws.onopen = () => ws.send(JSON.stringify((capture as any).joinMsg()));
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { clearTimeout(timer); resolve(m); }
      if (m.type === "error") { clearTimeout(timer); reject(new Error(m.error)); }
    };
  });
  check("a join to a sequencer with HN_NATIVE_ORIGIN set names the guide at that origin", publicSnapshot.briefing?.docs?.[0]?.url === "https://world.example/agents.md",
    JSON.stringify(publicSnapshot.briefing?.docs));

  async function door(label: string, worldUrl: string) {
    const port = freePort(h!.PORT + 100 + 10 * sockets.length);
    const nonce = crypto.randomUUID();
    const p = h!.track(Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
      cwd: ROOT,
      env: { ...process.env, MCPL_PORT: String(port), MCPL_INSTANCE_NONCE: nonce, MCPL_TOKENS: tokenPath, MCPL_TOKENS_EXAMPLE: examplePath,
        MCPL_STATE: join(h!.SCRATCH, label + "-state.json"), WORLD_URL: worldUrl, WORLD_TOKEN: "", EIDO_MEDIA_PORT: "0", HN_ISSUER_KEY: "" },
      stdout: Bun.file(join(h!.SCRATCH, label + ".log")), stderr: Bun.file(join(h!.SCRATCH, label + ".stderr.log")),
    }));
    await until(`door ${label} ready`, async () => {
      if (p.exitCode !== null) throw new Error(`door ${label} exited ${p.exitCode}; logs at ${h!.SCRATCH}`);
      try { return (await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).text()).trim() === `ok ${nonce}`; } catch { return false; }
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=briefing-reader-token&world=briefing`); sockets.push(ws);
    const replies = new Map<number, any>();
    let next = 0;
    const send = (m: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", ...(m as object) }) + "\n");
    ws.onmessage = ev => {
      for (const line of String(ev.data).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.id != null && !m.method) replies.set(m.id, m);
        else if (m.id != null && m.method) send({ id: m.id, result: { results: (m.params?.added ?? []).map((c: any) => ({ id: c.id, accepted: true })) } });
      }
    };
    await until(`door ${label} socket open`, () => ws.readyState === WebSocket.OPEN);
    const rpc = async (method: string, params: unknown) => {
      const id = ++next; send({ id, method, params });
      const reply = await until(`door ${label} ${method}`, () => replies.get(id));
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    };
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "briefing-test", version: "1" } });
    send({ method: "notifications/initialized" });
    const call = (name: string, args = {}) => rpc("tools/call", { name, arguments: args });
    const look = async (): Promise<string> => (await call("look")).content[0].text;
    return { call, look };
  }
  const publicDoor = await door("public", publicWS);
  const publicLines = guideLines(await publicDoor.look());
  check("a network door names the guide at its server's public origin, never at its private sequencer address",
    JSON.stringify(publicLines) === JSON.stringify([`Agent guide: https://world.example/agents.md, version ${doc.version} when you joined`]), JSON.stringify(publicLines));
  const travel = await publicDoor.call("travel", { world: "annex" });
  const travelled = await publicDoor.look();
  check("travel through the door reaches the other world", !travel.isError && travelled.includes(`in world "annex"`), travelled.split("\n")[0]);
  check("and the body it travels with names the guide at the same origin", JSON.stringify(guideLines(travelled)) === JSON.stringify(publicLines));
  const bareDoor = await door("bare", WS);
  const bareLines = guideLines(await bareDoor.look());
  check("a network door whose server has no public origin gives the version and says the address is unknown on this connection",
    JSON.stringify(bareLines) === JSON.stringify([`Agent guide: version ${doc.version} when you joined; its address is unknown on this connection (the world's server has no public origin set)`]), JSON.stringify(bareLines));
  completed = true;
} finally {
  for (const a of agents) a.close();
  for (const ws of sockets) ws.close();
  for (const s of servers) s.stop(true);
  await hPublic?.cleanup(completed && !tally.failed ? 0 : 1);
  await h?.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed${tally.note()}`);
process.exit(tally.failed ? 1 : 0);
