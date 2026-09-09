// Optional local corpus gate. The owned-server test has self-contained rigs;
// this exercises the real installed avatars without touching a running world.
// EIDOVERSE_DIR=/path/to/eidoverse-video bun tools/body-state-rigs-test.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BodyStateReader } from "../mcpl/body-state.ts";
const library = process.env.EIDOVERSE_DIR;
if (!library) throw new Error("set EIDOVERSE_DIR to the avatar library");
const dir = join(library, "eidoverse/assets/vrms");
const paths = readdirSync(dir).filter(n => n.endsWith(".vrm") && !n.endsWith(".ktx2.vrm"));
if (!paths.length) throw new Error("no real avatar fixtures found");
const files = new Map(paths.map(n => ["/library/" + n, join(dir, n)]));
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const path = files.get(decodeURIComponent(new URL(req.url).pathname));
  return path ? new Response(Bun.file(path)) : new Response("missing", { status: 404 });
} });
let passed = 0;
try {
  const reader = new BodyStateReader(`http://127.0.0.1:${server.port}`);
  for (const path of paths) {
    const o: any = { who: path, avatar: path, generation: 1, self: true, source: "authored", connected: true,
      pose: { p: [3, 2, -4], yaw: .7, clip: "idle", speed: 0,
        pose: { leftUpperArm: [0, 0, Math.sin(.15), Math.cos(.15)], rightLowerArm: [0, Math.sin(.2), 0, Math.cos(.2)] } } };
    const result = await reader.read(path, "all", ["hand_l", "hand_r", "chest_front"], () => ({ ...o, receivedAt: Date.now() }));
    if (!result.ok || !result.joints?.head || !Object.values(result.joints).every((j: any) => j.position.every(Number.isFinite))
      || !Object.values(result.contacts).every((c: any) => c.quality === "anatomical_estimate" && c.position.every(Number.isFinite)
        && Math.abs(Math.hypot(...c.normal) - 1) < 1e-6)) {
      throw new Error(`${path}: invalid geometry: ${JSON.stringify(result.geometry)}`);
    }
    passed++;
    console.log(`PASS ${path}: ${Object.keys(result.joints).length} joints, finite posed contacts`);
  }
} finally { server.stop(true); }
console.log(`${passed}/${paths.length} real avatars passed`);
