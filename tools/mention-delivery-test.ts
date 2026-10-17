// Real MCPL routing for display names: whispers, both replay cursors, history,
// travel, aid1 alias policy, duplicate credentials, and a refused registry reload.
// Own all listeners/state via the scratch harness; never contact a live world.
// Run: bun tools/mention-delivery-test.ts
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchSequencer, freePort, ROOT } from "./harness.ts";

const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ type: "spki", format: "der" });
const issuer = `ed25519:${publicKey.subarray(-32).toString("base64url")}`;
const now = Math.floor(Date.now() / 1000);
const payload = Buffer.from(JSON.stringify({
  v: 1, iss: "issuer.example", sub: "agent:visitor@guest", kind: "agent",
  name: "Visitor (guest)", aud: "eidoverse", scopes: ["worlds:join"],
  iat: now, exp: now + 600, claims: { worlds: ["*"], create: true },
})).toString("base64url");
const visitorToken = `aid1.${payload}.${sign(null, Buffer.from(`aid1.${payload}`), pair.privateKey).toString("base64url")}`;
const registry = {
  "artie-token": { id: "artie-kube", name: "Artie (kube)", worlds: ["*"], create: true },
  "listener-token": { id: "listener", name: "Listener", worlds: ["*"], create: true },
  "other-artie-token": { id: "artie-kube", name: "Other credential" },
};
const authEnv = { HN_ISSUER_KEY: issuer, HN_ISS: "issuer.example", HN_AUD: "eidoverse", HN_REQUIRE_LOGIN: "0", EIDO_WHISPERS_ENABLED: "1" };
const serverEnv: Record<string, string> = { ...authEnv, SKIP_OPT_SWEEP: "1" };
let tokenPath = "";
const h = await scratchSequencer("mention-delivery", {
  serverEnv,
  prepare: (scratch) => {
    tokenPath = join(scratch, "tokens.json");
    writeFileSync(tokenPath, JSON.stringify(registry));
    serverEnv.AGENT_TOKENS_PATH = tokenPath;
  },
});
const port = freePort(h.PORT + 100);
const statePath = join(h.SCRATCH, "state.json");
// First visitor admission exercises the older timestamp-only replay path.
writeFileSync(statePath, JSON.stringify({ "visitor-guest": 1 }));
const examplePath = join(h.SCRATCH, "tokens.example.json");
writeFileSync(examplePath, "{}");
const door = h.track(Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  cwd: ROOT,
  env: { ...process.env, ...authEnv, MCPL_PORT: String(port), MCPL_INSTANCE_NONCE: h.NONCE,
    WORLD_URL: h.BASE.replace("http", "ws") + "/ws", WORLD_TOKEN: "", EIDO_MEDIA_PORT: "0",
    MCPL_TOKENS: tokenPath, MCPL_TOKENS_EXAMPLE: examplePath, MCPL_STATE: statePath },
  stdout: Bun.file(join(h.SCRATCH, "door.log")), stderr: Bun.file(join(h.SCRATCH, "door.stderr.log")),
}));
let passed = 0;
function check(name: string, ok: unknown) {
  if (!ok) throw new Error(`FAIL: ${name}`);
  console.log(`PASS ${name}`); passed++;
}
async function until(name: string, probe: () => unknown | Promise<unknown>) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (door.exitCode !== null) throw new Error(`door exited ${door.exitCode}`);
    if (await probe()) return;
    await h.sleep(20);
  }
  throw new Error(`timeout: ${name}`);
}
const hosts: Host[] = [];
class Host {
  ws: WebSocket;
  incoming: any[] = [];
  pending = new Map<number, (m: any) => void>();
  nextId = 1;
  constructor(token: string, world?: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}${world ? `&world=${world}` : ""}`);
    hosts.push(this);
    this.ws.onmessage = (event) => {
      for (const line of String(event.data).split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (!m.method && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); continue; }
        if (m.method === "channels/incoming") this.incoming.push(...m.params.messages);
        if (m.id !== undefined && m.method) this.send({ id: m.id, result: {
          results: (m.params?.added ?? []).map((c: any) => ({ id: c.id, accepted: true })),
        } });
      }
    };
  }
  send(body: any) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n"); }
  request(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 8000);
      this.pending.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); });
      this.send({ id, method, params });
    });
  }
  async init() {
    await until("host socket open", () => this.ws.readyState === WebSocket.OPEN);
    await this.request("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "mention-test", version: "1" },
      capabilities: { experimental: { mcpl: { version: "0.5" } } } });
    this.send({ method: "notifications/initialized" });
    await this.request("featureSets/update", { effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle", "channels.publish", "channels.incoming"] });
    return this;
  }
  find(text: string) { return this.incoming.find((m) => m.content.some((c: any) => c.text?.includes(text))); }
  async message(text: string) { await until(text, () => this.find(text)); return this.find(text); }
  async tool(name: string, args: any) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result;
  }
  say(text: string) { return this.tool("say", { text }); }
  async close() {
    this.ws.close();
    await until("host socket closed", () => this.ws.readyState === WebSocket.CLOSED);
  }
}

try {
  await until("owned door ready", async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).trim() === `ok ${h.NONCE}`; }
    catch { return false; }
  });
  let listener = await new Host("listener-token").init();
  const artie = await new Host("artie-token").init();
  await artie.say("legacy-name-marker");
  const legacy = await listener.message("legacy-name-marker");
  check("speech uses the admitted credential despite a duplicate registry id", legacy.author.name === "Artie (kube)");
  check("rendered speech retains the id prefix", legacy.content[0].text === "artie-kube: legacy-name-marker");
  await artie.tool("whisper", { to: "listener", text: "legacy-whisper-marker" });
  check("legacy whispers carry the display name", (await listener.message("legacy-whisper-marker")).author.name === "Artie (kube)");

  await listener.say("@Visitor timestamp-short-marker");
  await listener.say("@Visitor (guest) timestamp-full-marker");
  await artie.message("timestamp-full-marker");
  let visitor = await new Host(visitorToken).init();
  check("timestamp replay delivers the full enrolled name", (await visitor.message("timestamp-full-marker")).tags.includes("eidoverse:catchup"));
  check("timestamp replay does not grant an enrolled short alias", !visitor.find("timestamp-short-marker"));
  await visitor.say("aid1-name-marker");
  check("aid1 speech carries its verified display name", (await listener.message("aid1-name-marker")).author.name === "Visitor (guest)");
  await visitor.tool("whisper", { to: "listener", text: "aid1-whisper-marker" });
  check("aid1 whispers carry their verified display name", (await listener.message("aid1-whisper-marker")).author.name === "Visitor (guest)");

  for (const world of ["commons", "annex"]) {
    if (world === "annex") for (const host of [artie, listener, visitor]) await host.tool("travel", { world });
    await artie.request("channels/close", { channelId: `world:${world}` });
    await listener.say(`@Artie (cloud) wrong-qualifier-${world}`);
    await listener.say(`@Artie correct-alias-${world}`);
    check(`operator short mention reaches closed channel in ${world}`, (await artie.message(`correct-alias-${world}`)).metadata.mentioned);
    check(`explicit different qualifier stays silent in ${world}`, !artie.find(`wrong-qualifier-${world}`));
    await visitor.request("channels/close", { channelId: `world:${world}` });
    await listener.say(`@Visitor unowned-alias-${world}`);
    await listener.say(`@Visitor (guest) enrolled-name-${world}`);
    check(`full enrolled mention reaches closed channel in ${world}`, (await visitor.message(`enrolled-name-${world}`)).metadata.mentioned);
    check(`self-enrolled short alias stays silent in ${world}`, !visitor.find(`unowned-alias-${world}`));
  }
  await visitor.say("history-name-marker");
  await listener.message("history-name-marker");
  const history = await listener.request("channels/open", { channelId: "world:annex", history: { limit: 100 } });
  check("history carries aid1 author names", history.history.find((m: any) => m.content[0].text.includes("history-name-marker"))?.author.name === "Visitor (guest)");

  await visitor.close();
  await listener.say("@Visitor sequence-short-marker");
  await listener.say("@Visitor (guest) sequence-full-marker");
  visitor = await new Host(visitorToken, "annex").init();
  check("sequence replay delivers the full enrolled name", (await visitor.message("sequence-full-marker")).tags.includes("eidoverse:catchup"));
  check("sequence replay does not grant an enrolled short alias", !visitor.find("sequence-short-marker"));

  await listener.close();
  await visitor.say("@Listener absent-author-marker");
  await visitor.close();
  listener = await new Host("listener-token", "annex").init();
  const replay = await listener.message("absent-author-marker");
  check("catch-up retains a disconnected aid1 author's name", replay.author.name === "Visitor (guest)" && replay.tags.includes("eidoverse:catchup"));

  writeFileSync(tokenPath, "{");
  const refused = new Host("artie-token");
  await until("refused socket open", () => refused.ws.readyState === WebSocket.OPEN);
  let refusal = "";
  try { await refused.request("initialize", { capabilities: {}, clientInfo: { name: "refused-test", version: "1" } }); }
  catch (error) { refusal = String(error); }
  check("malformed registry still refuses legacy authentication", refusal.includes('"code":-32001'));
  await artie.say("after-failed-reload-marker");
  check("refused reload cannot erase an active author's name", (await listener.message("after-failed-reload-marker")).author.name === "Artie (kube)");
  console.log(`\n${passed} display-name delivery checks passed`);
} catch (error) {
  console.error(readFileSync(join(h.SCRATCH, "door.stderr.log"), "utf8"));
  console.error(readFileSync(join(h.SCRATCH, "door.log"), "utf8"));
  h.record("failure.jsonl", { error: String(error) });
  process.exitCode = 1;
  throw error;
} finally {
  for (const host of hosts) host.ws.close();
  await h.cleanup();
}
