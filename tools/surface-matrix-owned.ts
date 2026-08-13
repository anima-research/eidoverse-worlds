// surface-matrix-owned.ts — B3 (#57 review): owns the server that
// surface-test.py inspects. The python matrix assumed an externally prepared
// server at SURF_URL, so its checked-in results could not prove WHICH server
// they described. This wrapper is the ownership layer: free port (pid-derived,
// verified by nonce below), scratch worlds dir, per-run join token, child
// diagnostics preserved, and a process-identity check — the served /version
// startedAt must postdate this harness's own start, so a stale server on the
// port fails loudly instead of lending its answers.
//
//   bun tools/surface-matrix-owned.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8420 + (process.pid % 150);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-surfmatrix-"));
const TOK = `surf-${Math.random().toString(36).slice(2, 10)}`;   // per-run fixture

// Own the AGENT-token fixture too (Antra B1): surface-test.py needs the agent
// bearers that reserve hesp/hesp2/hesp3/watcher2-owner, but this wrapper only
// owned the browser JOIN_TOKEN — so the matrix silently borrowed the checkout's
// mcpl/tokens.json. Write the fixture the matrix relies on and point the server
// at it via AGENT_TOKENS_PATH, so the run proves WHICH tokens produced it.
const agentTokensPath = join(worldsDir, "agent-tokens.json");
writeFileSync(agentTokensPath, JSON.stringify({
  "surf-lab-hesp": { id: "hesp" },
  "surf-lab-hesp2": { id: "hesp2" },
  "surf-lab-hesp3": { id: "hesp3" },
  "surf-lab-w2o": { id: "watcher2-owner" },
}));

const server = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: TOK, AGENT_TOKENS_PATH: agentTokensPath,
    FOLD_EVERY: "5" /* T22: a handful of comps must fold entries[] out from under a held say */ },
  stdout: "pipe", stderr: "pipe",
});
const drain = async (label: string, stream: unknown) => {
  const text = await new Response(stream as ReadableStream).text().catch(() => "");
  if (text.trim()) console.log(`--- server ${label} (tail) ---\n${text.split("\n").slice(-20).join("\n")}`);
};

let code = 1;
try {
  // readiness + ownership in ONE probe: the per-run random JOIN_TOKEN is the
  // ownership credential — only the child we just spawned knows it, so a
  // pre-existing foreign listener on this port refuses our join and the
  // harness fails loudly instead of borrowing that server's answers.
  // (/version startedAt would be cleaner; it arrives with #51.)
  let owned = false;
  for (let i = 0; i < 40 && !owned; i++) {
    await new Promise((r) => setTimeout(r, 250));
    owned = await new Promise<boolean>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const t = setTimeout(() => { ws.close(); res(false); }, 1500);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOK, world: "ownprobe", id: "harness-probe", spectate: true }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data));
        clearTimeout(t);
        if (m.type === "snapshot") { ws.close(); res(true); }
        else { ws.close(); throw new Error(`port ${PORT} is served by a server that refused OUR token — foreign process, refusing to test it (${JSON.stringify(m).slice(0, 80)})`); } };
      ws.onerror = () => { clearTimeout(t); res(false); };
    });
  }
  if (!owned) throw new Error("owned server never became ready");
  console.log(`owned server up on :${PORT} (worlds: ${worldsDir}, per-run token)`);

  const py = Bun.spawn(["python3", "tools/surface-test.py"], {
    env: { ...process.env, SURF_URL: `ws://127.0.0.1:${PORT}/ws`, SURF_TOK: TOK },
    stdout: "inherit", stderr: "inherit",
  });
  code = await py.exited;
} catch (e) {
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}`);
  await drain("out", server.stdout); await drain("err", server.stderr);
} finally {
  server.kill();
}
process.exit(code);
