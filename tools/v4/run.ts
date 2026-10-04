// tools/v4/run.ts — every protocol-v4 suite, one command:
//   bun run test:v4                 (= BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/v4/run.ts)
//   V4_LAB=<v4-lab checkout>        also run the control arms (the lab's pre-fix door and fold; see common.ts)
//   V4_WORLDS=<dir>[:<dir>…]        where the sweep looks for world logs (default: the checkout's parent directory)
//   bun tools/v4/run.ts hostile phys    run only the named suites
// Each suite runs in its own process (they pin the door's clock through V4_NOW). Prints each suite's tail; exits 1
// if any suite fails.
import { ENGINE, controlNote } from "./common.ts";

const SUITES: [string, string, number][] = [ // name, file, tail lines to show
  ["hostile", "hostile-check.ts", 2],   // PROTOCOL-v4 §6 proof 1: hostile logs against the strict fold
  ["attack", "attack-check.ts", 2],     // §6 proofs 2–3: 25d H1/H2/H4 attacks through the door (admit, L7)
  ["gaps", "gaps-check.ts", 2],         // research 34: creator rights, presence track, rate, two hands
  ["phys", "phys-check.ts", 1],         // design 20: launches, rests by cause, carriers
  ["replay", "replay-check.ts", 1],     // L1: the fold alone, self-agreement, the lab's digest
  ["conformance", "compare.ts", 3],     // the JS fold vs the Python reference reader (+ its own tests)
  ["sweep", "sweep.ts", 3],             // translators on every local world log + her dialect-3 goldens + pins
  ["browser", "browser-check.ts", 1],   // the shared core imported by headless Chromium, byte-for-byte with bun
  ["door", "door-check.ts", 1],
  ["server", "server-check.ts", 1],     // slice 2 at the server: real processes, real WebSockets, scratch ports; v1 byte-compared         // slice 2 in process: names, translator stamp, ancestor pins, live = whole-log, catalogue, projection
];
const only = process.argv.slice(2);
const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }; // a cached transpile once hid a stale module (bun cache poison)
let failed: string[] = [];
const t0 = performance.now();
for (const [name, file, tail] of SUITES) {
  if (only.length && !only.includes(name)) continue;
  const t = performance.now();
  const r = Bun.spawnSync(["bun", ENGINE + "tools/v4/" + file], { cwd: ENGINE, env });
  const out = (r.stdout.toString() + r.stderr.toString()).trimEnd().split("\n");
  const fails = out.filter((l) => /^\s*FAIL\b/.test(l));
  const ok = r.exitCode === 0;
  if (!ok) failed.push(name);
  console.log(`\n== ${name} (${file}) ${ok ? "PASS" : `FAIL (exit ${r.exitCode})`} ${((performance.now() - t) / 1000).toFixed(1)} s`);
  for (const l of fails.slice(0, 20)) console.log(l);
  for (const l of out.slice(-tail)) console.log(l);
}
console.log(`\n${controlNote()}`);
console.log(`v4: ${failed.length ? `FAILED: ${failed.join(", ")}` : "all suites pass"} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed.length ? 1 : 0);
