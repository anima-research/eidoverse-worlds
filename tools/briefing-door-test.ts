// A remote MCPL reader uses the public door, not its private sequencer URL.
// Run: bun tools/briefing-door-test.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WebSocket } from "../mcpl/node_modules/ws";
import { briefingOrigin, proxyAgentGuide, sequencerGuideURL } from "../mcpl/briefing-door.ts";
import { scratchSequencer, freePort, mkCheck, sleep } from "./harness.ts";
const { check, tally } = mkCheck();
const dir = mkdtempSync(join(tmpdir(), "briefing-door-"));
let h: Awaited<ReturnType<typeof scratchSequencer>> | undefined;
const sockets: WebSocket[] = [], servers: ReturnType<typeof Bun.serve>[] = [];
let completed = false;
async function until(f: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!await f()) { if (Date.now() > end) throw new Error("network briefing condition timed out"); await sleep(20); }
}
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
try {
  check("direct origin uses the public door Host and port", briefingOrigin({ host: "world.example:8941" }) === "http://world.example:8941");
  check("TLS proxy preserves HTTPS in the reader-facing origin", briefingOrigin({ host: "world.example", "x-forwarded-proto": "https" }) === "https://world.example");
  check("public origin override wins over internal proxy headers", briefingOrigin({ host: "127.0.0.1:8941" }, "https://outside.example") === "https://outside.example");
  check("missing and credential-bearing Host cannot become a pointer", briefingOrigin({}) === null && briefingOrigin({ host: "user:secret@world.example" }) === null);
  let rejected = 0;
  for (const setting of ["file:///tmp", "https://u:p@world.example", "https://world.example/path", "https://world.example?token=x", "https://world.example/#secret"])
    try { briefingOrigin({}, setting); } catch { rejected++; }
  check("invalid public configuration fails explicitly", rejected === 5);
  check("upstream guide URL keeps a mount prefix but strips credentials", sequencerGuideURL("wss://user:secret@private.example/prefix/ws?token=hidden#fragment").href === "https://private.example/prefix/agents.md");

  let upstreamRequest: { url: string; headers: Headers } | undefined;
  const failed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    upstreamRequest = { url: req.url, headers: new Headers(req.headers) };
    return new Response("unavailable", { status: 503, headers: { "cache-control": "no-store" } });
  } }); servers.push(failed);
  const missing = await proxyAgentGuide("GET", { authorization: "Bearer do-not-forward", cookie: "private=x", "if-none-match": '"v1"' }, `ws://127.0.0.1:${failed.port}/ws?token=private-transport`);
  check("guide failure stays a legible uncached failure", missing.status === 503 && missing.headers.get("cache-control") === "no-store");
  check("proxy forwards only the conditional header to the fixed guide path", new URL(upstreamRequest!.url).pathname === "/agents.md" && !new URL(upstreamRequest!.url).search && !upstreamRequest!.headers.has("authorization") && !upstreamRequest!.headers.has("cookie") && upstreamRequest!.headers.get("if-none-match") === '"v1"');
  const failedPort = failed.port; failed.stop(true);
  const disconnected = await proxyAgentGuide("GET", {}, `ws://127.0.0.1:${failedPort}/ws`);
  check("unreachable sequencer fails without exposing its private URL", disconnected.status === 502 && !((await disconnected.text()).includes("127.0.0.1")));

  h = await scratchSequencer("briefing-door", { portFrom: 9740, serverEnv: {
    OPT_DIR: join(dir, "opt"), EIDOVERSE_DIR: join(dir, "library"), SKIP_OPT_SWEEP: "1", HN_REQUIRE_LOGIN: "0", HN_ISSUER_KEY: "",
  } });
  const guide = new Uint8Array(await (await fetch(h.BASE + "/agents.md")).arrayBuffer());
  const version = digest(guide);
  async function door(label: string, publicOrigin = "") {
    const port = freePort(h!.PORT + 30 + sockets.length);
    const nonce = crypto.randomUUID();
    const tokens = join(dir, label + "-tokens.json");
    writeFileSync(tokens, JSON.stringify({ "reader-token": { id: label, world: "briefing", worlds: ["*"], create: true, avatar: "" } }));
    const p = h!.track(Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, MCPL_PORT: String(port), MCPL_TOKENS: tokens, MCPL_STATE: join(dir, label + "-state.json"), MCPL_INSTANCE_NONCE: nonce,
        WORLD_URL: h!.BASE.replace("http", "ws") + "/ws?token=private-transport", WORLD_TOKEN: "", HN_ISSUER_KEY: "", MCPL_PUBLIC_ORIGIN: publicOrigin },
      stdout: Bun.file(join(h!.SCRATCH, label + ".log")), stderr: Bun.file(join(h!.SCRATCH, label + ".stderr.log")),
    }));
    await until(async () => {
      if (p.exitCode !== null) throw new Error(`MCPL child ${label} exited ${p.exitCode}; logs at ${h!.SCRATCH}`);
      try { return await (await fetch(`http://127.0.0.1:${port}/healthz`)).text() === `ok ${nonce}\n`; } catch { return false; }
    });
    return { port, base: `http://127.0.0.1:${port}` };
  }
  async function host(port: number, headers: Record<string, string> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcpl?token=reader-token`, { headers }); sockets.push(ws);
    let next = 0;
    const replies = new Map<number, any>();
    ws.on("message", data => { for (const line of String(data).split("\n")) if (line.trim()) {
      const m = JSON.parse(line); if (m.id != null && !m.method) replies.set(m.id, m);
    } });
    await until(() => ws.readyState === WebSocket.OPEN);
    async function rpc(method: string, params: any) {
      const id = ++next; ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      await until(() => replies.has(id));
      const reply = replies.get(id); if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    }
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "remote-reader-test", version: "1" } });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const call = (name: string, args = {}) => rpc("tools/call", { name, arguments: args });
    async function briefing() {
      const reply = await call("look");
      const line = reply.content[0].text.split("\n").find((s: string) => s.startsWith("Briefing (door guidance): "));
      if (!line) throw new Error("network look omitted briefing");
      return JSON.parse(line.slice("Briefing (door guidance): ".length));
    }
    return { ws, call, briefing };
  }
  const directDoor = await door("direct-reader");
  const reader = await host(directDoor.port);
  const offered = await reader.briefing(), doc = offered.docs[0];
  check("network look advertises the reader-facing door, not its backend", doc.url === directDoor.base + "/agents.md" && doc.url !== h.BASE + "/agents.md");
  const read = await fetch(doc.url), body = new Uint8Array(await read.arrayBuffer());
  check("remote reader can fetch the advertised document with exact version", read.ok && digest(body) === doc.version && doc.version === version);
  check("proxy preserves the guide ETag", read.headers.get("etag") === `"${version}"`);
  const cached = await fetch(doc.url, { headers: { "if-none-match": `"${version}"` } });
  check("reader-facing conditional fetch returns 304", cached.status === 304 && await cached.text() === "");
  const head = await fetch(doc.url, { method: "HEAD" });
  check("reader-facing HEAD exposes metadata without a body", head.ok && head.headers.get("etag") === `"${version}"` && await head.text() === "");
  const travel = await reader.call("travel", { world: "annex" });
  check("plain MCP travel succeeds through the actual door", !travel.isError && travel.content[0].text.includes("annex"));
  check("travel retains the public briefing origin", (await reader.briefing()).docs[0].url === doc.url);
  check("reader-facing guide URL contains no transport credentials", !new URL(doc.url).search && !new URL(doc.url).username && !new URL(doc.url).password && !JSON.stringify(offered).includes("private-transport") && !JSON.stringify(offered).includes("reader-token"));
  reader.ws.close();
  const tlsReader = await host(directDoor.port, { Host: "public.example", "X-Forwarded-Proto": "https" });
  check("real network session honors TLS proxy host/protocol", (await tlsReader.briefing()).docs[0].url === "https://public.example/agents.md");
  tlsReader.ws.close();

  let publicReads = 0;
  const publicHTTP = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    publicReads++;
    return await fetch(h!.BASE + new URL(req.url).pathname);
  } }); servers.push(publicHTTP);
  const publicOrigin = `http://127.0.0.1:${publicHTTP.port}`;
  const configuredDoor = await door("configured-reader", publicOrigin);
  const configuredReader = await host(configuredDoor.port, { Host: "internal-proxy.example", "X-Forwarded-Proto": "https" });
  const publicDoc = (await configuredReader.briefing()).docs[0];
  check("operator origin overrides private proxy headers in actual look", publicDoc.url === publicOrigin + "/agents.md");
  const publicBody = new Uint8Array(await (await fetch(publicDoc.url)).arrayBuffer());
  check("explicitly advertised public origin serves the same guide", publicReads === 1 && digest(publicBody) === publicDoc.version);
  completed = true;
} finally {
  for (const ws of sockets) ws.close();
  for (const server of servers) server.stop(true);
  await h?.cleanup(completed && !tally.failed ? 0 : 1);
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${tally.passed} passed; ${tally.failed} failed`);
process.exit(tally.failed ? 1 : 0);
