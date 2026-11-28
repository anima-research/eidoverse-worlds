// agentTokens() hot-reload fails closed: a tokens.json gone malformed or unreadable authorizes nobody (bot #333 5),
// while the agent names it reserved stay reserved.
//
//   bun test/server/agent-tokens-reload-test.ts
import { mkdtempSync, writeFileSync, utimesSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { suite } from "../gate/suite.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-tokens-"));
const live = join(dir, "tokens.json"), example = join(dir, "tokens.example.json");
writeFileSync(example, JSON.stringify({ "public-token": { id: "player" } }));
writeFileSync(live, JSON.stringify({ "secret-key": { id: "alice", subs: ["agent:aid1:alice"] } }));
process.env.AGENT_TOKENS_PATH = live; process.env.MCPL_TOKENS_EXAMPLE = example;
process.env.SESSIONS_PATH = join(dir, "sessions.json");
const { agentTokens } = await import("../../server/auth.ts");
const { check, done } = suite("agent-tokens-reload");

const a = agentTokens();
check("setup: the valid key authorizes alice", a.byToken.get("secret-key") === "alice" && a.bySub.get("agent:aid1:alice") === "alice");

// the file goes bad, with a new mtime so the cache re-reads it
writeFileSync(live, "{ not json");
const later = new Date(Date.now() + 5_000); utimesSync(live, later, later);
const b = agentTokens();
check("a malformed reload: the old key authorizes nobody", !b.byToken.has("secret-key"), JSON.stringify([...b.byToken]));
check("...nor the old aid1 sub", !b.bySub.has("agent:aid1:alice"), JSON.stringify([...b.bySub]));
check("...and alice's name stays reserved against plain joins", b.names.has("alice"), JSON.stringify([...b.names]));

// a registry that parses but isn't an object (a JSON array) is as malformed: the name stays reserved
writeFileSync(live, "[]");
const arr = new Date(Date.now() + 7_500); utimesSync(live, arr, arr);
const c = agentTokens();
check("an array reload: authorizes nobody and alice's name stays reserved", !c.byToken.has("secret-key") && c.names.has("alice"), JSON.stringify([...c.names]));

// repaired: authorizes again
writeFileSync(live, JSON.stringify({ "secret-key": { id: "alice" } }));
const fixed = new Date(Date.now() + 10_000); utimesSync(live, fixed, fixed);
check("repaired: the key authorizes again", agentTokens().byToken.get("secret-key") === "alice");

// a change that keeps the mtime still reloads: a rewrite with its time put back, and a chmod the server can't read past
const kept = statSync(live).mtime;
writeFileSync(live, JSON.stringify({ "other-key": { id: "alice" } })); utimesSync(live, kept, kept);
check("a rewrite that keeps the mtime: the removed key authorizes nobody", !agentTokens().byToken.has("secret-key"), JSON.stringify([...agentTokens().byToken]));
if (process.platform !== "win32" && process.getuid?.() !== 0) {
  chmodSync(live, 0);
  check("tokens.json made unreadable: no key authorizes", agentTokens().byToken.size === 0, JSON.stringify([...agentTokens().byToken]));
  chmodSync(live, 0o600);
}
done();
