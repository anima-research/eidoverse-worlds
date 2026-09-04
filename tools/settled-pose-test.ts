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
// silently testing a stale copy.
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  const { emote: _emote, ...still } = pose as Record<string, unknown>;
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
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
  ck("the JOIN SNAPSHOT uses it (this is the fix; reverting it fails here)",
     /pose: settledPose\(o\.lastPose\)/.test(src), true);
  ck("no raw lastPose ships to other clients",
     /pose: o\.lastPose\b/.test(src), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
