// request-body-cap-test — the capped route reads past their caps (server/request-body.ts readCapped, #333 backlog G4-027;
// /upload's own cap is upload-cap-test's). On a scratch door, each one byte over and exactly at its cap:
//   /seat-profile  MAX_PROPOSAL_BYTES (server/seats.ts): over is 413 in the cap's words, with a length or chunked
//   /thumb         400 000 bytes: over is 413 "thumb too large", nothing written; at the cap the PNG is stored
//   /perflog       100 000 bytes: over is answered "ok" (a beacon never learns why) and nothing is appended
// Not every readCapped caller. Elsewhere: /setup's 1024/1025 boundary (setup-check SU11); /clientlog and /native/start
// refuse an oversize body (clientlog-test S2 at 300 KB, native-login-test at 2048 bytes), not one byte over their caps;
// /auth's 64 KiB read (routes.ts) has no over-cap row anywhere yet.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/request-body-cap-test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scratchSequencer } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { MAX_PROPOSAL_BYTES } from "../../server/seats.ts";

const S = suite("request-body-cap"), { check } = S;
const KEY = "test-door", AGENT = "cap-agent-token";
const env: Record<string, string> = { JOIN_TOKEN: KEY, SKIP_OPT_SWEEP: "1" };
const door = await scratchSequencer("bodycap", { serverEnv: env, prepare: (scratch) => {
  env.OPT_DIR = join(scratch, "opt"); mkdirSync(env.OPT_DIR);
  env.AGENT_TOKENS_PATH = join(scratch, "tokens.json"); writeFileSync(env.AGENT_TOKENS_PATH, JSON.stringify({ [AGENT]: { id: "cap-agent" } }));
} });
const post = async (path: string, body: Uint8Array | ReadableStream<Uint8Array>, bearer: string) => {
  const res = await fetch(`${door.BASE}${path}`, { method: "POST", body, headers: { authorization: `Bearer ${bearer}` } });
  return { status: res.status, text: await res.text() };
};
const chunked = (b: Uint8Array) => { const parts = [b.subarray(0, b.length >> 1), b.subarray(b.length >> 1)];
  return new ReadableStream<Uint8Array>({ pull(c) { const n = parts.shift(); if (n) c.enqueue(n); else c.close(); } }); };
const json = (n: number) => { const b = new Uint8Array(n).fill(0x20); b[0] = 0x7b; b[n - 1] = 0x7d; return b; };   // "{   …   }": n bytes of valid JSON
try {
  // /seat-profile: the proposal cap
  let r = await post("/seat-profile", json(MAX_PROPOSAL_BYTES + 1), AGENT);
  check(`/seat-profile one byte over MAX_PROPOSAL_BYTES (${MAX_PROPOSAL_BYTES}): 413 in the cap's words`, r.status === 413 && r.text.includes(`proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`), `${r.status} ${r.text.slice(0, 120)}`);
  r = await post("/seat-profile", chunked(json(MAX_PROPOSAL_BYTES + 1)), AGENT);
  check("…and chunked, with no length to trust: 413, the same cap", r.status === 413 && r.text.includes(`proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`), `${r.status} ${r.text.slice(0, 120)}`);
  r = await post("/seat-profile", json(MAX_PROPOSAL_BYTES), AGENT);
  // "{ … }" parses to {}, which the store refuses on content: 422 (seats.ts propose), never the cap's 413 or a 5xx
  check("…while exactly the cap is read (answered 422 on its content, not 413)", r.status === 422 && !r.text.includes("proposal exceeds"), `${r.status} ${r.text.slice(0, 120)}`);

  // /thumb: 400 000 bytes of PNG
  const thumb = join(env.OPT_DIR, "thumbs", "capthumb.png");
  const png = (n: number) => { const b = new Uint8Array(n); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); return b; };
  r = await post("/thumb?name=capthumb", png(400_001), KEY);
  check("/thumb one byte over 400 000: 413 \"thumb too large\", nothing written", r.status === 413 && /thumb too large/.test(r.text) && !existsSync(thumb), `${r.status} ${r.text.slice(0, 80)} written=${existsSync(thumb)}`);
  r = await post("/thumb?name=capthumb", png(400_000), KEY);
  check("…while exactly the cap is stored", r.status === 200 && existsSync(thumb) && statSync(thumb).size === 400_000, `${r.status} ${r.text.slice(0, 80)}`);

  // /perflog: a beacon past 100 000 bytes is dropped; it is answered as any beacon is
  const perflog = join(door.SCRATCH, "worlds", ".perflogs.jsonl");
  const lines = () => existsSync(perflog) ? readFileSync(perflog, "utf8").split("\n").filter(Boolean).length : 0;
  const beacon = (n: number) => { const head = `{"probe":"cap","pad":"`, tail = `"}`; return new TextEncoder().encode(head + "x".repeat(n - head.length - tail.length) + tail); };
  r = await post("/perflog", beacon(100_001), KEY);
  check("/perflog one byte over 100 000: answered ok, nothing appended", r.status === 200 && r.text === "ok" && lines() === 0, `${r.status} ${r.text} lines=${lines()}`);
  r = await post("/perflog", beacon(100_000), KEY);
  check("…while exactly the cap is appended (the control: the beacon itself is well formed)", r.status === 200 && lines() === 1, `${r.status} lines=${lines()}`);
} finally { await door.cleanup(S.fail ? 1 : 0); }
S.done();
