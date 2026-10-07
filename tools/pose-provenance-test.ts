// Pose provenance — the agent-side half of #61.
//
// The server's settledPose (tools/settled-pose-test.ts) strips ragdoll frames
// at every hand-off — but it keys on the CLIP LABEL, and the field showed a
// tumble frame that had been relabelled "idle" agent-side before it ever
// reached a sanitizer: princess's settled ragdoll bag rode `heldPose` under
// clip "idle" for weeks, got remembered by the server as an "enacted pose",
// re-armed on every restore, and survived every explicit `posture stand`
// (which only changed the label). These tests pin the invariant that closes
// that loop: a physics pose may only ever leave the process labelled
// "ragdoll", and any decision to move sheds the held pose entirely.
//
// Deliberately no sockets, no sim, no VRM: WorldAgent is constructed cold and
// driven through its public methods; wire-level behavior is asserted against
// the SOURCE (the settled-pose-test pattern), so reverting a call site fails
// the suite.

import { WorldAgent } from "../mcpl/agent.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let pass = 0, fail = 0;
function ok(cond: unknown, label: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const BAG = { hips: [-0.6186, 0.2801, 0.3753, 0.6308] } as Record<string, number[]>;

function agent(): any {
  return new WorldAgent({ name: "prov-test", world: "prov-test" }) as any;
}

console.log("authored poses (setPose):");
{
  const a = agent();
  a.setPose(BAG);
  ok(a.heldPose === BAG && a.heldPoseAuthored === true, "setPose(bones) marks the pose authored");
  a.setPose(null);
  ok(a.heldPose === null && a.heldPoseAuthored === false, "setPose(null) clears pose AND provenance");
}

console.log("the relabelled tumble frame (the exact #61 field state):");
{
  // a legacy store hands back clip "idle" + ragdoll bones; pre-fix this was
  // indistinguishable from an enacted pose and NOTHING could shed it
  const a = agent();
  a.heldPose = { ...BAG }; a.heldPoseAuthored = false; a.clip = "idle";
  a.setPosture("idle");   // princess's "explicit stand command", seq 4728
  ok(a.heldPose === null, "posture stand sheds a physics bag even under an idle label");
  ok(a.clip === "idle", "…and actually stands");
}
{
  const a = agent();
  a.heldPose = { ...BAG }; a.heldPoseAuthored = false; a.clip = "ragdoll";
  a.setPosture("lie");
  ok(a.heldPose === null && a.clip === "lie", "leaving ragdoll via any posture sheds the sim frame");
}
{
  const a = agent();
  a.setPose(BAG); a.clip = "sit";
  a.setPosture("sitchair");
  ok(a.heldPose === BAG, "an authored pose survives a posture change (a place, not physics)");
}

console.log("walking sheds the held pose — 'held until you clear_pose or move':");
{
  const a = agent();
  a.setPose(BAG);
  void a.walkTo(1, 1);
  ok(a.heldPose === null && a.heldPoseAuthored === false, "walkTo sheds even an authored pose (the tool's documented contract)");
  a.stop();
}
{
  const a = agent();
  a.heldPose = { ...BAG }; a.heldPoseAuthored = false; a.clip = "idle";
  void a.walkTo(1, 1);
  ok(a.heldPose === null, "walkTo sheds the relabelled physics bag — a poisoned store self-heals on first walk");
  a.stop();
}

console.log("wire + call-site invariants (asserted against the source):");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../mcpl/agent.ts"), "utf8");
  ok(/this\.heldPose && \(this\.heldPoseAuthored \|\| this\.clip === "ragdoll"\)/.test(src),
     "the presence packet only ships a physics bag under the ragdoll label");
  ok(/heldPose = out\.pose; this\.heldPoseAuthored = false/.test(src),
     "a settled sim frame is marked physics at capture");
  // a seat is presence (the body's own frames carry it, nothing is logged): leaving it is setSeat(null)
  const leaves = src.match(/this\.mySeat && this\.mayLeaveSeat\("menu"\)\) this\.setSeat\(null\)/g) ?? [];
  ok(leaves.length >= 2, "walking AND standing both leave the seat (found " + leaves.length + " call sites)");
  ok(/msg\.restore\.pose && msg\.restore\.clip !== "ragdoll"\) \{ this\.heldPose = msg\.restore\.pose; this\.heldPoseAuthored = true/.test(src),
     "a restored pose (post-settledPose server memory) counts as authored");
  // (gone with v1: "stateToEntries replays folded mounts — a rejoined agent knows it is seated". A seat is presence
  //  and isn't in the log or the cut, so a rejoin starts standing; there is no folded mount to replay.)
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
