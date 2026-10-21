// idle-stall-test — a download whose reader stalls longer than Bun's default
// 10s idle timeout must still arrive whole (#219).
//
//   bun tools/idle-stall-test.ts
//
// A scratch sequencer (harness.ts) serves one large file from a temp library.
// A raw TCP client requests it, reads the headers, then stops reading for
// STALL_MS so the socket buffers fill and the server can't write. On resume it
// counts the body bytes against Content-Length. With Bun's default idleTimeout
// (10s) the server drops the connection mid-body and the count comes up short:
// Bun 1.4.3 did so about 12s after the client paused, so the stall leaves room
// past that. Takes about 25s.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { mkCheck, scratchSequencer } from "./harness.ts";

const STALL_MS = 20_000;
const SIZE = 48 * 1024 * 1024;   // well past loopback socket buffers, so the server's writes block
const DEADLINE_MS = STALL_MS + 30_000;   // a download that neither completes nor closes by then fails

const { check, tally } = mkCheck();
const assets = mkdtempSync(join(tmpdir(), "idle-stall-"));
const models = join(assets, "library", "eidoverse/assets/models");
mkdirSync(models, { recursive: true });
writeFileSync(join(models, "big.bin"), randomBytes(SIZE));   // random: nothing for a codec to shrink

const run = await scratchSequencer("idle-stall", {
  portFrom: 9760,
  serverEnv: { EIDOVERSE_DIR: join(assets, "library"), OPT_DIR: join(assets, "opt"), SKIP_OPT_SWEEP: "1" },
});
try {
  const result = await new Promise<{ expected: number; got: number; end: string }>((resolve) => {
    const sock = connect(run.PORT, "127.0.0.1");
    let head = Buffer.alloc(0), expected = -1, got = 0, stalled = false;
    const deadline = setTimeout(() => { sock.destroy(); resolve({ expected, got, end: `no end within ${DEADLINE_MS / 1000}s` }); }, DEADLINE_MS);
    sock.on("connect", () => sock.write(
      `GET /library/eidoverse/assets/models/big.bin HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
    sock.on("data", (chunk: Buffer) => {
      if (expected < 0) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const m = /content-length:\s*(\d+)/i.exec(head.subarray(0, end).toString());
        expected = m ? Number(m[1]) : SIZE;
        got = head.length - end - 4;
      } else got += chunk.length;
      if (expected >= 0 && got >= expected) { clearTimeout(deadline); sock.destroy(); resolve({ expected, got, end: "complete" }); return; }
      if (!stalled) {
        stalled = true;
        sock.pause();
        console.log(`  reading paused for ${STALL_MS / 1000}s after ${got} body bytes…`);
        setTimeout(() => sock.resume(), STALL_MS);
      }
    });
    sock.on("close", () => { clearTimeout(deadline); resolve({ expected, got, end: "connection closed" }); });
    sock.on("error", () => {});
  });
  check("stalled download arrives whole", result.expected === SIZE && result.got === result.expected,
    `${result.got}/${result.expected} bytes, ${result.end}`);
} finally {
  await run.cleanup(tally.failed ? 1 : 0);
  rmSync(assets, { recursive: true, force: true });
}
console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
process.exitCode = tally.failed ? 1 : 0;
