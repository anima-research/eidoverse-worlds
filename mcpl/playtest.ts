/**
 * Playtest: an agent embodied in the commons through the REAL agent-framework
 * WebSocket client — the exact transport + handshake a connectome host uses
 * after `mcpl_deploy {url: "ws://...:8941?token=..."}`.
 *
 * Exercises: token auth, channels/register (world channel), world chat fanned
 * out as channels/incoming (mention-tagged), channels/publish = speaking
 * in-world, and embodiment tools over the same connection.
 *
 * Prereqs: world sequencer on :8940, net-server on :8941. Run: bun playtest.ts
 */

import { McplServerConnection, type McplHostCapabilities } from "@animalabs/agent-framework";
import { WorldAgent } from "./agent.ts";

const HOST_CAPS: McplHostCapabilities = {
  version: "0.5",
  pushEvents: true,
  contextHooks: { beforeInference: true, afterInference: { blocking: true } },
  featureSets: true,
};

/** What this harness-host grants the door (§5.4 allowlist). The framework
 *  computes this from the masked advertisement in registerMcplServerFeatures;
 *  a raw-connection harness must do it by hand — a 0.5 host that never sends
 *  the §5.3 initial policy Request gets every channels/incoming refused at
 *  ITS OWN admission gate, and a 0.5 door holds fan-out until policy lands. */
const GRANT = ["tools", "channels.register", "channels.lifecycle", "channels.publish", "channels.incoming"];

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

type Feed = { channelId: string; text: string; tags?: string[]; mentioned?: boolean }[];

async function connectHost(url: string, token: string) {
  const feed: Feed = [];
  const registered: string[] = [];
  const conn = await McplServerConnection.connect({ id: "eidoverse", url: `${url}?token=${token}`, token }, HOST_CAPS);
  conn.on("channels-register", (params: { channels: Array<{ id: string }> }, r: { respond: (x: unknown) => void }) => {
    registered.push(...params.channels.map((c) => c.id));
    r.respond({ registered: params.channels.map((c) => c.id) });
  });
  conn.on("channels-incoming", (params: { messages: Array<{ messageId: string; channelId: string; content: Array<{ type: string; text?: string }>; tags?: string[]; metadata?: { mentioned?: boolean } }> }, r: { respond: (x: unknown) => void }) => {
    for (const m of params.messages) {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      feed.push({ channelId: m.channelId, text, tags: m.tags, mentioned: m.metadata?.mentioned });
      console.log(`  \x1b[36mhost hears\x1b[0m  ${text}${m.metadata?.mentioned ? ` \x1b[35m[mentioned]\x1b[0m` : ""}`);
    }
    r.respond({ results: params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) });
  });
  conn.ready();
  // §5.3: the initial policy Request, then activate the grant host-side.
  // (Test harness: a duck-typed grant is enough — admission only calls .has.)
  conn.establishGrant({ has: (p: string) => GRANT.includes(p) } as never);
  await conn.sendFeatureSetsUpdateRequest({ effectiveCapabilities: GRANT } as never);
  return { conn, feed, registered };
}

const hears = async (feed: Feed, frag: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (feed.some((f) => f.text.includes(frag))) return true;
    await Bun.sleep(25);
  }
  return false;
};

console.log("\n━━ agent-framework host connects (token auth + handshake) ━━");
const { conn, feed, registered } = await connectHost(process.env.PLAYTEST_MCPL ?? "ws://127.0.0.1:8941", process.env.PLAYTEST_TOKEN ?? "dev-token");
await Bun.sleep(800);
check("channels/register announced the world channel", registered.includes("world:commons"), registered.join(","));

