// version-route-test: /version, actually fetched, from spawns of the real server (harness.scratchSequencer: a scratch
// WORLDS_DIR, and the child proven ours by its nonce before any assertion counts):
//   A. env-driven: BUILD_SHA/BUILD_TIME/BUILD_DIRTY → exact body echo
//   B. git-driven: no env, repo present → sha/commitTime from git, dirty bool
//   C. neither: no env, git unreachable → honest "unknown"s, never fake-clean
// Plus startedAt stable across requests (fresh process ≠ fresh code), and the GET-route contract over /worlds, /version
// and /geom: JSON, no-store where the route promises it, and asking never founds a world.
//   bun test/client/version-route-test.ts

import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pause } from "../gate/wait.ts";
import { mkCheck, scratchSequencer, ROOT as REPO } from "../harness/harness.ts";

const { check, tally } = mkCheck();
// the env-less rows mean no BUILD_* at all, whatever the caller's shell carries
for (const k of ["BUILD_SHA", "BUILD_TIME", "BUILD_DIRTY"]) delete process.env[k];
const serve = (name: string, env: Record<string, string> = {}, worlds: string[] = []) =>
  scratchSequencer(`vr-${name}`, { serverEnv: { SKIP_OPT_SWEEP: "1", ...env }, worlds });
// a run killed outright (Windows) skips the exit handler: sweep what an earlier run planted
for (const f of readdirSync(join(REPO, "client"))) if (/^vr-nonce-[0-9a-f]{8}\.txt$/.test(f)) rmSync(join(REPO, "client", f), { force: true });
const version = async (s: { BASE: string }) => (await fetch(`${s.BASE}/version`)).json();

console.log("\n— the GET-route contract —");
{
  const s = await serve("contract", {}, ["yard"]);
  const worldsDir = join(s.SCRATCH, "worlds"), before = readdirSync(worldsDir).sort();
  // [route, promises no-store]
  const ROUTES: [string, boolean][] = [["/worlds", true], ["/version", true], ["/geom?world=yard", true], ["/geom?world=yard&id=nothing", true], ["/geom?lib=nothing", true]];
  for (const [route, noStore] of ROUTES) {
    const r = await fetch(`${s.BASE}${route}`); const ct = r.headers.get("content-type") ?? "";
    const body = await r.text(); let json = true; try { JSON.parse(body); } catch { json = false; }
    check(`${route}: answers JSON (content-type and body)`, ct.includes("json") && json, `${r.status} ${ct} ${body.slice(0, 80)}`);
    if (noStore) check(`${route}: cache-control is no-store`, r.headers.get("cache-control") === "no-store", String(r.headers.get("cache-control")));
    const asked = route.replace(/world=yard/, "world=never-made") + (route.includes("?") ? "" : "?world=never-made");
    await fetch(`${s.BASE}${asked}`);
    check(`${asked}: founds nothing on disk`, JSON.stringify(readdirSync(worldsDir).sort()) === JSON.stringify(before), readdirSync(worldsDir).join(","));
  }
  const listed = ((await (await fetch(`${s.BASE}/worlds`)).json()) as { worlds: { name: string }[] }).worlds.map((w) => w.name);
  check("…and no phantom world is listed", !listed.includes("never-made") && listed.includes("yard"), listed.join(","));
  await s.cleanup();
}

console.log("\n— A. env-driven build identity (deploy-image case) —");
{
  const s = await serve("a", { BUILD_SHA: "cafe123", BUILD_TIME: "2026-08-11T00:00:00Z", BUILD_DIRTY: "false" });
  const body = await version(s);
  check("env sha echoed exactly", body.sha === "cafe123", JSON.stringify(body));
  check("env commitTime echoed exactly", body.commitTime === "2026-08-11T00:00:00Z");
  check("env dirty=false is boolean false", body.dirty === false, String(body.dirty));
  check("startedAt is a valid timestamp", !Number.isNaN(Date.parse(body.startedAt)));
  await pause("let a second pass so a request-time startedAt would differ", 1100);
  const again = await version(s);
  check("startedAt STABLE across requests (process identity, not request time)",
    again.startedAt === body.startedAt, `${body.startedAt} vs ${again.startedAt}`);
  await s.cleanup();
}

console.log("\n— A2. env-driven dirty=true (a modified deploy must say so) —");
{
  const s = await serve("a2", { BUILD_SHA: "cafe123", BUILD_TIME: "2026-08-11T00:00:00Z", BUILD_DIRTY: "true" });
  const body = await version(s);
  check("env dirty=true is boolean true (visible, not laundered)", body.dirty === true, String(body.dirty));
  await s.cleanup();
}

