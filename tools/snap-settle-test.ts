// snap-settle-test — a renderer waits for the world as long as the server says it may, headless.
//
//   bun tools/snap-settle-test.ts
//
// net_snap.js settle() waits for a just-arrived renderer's world to finish loading before it captures (no partial
// worlds). It used to stop at a fixed 20 s while the server would wait 40 s for a summoned roamer, so a world that
// finished loading at 22 s became a failed first snapshot (2026-10-24). Each snap now carries `wait` from the server
// (server/snapshots.ts dispatch), and settle uses it.
//
// The real net_snap.js, in a fresh process per case, with its browser-only imports (core.js, remotes.js, fp_view.js,
// capture.js) stubbed and the readiness probe scripted: the world becomes ready after `readyAt` ms.

import { join } from "node:path";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = join(import.meta.dir, "..");

/** Ask the real snapshot() for a frame: the world is ready after `readyAt` ms (never, if null); `wait` is the
 *  server's budget (absent, if undefined). Returns what it answered and how long it took. */
function snapCase(readyAt: number | null, wait: number | undefined) {
  const L = join(ROOT, "client/lib") + "/";
  const code = `
    const { mock } = await import("bun:test");
    const L = ${JSON.stringify(L)};
    const THREE = await import(${JSON.stringify(join(ROOT, "client/node_modules/three/build/three.module.js"))});
    const camera = { position: { set() {} }, lookAt() {}, updateMatrixWorld() {} };
    mock.module(L + "core.js", () => ({ THREE, camera }));
    const root = { position: new THREE.Vector3(), rotation: { y: 0 }, visible: true };
    mock.module(L + "remotes.js", () => ({ remotes: new Map([["agent", { avatar: { root, headWorldPosition: () => null, visualBounds: (b) => b } }]]) }));
    mock.module(L + "fp_view.js", () => ({ composeFirstPerson: () => "data:image/png;base64,FIRST" }));
    mock.module(L + "capture.js", () => ({ captureFrame: () => "data:image/png;base64,FRAME", captureFrom: () => "data:image/png;base64,FROM" }));
    const snap = await import(L + "net_snap.js");
    const t0 = performance.now(), readyAt = ${JSON.stringify(readyAt)};
    snap.setSnapReadiness(async () => {
      const ready = readyAt !== null && performance.now() - t0 >= readyAt;
      return { ready, body: true, builds: false, models: ready ? 1 : 0, loading: ready ? 0 : 1, compiling: 0 };
    });
    const msg = { follow: "agent", view: "third" ${wait === undefined ? "" : `, wait: ${wait}`} };
    const r = await snap.snapshot(msg);
    console.log(JSON.stringify({ r, ms: Math.round(performance.now() - t0), budget: snap.settleBudget(msg) }));`;
  const out = Bun.spawnSync(["bun", "-e", code], { stdout: "pipe", stderr: "pipe" });
  try { return JSON.parse(out.stdout.toString().trim().split("\n").pop()!) as { r: any; ms: number; budget: number }; }
  catch { return { r: { error: `ERROR ${out.stderr.toString().slice(0, 300)}` }, ms: -1, budget: -1 }; }
}

console.log("the server's budget");
{
  // the world finishes loading at 1.5 s; four steady checks follow; the server allows 4 s
  const ok = snapCase(1500, 4000);
  check("a world that loads within the server's wait is captured, not refused", ok.r?.dataUrl === "data:image/png;base64,FROM", JSON.stringify(ok));
  check("…after waiting for it (1.5 s to load, then four steady checks 250 ms apart)", ok.ms >= 2100 && ok.ms < 3500, `${ok.ms} ms`);
  // the same world, with a wait shorter than its load: refused at the server's budget, with the counts
  const short = snapCase(1500, 500);
  check("a world still loading when the server's wait runs out is refused, with the counts", /still loading this world — 1 model still loading \(0 in\)/.test(String(short.r?.error)), JSON.stringify(short));
  check("…at the server's budget, not a fixed 20 s", short.ms >= 450 && short.ms < 1500, `${short.ms} ms`);
  const zero = snapCase(null, 0);
  check("a wait of 0 refuses at once if the world is not ready", !!zero.r?.error && zero.ms < 600, `${zero.ms} ms`);
  const ready = snapCase(0, 0);
  check("…and a world already ready is captured at once, whatever the wait", ready.r?.dataUrl === "data:image/png;base64,FROM" && ready.ms < 600, JSON.stringify(ready));
}

console.log("settleBudget");
{
  check("no wait from the server: the old fixed 20 s", snapCase(0, undefined).budget === 20_000);
  check("the server's wait is used as given", snapCase(0, 38_000).budget === 38_000);
  check("a huge wait is bounded (240 s)", snapCase(0, 10_000_000).budget === 240_000);
  check("a negative wait is ignored (the old 20 s)", snapCase(0, -5).budget === 20_000);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
