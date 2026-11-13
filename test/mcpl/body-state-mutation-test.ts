// Every seam body-state-test (and effective-test's seated-size rows) relies on must be load-bearing: each mutation turns its named check red.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/mcpl/body-state-mutation-test.ts (in-memory rewrites: test/harness/contact-mutation-preload.ts)
import { join } from "node:path";
const root = join(import.meta.dir, "..", "..");
const BODY = "body-state-test.ts", EFF = "effective-test.ts";   // EFF: where the seated-occupant rows live
const cases = [
  { name: "drop incoming bone map", file: "mcpl/agent.ts", from: "p.pose = pose; p.observedAt = now;", to: "p.pose = { ...pose, pose: null }; p.observedAt = now;", test: BODY, witness: "presence condition timed out" },
  { name: "tool discards requested detail", file: "mcpl/tools.ts", from: 'a.detail ?? "summary", a.points', to: '"summary", a.points', test: BODY, witness: "eight exact quaternions round-trip" },
  { name: "FK ignores root yaw", file: "mcpl/body-state.ts", from: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null, o.pose!.scale)", to: "item.body.poseAt(o.pose!.p, 0, null, o.pose!.scale)", test: BODY, witness: "world joints include root translation and yaw" },
  { name: "self leaks unpublished physics", file: "mcpl/agent.ts", from: 'const bones = this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? this.heldPose : null;', to: 'const bones = this.heldPose;', test: BODY, witness: "internal retired physics does not leak into self readback" },
  { name: "missing clip is silently replaced by rest geometry", file: "mcpl/body-state.ts", from: "animation = await this.clips.load(slot)", to: "animation = null; void Promise.resolve()", test: BODY, witness: "a reach toward an unevaluated seated body" },
  { name: "the headless sender's tick drops its yaw", file: "mcpl/agent.ts",
    from: 'type: "pose",\n      pose: {\n        p: [this.pos.x, this.pos.y, this.pos.z], yaw: this.yaw,', to: 'type: "pose",\n      pose: {\n        p: [this.pos.x, this.pos.y, this.pos.z], yaw: 0,',
    test: BODY, witness: "yaw × agent" },
  { name: "body_state drops the named poses", file: "mcpl/body-state.ts", from: "poses: Array.isArray(p?.poses) ? p.poses : null,", to: "poses: null,", test: BODY, witness: "named pose × browser" },
  { name: "FK drops body scale (the pivot never sizes)", file: "mcpl/physics.ts",
    from: "this.av.pivot.scale.setScalar(u);", to: "this.av.pivot.scale.setScalar(1);",
    test: BODY, witness: "every contact (27) scales about the body root" },
  { name: "reader does not pass the observed scale to FK", file: "mcpl/body-state.ts",
    from: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null, o.pose!.scale);", to: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null);",
    test: BODY, witness: "hand-computed FK — leftHand at root + yaw·2" },
  { name: "FK trusts the wire unclamped", file: "mcpl/physics.ts",
    from: "const u = clampBodyScale(scale);", to: "const u = typeof scale === 'number' ? scale : 1;",
    test: BODY, witness: "the reader clamps what it is handed" },
  { name: "a size change keeps stale limb lengths", file: "mcpl/physics.ts",
    from: "this.chains.clear();", to: "",
    test: BODY, witness: "re-measures its arm when its size changes" },
  { name: "contact standoff scales with the body", file: "mcpl/physics.ts",
    from: "return { pos: p.addScaledVector(n, standoff).toArray(), normal: n.toArray() };",
    to: "return { pos: p.addScaledVector(n, standoff * this.av.pivot.scale.x).toArray(), normal: n.toArray() };",
    test: BODY, witness: "the same 2 cm (absolute) standoff" },
  { name: "root-frame reach points scale with the body (browser root is unscaled)", file: "mcpl/body-state.ts",
    from: "if (frame) target = rootPoint(e.t.p, frame);",
    to: "if (frame) target = rootPoint(e.t.p.map((v: number) => v * clampBodyScale(frame.scale)), frame);",
    test: BODY, witness: "a point in the owner's root frame is the same metres at any size" },
  { name: "unjoined agent path ignores the target's size", file: "mcpl/agent-reach.ts",
    from: "?.pose ?? null, pose?.scale, pose?.clip !== \"ragdoll\");", to: "?.pose ?? null, undefined, pose?.clip !== \"ragdoll\");",
    test: BODY, witness: "unjoined path: a 2× body's contact target scales" },
  { name: "seat correction ignores occupant size", file: "mcpl/effective.ts",
    from: "const c = applySeatCorrection(pos, g.contactY, Number.isFinite(rs) && rs > 0 ? rs : 1);",
    to: "const c = applySeatCorrection(pos, g.contactY, 1);",
    test: EFF, witness: "a 2× occupant's root sits at y" },
  { name: "agent's mount view drops the occupant's size", file: "mcpl/agent.ts",
    from: "occupantScale: (eid) => eid === this.name ? 1 : clampBodyScale(this.people.get(eid)?.pose?.scale),",
    to: "occupantScale: (eid) => 1,",
    test: EFF, witness: "the agent seats a 2× occupant" },
];
async function run(test: string, m?: object) {
  const p = Bun.spawn([process.execPath, ...(m ? ["--preload", join(import.meta.dir, "../harness/contact-mutation-preload.ts")] : []), join(import.meta.dir, test)],
    { cwd: root, env: { ...process.env, ...(m ? { CONTACT_MUTATION: JSON.stringify(m) } : {}) }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}
for (const test of new Set(cases.map(c => c.test))) {
  const r = await run(test);
  if (r.code) throw new Error(`baseline ${test} is not green\n${r.out}\n${r.err}`);
  console.log(`baseline ${test}: green`);
}
let missed = 0;
for (const c of cases) {
  const r = await run(c.test, c);
  const red = r.out.split("\n").filter(l => l.includes("✗"));
  const witnessed = red.some(l => l.includes(c.witness)) || r.err.includes(c.witness);   // a wait that never settles throws its own words
  if (!r.code || !r.err.includes("CONTACT_MUTATION_APPLIED") || !witnessed) {
    missed++;
    console.log(`MISSED ${c.name}: exit ${r.code}, applied ${r.err.includes("CONTACT_MUTATION_APPLIED")}\n${red.join("\n") || r.out.slice(-1500)}\n${r.err.slice(-800)}`);
  } else console.log(`PASS ${c.name}: ${red.length} check(s) red, including "${c.witness}"`);
}
console.log(`${cases.length - missed}/${cases.length} mutations detected`);
process.exit(missed ? 1 : 0);
