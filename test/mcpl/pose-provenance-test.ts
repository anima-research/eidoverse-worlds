// Pose provenance — the agent-side half of #61.
//
// The server's settledPose (test/server/settled-pose-test.ts) strips ragdoll frames
// at every hand-off — but it keys on the CLIP LABEL, and the field showed a
// tumble frame that had been relabelled "idle" agent-side before it ever
// reached a sanitizer: princess's settled ragdoll bag rode `heldPose` under
// clip "idle" for weeks, got remembered by the server as an "enacted pose",
// re-armed on every restore, and survived every explicit `posture stand`
// (which only changed the label). These tests pin the invariant that closes
// that loop: a physics pose may only ever leave the process labelled
// "ragdoll", and any decision to move sheds the held pose (unless pinned with `hold`: selfpose-test).
//
// Deliberately no sockets, no sim, no VRM: WorldAgent is constructed cold and
// driven through its public methods; wire-level behavior is asserted against
// the SOURCE (the settled-pose-test pattern), so reverting a call site fails
// the suite.

import { noWorldUrl } from "../harness/no-world.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { suite } from "../gate/suite.ts";

const { ok, done } = suite("pose-provenance");

const BAG = { hips: [-0.6186, 0.2801, 0.3753, 0.6308] } as Record<string, number[]>;

function agent(): any {
  return new WorldAgent({ url: noWorldUrl(), name: "prov-test", world: "prov-test" }) as any;
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

console.log("the presence packet, as tick() sends it (a fake socket):");
{
  const a = agent(), sent: any[] = [];
  a.ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) }; a.joined = true;   // tickInWorld sends only once joined
  const shipped = (authored: boolean, clip: string) => {
    a.heldPose = { ...BAG }; a.heldPoseAuthored = authored; a.clip = clip; sent.length = 0; a.tick();
    const p = sent.find((m) => m.type === "pose"); return p ? "pose" in p.pose : "no packet";
  };
  ok(shipped(false, "idle") === false, "a physics bag under an idle clip is not shipped");
  ok(shipped(false, "ragdoll") === true, "…under the ragdoll label it is");
  ok(shipped(true, "idle") === true, "an authored pose ships under any clip");
  a.stop();
}

console.log("wire + call-site invariants (asserted against the source):");
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../mcpl/agent.ts"), "utf8");
  ok(/heldPose = out\.pose; this\.heldPoseAuthored = false/.test(src),
     "a settled sim frame is marked physics at capture");
  // a seat is presence (the body's own frames carry it, nothing is logged): leaving it is setOccupant(null)
  const leaves = src.match(/this\.myOccupancy && this\.mayVacate\("menu"\)\) this\.setOccupant\(null\)/g) ?? [];
  ok(leaves.length >= 2, "walking AND standing both leave the seat (found " + leaves.length + " call sites)");
  ok(/msg\.restore\.pose && msg\.restore\.clip !== "ragdoll"\) \{ this\.heldPose = msg\.restore\.pose; this\.heldPoseAuthored = true/.test(src),
     "a restored pose (post-settledPose server memory) counts as authored");
}

done();