console.log("\n— B. git-driven identity (dev checkout case) —");
{
  // an UNTRACKED file planted in the checkout for the server's lifetime: the tree is dirty while it runs
  const plant = join(REPO, "client", `vr-nonce-${crypto.randomUUID().slice(0, 8)}.txt`);
  writeFileSync(plant, "untracked"); process.on("exit", () => rmSync(plant, { force: true }));
  const s = await serve("b");
  const body = await version(s);
  check("sha resolved from git (not unknown)", body.sha !== "unknown" && body.sha.length >= 7, body.sha);
  check("commitTime resolved from git", body.commitTime !== "unknown" && !Number.isNaN(Date.parse(body.commitTime)));
  // the planted nonce file is UNTRACKED, so the checkout is dirty while the server runs: a hardcoded `dirty: false` fails here
  check("git-derived dirty is TRUE while the tree holds the nonce (real detection, not a hardcode)",
    body.dirty === true, String(body.dirty));
  await s.cleanup(); rmSync(plant, { force: true });
}

console.log("\n— B2. mixed provenance refused: sha/time are ONE pair (r3, review vectors) —");
{
  // BUILD_SHA without BUILD_TIME, git PRESENT: filling time from local HEAD would pair the image's sha with another
  // identity's timestamp, the composite the dirty fix rejects
  const a = await serve("b2a", { BUILD_SHA: "cafe123" });
  const bodyA = await version(a); await a.cleanup();
  check("BUILD_SHA alone, git present: commitTime is unknown, never local HEAD's",
    bodyA.sha === "cafe123" && bodyA.commitTime === "unknown", `${bodyA.sha} @ ${bodyA.commitTime}`);
  check("BUILD_SHA alone: dirty stays unknown too (no partner from another tree)",
    bodyA.dirty === "unknown", String(bodyA.dirty));
  // the mirror: BUILD_TIME without BUILD_SHA, git present
  const b = await serve("b2b", { BUILD_TIME: "2026-08-12T00:00:00Z" });
  const bodyB = await version(b); await b.cleanup();
  check("BUILD_TIME alone, git present: sha is unknown, never local HEAD",
    bodyB.commitTime === "2026-08-12T00:00:00Z" && bodyB.sha === "unknown", `${bodyB.sha} @ ${bodyB.commitTime}`);
  // the third direction: BUILD_DIRTY alone, git PRESENT, must NOT pair with a local git sha+time; sha and commitTime go unknown
  const c = await serve("b2c", { BUILD_DIRTY: "true" });
  const bodyC = await version(c); await c.cleanup();
  check("BUILD_DIRTY alone, git present: sha AND commitTime are unknown (no local partner for an env dirty)",
    bodyC.sha === "unknown" && bodyC.commitTime === "unknown", `${bodyC.sha} @ ${bodyC.commitTime} dirty=${bodyC.dirty}`);
  check("BUILD_DIRTY alone: the env dirty value itself is still honored",
    bodyC.dirty === true, String(bodyC.dirty));
  // garbage / empty BUILD_DIRTY clamps to "unknown", never a leaked raw string
  const d = await serve("b2d", { BUILD_DIRTY: "" });
  const bodyD = await version(d); await d.cleanup();
  check("BUILD_DIRTY='' clamps dirty to unknown (no leaked empty string) and still marks env-identity",
    bodyD.dirty === "unknown" && bodyD.sha === "unknown" && bodyD.commitTime === "unknown",
    `dirty=${JSON.stringify(bodyD.dirty)} sha=${bodyD.sha}`);
  const e = await serve("b2e", { BUILD_DIRTY: "garbage" });
  const bodyE = await version(e); await e.cleanup();
  check("BUILD_DIRTY='garbage' clamps dirty to unknown (only true/false pass)",
    bodyE.dirty === "unknown", JSON.stringify(bodyE.dirty));
}

console.log("\n— C. no env, no git: honest unknowns, never fake-clean —");
{
  // PATH without git: gitLine's spawn fails → catch → "" → "unknown"s
  const bare = mkdtempSync(join(tmpdir(), "no-git-bin-"));
  const bunReal = Bun.which("bun") ?? "/usr/local/bin/bun";
  const { linkSync, copyFileSync } = await import("node:fs");
  const exe = join(bare, process.platform === "win32" ? "bun.exe" : "bun");
  try { linkSync(bunReal, exe); } catch { copyFileSync(bunReal, exe); }   // a symlink needs Developer Mode on Windows
  const s = await serve("c", { PATH: bare });
  const body = await version(s);
  check("sha falls back to 'unknown'", body.sha === "unknown", body.sha);
  check("commitTime falls back to 'unknown'", body.commitTime === "unknown", body.commitTime);
  check("dirty is 'unknown' — NOT false — when nothing can answer",
    body.dirty === "unknown", String(body.dirty));
  check("startedAt still present (process identity independent of code identity)",
    !Number.isNaN(Date.parse(body.startedAt)));
  await s.cleanup(); rmSync(bare, { recursive: true, force: true });
}

console.log(`\n${tally.passed} passed, ${tally.failed} failed\n`);
process.exit(tally.failed ? 1 : 0);
