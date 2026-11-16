// settled-pose-test — what a body looks like TO SOMEONE ELSE (#61).
//
//   bun test/server/settled-pose-test.ts
//
// The bug this pins: the join snapshot had two paths that disagreed.
// `restore` (your own body) went through rememberPose and came back
// normalized; `present` (everyone else's bodies) shipped o.lastPose raw. So a
// resident who was mid-ragdoll when someone joined arrived collapsed for that
// joiner while looking fine to herself: nobody can notice it from inside
// their own session.
//
// The invariant, stated once: A POSE IN THE JOIN SNAPSHOT IS THE SETTLED
// RESULT, NEVER A FRAME OF PHYSICS IN FLIGHT (live frames still carry the flight). Both paths now call settledPose.
//
// Pure logic, no VRM assets, no renderer — deliberately, so it runs anywhere
// (test/client/ragdoll-test.ts needs the shipped rigs and is the right home for the
// solver, not for this).

import { withoutOnceAnim, ONCE_KEYS } from "../../shared/onceanim.js";
import { suite } from "../gate/suite.ts";

// Mirror of server.ts's settledPose. Kept in sync by the assertions below —
// if the server's version changes shape, these fail loudly rather than
// silently testing a stale copy.
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { mic: _mic, hear: _hear, t: _t, seq: _seq, ...still } = withoutOnceAnim(pose as Record<string, unknown>);
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}

const { ok, done } = suite("settled-pose");
const ck = (n: string, got: unknown, want: unknown) => ok(JSON.stringify(got) === JSON.stringify(want), n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the bug itself ──────────────────────────────────────────────────────────
{
  const midFall = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1], spine: [0.4, 0, 0, 0.9] }, p: [1, 0.6, 2] };
  const out = settledPose(midFall)!;
  ck("a mid-ragdoll frame never leaves as ragdoll", out.clip, "idle");
  ck("  ...and its tumble bones do not travel", out.pose, undefined);
  ck("  ...but position survives (she is still standing there)", out.p, [1, 0.6, 2]);
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
  const vigil = { clip: "idle", poses: ["wings-folded"], p: [4, 0, 2] };
  const out = settledPose(vigil)!;
  ck("folded wings (the named pose) survive settled presence", JSON.stringify(out.poses), '["wings-folded"]');
  ck("  ...without becoming a bone override", out.pose, undefined);
}

// ── a gesture is a MOMENT, not a place ──────────────────────────────
{
  const waving = { clip: "idle", anim: "wave", p: [0, 0, 0] };
  const out = settledPose(waving)!;
  ck("a gesture (pose.anim) does not persist (a wave would become a tic)", out.anim, undefined);
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

// ── a ragdoll mid-gesture: both rules apply, neither leaks ───────────────────
{
  const knockedMidWave = { clip: "ragdoll", anim: "wave", pose: { hips: [0, 0, 0, 1] }, p: [5, 1.2, 5] };
  const out = settledPose(knockedMidWave)!;
  ck("knocked over mid-wave: clip settles", out.clip, "idle");
  ck("  ...gesture dropped", out.anim, undefined);
  ck("  ...tumble bones dropped", out.pose, undefined);
}

// ── the asymmetry that WAS the bug ─────────────────────────────────────────
// That both server paths (restore and present) reach settledPose is pinned by the source checks at the end.
{
  const live = { clip: "ragdoll", pose: { hips: [0, 0, 0, 1] }, p: [2, 0.8, 2] };
  ck("a ragdolled body's settled answer (what owner and joiner both get) is upright", settledPose(live)!.clip, "idle");
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
  const src = await Bun.file(new URL("../../server/server.ts", import.meta.url)).text();
  ck("server still defines settledPose", /function settledPose\(/.test(src), true);
  { const body = (src.match(/function settledPose\([^]*?\n\}\n/)?.[0] ?? "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join(" ").replace(/\s+/g, " ").trim();
    ck("the real function is this mirror, statement for statement", body, "function settledPose(pose: unknown): Record<string, unknown> | null { if (!pose) return null; const { mic: _mic, hear: _hear, t: _t, seq: _seq, ...still } = withoutOnceAnim(pose as Record<string, unknown>); if (still.clip === \"ragdoll\") { still.clip = \"idle\"; delete still.pose; } return still; }"); }
  ck("the ragdoll rule is still in the real function",
     /still\.clip === "ragdoll".*still\.clip = "idle".*delete still\.pose/s.test(src), true);
  ck("the real function drops mic and hear",
     /function settledPose\([^]*?const \{[^}]*\bmic: _\w+[^}]*\bhear: _\w+[^}]*\.\.\.still \}/.test(src), true);
  ck("the real function drops the once anim (pose.anim, either key)",
     /function settledPose\([^]*?= withoutOnceAnim\(pose/.test(src), true);
  ck("the JOIN SNAPSHOT uses it (this is the fix; reverting it fails here)",
     /pose: settledPose\(o\.lastPose\)/.test(src), true);
  ck("no raw lastPose ships to other clients",
     /pose: o\.lastPose\b/.test(src), false);
}

done();
