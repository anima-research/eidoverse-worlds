// idle-stall-test — a download whose reader stalls longer than Bun's default
// 10s idle timeout must still arrive whole (#219).
//
//   bun tools/idle-stall-test.ts
//
// A scratch sequencer serves one large file from a temp library. A raw TCP
// client requests it, reads the headers, then stops reading for STALL_MS so
// the socket buffers fill and the server can't write. On resume it counts the
// body bytes against Content-Length. With Bun's default idleTimeout (10s)
// the server drops the connection mid-body and the count comes up short.
// Takes ~15s.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

const STALL_MS = 13_000;
const SIZE = 48 * 1024 * 1024;   // well past loopback socket buffers, so the server's writes block

const root = mkdtempSync(join(tmpdir(), "idle-stall-"));
const models = join(root, "library", "eidoverse/assets/models");
mkdirSync(models, { recursive: true });
writeFileSync(join(models, "big.bin"), randomBytes(SIZE));   // random: nothing for a codec to shrink

const PORT = 8000 + Math.floor(Math.random() * 900);
const seq = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: mkdtempSync(join(tmpdir(), "idle-stall-w-")),
    EIDOVERSE_DIR: join(root, "library"), OPT_DIR: join(root, "opt"), SKIP_OPT_SWEEP: "1" },
  stdout: "ignore", stderr: "ignore",
});
process.on("exit", () => seq.kill());
let up = false;
for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/worlds`); up = true; } catch { await Bun.sleep(200); } }
if (!up) { console.error("FATAL: scratch sequencer never came up (bun install in the repo root?)"); process.exit(2); }

const result = await new Promise<{ expected: number; got: number; closedEarly: boolean }>((resolve) => {
  const sock = connect(PORT, "127.0.0.1");
  let head = Buffer.alloc(0), expected = -1, got = 0, stalled = false;
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
    if (expected >= 0 && got >= expected) { sock.destroy(); resolve({ expected, got, closedEarly: false }); return; }
    if (!stalled) {
      stalled = true;
      sock.pause();
      console.log(`  reading paused for ${STALL_MS / 1000}s after ${got} body bytes…`);
      setTimeout(() => sock.resume(), STALL_MS);
    }
  });
  sock.on("close", () => resolve({ expected, got, closedEarly: got < expected }));
  sock.on("error", () => {});
});

const ok = result.expected === SIZE && result.got === result.expected;
console.log(`${ok ? "  ok " : "FAIL "} stalled download arrives whole — ${result.got}/${result.expected} bytes`);
console.log(`\n${ok ? 1 : 0} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