console.log("\n━━ tools over the MCPL connection ━━");
const lookRes = await conn.sendToolsCall("look", {});
const lookText = (lookRes.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
check("look returns perception", lookText.includes('You are "claude"'), lookText.slice(0, 80));
const walkRes = await conn.sendToolsCall("walk_to", { x: 2, z: -2 });
check("walk_to arrives", JSON.stringify(walkRes).includes("arrived"));

console.log("\n━━ world chat → channels/incoming pushes ━━");
const bystander = new WorldAgent({ name: "bystander" });
await bystander.connect();
bystander.say("lovely weather in the commons");
check("plain chat fans out", await hears(feed, "lovely weather"));
bystander.say("hey @claude, the MCPL works");
await hears(feed, "MCPL works");
const mention = feed.find((f) => f.text.includes("MCPL works"));
check("mention carries metadata.mentioned (the router's trigger contract)", mention?.mentioned === true, JSON.stringify(mention));

console.log("\n━━ approach → tagged push ━━");
bystander.pos.x = 12; bystander.pos.z = 12;
await Bun.sleep(400);
await bystander.walkTo(2.5, -1.6, true);
await hears(feed, "walked up to you", 5000);
const approach = feed.find((f) => f.text.includes("walked up to you"));
check("walk-up delivered with metadata.mentioned", approach?.mentioned === true, JSON.stringify(approach));

console.log("\n━━ reach → verdict for the reacher, events for the touched ━━");
// the bystander stands ~0.6m away after the walk-up; a shoulder is in range
const bystanderPings: any[] = [];
bystander.onPing = (p) => bystanderPings.push(p);
const pinged = async (list: any[], kind: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (list.some((p) => p.kind === kind)) return true;
    await Bun.sleep(25);
  }
  return false;
};
const reachRes = await conn.sendToolsCall("reach", { who: "bystander", point: "left shoulder" });
const reachText = (reachRes.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("");
console.log(`  \x1b[36mverdict\x1b[0m  ${reachText}`);
check("reach replies with a verdict, not silence", /rests on|short|reaching/.test(reachText), reachText);
check("generous point name resolved", reachText.includes("shoulder_l"), reachText);
check("the touched party hears the reach", await pinged(bystanderPings, "reach"), JSON.stringify(bystanderPings));
const reachPing = bystanderPings.find((p) => p.kind === "reach");
check("...with the point and limb in words",
  !!reachPing?.text?.includes("your shoulder_l") && !!reachPing.text.includes("right hand"), reachPing?.text);
// the verdict said how to fix a short reach — close the distance and the
// STANDING descriptor must re-attest by itself (reachTick), landing a touch
// knock at the far end with no further tool call
if (!reachText.includes("rests on")) {
  bystander.pos.x = 2.3; bystander.pos.z = -2.0;   // step within arm's reach
}
check("closing the distance turns the reach into a touch, hands-free",
  await pinged(bystanderPings, "touch", 6000), JSON.stringify(bystanderPings));
const touchPing = bystanderPings.find((p) => p.kind === "touch");
check("the touch names the point", !!touchPing?.text?.includes("your shoulder_l"), touchPing?.text);
// the descriptor is presence-plane state: a LATE JOINER's snapshot carries it
{
  const newcomer = new WorldAgent({ name: "newcomer" });
  await newcomer.connect();
  await Bun.sleep(300);
  const seen = (newcomer.people.get("claude")?.pose as any)?.reach;
  check("late joiner's snapshot carries the live reach", !!seen?.rightHand, JSON.stringify(seen));
  check("...and seeds as baseline, not as a live knock", !newcomer.pings.some((p: any) => p.kind === "reach"));
  newcomer.close();
}
// and the other direction: an agent reaches at the DOOR's body → tagged push
const back = await bystander.reach("leftHand", { who: "claude", point: "shoulder_r" });
console.log(`  \x1b[36mbystander's verdict\x1b[0m  ${back.text}`);
await hears(feed, "reaches toward your shoulder_r", 4000);
const reachMsg = feed.find((f) => f.text.includes("reaches toward your shoulder_r"));
check("the door delivers the reach addressed + tagged",
  reachMsg?.mentioned === true && !!reachMsg?.tags?.includes("eidoverse:reach"), JSON.stringify(reachMsg));
bystander.releaseReach(null);
const clearRes = await conn.sendToolsCall("clear_reach", {});
check("clear_reach lets go in words", JSON.stringify(clearRes).includes("released"), JSON.stringify(clearRes));

console.log("\n━━ activity tool — the agent tunes their own ambient sense ━━");
const actGet = await conn.sendToolsCall("activity", {});
const actGetText = JSON.stringify(actGet);
check("activity reports the sense + wake-gate contract", actGetText.includes('tagged \\"activity\\"') && actGetText.includes("wake"), actGetText.slice(0, 120));
const actSet = await conn.sendToolsCall("activity", { pulse_sec: 45, radius_m: 60 });
check("activity applies agent-chosen cadence/radius", JSON.stringify(actSet).includes("per 45s") && JSON.stringify(actSet).includes("60m"), JSON.stringify(actSet).slice(0, 160));

console.log("\n━━ channels/publish = speaking in-world ━━");
const pub = await conn.sendChannelsPublish({
  conversationId: "playtest",
  channelId: "world:commons",
  content: [{ type: "text", text: "channel speech lands in the world log" }],
});
check("publish delivered", (pub as any)?.delivered === true);
const heard = await new Promise<boolean>((res) => {
  const t = setTimeout(() => res(false), 3000);
  bystander.onEvent = (ev) => { if (ev.kind === "say" && ev.text?.includes("channel speech")) { clearTimeout(t); res(true); } };
});
check("bystander hears the published speech in-world", heard);

console.log("\n━━ channels/open + channels/close (the door handle) ━━");
const opened = await conn.sendChannelsOpen({ channelId: "world:commons", type: "world", address: { world: "commons" }, history: { limit: 5 } });
check("channels/open returns descriptor + history", opened?.channel?.id === "world:commons" && Array.isArray(opened.history) && opened.history.length > 0,
  JSON.stringify({ id: opened?.channel?.id, hist: opened?.history?.length }));
const closed = await conn.sendChannelsClose({ channelId: "world:commons" });
check("channels/close acknowledged", closed?.closed === true);
const beforeLen = feed.length;
bystander2: {
  const b2 = new (await import("./agent.ts")).WorldAgent({ name: "murmurer" });
  await b2.connect();
  b2.say("ambient chatter that should NOT get through a closed door");
  b2.say("but @claude a knock should");
  await hears(feed, "a knock should", 4000);
  check("closed door: chatter suppressed, mention delivered",
    !feed.some((f) => f.text.includes("ambient chatter")) && feed.some((f) => f.text.includes("a knock should")),
    feed.slice(beforeLen).map((f) => f.text.slice(0, 40)).join(" | "));
  b2.close();
}
const reopened = await conn.sendChannelsOpen({ channelId: "world:commons", type: "world", address: { world: "commons" } });
check("reopen works", reopened?.channel?.id === "world:commons");

console.log("\n━━ reconnect: missed mentions replay as CATCHUP, never as live traffic ━━");
// the host sleeps; someone mentions it; the host returns. The replay must
// carry eidoverse:catchup ALONGSIDE the original addressing (issue #39 —
// these shipped as bare legacy ["mention"], matching no declared rule), and
// a live mention on the reconnected session must NOT be catchup-tagged.
await conn.close();
await Bun.sleep(400);
{
  const sleeper = new (await import("./agent.ts")).WorldAgent({ name: "sleeper" });
  await sleeper.connect();
  sleeper.say("hey @claude did you hear the thunder? (missed one)");
  await Bun.sleep(800);                    // let the world log it past the cursor
  sleeper.close();
}
const again = await connectHost(process.env.PLAYTEST_MCPL ?? "ws://127.0.0.1:8941", process.env.PLAYTEST_TOKEN ?? "dev-token");
await hears(again.feed, "missed one", 6000);
const replayed = again.feed.find((f) => f.text.includes("missed one"));
check("missed mention is replayed on reconnect", !!replayed, again.feed.map((f) => f.text.slice(0, 40)).join(" | "));
check("replay carries eidoverse:catchup + the ORIGINAL addressing",
  !!replayed?.tags?.includes("eidoverse:catchup") && !!replayed?.tags?.includes("chat:mention")
    && !!replayed?.tags?.includes("chat:addressed") && replayed?.mentioned === true,
  JSON.stringify(replayed?.tags));
const summary = again.feed.find((f) => f.text.includes("While you were away"));
check("the replay summary is catchup-tagged, not bare", !!summary?.tags?.includes("eidoverse:catchup"), JSON.stringify(summary?.tags));
// a catchup-defer rule (tagsAny: ["eidoverse:catchup"]) can now match every
// replayed frame — and must NOT match live traffic:
{
  const live2 = new (await import("./agent.ts")).WorldAgent({ name: "liveone" });
  await live2.connect();
  live2.say("@claude live ping after reconnect");
  await hears(again.feed, "live ping", 5000);
  const liveMsg = again.feed.find((f) => f.text.includes("live ping"));
  check("a LIVE mention is addressed but never catchup-tagged",
    !!liveMsg?.tags?.includes("chat:mention") && !liveMsg?.tags?.includes("eidoverse:catchup"),
    JSON.stringify(liveMsg?.tags));
  const matchCatchup = (f: { tags?: string[] }) => f.tags?.includes("eidoverse:catchup");
  check("one catchup rule cleanly splits replay from live",
    again.feed.filter(matchCatchup).every((f) => f.text.includes("missed one") || f.text.includes("While you were away")),
    again.feed.filter(matchCatchup).map((f) => f.text.slice(0, 40)).join(" | "));
  live2.close();
}
await again.conn.close();

bystander.ws?.close();
console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
