// deps-route-test — the TTS runtime's served routes, actually fetched (#91 B1).
//
//   bun tools/deps-route-test.ts
//
// `bun build` being green proves nothing about DEPLOYMENT: the browser loads
// the TTS runtime through import-map + dynamic imports resolved against
// /node_modules and /vendor at request time, so a checkout without client
// deps installed serves 404s while every build stays green (review, #91 B1).
// This spawns the real server and fetches every route the voice stack needs.
// The hashed chunk name (piper-o91UDS6e.js) is pinned deliberately: the
// lockfile pins the package, the package pins the chunk, and this test is
// what notices when a dep bump silently renames it.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

// ── PORT SAFETY + CHILD OWNERSHIP (r3 B2) ─────────────────────────────────
// The revision-2 review hit this harness's false-receipt bug in the field: a
// fixed default port was already occupied, the child failed to bind, and the
// test fetched a STALE listener — reporting on a server it never spawned. Two
// defenses, both required:
//   1. pick a port that is verifiably FREE before spawning (random high port,
//      preflight fetch must FAIL);
//   2. prove the listener we then talk to is OUR child: a nonce file written
//      into this checkout's served tree, fetched back. Only a server rooted at
//      THIS tree can serve it — a squatter from another checkout cannot.
async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }               // nothing answered: free
  }
  throw new Error("no free port found in 20 tries");
}
const PORT = await freePort();
const NONCE = `route-nonce-${crypto.randomUUID()}`;
const clientDir = join(import.meta.dir, "..", "client");
writeFileSync(join(clientDir, `${NONCE}.txt`), NONCE);

const server = spawn("bun", [join(import.meta.dir, "..", "server", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: mkdtempSync(join(tmpdir(), "deps-route-")) },
  stdio: "ignore",
});
const cleanup = () => {
  try { server.kill(); } catch { /* already gone */ }
  try { rmSync(join(clientDir, `${NONCE}.txt`)); } catch { /* best effort */ }
};
// Cleanly stop the child on ANY exit — including assertion failure (r3 B5).
process.on("exit", cleanup);

// wait for the door
let up = false;
for (let i = 0; i < 40; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/`); up = true; break; }
  catch { await new Promise((r) => setTimeout(r, 250)); }
}
check("child server came up on a verified-free port", up, `:${PORT}`);
// ownership: the nonce only exists in the tree WE spawned from
{
  let owned = false, got = "";
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/${NONCE}.txt`);
    got = res.ok ? (await res.text()).trim() : `status=${res.status}`;
    owned = got === NONCE;
  } catch (e) { got = String(e).slice(0, 40); }
  check("listener is OUR child (nonce round-trip), not a squatter", owned, got);
  if (!owned) { console.log("\n  refusing to test an unowned server\n"); process.exit(1); }
}

// Every route the TTS stack resolves at runtime. Sizes are floors, not
// equalities — a truncated serve is as dead as a 404.
const ROUTES: [string, number][] = [
  // import-map targets (client/index.html)
  ["/node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js", 1_000],
  ["/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs", 100_000],
  // the phonemizer chunk piperphon.js resolves for the worker (hashed name —
  // pinned on purpose, see header)
  ["/node_modules/@mintplex-labs/piper-tts-web/dist/piper-o91UDS6e.js", 1_000],
  // ORT's wasm sidecars, fetched relative to the bundle at session build
  ["/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", 1_000_000],
  ["/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", 1_000_000],
  // vendored phonemizer runtime (see client/vendor/piper/NOTICE.md)
  ["/vendor/piper/piper_phonemize.wasm", 100_000],
  ["/vendor/piper/piper_phonemize.data", 1_000_000],
  // the worker itself, and the modules it imports at runtime
  ["/lib/phon.worker.js", 500],
  ["/lib/tts.js", 1_000],
  ["/lib/engine-piper.js", 1_000],
];

console.log(`\n— served routes for the TTS runtime (:${PORT}) —`);
for (const [path, minBytes] of ROUTES) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
    const bytes = res.ok ? (await res.arrayBuffer()).byteLength : 0;
    check(path, res.ok && bytes >= minBytes, `status=${res.status} bytes=${bytes} (need ≥${minBytes})`);
  } catch (e) {
    check(path, false, String(e).slice(0, 60));
  }
}

// Truthful-unavailable: a page whose optional TTS chunk is missing must know.
// engine-piper guards its dynamic imports; prove the guard path exists by
// fetching a deliberately-wrong chunk and asserting the server 404s cleanly
// (rather than serving index.html for everything, which would turn a missing
// module into a cryptic parse error instead of a catchable load failure).
{
  const res = await fetch(`http://127.0.0.1:${PORT}/node_modules/@mintplex-labs/piper-tts-web/dist/no-such-chunk.js`);
  const text = res.ok ? await res.text() : "";
  const honest404 = !res.ok || !text.includes("<html");
  check("missing module 404s honestly (no index.html fallback masking it)", honest404,
    `status=${res.status} html=${text.includes("<html")}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
