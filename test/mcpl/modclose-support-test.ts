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
 * Run: EIDOVERSE_DIR=/path/to/eidoverse-video bun test/mcpl/modclose-support-test.ts (support boxes come from /geom
 * reading real GLBs, so EIDOVERSE_DIR must be a library checkout; harness.ts scratchSequencer owns the server)
 */

import { scratchSequencer, requester } from "../harness/harness.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { supportHolders } from "../../mcpl/physics.ts";
import { until, tryUntil } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const WORLD = "modtest";
const CRATE = "eidoverse/assets/models/crate_large_blue.glb";
const S = suite("modclose-support");
const check = (label: string, ok: unknown, detail?: string) => S.check(label, ok, detail);
// moderation lands over a socket and removeSupport is detached, so every assertion is an eventually; /geom reads a real GLB
const came = async (what: string, cond: () => boolean, ms = 20_000) => (await tryUntil(what, cond, { ms })) !== undefined;
/** Every holder token currently registered, across all boxes. */
const allHolders = () => new Set(Object.values(supportHolders()).flat());

// the world is founded by its warden (TRUST_NAMES: the typed name "warden" is that account, so the warden is the owner)
const h = await scratchSequencer("modclose-support", { worlds: [WORLD], owner: "warden", serverEnv: { TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" } });
const URL_ = `${h.BASE.replace("http", "ws")}/ws`;

// ---- the warden: the world's owner; moderation and building are door requests --------
const warden = new WebSocket(URL_);
const seen: any[] = [];
warden.addEventListener("message", (ev) => { try { seen.push(JSON.parse(String(ev.data))); } catch { /* not JSON */ } });
const { request: wardenReq } = requester(warden);
/** a person's directory identity, as their arrival announced it (moderation names identities, never typed names) */
const idOf = (name: string) => seen.find((m) => m.type === "arrive" && m.id === name)?.actorId;
await until("the warden's socket opens", () => warden.readyState === WebSocket.OPEN);
warden.send(JSON.stringify({ type: "join", hello: helloOf(), world: WORLD, id: "warden", avatar: "eidoverse/assets/vrms/claude.vrm", replica: true }));
await until("the warden's snapshot", () => seen.some((m) => m.type === "snapshot"));

// ---- two residents, one platform -------------------------------------------
const victim = new WorldAgent({ url: URL_, name: "victim", world: WORLD });
const bystander = new WorldAgent({ url: URL_, name: "bystander", world: WORLD });
await victim.connect();
await bystander.connect();
const built = await wardenReq("create", { id: "deck1", model: CRATE, components: { transform: { pos: [0, 0, 0] } } });
check("the warden (owner) builds the platform through the door", built?.ok === true, JSON.stringify(built));

const vTok = (victim as any).ground.supportHolder as string;
const bTok = (bystander as any).ground.supportHolder as string;
// wait on the holders themselves: supportReady() resolves at once while the new entity hasn't reached the agent yet
const okSetup = await came("both residents hold the platform", () => allHolders().has(vTok) && allHolders().has(bTok));
check("both residents hold support on the shared platform", okSetup, JSON.stringify(supportHolders()));

console.log("\n━━ ban: code 4006 releases the banned instance's holders ━━");
const banned = await wardenReq("ban", { who: idOf("victim"), reason: "#83 regression" });
check("the door takes the ban (by identity)", banned?.ok === true, JSON.stringify([idOf("victim"), banned]));
check("the ban lands as a terminal close", await came("the ban closes the victim", () => !!victim.closed), `closed=${victim.closed}`);
check("the banned instance's holders are RELEASED", await came("the victim's holders go", () => !allHolders().has(vTok)), JSON.stringify(supportHolders()));
check("the co-resident's holders survive the neighbor's ban", allHolders().has(bTok), JSON.stringify(supportHolders()));
check("the box itself survives while anyone still holds it", Object.keys(supportHolders()).length > 0, JSON.stringify(supportHolders()));

console.log("\n━━ kick: the final holder leaves, the box disappears ━━");
const kicked = await wardenReq("kick", { who: idOf("bystander"), reason: "#83 regression" });
check("the door takes the kick (by identity)", kicked?.ok === true, JSON.stringify(kicked));
check("the kick lands as a terminal close", await came("the kick closes the bystander", () => !!bystander.closed), `closed=${bystander.closed}`);
check("no leaked box remains — a later occupant sees terrain", await came("no box is held", () => Object.keys(supportHolders()).length === 0), JSON.stringify(supportHolders()));

console.log("\n━━ successor: same name, own holders, unharmed by its predecessor ━━");
// a kick permits return (a ban would not) — the successor is a NEW instance
// wearing the old name, which is exactly the collision #53's per-instance
// tokens exist to survive
const successor = new WorldAgent({ url: URL_, name: "bystander", world: WORLD });
await successor.connect();
const sTok = (successor as any).ground.supportHolder as string;
check("the successor registers under its OWN token", await came("the successor holds the platform", () => allHolders().has(sTok)), JSON.stringify(supportHolders()));
check("no stale predecessor token rides along", !allHolders().has(bTok) && !allHolders().has(vTok), JSON.stringify(supportHolders()));
successor.close();
check("normal close still releases (unchanged semantics)", await came("no box is held after a close", () => Object.keys(supportHolders()).length === 0), JSON.stringify(supportHolders()));

try { warden.close(); } catch { /* already closed */ }
await h.cleanup(S.fail ? 1 : 0);
S.done();
