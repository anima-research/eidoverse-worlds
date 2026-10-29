// tools/operator-repair.ts — one server operator's request into a world, from the command line (docs/TRANSLATING-OLD-WORLDS.md).
// usage: EIDO_SESSION=<ew_sess cookie> | EIDO_AGENT_TOKEN=<token>  [EIDO_KEY=<door key>]
//        bun tools/operator-repair.ts <server url> <world> <verb> ['<args as JSON>']
//   verb whois {name} looks someone up; every other verb is operator-repair (spec/PROTOCOL.md "Operator repair").
//        WORLDS_DIR=<dir> bun tools/operator-repair.ts bind <world> <identity-or-name> <account> [--by <who asked>]
//   on the host: an imported identity (a main-era name with no account yet) is worn by that account from now on (tools/operator-bind.ts)
if (process.argv[2] === "bind") { const { bindCli } = await import("./operator-bind.ts"); const { WORLDS_DIR } = await import("../server/config.ts"); process.exit(bindCli(process.argv.slice(3), WORLDS_DIR)); }
const [url, world, verb, json = "{}"] = process.argv.slice(2);
if (!url || !world || !verb) { console.error("usage: bun tools/operator-repair.ts <server url> <world> <verb> ['<args JSON>']   (EIDO_SESSION or EIDO_AGENT_TOKEN names you)"); process.exit(2); }
const sid = process.env.EIDO_SESSION ?? "", agentToken = process.env.EIDO_AGENT_TOKEN ?? "";
if (!sid && !agentToken) { console.error("set EIDO_SESSION (your browser's ew_sess cookie) or EIDO_AGENT_TOKEN: a server operator is a signed-in account"); process.exit(2); }
let args: unknown; try { args = JSON.parse(json); } catch { console.error(`the args aren't JSON: ${json}`); process.exit(2); }
const ws = new WebSocket(url.replace(/^http/, "ws").replace(/\/?$/, "/ws"), sid ? { headers: { cookie: `ew_sess=${sid}` } } as any : undefined);
let over = false;   // close() can fire onclose before exit (Windows): one answer, one exit code
const done = (code: number, line: unknown) => { if (over) return; over = true; console.log(typeof line === "string" ? line : JSON.stringify(line, null, 1)); try { ws.close(); } catch {} process.exit(code); };
setTimeout(() => done(1, "no answer in 20 s"), 20_000);
ws.onerror = () => done(1, `couldn't reach ${url}`);
ws.onclose = (e) => done(1, `the server closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ""})`);
ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: "operator", avatar: "", spectate: true, replica: true, token: process.env.EIDO_KEY ?? "", ...(agentToken ? { agentToken } : {}) }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "error") done(1, m.error);
  if (m.type === "snapshot") ws.send(JSON.stringify(verb === "whois" ? { type: "request", id: "op", verb, args } : { type: "operator-repair", id: "op", verb, args }));
  if (m.type === "reply" && m.id === "op") done(m.ok ? 0 : 1, m.reply);
};
