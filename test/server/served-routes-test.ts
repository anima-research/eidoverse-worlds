// served-routes-test: a route per family the client needs (a sample, not every import), really served, and every response isolated. `bun test/server/served-routes-test.ts`
// One table over a real server: status, a byte floor, COOP same-origin + COEP credentialless per row (server/routes.ts
// isolate()); without COEP on the document (or a worker's script) crossOriginIsolated goes false and wasm silently loses its threads. The
// hashed piper chunk name (piper-o91UDS6e.js) is pinned on purpose: this is what notices a dep bump renaming it.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { tryUntil } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";
import { freePort } from "../harness/harness.ts";

const S = suite("served-routes");
const check = (name: string, ok: unknown, detail?: unknown) => S.check(name, ok, detail);

// the child's per-run nonce on /version (EIDO_BOOT_NONCE) is checked before any vector and again after them
const PORT = freePort(20000);
const BASE = `http://127.0.0.1:${PORT}`;
const NONCE = randomUUID();
const scratch = mkdtempSync(join(tmpdir(), "served-routes-"));
// process.execPath, not "bun": on Windows the PATH "bun" is a .cmd shim whose pid dies at once, so the server outlives the test
const server = spawn(process.execPath, [join(import.meta.dir, "..", "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "served-routes-test", WORLDS_DIR: scratch, EIDO_BOOT_NONCE: NONCE },
  stdio: "ignore",
});
const childAlive = () => server.exitCode === null && !server.killed;
const ours = async () => { try { return (await (await fetch(`${BASE}/version`)).json()).nonce === NONCE; } catch { return false; } };
process.on("exit", () => {
  try { server.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

let up = false;
up = !!(await tryUntil("the child answers as ours", async () => !childAlive() || await ours(), { ms: 15_000, step: 250 })) && childAlive() && await ours();
check("listener on a verified-free port is OUR child (nonce round-trip)", up, `:${PORT} child ${childAlive() ? "alive" : `exited ${server.exitCode}`}`);
if (!up) { console.log("\n  refusing to test an unowned server\n"); process.exit(1); }

// [path, expected status, byte floor]; a truncated serve is as dead as a 404. The static tree is rooted AT client/.
const ROUTES: [string, number, number][] = [
  ["/", 200, 500],                                   // the document itself
  ["/main.js", 200, 1_000],
  ["/lib/core.js", 200, 1_000],
  ["/nonexistent-404", 404, 0],                      // a 404 is isolated too
  // the TTS runtime's import-map targets (client/index.html)
  ["/node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js", 200, 1_000],
  ["/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs", 200, 100_000],
  // the phonemizer chunk piperphon.js resolves for the worker (hashed name, pinned: see header)
  ["/node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js", 200, 1_000],
  // ORT's wasm sidecars, fetched relative to the bundle at session build
  ["/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", 200, 1_000_000],
  ["/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", 200, 1_000_000],
  // vendored phonemizer runtime (see client/vendor/piper/NOTICE.md)
  ["/vendor/piper/piper_phonemize.wasm", 200, 100_000],
  ["/vendor/piper/piper_phonemize.data", 200, 1_000_000],
  // the worker itself, and the modules it imports at runtime
  ["/lib/audio/phon.worker.js", 200, 500],
  ["/lib/audio/tts.js", 200, 1_000],
  ["/lib/audio/engine-piper.js", 200, 1_000],
  // a missing optional TTS chunk 404s honestly (not index.html), so engine-piper's guarded import gets a catchable failure
  ["/node_modules/@mintplex-labs/piper-tts-web/dist/no-such-chunk.js", 404, 0],
];

console.log(`\n— served routes (:${PORT}) —`);
for (const [path, status, minBytes] of ROUTES) {
  try {
    const res = await fetch(`${BASE}${path}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const coop = res.headers.get("cross-origin-opener-policy"), coep = res.headers.get("cross-origin-embedder-policy");
    const html = status === 404 && new TextDecoder().decode(body).includes("<html");
    // exact credentialless, not require-corp (a different product decision): a "stricter is safer" edit has to argue
    check(`${path} ${status}`, res.status === status && body.byteLength >= minBytes && !html && coop === "same-origin" && coep === "credentialless",
      `status=${res.status} bytes=${body.byteLength} (need ${status}, ≥${minBytes}) html=${html} COOP=${coop} COEP=${coep}`);
  } catch (e) { check(path, false, String(e).slice(0, 60)); }
}

// the client tree is served as /shared/ is (the control): gzipped on request, and an ETag revalidation is a 304
for (const path of ["/", "/lib/core.js", "/shared/components.js"]) {
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { "accept-encoding": "gzip" } }); await res.arrayBuffer();
    const etag = res.headers.get("etag");
    const again = etag ? await fetch(`${BASE}${path}`, { headers: { "if-none-match": etag } }) : null;
    check(`${path}: gzipped on request and revalidated to a 304 by its ETag`, res.status === 200 && res.headers.get("content-encoding") === "gzip" && again?.status === 304,
      `status=${res.status} encoding=${res.headers.get("content-encoding")} etag=${etag} again=${again?.status}`);
  } catch (e) { check(path, false, String(e).slice(0, 60)); }
}

// a q of 0 refuses gzip (RFC 9110 12.5.3): the file comes plain
for (const ae of ["gzip;q=0", "br, GZIP; q=0.0, identity"]) {
  try {
    const res = await fetch(`${BASE}/lib/core.js`, { headers: { "accept-encoding": ae } }); await res.arrayBuffer();
    check(`accept-encoding "${ae}": /lib/core.js comes back not gzipped`, res.status === 200 && !res.headers.get("content-encoding"), `status=${res.status} encoding=${res.headers.get("content-encoding")}`);
  } catch (e) { check(ae, false, String(e).slice(0, 60)); }
}

// the websocket upgrade must be untouched: a 101 never reaches fetch(), so the observable is that the socket still opens
const wsOk = await new Promise<boolean>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const t = setTimeout(() => { try { ws.close(); } catch { /* */ } resolve(false); }, 4000);
  ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
  ws.onerror = () => { clearTimeout(t); resolve(false); };
});
check("websocket upgrade still succeeds under isolate()", wsOk);

// bind the whole run to the child once more: a mid-run crash + stale listener would pass every row above
check("child is still alive and still OURS after the vectors", childAlive() && await ours(), `exitCode=${server.exitCode}`);

S.done();
