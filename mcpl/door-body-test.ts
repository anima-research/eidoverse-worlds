/**
 * The door's own body state on a bare WorldAgent (no world): a tracks loop and
 * treading water, a reach the relay holds to more than one body, and a walk
 * carried across a rejoin.
 *
 * Run: bun mcpl/door-body-test.ts
 */
import { WorldAgent } from "./agent.ts";
import { pointClass } from "../shared/protocol/consent.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("a tracks loop");
{
  // Treading water is a swimmer at rest. A loop started while treading plays on; a swim stroke is a move, and ends it.
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  ag.anims = [{ name: "wave", mode: "loop", kind: "track" }];
  ag.clip = "tread"; ag.target = null;
  ag.watchAnim();
  check("a tracks loop plays on while its body treads water", ag.anims.some((a: any) => a.kind === "track"));
  ag.clip = "swim";
  ag.watchAnim();
  check("...and a swim ends it, as a move", !ag.anims.some((a: any) => a.kind === "track"));
}

console.log("a reach held to two bodies");
{
  // A world point inside both Ann and Cal: the relay holds the reach to each of them, and strips it if either refuses.
  // Cal refuses, so the reach is refused, by Cal, whichever of the two the door reads first.
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  const pose = (p: number[]) => ({ p, yaw: 0, speed: 0, clip: "idle" });
  ag.people.set("Ann", { id: "Ann", avatar: "", pose: pose([0, 0, 0]) });
  ag.people.set("Cal", { id: "Cal", avatar: "", pose: pose([0.1, 0, 0]) });
  ag.actorIds.set("Ann", "a-ann"); ag.actorIds.set("Cal", "a-cal");
  const pt = [0.05, 1.2, 0];
  const calCls = pointClass([0, 0, 0], [pt[0] - 0.1, pt[1], pt[2]]);
  check("(the point lands in both bodies)", !!pointClass([0, 0, 0], pt) && !!calCls);
  ag.joined = true;
  ag.refreshReachReading = async () => {};
  ag.solveReachEntry = () => ({ state: "pending" });
  setTimeout(() => ag.reachRefusals.push({ to: "a-cal", cls: calCls, why: "Cal's table says no", limb: "rightHand", ts: Date.now() }), 60);
  const r = await ag.reach("rightHand", { p: pt });
  check("a reach refused by the second body it lands in is refused", r.ok === false && /Cal's consent refused it/.test(r.text), r.text);
  check("...and withdrawn", !ag.reaches.has("rightHand"));
}

console.log("a walk carried across a rejoin");
{
  // A stretch of the walk asked on the old connection answers after the rejoin, with a timeout. The resumed walk asked
  // again where it stands and was answered, so that late answer is the old connection's, and the walk goes on.
  const ag: any = new WorldAgent({ name: "me", world: "w" });
  let answerOld: (v: unknown) => void = () => {};
  ag.request = (verb: string) => verb === "move" ? new Promise((res) => { answerOld = res; }) : Promise.resolve({ ok: true });
  ag.trackHere = async () => ({ ok: true });
  ag.walkDone = () => {};
  ag.target = { x: 0, y: 0, z: 5 };
  ag.trackAt = [0, 0, 0];
  ag.walkGate = { mode: "tracked", permit: [0, 0, 1], busy: false };
  ag.extendPermit(ag.walkGate);   // the old connection's stretch, still out
  // the rejoin's step for a walk it carries
  if (typeof ag.resumeWalkGate === "function") ag.resumeWalkGate(); else ag.syncWalkGate(ag.walkGate);
  await sleep(10);
  answerOld({ ok: false, refused: { code: "timeout", reason: "the authority did not answer within 8 s" } });
  await sleep(10);
  check("the old connection's late answer doesn't end the resumed walk", ag.target !== null && ag.lastWalkRefusal?.code !== "timeout",
    JSON.stringify({ target: ag.target, refusal: ag.lastWalkRefusal }));
  check("...which goes on, tracked again", ag.walkGate?.mode === "tracked");
}

console.log(failures ? `\x1b[31m${failures} failed\x1b[0m` : "\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
