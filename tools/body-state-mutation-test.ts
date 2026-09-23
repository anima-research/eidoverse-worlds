// The actual receive seam, tool dispatcher, and FK input must govern results.
// Run: bun tools/body-state-mutation-test.ts
import { join } from "node:path";
const root = join(import.meta.dir, "..");
async function run(mutation?: object) {
  const p = Bun.spawn([process.execPath, ...(mutation ? ["--preload", join(import.meta.dir, "body-state-mutation-preload.ts")] : []),
    join(import.meta.dir, "body-state-test.ts")], { cwd: root, env: { ...process.env, ...(mutation ? { BODY_STATE_MUTATION: JSON.stringify(mutation) } : {}) }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err };
}
const baseline = await run();
if (baseline.code !== 0) throw new Error("baseline is not green:\n" + baseline.out + baseline.err);
const cases = [
  { name: "drop incoming bone map", file: "agent.ts", from: "p.pose = pose; p.observedAt = now;", to: "p.pose = { ...pose, pose: null }; p.observedAt = now;", witness: "presence condition timed out" },
  { name: "tool discards requested detail", file: "tools.ts", from: 'a.detail ?? "summary", a.points', to: '"summary", a.points', witness: "eight exact quaternions round-trip" },
  { name: "FK ignores root yaw", file: "body-state.ts", from: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null)", to: "item.body.poseAt(o.pose!.p, 0, null)", witness: "world joints include root translation and yaw" },
  { name: "self leaks unpublished physics", file: "agent.ts", from: 'const bones = this.heldPose && (this.heldPoseAuthored || this.clip === "ragdoll") ? this.heldPose : null;', to: 'const bones = this.heldPose;', witness: "internal retired physics does not leak into self readback" },
  { name: "missing clip is silently replaced by rest geometry", file: "body-state.ts", from: 'animation = await this.clips.load(o.pose?.clip ?? "idle");', to: 'animation = null;', witness: "a reach toward an unevaluated seated body" },
];
for (const c of cases) {
  const r = await run(c);
  const failedWitness = c.witness === "presence condition timed out" ? r.err.includes(c.witness)
    : r.out.split("\n").some(line => line.includes("✗") && line.includes(c.witness));
  if (r.code === 0 || !r.err.includes("BODY_STATE_MUTATION_APPLIED") || !failedWitness) {
    throw new Error(`mutation did not trip its expected check: ${c.name}\n${r.out}\n${r.err}`);
  }
  console.log(`PASS: ${c.name} makes the product test fail`);
}
console.log(`${cases.length}/${cases.length} mutations detected; baseline passed`);
