// tools/protocol/hello-refused-check.ts — a join the server refuses at the hello ({type: "refused", code, need}: F-3
// steps 2 and 4) is an answer every client says in words, never a join timeout (docs/DESIGN-log-vocabulary.md §F).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/hello-refused-check.ts
// @ts-nocheck
import fs from "node:fs";
import { ENGINE } from "./common.ts";
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

// HR3: the page (client/lib/net.js), the server's tend and the caption bot read the refusal too (the inline early socket's
// buffered messages are read by net.js)
{ const net = read("client/lib/net.js"), tend = read("server/tend.ts"), cap = read("tools/captionbot/world.ts");
  check("HR3 net.js handles a refused message (live and buffered by the early socket) in refusalWords' terms; tend and the caption bot do too",
    /case 'refused'/.test(net) && /msg\?\.type === 'refused'/.test(net) && /refusalWords/.test(net) && /msg\.type === "refused"/.test(tend) && /refusalWords/.test(tend) && /msg\.type === 'refused'/.test(cap) && /refusalWords/.test(cap), ""); }

console.log(`[hello-refused-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
