// test/protocol/hello-refused-check.ts — a join the server refuses at the hello ({type: "refused", code, need}: F-3
// steps 2 and 4) is an answer the agent, the page, tend and the caption bot say in words, never a join timeout (docs/decisions/LOG-VOCABULARY.md §F).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/protocol/hello-refused-check.ts
// @ts-nocheck
import fs from "node:fs";
import { ENGINE } from "../gate/common.ts";
import { refusalWords, NEED } from "../../shared/protocol/hello.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail !== "" ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`); };
const read = (p: string) => fs.readFileSync(ENGINE + p, "utf8");

// HR1: the words, from the refusal alone (no world named)
const upd = refusalWords({ type: "refused", code: "update-required", need: { dialect: NEED.dialect, v: NEED.v } });
const feat = refusalWords({ type: "refused", code: "unsupported-feature", need: ["acme:boats@1"] });
check("HR1 an update-required refusal says what the server speaks and to update the client; an unsupported-feature one names the features", /update/.test(upd) && upd.includes(NEED.dialect) && /acme:boats@1/.test(feat) && /update/.test(feat), [upd, feat]);

// HR2: the agent (mcpl/agent.ts) against a server that refuses its hello: the join rejects at once, in those words
{ const server = Bun.serve({ port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: { message(ws, m) { const msg = JSON.parse(String(m)); if (msg.type === "join") { ws.send(JSON.stringify({ type: "refused", code: "update-required", need: { dialect: NEED.dialect, v: NEED.v } })); ws.close(4005, "update-required"); } } } });
  const { WorldAgent } = await import("../../mcpl/agent.ts");
  const ag = new WorldAgent({ url: `ws://127.0.0.1:${server.port}/ws`, world: "w", name: "probe" });
  const t0 = Date.now(); let said = "";
  try { await Promise.race([ag.connect(), new Promise((_, no) => setTimeout(() => no(new Error("TIMEOUT")), 8000))]); said = "joined?"; } catch (e) { said = String(e?.message ?? e); }
  try { ag.close?.(); } catch { /* closed */ }
  server.stop(true);
  check("HR2 the agent's join refused at the hello rejects in the server's terms (update the client), not a timeout", /update/.test(said) && !/TIMEOUT|timed out/i.test(said) && Date.now() - t0 < 8000, said); }

// HR3: tend and the caption bot, each run against a server that refuses its hello: each says refusalWords' answer, at
// once (G6-106: they were source greps). The page (client/lib/net.js, live and the early socket's buffered messages) is
// still read as source: a browser leg needs a server that refuses the page's own hello
const REFUSAL = { type: "refused", code: "update-required", need: { dialect: NEED.dialect, v: NEED.v } }, WORDS = refusalWords(REFUSAL);
const refuser = () => Bun.serve({ port: 0, fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: { message(ws, m) { const msg = JSON.parse(String(m)); if (msg.type === "join") { ws.send(JSON.stringify(REFUSAL)); ws.close(4005, "update-required"); } } } });
{ const server = refuser(); const t0 = Date.now();
  const p = Bun.spawn(["bun", ENGINE + "tools/tend.ts", "w"], { cwd: ENGINE, env: { ...process.env, PORT: String(server.port), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  const code = await p.exited, err = (await new Response(p.stderr).text()).trim(); server.stop(true);
  check("HR3 tend refused at the hello exits non-zero with refusalWords' answer, not its timeout", code === 1 && err.includes(WORDS) && !/timeout/.test(err) && Date.now() - t0 < 9000, [code, err.slice(0, 200)]); }
{ const server = refuser(); const { WorldClient } = await import("../../services/captionbot/world.ts"); const { tryUntil } = await import("../gate/wait.ts"); const said: string[] = [];
  const bot = new WorldClient({ url: `ws://127.0.0.1:${server.port}/ws`, token: "", world: "w", actor: "captions", screenId: "screen", log: (m) => said.push(m) });
  bot.connect();
  await tryUntil("the bot says the refusal", () => said.some((m) => m.includes(WORDS)), { ms: 3000, step: 20 });
  server.stop(true); bot.close();
  check("HR3 the caption bot refused at the hello says refusalWords' answer", said.some((m) => m === `world error: ${WORDS}`), said.slice(0, 4)); }
{ const net = read("client/lib/net.js"); const live = net.slice(net.indexOf("case 'refused':"), net.indexOf("break;", net.indexOf("case 'refused':")));
  check("HR3 net.js handles a refused message (live and buffered by the early socket) in refusalWords' terms (source)",
    /noteRefusal\(refusalWords\(msg\)/.test(live) && /msg\?\.type === 'refused'\) noteRefusal\(refusalWords\(msg\)/.test(net), ""); }

console.log(`[hello-refused-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
