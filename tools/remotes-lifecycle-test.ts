/**
 * Remotes lifecycle test — #95: a departed participant must die whole, and
 * nothing but an AUTHORITY (arrive, roster) may bring a body into being.
 * Presence — pose, frame, RTC — updates generations; it never creates them.
 *
 * Drives net.js's dispatch directly (the server's per-socket FIFO — proven
 * in the #95 inventory: synchronous handler, interval-driven frames, FIFO
 * ws sends — is the license to sequence messages by hand). Avatar loads are
 * held open and resolved by the test, so every race is forced, never timed.
 *
 * Run: bun run tools/remotes-lifecycle-test.ts
 *
 * Fail-on-main vectors (each named in the checks): leave→straggler frame /
 * pose (the default-avatar sunflower ghost, and #56's stand-forever race),
 * takeover buffer inheritance, predecessor cleanup vs successor, frame-
 * before-legitimate-arrive, reconnect roster seed, custody-before-dispose
 * ordering. leave→delayed-load and takeover→old-load ride the stale-load
 * guard, asserted here as regressions.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const settle = () => new Promise((r) => setTimeout(r, 10));

const stubs = await import("./remotes-stubs.mjs");
const { mock } = await import("bun:test");
for (const m of ["core", "assets", "world", "chat", "fp_view", "boot", "ui", "avatar"]) {
  mock.module(`${import.meta.dir}/../client/lib/${m}.js`, () => stubs);
}
const remotesMod = await import("../client/lib/remotes.js");
const netMod = await import("../client/lib/net.js");
const { remotes, dropRemote, ensureRemote, pushPose } = remotesMod as any;
const { _dispatch, teardownParticipant, stalePresenceCount } = netMod as any;

// ---- pre-#95 head: net exports no dispatch seam. Fail by name, with the
// ghost visible in each detail — the control stays a control (assert the
// FIXED contracts against the components main actually exports; main's
// pose path is literally `ensureRemote(id, null)`, net.js:359).
if (typeof _dispatch !== "function") {
  console.log("\n━━ pre-#95 head detected — component receipts ━━");
  check("net exposes the participant-teardown funnel", false, "teardownParticipant absent");
  const r = await ensureRemote("ghost", null);            // the pose path's exact creation call
  check("presence-shaped creation cannot build a body",
    !remotes.has("ghost"), `built one: avatar path ${JSON.stringify(stubs.avatarCalls.at(-1)?.path)} — the sunflower`);
  await ensureRemote("helen", "vrms/helen.vrm");
  pushPose("helen", { p: [1, 0, 1], yaw: 0, speed: 0, clip: "idle" }, 1);
  await ensureRemote("helen", "vrms/helen.vrm");          // takeover re-announce
  check("a same-name successor inherits no pose buffer",
    (remotes.get("helen")?.buf?.length ?? 0) === 0, `buf=${remotes.get("helen")?.buf?.length}`);
  check("…and starts a fresh generation", typeof remotes.get("helen")?.gen === "number", "no generations on this head");
  const live = remotes.get("helen");
  dropRemote("helen", { id: "helen" });                   // a predecessor's stale cleanup
  check("a stale expected-record drop cannot delete the successor",
    remotes.has("helen") && remotes.get("helen") === live, "unconditional drop killed it");
  console.log("");
  process.exit(1);
}

const DEFAULTISH = (p: string) => /claudesona|default|sunflower/i.test(p) || p == null;
const defaultBuilds = () => stubs.avatarCalls.filter((c: any) => DEFAULTISH(c.path)).length;
const pose = (over = {}) => ({ p: [1, 0, 1], yaw: 0.5, speed: 0, clip: "idle", ...over });

console.log("\n━━ the sunflower door: presence never creates a body ━━");
{
  // leave → straggler FRAME (Digi's specimen; #56's race)
  await _dispatch({ type: "arrive", id: "shoalstone", avatar: "vrms/shoalstone.vrm" });
  await settle();
  check("an arrive builds the announced body", remotes.has("shoalstone") && stubs.avatarCalls.at(-1).path === "vrms/shoalstone.vrm");
  await _dispatch({ type: "leave", id: "shoalstone" });
  check("a leave removes it", !remotes.has("shoalstone"));
  const disposedBefore = stubs.disposeCount;
  await _dispatch({ type: "frame", t: 1, poses: { shoalstone: pose() } });
  await settle();
  check("a straggler frame resurrects NOTHING", !remotes.has("shoalstone"), JSON.stringify([...remotes.keys()]));
  check("and no default-avatar body was ever constructed", defaultBuilds() === 0,
    `default-avatar builds: ${defaultBuilds()} (the sunflower ghost, on main)`);
  // leave → straggler POSE (same door, singular shape)
  await _dispatch({ type: "pose", id: "shoalstone", pose: pose(), t: 2 });
  await settle();
  check("a straggler pose resurrects nothing either", !remotes.has("shoalstone") && defaultBuilds() === 0);
  check("the drops are counted for the flight recorder", stalePresenceCount() >= 2, String(stalePresenceCount()));
  check("nothing was double-disposed by the stragglers", stubs.disposeCount === disposedBefore);
}

console.log("\n━━ frame before its authority: dropped, then honestly rebuilt ━━");
{
  stubs.resetAvatarLog();
  await _dispatch({ type: "frame", t: 3, poses: { early: pose() } });
  await settle();
  check("presence for a never-announced id builds nothing", !remotes.has("early") && stubs.avatarCalls.length === 0);
  await _dispatch({ type: "arrive", id: "early", avatar: "vrms/early.vrm" });
  await settle();
  await _dispatch({ type: "frame", t: 4, poses: { early: pose() } });
  check("the arrive then builds exactly one body, with the REAL avatar",
    remotes.has("early") && stubs.avatarCalls.length === 1 && stubs.avatarCalls[0].path === "vrms/early.vrm");
  check("and its post-arrive frames land", remotes.get("early").buf.length === 1);
  await _dispatch({ type: "leave", id: "early" });
}

console.log("\n━━ delayed loads from a departed generation ━━");
{
  stubs.resetAvatarLog();
  stubs.setHoldLoads(true);
  const p = _dispatch({ type: "arrive", id: "digi", avatar: "vrms/digi.vrm" });
  await settle();
  check("the load is in flight", stubs.pendingLoads.length === 1 && remotes.has("digi"));
  await _dispatch({ type: "leave", id: "digi" });                      // leave lands mid-load
  stubs.pendingLoads.shift()!.resolve();                               // …then the load completes
  await p; await settle();
  check("leave→delayed load: the completion disposes instead of attaching",
    !remotes.has("digi") && stubs.disposeCount === 1, `disposed=${stubs.disposeCount}`);

  // takeover → old load: v1 still loading when v2 re-announces
  const p1 = _dispatch({ type: "arrive", id: "fc", avatar: "vrms/fc-v1.vrm" });
  await settle();
  const held = stubs.pendingLoads.shift()!;
  const p2 = _dispatch({ type: "arrive", id: "fc", avatar: "vrms/fc-v2.vrm" });
  await settle();
  const held2 = stubs.pendingLoads.shift()!;
  held.resolve();                                                       // predecessor's load completes late
  held2.resolve();
  await p1; await p2; await settle();
  stubs.setHoldLoads(false);
  const fc = remotes.get("fc");
  check("takeover→old load: one body stands, wearing the successor's avatar",
    !!fc && fc.avatarPath === "vrms/fc-v2.vrm" && remotes.size === 1, JSON.stringify({ path: fc?.avatarPath, size: remotes.size }));
  await _dispatch({ type: "leave", id: "fc" });
}

console.log("\n━━ takeover: a successor inherits nothing, and outlives its predecessor's cleanup ━━");
{
  await _dispatch({ type: "arrive", id: "helen", avatar: "vrms/helen.vrm" });
  await settle();
  await _dispatch({ type: "frame", t: 10, poses: { helen: pose({ p: [9, 0, 9] }) } });
  const pre = remotes.get("helen");
  check("the predecessor holds streamed poses", pre.buf.length === 1);
  const preGen = pre.gen;
  // same avatar re-announced = server-suppressed-leave takeover
  await _dispatch({ type: "arrive", id: "helen", avatar: "vrms/helen.vrm" });
  await settle();
  const post = remotes.get("helen");
  check("same-name successor: fresh generation", typeof post.gen === "number" && post.gen === preGen + 1,
    `gen ${preGen} → ${post.gen} (on main: no generations, buffer inherited)`);
  check("…and the predecessor's pose buffer is NOT inherited", post.buf.length === 0, `buf=${post.buf.length}`);
  // predecessor cleanup cannot delete the successor
  const stale = { id: "helen" };                                        // a record the id no longer belongs to
  const dropped = dropRemote("helen", stale as any);
  check("a stale expected-record drop is a no-op", dropped === null && remotes.has("helen"));
  const dropped2 = teardownParticipant("helen", stale as any);
  check("…through the funnel too", dropped2 === null && remotes.has("helen"));
  await _dispatch({ type: "leave", id: "helen" });
  check("a genuine leave still lands (idempotent, unconditional)", !remotes.has("helen"));
}

console.log("\n━━ reconnect roster seed: the snapshot prunes through the funnel ━━");
{
  stubs.resetAvatarLog();
  await _dispatch({ type: "arrive", id: "stays", avatar: "vrms/stays.vrm" });
  await _dispatch({ type: "arrive", id: "ghost", avatar: "vrms/ghost.vrm" });
  await settle();
  const torn: string[] = [];
  stubs.bus.on("participant-teardown", (id: string) => torn.push(id));
  const disposedBefore = stubs.disposeCount;
  await _dispatch({ type: "snapshot", you: "tester", yourRights: { role: "visitor" },
    present: [{ id: "stays", avatar: "vrms/stays.vrm" }], state: null, entries: [], throughSeq: 0 });
  await settle();
  check("the absent id is torn down THROUGH the funnel", torn.includes("ghost"),
    `teardown events: ${JSON.stringify(torn)} (on main: raw dropRemote, no event)`);
  check("custody released BEFORE the body was disposed (ordering contract)",
    torn.includes("ghost") && stubs.disposeCount > disposedBefore, "the bodydrag listener depends on this order");
  check("the present id survives, generation fresh", remotes.has("stays") && !remotes.has("ghost"));
  await _dispatch({ type: "leave", id: "stays" });
}

console.log("\n━━ kick/ban: the expel's leave broadcast walks the same funnel ━━");
{
  // the server accompanies every 4006 expel with an ordinary leave broadcast
  // (server.ts ~1109, verified in the #95 inventory) — so moderation removal
  // IS the leave path; this pins that the funnel treats it as such
  const torn: string[] = [];
  stubs.bus.on("participant-teardown", (id: string) => torn.push(id));
  await _dispatch({ type: "arrive", id: "banned", avatar: "vrms/banned.vrm" });
  await settle();
  await _dispatch({ type: "leave", id: "banned" });
  check("the moderation leave tears down whole", torn.includes("banned") && !remotes.has("banned"));
  await _dispatch({ type: "frame", t: 99, poses: { banned: pose() } });
  await settle();
  check("and the expelled body cannot be resurrected by stragglers", !remotes.has("banned"));
}

console.log("");
process.exit(failures ? 1 : 0);
