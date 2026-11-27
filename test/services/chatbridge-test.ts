// chatbridge-test — the Discord chat bridge (services/chatbridge) against an owned scratch world, Discord played by
// the bridge's own DRY_RUN (stdin lines "Name: text" are Discord messages; world lines print as "→ discord [who]").
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/services/chatbridge-test.ts
//
// The world speaks the protocol: the bridge must join with replica, read chat from the log stream's `say` entries
// (actors are opaque ids, named by the stream), and speak through a door `say` request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, foundWorlds, freePort, saysIn, scratchState } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const BRIDGE = process.env.CHATBRIDGE ?? "services/chatbridge/index.ts";   // another build, for a red-first control
const W = mkdtempSync(join(tmpdir(), "ew-chatbridge-"));
foundWorlds(W, ["commons"]);
const PORT = freePort(9720);
const srv = Bun.spawn([process.execPath, "server/server.ts"], { cwd: ROOT,
  env: { ...process.env, ...scratchState(), PORT: String(PORT), WORLDS_DIR: W, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1" }, stdout: "ignore", stderr: "ignore" });
let bridge: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
const cleanup = () => { try { bridge?.kill(); } catch {} try { srv.kill(); } catch {} rmSync(W, { recursive: true, force: true }); };
// up = the door answers; with JOIN_TOKEN /worlds is 401 (public reads gated 10-14)
if (!await tryUntil("the scratch server answers", async () => (await fetch(`http://127.0.0.1:${PORT}/worlds`)).status < 500, { ms: 20_000 })) {
  console.error("scratch server never came up"); cleanup(); process.exit(2);
}

const join_ = (id: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const msgs: any[] = [];
  const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 8000);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); msgs.push(m); if (m.type === "snapshot") { clearTimeout(t); res({ ws, msgs }); } if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", id, replica: true }));
});
const say = (c: { ws: WebSocket }, text: string) => c.ws.send(JSON.stringify({ type: "request", id: `t-${Math.random()}`, verb: "say", args: { text } }));

const S = suite("chatbridge");
const check = (what: string, c: unknown, detail?: unknown) => S.check(what, c, detail);

const alice = await join_("alice");
say(alice, "before the bridge (history: must not be mirrored)");
await tryUntil("the history line is in the log", () => saysIn(alice.msgs).some((x) => /before the bridge/.test(x.text)));
bridge = Bun.spawn([process.execPath, BRIDGE], { cwd: ROOT,
  env: { ...process.env, DRY_RUN: "1", WORLD_URL: `ws://127.0.0.1:${PORT}/ws`, WORLD_NAME: "commons", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let out = "";
(async () => { for await (const c of bridge!.stdout) out += Buffer.from(c).toString(); })();
await tryUntil("the bridge joins", () => /joined "commons"/.test(out));
say(alice, "hello from the world");
bridge.stdin.write("Ann: hi from discord\n"); bridge.stdin.flush();
await tryUntil("both directions crossed", () => /→ discord \[alice\]/.test(out) && saysIn(alice.msgs).some((x) => x.actor === "discord"));
// the fence: the bridge mirrors the log in order, so a wrongly echoed own say would print before this line does
say(alice, "fence after the discord line");
await tryUntil("the fence line reaches Discord", () => /→ discord \[alice\]: fence after the discord line/.test(out));

console.log("\nchatbridge — world ⇄ Discord (DRY_RUN) on a world\n");
check('the bridge joins (replica) embodied, as "discord"', /joined "commons" as discord/.test(out), out.slice(-300));
check("a world say reaches Discord, attributed to its speaker's display name (not the opaque id)", /→ discord \[alice\]: hello from the world/.test(out), out.slice(-300));
check("history from before the join is not mirrored", !/before the bridge/.test(out));
check("a Discord line enters the world as the bridge's door say, attributed inside the text", saysIn(alice.msgs).some((x) => x.actor === "discord" && x.text === "Ann: hi from discord"), JSON.stringify(saysIn(alice.msgs)));
check("the bridge's own say is not echoed back to Discord (and the fence after it was mirrored)", /→ discord \[alice\]: fence after the discord line/.test(out) && !/→ discord \[discord\]/.test(out) && !/hi from discord\n.*→ discord/.test(out));
check("nothing was refused", !/refused/.test(out), out.slice(-300));

// a burst faster than the say limit (20 per 10 s per actor, authority/gate.js): the bridge paces itself under it (SEND_GAP_MS) and every line lands, in order (#260 house I1)
const N = 25, burst = Array.from({ length: N }, (_, i) => `Bo: burst ${i}`);
bridge.stdin.write(burst.join("\n") + "\n"); bridge.stdin.flush();
const landed = () => saysIn(alice.msgs).filter((x) => x.actor === "discord" && /^Bo: burst \d+$/.test(x.text)).map((x) => x.text);
await tryUntil("the whole burst lands", () => landed().length >= N, { ms: 40_000 });
check(`a burst of ${N} Discord lines all enter the world, in order`, JSON.stringify(landed()) === JSON.stringify(burst), `${landed().length} landed: ${landed().slice(-3).join(" | ")}`);
check("…none dropped: no refusal but the rate one, which is retried in place", !/refused/.test(out), out.split("\n").filter((l) => /refused/.test(l)).slice(0, 3).join(" | "));
check("…paced under the limit: the world never had to ask the bridge to slow down (the rate retry path is not exercised here)", !/slow down/.test(out), out.split("\n").filter((l) => /slow down/.test(l)).slice(0, 2).join(" | "));
cleanup();
S.done();
