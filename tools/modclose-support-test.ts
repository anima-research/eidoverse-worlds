/**
 * Moderation-close support-holder test — #83: a 4006 (kick/ban) must release
 * every support holder the closed instance owns, exactly like a deliberate
 * close(). Before the fix, the 4006 branch set `closed` and returned, and the
 * leaked box held bodies up in LATER worlds at the same coordinates (#17's
 * ghost floor, reached through moderation).
 *
 * The whole run rides the REAL moderation path over a real socket — an owner
 * bans and kicks; nothing calls a release helper directly (the issue's
 * acceptance). The registry is observed through physics.supportHolders(),
 * shared module state in this process, the same state that leaked.
 *
 * Run:
 *   EIDOVERSE_DIR=/path/to/eidoverse-video bun run tools/modclose-support-test.ts
 * (spawns its own scratch sequencer; EIDOVERSE_DIR must point at a real
 *  library checkout — support boxes come from /geom reading actual GLBs)
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "./harness.ts";
import { WorldAgent } from "../mcpl/agent.ts";
import { supportHolders } from "../mcpl/physics.ts";

const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(9460);   // a free port, never a fixed default
const URL_ = `ws://127.0.0.1:${PORT}/ws`;
const WORLD = "modtest";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds or `ms` elapses — moderation lands over a socket
 *  and removeSupport is detached, so every assertion is an eventually. */
async function until(cond: () => boolean, ms = 6000, step = 100) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(step);
  return cond();
}
/** Every holder token currently registered, across all boxes. */
const allHolders = () => new Set(Object.values(supportHolders()).flat());

// ---- scratch sequencer ------------------------------------------------------
// house default: the sibling checkout, like every other tools/*.ts
process.env.EIDOVERSE_DIR ??= join(import.meta.dir, "..", "..", "eidoverse-video");
// process.execPath, never "bun" — the Windows npm-shim footgun (docs/INCIDENTS.md)
// the world is founded by its warden (TRUST_NAMES: the typed name "warden" is that account, so the warden is the owner)
const worldsDir = mkdtempSync(join(tmpdir(), "ew-modtest-"));
foundWorlds(worldsDir, [WORLD], "warden");
const server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" },
  stdio: "ignore",
});
const stop = () => { try { server.kill(); } catch {} };
process.on("exit", stop);
await sleep(1500);

// ---- the warden: the world's owner; moderation and building are door requests --------
const warden = new WebSocket(URL_);
const seen: any[] = []; const results = new Map<string, any>(); let rq = 0;
warden.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m); if (m.type === "v4-result") results.set(m.id, m); };
const wardenReq = async (tool: string, args: any) => { const id = `w${++rq}`; warden.send(JSON.stringify({ type: "v4", id, tool, args }));
  for (let i = 0; i < 60 && !results.has(id); i++) await sleep(50); return results.get(id); };
/** a person's directory identity, as their arrival announced it (moderation names identities, never typed names) */
const idOf = (name: string) => seen.find((m) => m.type === "arrive" && m.id === name)?.v4id;
await new Promise<void>((res, rej) => {
  warden.onopen = () => { warden.send(JSON.stringify({ type: "join", world: WORLD, id: "warden", avatar: "eidoverse/assets/vrms/claude.vrm", v4fold: true })); res(); };
  warden.onerror = () => rej(new Error("warden failed to connect — is the scratch server up?"));
});
await sleep(400);

// ---- two residents, one platform -------------------------------------------
await sleep(200);
const victim = new WorldAgent({ url: URL_, name: "victim", world: WORLD });
const bystander = new WorldAgent({ url: URL_, name: "bystander", world: WORLD });
await victim.connect();
await bystander.connect();
const built = await wardenReq("create", { id: "deck1", model: CRATE, components: { transform: { pos: [0, 0, 0] } } });
check("the warden (owner) builds the platform through the door", built?.ok === true, JSON.stringify(built?.reply));
await (victim as any).supportReady(6000);
await (bystander as any).supportReady(6000);

const vTok = (victim as any).supportHolder as string;
const bTok = (bystander as any).supportHolder as string;
const okSetup = await until(() => allHolders().has(vTok) && allHolders().has(bTok));
check("both residents hold support on the shared platform", okSetup, JSON.stringify(supportHolders()));

console.log("\n━━ ban: code 4006 releases the banned instance's holders ━━");
const banned = await wardenReq("ban", { who: idOf("victim"), reason: "#83 regression" });
check("the door takes the ban (by identity)", banned?.ok === true, JSON.stringify([idOf("victim"), banned?.reply]));
check("the ban lands as a terminal close", await until(() => victim.closed), `closed=${victim.closed}`);
check("the banned instance's holders are RELEASED", await until(() => !allHolders().has(vTok)), JSON.stringify(supportHolders()));
check("the co-resident's holders survive the neighbor's ban", allHolders().has(bTok), JSON.stringify(supportHolders()));
check("the box itself survives while anyone still holds it", Object.keys(supportHolders()).length > 0, JSON.stringify(supportHolders()));

console.log("\n━━ kick: the final holder leaves, the box disappears ━━");
const kicked = await wardenReq("kick", { who: idOf("bystander"), reason: "#83 regression" });
check("the door takes the kick (by identity)", kicked?.ok === true, JSON.stringify(kicked?.reply));
check("the kick lands as a terminal close", await until(() => bystander.closed), `closed=${bystander.closed}`);
check("no leaked box remains — a later occupant sees terrain", await until(() => Object.keys(supportHolders()).length === 0), JSON.stringify(supportHolders()));

console.log("\n━━ successor: same name, own holders, unharmed by its predecessor ━━");
// a kick permits return (a ban would not) — the successor is a NEW instance
// wearing the old name, which is exactly the collision #53's per-instance
// tokens exist to survive
const successor = new WorldAgent({ url: URL_, name: "bystander", world: WORLD });
await successor.connect();
await (successor as any).supportReady(6000);
const sTok = (successor as any).supportHolder as string;
check("the successor registers under its OWN token", await until(() => allHolders().has(sTok)), JSON.stringify(supportHolders()));
check("no stale predecessor token rides along", !allHolders().has(bTok) && !allHolders().has(vTok), JSON.stringify(supportHolders()));
successor.close();
check("normal close still releases (unchanged semantics)", await until(() => Object.keys(supportHolders()).length === 0), JSON.stringify(supportHolders()));

try { warden.close(); } catch {}
stop();
console.log("");
process.exit(failures ? 1 : 0);
