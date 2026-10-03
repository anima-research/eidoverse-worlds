// Every seam that composes a chosen body size into text-tier geometry must be load-bearing: break it in place
// (source rewrite at load, tools/contact-mutation-preload.ts) and the named product check must go red.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/body-state-scale-mutation-test.ts
import { join } from "node:path";
const SCALE = "body-state-scale-test.ts", EFF = "../mcpl/effective-test.ts";
const cases = [
  { name: "FK drops body scale (the pivot never sizes)", file: "mcpl/physics.ts",
    from: "this.av.pivot.scale.setScalar(u);", to: "this.av.pivot.scale.setScalar(1);",
    test: SCALE, witness: "every contact (27) scales about the body root" },
  { name: "reader does not pass the observed scale to FK", file: "mcpl/body-state.ts",
    from: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null, o.pose!.scale);", to: "item.body.poseAt(o.pose!.p, o.pose!.yaw, null);",
    test: SCALE, witness: "hand-computed FK — leftHand at root + yaw·2" },
  { name: "FK trusts the wire unclamped", file: "mcpl/physics.ts",
    from: "const u = clampBodyScale(scale);", to: "const u = typeof scale === 'number' ? scale : 1;",
    test: SCALE, witness: "the reader clamps what it is handed" },
  { name: "a size change keeps stale limb lengths", file: "mcpl/physics.ts",
    from: "this.chains.clear();", to: "",
    test: SCALE, witness: "re-measures its arm when its size changes" },
  { name: "contact standoff scales with the body", file: "mcpl/physics.ts",
    from: "return { pos: p.addScaledVector(n, standoff).toArray(), normal: n.toArray() };",
    to: "return { pos: p.addScaledVector(n, standoff * this.av.pivot.scale.x).toArray(), normal: n.toArray() };",
    test: SCALE, witness: "the same 2 cm (absolute) standoff" },
  { name: "root-frame reach points scale with the body (browser root is unscaled)", file: "mcpl/body-state.ts",
    from: "if (frame) target = rootPoint(e.t.p, frame);",
    to: "if (frame) target = rootPoint(e.t.p.map((v: number) => v * clampBodyScale(frame.scale)), frame);",
    test: SCALE, witness: "a point in the owner's root frame is the same metres at any size" },
  { name: "unjoined agent path ignores the target's size", file: "mcpl/agent.ts",
    from: "?.pose ?? null, pose?.scale);", to: "?.pose ?? null);",
    test: SCALE, witness: "unjoined path: a 2× body's contact target scales" },
  { name: "seat correction ignores rider size", file: "mcpl/effective.ts",
    from: "const c = applySeatCorrection(pos, g.contactY, Number.isFinite(rs) && rs > 0 ? rs : 1);",
    to: "const c = applySeatCorrection(pos, g.contactY, 1);",
    test: EFF, witness: "a 2× rider's root sits at y" },
  { name: "agent's mount view drops the rider's size", file: "mcpl/agent.ts",
    from: "riderScale: (eid) => eid === this.name ? 1 : clampBodyScale(this.people.get(eid)?.pose?.scale),",
    to: "riderScale: (eid) => 1,",
    test: EFF, witness: "the agent seats a 2× rider" },
];
async function run(test: string, m?: object) {
  const p = Bun.spawn([process.execPath, ...(m ? ["--preload", join(import.meta.dir, "contact-mutation-preload.ts")] : []), join(import.meta.dir, test)],
    { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...(m ? { CONTACT_MUTATION: JSON.stringify(m) } : {}) }, stdout: "pipe", stderr: "pipe" });
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
  const witnessed = red.some(l => l.includes(c.witness));
  if (!r.code || !r.err.includes("CONTACT_MUTATION_APPLIED") || !witnessed) {
    missed++;
    console.log(`MISSED ${c.name}: exit ${r.code}, applied ${r.err.includes("CONTACT_MUTATION_APPLIED")}\n${red.join("\n") || r.out.slice(-1500)}\n${r.err.slice(-800)}`);
  } else console.log(`PASS ${c.name}: ${red.length} check(s) red, including "${c.witness}"`);
}
console.log(`${cases.length - missed}/${cases.length} mutations detected`);
process.exit(missed ? 1 : 0);
