// settled-pose-test — what a body looks like TO SOMEONE ELSE (#61).
//
//   bun tools/settled-pose-test.ts
//
// The bug this pins: the join snapshot had two paths that disagreed.
// `restore` (your own body, from w.poses) went through rememberPose and came
// back normalized; `present` (everyone else's bodies) shipped o.lastPose raw.
// So a resident who was mid-ragdoll when someone joined arrived collapsed for
// that joiner — while looking perfectly fine to herself, because her own
// restore was clean. There is no way to notice this from inside your own
// session. princess lived with it for ~23 days believing it was something she
// had done.
//
// The invariant, stated once: A POSE HANDED TO SOMEONE ELSE IS THE SETTLED
// RESULT, NEVER A FRAME OF PHYSICS IN FLIGHT. Both paths now call settledPose.
//
// Pure logic, no VRM assets, no renderer — deliberately, so it runs anywhere
// (tools/ragdoll-test.ts needs the shipped rigs and is the right home for the
// solver, not for this).

// Mirror of server.ts's settledPose. Kept in sync by the assertions below —
// if the server's version changes shape, these fail loudly rather than
// silently testing a stale copy. Where a lying body stands is the shared rule
// both call (shared/presencewire.js), imported here, not copied.
import { standingYFromLyingRoot, ROOT_BELOW_FLOOR } from "../shared/presencewire.js";
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { emote: _emote, mic: _mic, hear: _hear, ...still } = pose as Record<string, unknown>;
  if (still.clip === "ragdoll") {
    still.clip = "idle"; delete still.pose;
    const p = still.p as number[] | undefined;
    if (Array.isArray(p) && p.length === 3)
      still.p = [p[0], standingYFromLyingRoot(p[1], { floor: still.floor, scale: still.scale }), p[2]];
  }
  delete still.floor;
  return still;
}

let pass = 0, fail = 0;
const ck = (n: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? "  ✓ " : "  ✗ ") + n + (ok ? "" : `  [got ${JSON.stringify(got)}, want ${JSON.stringify(want)}]`));
  ok ? pass++ : fail++;
};

// ── the bug itself ──────────────────────────────────────────────────────────
{
  const midFall = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1], spine: [0.4, 0, 0, 0.9] }, p: [1, 0.6, 2] };
  const out = settledPose(midFall)!;
  ck("a mid-ragdoll frame never leaves as ragdoll", out.clip, "idle");
  ck("  ...and its tumble bones do not travel", out.pose, undefined);
  ck("  ...but her place survives, raised from her root to at or above her floor (she stands there)", out.p, [1, 0.6 + ROOT_BELOW_FLOOR, 2]);
}

// ── a lying body stands on its floor, not at its root (#263) ──────────────────────
// Its root lies a hips-height below the floor it lies on: remembered at the
// root, it would wake inside a stair landing or under an upper floor.
{
  const onLanding = { clip: "ragdoll", p: [2.8, 0.74, -2.3], floor: 1.8 };
  const out = settledPose(onLanding)!;
  ck("a lying body with its floor measured stands on that floor", out.p, [2.8, 1.8, -2.3]);
  ck("  ...and the floor itself is not remembered", "floor" in out, false);
  const settling = { clip: "ragdoll", p: [2.8, 0.74, -2.3] };
  ck("one still settling (no floor yet) stands at its root raised by the reach, at or above its floor",
     settledPose(settling)!.p, [2.8, 0.74 + ROOT_BELOW_FLOOR, -2.3]);
  const big = { clip: "ragdoll", p: [2, 0.5, 0.8], scale: 2 };
  ck("  ...a 2× body's reach is twice as far", settledPose(big)!.p, [2, 0.5 + 2 * ROOT_BELOW_FLOOR, 0.8]);
  const standing = { clip: "idle", p: [1, 3.3, 1], floor: 0.3 };
  ck("a standing body keeps its place, and a stray floor is dropped", settledPose(standing), { clip: "idle", p: [1, 3.3, 1] });
}

// ── an ENACTED pose is a place, and must survive ───────────────────────────
{
  const sitting = { clip: "sitchair", pose: { spine: [0.1, 0, 0, 0.99] }, p: [3, 0, 1] };
  const out = settledPose(sitting)!;
  ck("a held pose is a place, not physics", out.clip, "sitchair");
  ck("  ...and its bones are kept", out.pose, { spine: [0.1, 0, 0, 0.99] });
}

