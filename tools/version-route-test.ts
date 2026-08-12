// version-route-test — /version, actually fetched (#51 review ask 1).
//
//   bun tools/version-route-test.ts
//
// Three spawns of the real server, each proving one leg of the contract:
//   A. env-driven: BUILD_SHA/BUILD_TIME/BUILD_DIRTY → exact body echo
//   B. git-driven: no env, repo present → sha/commitTime from git, dirty bool
//   C. neither: no env, git unreachable → honest "unknown"s, never fake-clean
// Plus: cache-control:no-store, and startedAt stable across repeated requests
// (fresh process ≠ fresh code — the field distinction this PR exists for).
// Port discipline per the stale-listener incident: verified-free random port
// + a nonce file served from THIS tree before any assertion counts.

import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const REPO = join(import.meta.dir, "..");
const children: ChildProcess[] = [];
const nonces: string[] = [];
process.on("exit", () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  for (const n of nonces) { try { rmSync(n); } catch { /* ok */ } }
});

async function freePort(): Promise<number> {
  for (let i = 0; i < 20; i++) {
    const cand = 20000 + Math.floor(Math.random() * 20000);
    try { await fetch(`http://127.0.0.1:${cand}/`, { signal: AbortSignal.timeout(400) }); }
    catch { return cand; }
  }
  throw new Error("no free port");
}

async function spawnServer(env: Record<string, string | undefined>): Promise<{ port: number }> {
  const port = await freePort();
  const nonce = `vr-nonce-${crypto.randomUUID().slice(0, 8)}`;
  const noncePath = join(REPO, "client", `${nonce}.txt`);
  writeFileSync(noncePath, nonce); nonces.push(noncePath);
  const child = spawn("bun", [join(REPO, "server", "server.ts")], {
    env: { PORT: String(port), WORLDS_DIR: mkdtempSync(join(tmpdir(), "vr-")), ...env },
    stdio: "ignore",
  });
  children.push(child);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const own = await fetch(`http://127.0.0.1:${port}/${nonce}.txt`).then((r) => r.ok && r.text()).catch(() => false);
  if (own !== nonce) throw new Error(`listener on :${port} is not our child — refusing to test it`);
  return { port };
  // (freePort's probe can false-positive "free" on a slow listener; the nonce
  // check above is the backstop that turns that race into a loud abort
  // rather than a wrong-server receipt — abort over false testimony.)
}

const HOME = process.env.HOME; const BUNPATH = process.env.PATH;

console.log("\n— A. env-driven build identity (deploy-image case) —");
{
  const { port } = await spawnServer({
    HOME, PATH: BUNPATH,
    BUILD_SHA: "cafe123", BUILD_TIME: "2026-08-11T00:00:00Z", BUILD_DIRTY: "false",
  });
  const res = await fetch(`http://127.0.0.1:${port}/version`);
  const body = await res.json();
  check("env sha echoed exactly", body.sha === "cafe123", JSON.stringify(body));
  check("env commitTime echoed exactly", body.commitTime === "2026-08-11T00:00:00Z");
  check("env dirty=false is boolean false", body.dirty === false, String(body.dirty));
  check("cache-control is no-store", res.headers.get("cache-control") === "no-store",
    String(res.headers.get("cache-control")));
  check("startedAt is a valid timestamp", !Number.isNaN(Date.parse(body.startedAt)));
  await new Promise((r) => setTimeout(r, 1100));
  const again = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  check("startedAt STABLE across requests (process identity, not request time)",
    again.startedAt === body.startedAt, `${body.startedAt} vs ${again.startedAt}`);
}

console.log("\n— A2. env-driven dirty=true (a modified deploy must say so) —");
{
  const { port } = await spawnServer({
    HOME, PATH: BUNPATH,
    BUILD_SHA: "cafe123", BUILD_TIME: "2026-08-11T00:00:00Z", BUILD_DIRTY: "true",
  });
  const body = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  check("env dirty=true is boolean true (visible, not laundered)", body.dirty === true, String(body.dirty));
}

console.log("\n— B. git-driven identity (dev checkout case) —");
{
  const { port } = await spawnServer({ HOME, PATH: BUNPATH });
  const body = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  check("sha resolved from git (not unknown)", body.sha !== "unknown" && body.sha.length >= 7, body.sha);
  check("commitTime resolved from git", body.commitTime !== "unknown" && !Number.isNaN(Date.parse(body.commitTime)));
  // The nonce file this harness plants in client/ is UNTRACKED, so during
  // any spawned-server's lifetime the checkout is guaranteed dirty — which
  // makes this the executable proof of the git-derived TRUE path (a
  // hardcoded `dirty: false` fails here; review caught that the boolean
  // check alone could not tell them apart).
  check("git-derived dirty is TRUE while the tree holds the nonce (real detection, not a hardcode)",
    body.dirty === true, String(body.dirty));
}

console.log("\n— C. no env, no git: honest unknowns, never fake-clean —");
{
  // PATH without git: gitLine's spawn fails → catch → "" → "unknown"s.
  const bare = mkdtempSync(join(tmpdir(), "no-git-bin-"));
  const bunReal = Bun.which("bun") ?? "/usr/local/bin/bun";
  const { symlinkSync } = await import("node:fs");
  symlinkSync(bunReal, join(bare, "bun"));
  const { port } = await spawnServer({ HOME, PATH: bare });
  const body = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  check("sha falls back to 'unknown'", body.sha === "unknown", body.sha);
  check("commitTime falls back to 'unknown'", body.commitTime === "unknown", body.commitTime);
  check("dirty is 'unknown' — NOT false — when nothing can answer",
    body.dirty === "unknown", String(body.dirty));
  check("startedAt still present (process identity independent of code identity)",
    !Number.isNaN(Date.parse(body.startedAt)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
