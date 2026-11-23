// gz-stall-test: gzip runs on the serving thread (server/gzcache.ts, a cache miss is Bun.gzipSync), so a body over GZIP_MAX_MB
// (default 32) is served as it is, uncompressed, by design: a big avatar is mostly packed binary (it shrinks some 25%) and
// gzipping 40 MB holds every visitor's requests for the better part of a second (a cold cache after a restart, or a few big
// bodies thrashing GZIP_CACHE_MB, does it again and again). Real route(), temp dirs. After the cold review's gz-stall repro.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/gz-stall-test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
const S = suite("gz-stall");
const root = mkdtempSync(join(tmpdir(), "gzstall-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: join(root, "opt"), EIDOVERSE_DIR: join(root, "lib"), KTX2_TOKTX: "" });
const vdir = join(root, "lib", "eidoverse/assets/vrms"); mkdirSync(vdir, { recursive: true });
// incompressible bytes behind a GLB magic: a big avatar as gzip sees it
const write = (name: string, mb: number) => { const b = new Uint8Array(mb * 1_000_000);
  for (let k = 0; k < b.length; k += 65536) crypto.getRandomValues(b.subarray(k, Math.min(b.length, k + 65536)));
  b.set([0x67, 0x6c, 0x54, 0x46]); writeFileSync(join(vdir, name), b); };
write("big.vrm", 40); write("small.vrm", 1);
const { route } = await import("../../server/routes.ts");
const get = async (name: string) => { const t = performance.now();
  const r = await route(new Request(`http://x/library/eidoverse/assets/vrms/${name}`, { headers: { "accept-encoding": "gzip" } }), { requestIP: () => ({ address: "192.0.2.9" }) } as any);
  return { enc: r.headers.get("content-encoding"), ms: Math.round(performance.now() - t), status: r.status }; };

const big = await get("big.vrm");
S.check("Z1 at the default GZIP_MAX_MB a 40 MB avatar is served uncompressed, and the request doesn't hold the thread to gzip it", big.status === 200 && big.enc === null && big.ms < 200, big);
const small = await get("small.vrm");
S.check("Z1b ...a body under it is gzipped as before", small.status === 200 && small.enc === "gzip", small);
S.done();