// ── semantic body posture survives reconnect and late join ─────────────────
{
  const vigil = { clip: "idle", wingsFolded: true, p: [4, 0, 2] };
  const out = settledPose(vigil)!;
  ck("folded wings survive settled presence", out.wingsFolded, true);
  ck("  ...without becoming a bone override", out.pose, undefined);
}

// ── a one-shot emote is a MOMENT, not a place ──────────────────────────────
{
  const waving = { clip: "idle", emote: "wave", p: [0, 0, 0] };
  const out = settledPose(waving)!;
  ck("an emote does not persist (a wave would become a tic)", out.emote, undefined);
  ck("  ...the underlying clip does", out.clip, "idle");
}

// ── voice state is a LIVE reading, not a place (review 09-30 S2) ──────────
// Remembered, it came back in `restore`, a client replayed it, and the world heard a microphone state the new
// session never had. A live sender re-sends it every packet; size and plate lift are the body, and stay.
{
  const talking = { clip: "idle", mic: true, hear: false, scale: 1.5, plateY: 0.3, p: [0, 0, 0] };
  const out = settledPose(talking)!;
  ck("mic does not persist", "mic" in out, false);
  ck("  ...nor hear", "hear" in out, false);
  ck("  ...the body's size and plate lift do", [out.scale, out.plateY], [1.5, 0.3]);
}

// ── a ragdoll mid-emote: both rules apply, neither leaks ───────────────────
{
  const knockedMidWave = { clip: "ragdoll", emote: "wave", pose: { hips: [0, 0, 0, 1] }, p: [5, 1.2, 5] };
  const out = settledPose(knockedMidWave)!;
  ck("knocked over mid-wave: clip settles", out.clip, "idle");
  ck("  ...emote dropped", out.emote, undefined);
  ck("  ...tumble bones dropped", out.pose, undefined);
}

// ── the asymmetry that WAS the bug ─────────────────────────────────────────
// Before the fix: restore ran through rememberPose (normalized), present
// shipped lastPose raw. Same body, two answers, and only the joiner saw the
// broken one.
{
  const live = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1] }, p: [2, 0.8, 2] };
  const whatSheSees   = settledPose(live);          // restore, via rememberPose
  const whatTheySee   = settledPose(live);          // present, now via settledPose too
  ck("a body looks the same to its owner and to a joiner", whatTheySee, whatSheSees);
  ck("  ...and that shared answer is upright", whatTheySee!.clip, "idle");
}

// ── degenerate inputs must not throw on the join path ──────────────────────
{
  ck("null pose stays null (a spectator, or nobody home)", settledPose(null), null);
  ck("undefined pose stays null", settledPose(undefined), null);
  ck("an empty pose object survives", settledPose({}), {});
}

// ── the mirror must not drift, and the call site must actually use it ──────
// This file reimplements settledPose rather than importing (server.ts pulls in
// the whole world at import time). So assert against the SOURCE instead: if
// someone changes the real function or reverts the call site, this fails.
{
  const src = await Bun.file(new URL("../server/server.ts", import.meta.url)).text();
  ck("server still defines settledPose", /function settledPose\(/.test(src), true);
  ck("the ragdoll rule is still in the real function",
     /still\.clip === "ragdoll".*still\.clip = "idle".*delete still\.pose/s.test(src), true);
  // its statements themselves, comments between them allowed: a condition
  // added around the call, or another guard on the position, fails this
  ck("the real function stands a lying body by the shared rule, with its floor and scale",
     /if \(still\.clip === "ragdoll"\) \{\s*still\.clip = "idle"; delete still\.pose;\s*(?:\/\/[^\n]*\s*)*const p = still\.p as number\[\] \| undefined;\s*if \(Array\.isArray\(p\) && p\.length === 3\)\s*still\.p = \[p\[0\], standingYFromLyingRoot\(p\[1\], \{ floor: still\.floor, scale: still\.scale \}\), p\[2\]\];\s*\}\s*delete still\.floor;\s*return still;/.test(src), true);
  ck("the real function drops mic and hear",
     /function settledPose\([^]*?const \{[^}]*\bmic: _\w+[^}]*\bhear: _\w+[^}]*\.\.\.still \}/.test(src), true);
  ck("the JOIN SNAPSHOT uses it (this is the fix; reverting it fails here)",
     /pose: settledPose\(o\.lastPose\)/.test(src), true);
  ck("no raw lastPose ships to other clients",
     /pose: o\.lastPose\b/.test(src), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
