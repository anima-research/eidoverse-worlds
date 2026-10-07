// voicebot-test — the show voice bot (tools/voicebot) hears a world: DRY_RUN, no Discord, no TTS key. With a voices
// file that maps nobody, every line it would voice logs `no voice for "<speaker>"`, which is the receipt that the line
// reached the synth step, under the speaker's display name, filtered by SPEAKERS.
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/voicebot-test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, foundWorlds, freePort, sleep } from "./harness.ts";

const BOT = process.env.VOICEBOT ?? "tools/voicebot/index.ts";   // another build, for a red-first control
const W = mkdtempSync(join(tmpdir(), "ew-voicebot-"));
foundWorlds(W, ["commons"]);
const voices = join(W, "voices.json"); writeFileSync(voices, JSON.stringify({ nobody: "REPLACE-me" }));
const PORT = freePort(9740);
const srv = Bun.spawn([process.execPath, "server/server.ts"], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: W, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1" }, stdout: "ignore", stderr: "ignore" });
let bot: Bun.Subprocess | null = null;
const done = (code: number) => { try { bot?.kill(); } catch {} try { srv.kill(); } catch {} rmSync(W, { recursive: true, force: true }); process.exit(code); };
let up = false;
for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${PORT}/worlds`)).ok; } catch {} if (!up) await sleep(150); }
if (!up) { console.error("scratch server never came up"); done(2); }

const join_ = (id: string) => new Promise<WebSocket>((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 8000);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "snapshot") { clearTimeout(t); res(ws); } if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "commons", id, replica: true }));
});
const say = (ws: WebSocket, text: string) => ws.send(JSON.stringify({ type: "request", id: `t-${Math.random()}`, verb: "say", args: { text } }));

let pass = 0, fail = 0;
const check = (what: string, c: boolean, detail = "") => { if (c) pass++; else fail++; console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${what}${!c && detail ? `  — ${detail}` : ""}`); };

const alice = await join_("alice"), bob = await join_("bob");
say(alice, "said before the bot came (history)");
await sleep(300);
bot = Bun.spawn([process.execPath, BOT], { cwd: ROOT,
  env: { ...process.env, DRY_RUN: "1", WORLD_URL: `ws://127.0.0.1:${PORT}/ws`, WORLD_NAME: "commons", SPEAKERS: "alice", VOICES_FILE: voices, ELEVEN_KEY: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  stdout: "pipe", stderr: "pipe" });
let out = "";
(async () => { for await (const c of (bot as any).stdout) out += Buffer.from(c).toString(); })();
for (let i = 0; i < 40 && !/watching world/.test(out); i++) await sleep(100);
say(bob, "bob is not a configured speaker");
say(alice, "alice is");
for (let i = 0; i < 40 && !/no voice for "alice"/.test(out); i++) await sleep(100);
await sleep(400);

console.log("\nvoicebot — hearing a world (DRY_RUN)\n");
check("the bot joins as a spectator that folds the log", /watching world "commons" as spectator/.test(out), out.slice(-300));
check("a configured speaker's live line reaches the synth step, by display name", (out.match(/no voice for "alice"/g) ?? []).length === 1, out.slice(-400));
check("history from before the join is not voiced", !/history/.test(out));
check("a speaker not in SPEAKERS is not voiced", !/"bob"/.test(out));
console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
