// worlds-route-test — GET /worlds, actually fetched: the discovery map the
// `worlds` tool reads before an agent decides where to `travel`.
//
//   bun test/server/worlds-route-test.ts
//
// One real sequencer (harness.scratchSequencer: a scratch WORLDS_DIR, the child proven ours by its nonce):
//   A. on-disk worlds with a log are listed, junk dirs and log-less dirs are not
//   B. a joined body shows under its world; a spectator shows as nothing
//   C. a join to a world nobody founded is refused and founds nothing
// The GET-route contract (JSON, no-store, asking never founds) is version-route-test's loop over every route.
import { join } from "node:path";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { mkCheck, scratchSequencer } from "../harness/harness.ts";
import { tryUntil, pause } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const { check, tally } = mkCheck();
const seq = await scratchSequencer("worlds-route", { serverEnv: { SKIP_OPT_SWEEP: "1" }, worlds: ["commons", "annex"],   // two worlds (a world.jsonl whose line 0 is a genesis)
  prepare: (scratch) => {
    const worldsDir = join(scratch, "worlds");
    // one dir with no log (never a world)
    mkdirSync(join(worldsDir, "logless"), { recursive: true });
    // an OLD world: a v1 log and no new one. The server serves only the protocol, so it isn't listed (it's translated by the
    // operator: a dry run, then `translate <name> --no-founder-key --approved <hash>` (+ --operator-only-no-owner when no owner can sign) — docs/operator/TRANSLATING-OLD-WORLDS.md)
    mkdirSync(join(worldsDir, "oldv1"), { recursive: true });
    writeFileSync(join(worldsDir, "oldv1", "log.jsonl"), JSON.stringify({ seq: 0, ts: 0, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log" } }) + "\n");
    mkdirSync(join(worldsDir, ".clientlogs"), { recursive: true });
  } });
const port = seq.PORT, worldsDir = join(seq.SCRATCH, "worlds");

type Row = { name: string; loaded: boolean; people: { id: string; declares?: string }[]; agents?: unknown };
const fetchWorlds = async (port: number) => {
  const r = await fetch(`http://127.0.0.1:${port}/worlds`);
  return { res: r, rows: ((await r.json()) as { worlds: Row[] }).worlds };
};
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

/** Join a world over the raw ws and wait for the snapshot. */
function joinBody(port: number, world: string, id: string, extra: Record<string, unknown> = {}): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => rej(new Error(`join ${id}@${world} timed out`)), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, avatar: "", replica: true, ...extra }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") { clearTimeout(t); res(ws); }
      if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); }
    };
  });
}

console.log("\n— A. on-disk worlds —");
{
  const { rows } = await fetchWorlds(port);
  const names = rows.map((r) => r.name);
  check("both logged worlds listed", names.includes("commons") && names.includes("annex"), names.join(","));
  check("a dir with no log is not a world", !names.includes("logless"), names.join(","));
  check("a dir with only an old v1 log is not a world here", !names.includes("oldv1"), names.join(","));
  check("dot-dirs are not worlds", !names.some((n) => n.startsWith(".")), names.join(","));
  check("sorted by name", JSON.stringify(names) === JSON.stringify([...names].sort()), names.join(","));
  check("unloaded on-disk world says so, empty", rows.every((r) => r.loaded === false && r.people.length === 0 && Array.isArray(r.agents) && r.agents.length === 0), JSON.stringify(rows));
}

console.log("\n— B. presence —");
{
  const alice = await joinBody(port, "annex", "alice");
  const bot = await joinBody(port, "annex", "bot", { declares: "agent" });
  const ghost = await joinBody(port, "commons", "ghost", { spectate: true });
  await tryUntil("the three joins show in /worlds", async () => byName((await fetchWorlds(port)).rows).annex?.people.length === 2, { ms: 5000 });
  const m = byName((await fetchWorlds(port)).rows);
  check("annex now loaded", m.annex?.loaded === true, JSON.stringify(m.annex));
  check("a participant who declared nothing lists under people, untagged", m.annex?.people.some((p) => p.id === "alice" && !("declares" in p)), JSON.stringify(m.annex));
  check("a participant who declared agent lists in the SAME people list, tagged with the word (R 10-17: one list), and in main's agents (decision table row 21)", m.annex?.people.some((p) => p.id === "bot" && p.declares === "agent") && JSON.stringify(m.annex?.agents) === '["bot"]' && m.annex?.people.length === 2, JSON.stringify(m.annex));
  check("a spectator appears as nothing", m.commons?.people.length === 0, JSON.stringify(m.commons));
  alice.close(); bot.close(); ghost.close();
  await tryUntil("the leaves empty the row", async () => byName((await fetchWorlds(port)).rows).annex?.people.length === 0, { ms: 5000 });
  const after = byName((await fetchWorlds(port)).rows);
  check("leaving empties the row (still loaded)", after.annex?.loaded === true && after.annex?.people.length === 0, JSON.stringify(after.annex));
}

console.log("\n— C. a join never founds —");
{
  // joining a world nobody founded is refused (security review 10-06 H3): nothing loads, nothing lands on disk
  const before = readdirSync(worldsDir).sort();
  const refused = await joinBody(port, "fresh", "founder").then(() => null, (e) => String(e.message));
  await pause("a refused join has its window to found something (it must not)", 200);
  const m = byName((await fetchWorlds(port)).rows);
  check("a join to a world that doesn't exist is refused, and says so", /No accessible world named fresh\./.test(refused ?? ""), String(refused));
  check("…and founds nothing: not listed, nothing on disk", !m.fresh && JSON.stringify(readdirSync(worldsDir).sort()) === JSON.stringify(before), Object.keys(m).join(","));
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
await seq.cleanup();
process.exit(tally.failed ? 1 : 0);
