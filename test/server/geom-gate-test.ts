// geom-gate-test: GET /geom?lib= parses a model on the serving thread, so new parses are rate-limited like the build check
// (GEOM_PER_ADDRESS a minute per address, GEOM_PER_MINUTE in all; a cached answer is never refused, and the box's own
// loopback, where the agent door asks from, is not limited per address), and a model that fails to parse is remembered
// by its mtime instead of parsed again on every ask. Real route(), temp dirs. `bun test/server/geom-gate-test.ts`
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suite } from "../gate/suite.ts";
const S = suite("geom-gate");
const root = mkdtempSync(join(tmpdir(), "geomgate-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const lib = join(root, "lib"), models = join(lib, "eidoverse", "models"); mkdirSync(models, { recursive: true });
Object.assign(process.env, { SKIP_OPT_SWEEP: "1", WORLDS_DIR: join(root, "worlds"), OPT_DIR: join(root, "opt"), EIDOVERSE_DIR: lib, KTX2_TOKTX: "",
  GEOM_PER_ADDRESS: "3", GEOM_PER_MINUTE: "100" });
const { route } = await import("../../server/routes.ts");
const { boxes, buildGlb } = await import("../fixtures/two-storey-fixture.ts");
const glb = await buildGlb(boxes as any);
for (let i = 0; i < 8; i++) writeFileSync(join(models, `m${i}.glb`), glb);
writeFileSync(join(models, "broken.glb"), new Uint8Array(4000).fill(0x42));
const ask = (name: string, address: string) => route(new Request(`http://x/geom?lib=eidoverse/models/${name}.glb`), { requestIP: () => ({ address }) } as any) as Promise<Response>;

// G1: one address, more new models than GEOM_PER_ADDRESS: the first three are parsed, the next refused 429
const st: number[] = [];
for (let i = 0; i < 5; i++) st.push((await ask(`m${i}`, "198.51.100.20")).status);
S.check("G1 an address asking for more new parses than GEOM_PER_ADDRESS (3) a minute is refused 429 past them", st.slice(0, 3).every((s) => s === 200) && st.slice(3).every((s) => s === 429), st);
S.check("G1b ...an answer already cached is never refused", (await ask("m0", "198.51.100.20")).status === 200);
S.check("G1c ...another address has its own", (await ask("m5", "198.51.100.21")).status === 200);
const local: number[] = []; for (const i of [6, 7]) local.push((await ask(`m${i}`, "127.0.0.1")).status);
S.check("G1d ...and the box's own loopback (the agent door) is not limited per address", local.every((s) => s === 200), local);

// G2: a model that fails to parse is parsed once per version, not on every ask
const warns: string[] = []; const w = console.warn; console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
const unread = () => warns.filter((x) => x.includes("unreadable") && x.includes("broken.glb")).length;
try {
  for (let i = 0; i < 3; i++) await ask("broken", "127.0.0.1");
  S.check("G2 a model that fails to parse is parsed once, not on every ask", unread() === 1, unread());
  const t = new Date(Date.now() + 5000); utimesSync(join(models, "broken.glb"), t, t);
  await ask("broken", "127.0.0.1");
  S.check("G2b ...and again once it changes", unread() === 2, unread());
} finally { console.warn = w; }

// G3: the parsed-model cache is least recently USED: a model asked for again is kept over one read once and left alone
{ const { summarizeGlb, geomCached, geomCacheConfig } = await import("../../server/geometry.ts");
  S.check("G3 the cache holds 256 models by default (a world's worth, with room)", geomCacheConfig.max >= 256, geomCacheConfig);
  const was = geomCacheConfig.max; geomCacheConfig.max = 3;
  const f = (i: number) => join(models, `c${i}.glb`);
  for (let i = 0; i < 4; i++) writeFileSync(f(i), glb);
  for (const i of [0, 1, 2]) await summarizeGlb(f(i));
  await summarizeGlb(f(0));   // c0 asked for again: now the most recent
  await summarizeGlb(f(3));   // over the cap: the least recently used (c1) goes
  S.check("G3b ...past it, the least recently used model goes, not the one asked for again", geomCached(f(0)) && !geomCached(f(1)) && geomCached(f(3)), [0, 1, 2, 3].map((i) => geomCached(f(i))));
  geomCacheConfig.max = was; }
S.done();
