// upload-cap-test — /upload's whole-body cap (UPLOAD_CAP; server/request-body.ts readCappedBytes, called by server/upload.ts) on a scratch door at UPLOAD_CAP_MB=1:
// one byte over is refused in the cap's own words, with a length or chunked (a stream far past it is cancelled near the cap), and nothing is stored; exactly the cap is read.
// (image-upload-test's oversize row is refused by the narrower IMAGE_CAP, so it never reaches this one.)
// A second door at UPLOAD_CAP_MB=200: a body past Bun's own request-body limit (128 MiB) and under the cap is read too.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/upload-cap-test.ts
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scratchSequencer } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";

const S = suite("upload-cap-test"), { check } = S;

const KEY = "test-door";
const env: Record<string, string> = { JOIN_TOKEN: KEY, UPLOAD_CAP_MB: "1", SKIP_OPT_SWEEP: "1" };   // OPT_DIR: the scratch's own store
const door = await scratchSequencer("uploadcap", { serverEnv: env, prepare: (scratch) => { env.OPT_DIR = join(scratch, "opt"); mkdirSync(env.OPT_DIR); } });
const OPT = env.OPT_DIR;
const up = async (body: Uint8Array | ReadableStream<Uint8Array>) => {
  const res = await fetch(`${door.BASE}/upload?name=cap.glb`, { method: "POST", body, headers: { authorization: `Bearer ${KEY}` } });
  return { status: res.status, text: await res.text() };
};
try {
  const over = new Uint8Array(1_000_000 + 1);
  let u = await up(over);
  check("a model upload one byte over UPLOAD_CAP (with Content-Length): 413 in the whole-body cap's words", u.status === 413 && /^too large \(1MB cap\)/.test(u.text), `${u.status} ${u.text.slice(0, 80)}`);
  const chunks = [over.subarray(0, 400_000), over.subarray(400_000, 800_000), over.subarray(800_000)];
  u = await up(new ReadableStream({ pull(c) { const n = chunks.shift(); if (n) c.enqueue(n); else c.close(); } }));
  check("...and chunked, with no length to trust: 413, the same cap", u.status === 413 && /^too large \(1MB cap\)/.test(u.text), `${u.status} ${u.text.slice(0, 80)}`);
  // a body far past the cap is cancelled once it passes it, never read to its end. The pull count measures the client's read-ahead
  // (40-64 of 100 kB under load against a 1 MB cap), so the row asserts only that the 100 MB end was never reached.
  let pulls = 0; const block = new Uint8Array(100_000);
  u = await up(new ReadableStream({ pull(c) { if (++pulls > 1000) c.close(); else c.enqueue(block); } }));
  check("...and a 100 MB stream is cancelled past the cap, not read to its end", u.status === 413 && pulls <= 1000, `${u.status} after ${pulls} pulls of 100 kB`);
  const stored = (() => { try { return readdirSync(join(OPT, "store"), { recursive: true }).length; } catch { return 0; } })();
  check("...and nothing refused was stored", stored === 0, `${stored} entries under store/`);
  u = await up(new Uint8Array(1_000_000));
  check("exactly UPLOAD_CAP is read (refused for what it is, not its size)", u.status !== 413, `${u.status} ${u.text.slice(0, 80)}`);
} finally { await door.cleanup(S.fail ? 1 : 0); }
// A cap an operator raises past Bun's own request-body limit (128 MiB, answered with a bare 413 before any route runs):
// server.ts moves that limit with the cap, so a body between the two is read to its end.
{ const env2: Record<string, string> = { JOIN_TOKEN: KEY, UPLOAD_CAP_MB: "200", SKIP_OPT_SWEEP: "1" };
  const door2 = await scratchSequencer("uploadcap-raised", { serverEnv: env2, prepare: (scratch) => { env2.OPT_DIR = join(scratch, "opt"); mkdirSync(env2.OPT_DIR); } });
  try {
    let left = 135; const block = new Uint8Array(1_000_000);
    const res = await fetch(`${door2.BASE}/upload?name=cap.glb`, { method: "POST", headers: { authorization: `Bearer ${KEY}` },
      body: new ReadableStream({ pull(c) { if (left-- > 0) c.enqueue(block); else c.close(); } }) });
    const text = await res.text();
    check("at UPLOAD_CAP_MB=200 a 135 MB body (past Bun's 128 MiB) is read to its end: refused for what it is, not its size", res.status === 415, `${res.status} ${text.slice(0, 80)}`);
  } finally { await door2.cleanup(S.fail ? 1 : 0); }
}
S.done();
