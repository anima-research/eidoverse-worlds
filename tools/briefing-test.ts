// Arrival snapshot -> WorldAgent -> shared MCPL look, plus the served guide.
// Run: bun tools/briefing-test.ts
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAgentGuide } from "../server/briefing.ts";
import { resolveBriefing } from "../shared/briefing.js";
import { scratchSequencer, mkCheck, sleep } from "./harness.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { handleTool, TOOLS } from "../mcpl/tools.ts";

process.env.WORLD_TOKEN = "";
process.env.AGENT_BODY_ENGINE = "verlet";
const { check, tally } = mkCheck();
const scratch = mkdtempSync(join(tmpdir(), "briefing-"));
const agents: WorldAgent[] = [], sockets: WebSocket[] = [];
let h: Awaited<ReturnType<typeof scratchSequencer>> | undefined;
let fake: ReturnType<typeof Bun.serve> | undefined;
let completed = false;
const hash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const look = async (agent: WorldAgent) => {
  const reply = await handleTool({ agent, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null } }, "look", {});
  const line = reply.content[0].text.split("\n").find((s: string) => s.startsWith("Briefing (door guidance): "));
  return line ? JSON.parse(line.slice("Briefing (door guidance): ".length)) : null;
};
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
  check("missing legacy briefing is optional", resolveBriefing(undefined, "http://localhost/") === null);
  const parsed = resolveBriefing({ motd: "hello", docs: [null, {}, { title: "bad", url: "javascript:alert(1)", version: "x" }, { title: "guide", url: "/agents.md", version: "v1" }] }, "https://world.example/");
  check("relative links resolve and malformed pointers stay out", parsed?.docs.length === 1 && parsed.docs[0].url === "https://world.example/agents.md");

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
  check("both MCPL doors advertise briefing through the shared look schema", TOOLS.find(t => t.name === "look")!.description.includes("content versions"));
  const history = await agent.history({ limit: 100 });
  check("briefing does not create a world-log entry", !JSON.stringify(history).includes("sha256:") && !JSON.stringify(history).includes("briefing\":"));

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
  peer.close(); await until(() => joins === 2 && client.joined);
  check("reconnect with identical guidance preserves content version", (await look(client)).docs[0].version === "one");
  current = { ...current, docs: [{ ...current.docs[0], version: "two" }] };
  peer.close(); await until(() => joins === 3 && client.joined);
  check("reconnect exposes changed document version", (await look(client)).docs[0].version === "two");
  current = undefined; peer.close(); await until(() => joins === 4 && client.joined);
  check("older server clears previous briefing rather than retaining stale guidance", await look(client) === null);
  check("offered guidance leaves reading and wakes to the consumer", guideFetches === 0 && pings === 0 && events === 0 && client.pings.length === 0);
  completed = true;
} finally {
  for (const a of agents) a.close();
  for (const ws of sockets) ws.close();
  fake?.stop(true);
  await h?.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
