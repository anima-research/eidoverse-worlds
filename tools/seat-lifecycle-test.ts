/**
 * seat-lifecycle-test — #101's load-bearing integration matrix: a REAL
 * scratch sequencer and a REAL WorldAgent, no injected math anywhere.
 *
 * What must be true end-to-end (design round, B4/B5): the server judges
 * profiles against current bytes and serves one verdict; proposals need a
 * NAMED actor (the anonymous door token bounces); countersign is an operator
 * write the running server notices and announces; and the headless client
 * receives the same profile revision through its actual delivery path —
 * httpBase fetch at join plus the two update events — until its own look()
 * says the corrected seat out loud.
 *
 * Fail-on-main control (run this file on main): /seat-profile is 404, the
 * roster has no seat field, and the seated look() shows neither the declared
 * approximation nor the corrected height — every section below fails by name.
 *
 * Run: bun run tools/seat-lifecycle-test.ts
 * (owns its scratch WORLDS_DIR; backs up and restores assets/opt/seats and
 *  mcpl/tokens.json — nothing durable is touched)
 */

import { mkdtempSync, existsSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldAgent } from "../mcpl/agent.ts";
import { SeatStore } from "../server/seats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
const PORT = 8977;
const DOOR = "test-door";
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${name}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");

/** Poll until `fn` (sync or async) is truthy or the deadline passes. */
async function until<T>(fn: () => T | Promise<T>, ms = 9000, step = 250): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) { await sleep(step); v = await fn(); }
  return v;
}

// ---- hygiene: nothing durable is touched ------------------------------------
const SEATS_DIR = join(ROOT, "assets", "opt", "seats");
const SEATS_BAK = `${SEATS_DIR}.bak-lifecycle`;
const TOKENS = join(ROOT, "mcpl", "tokens.json");
let seatsBacked = false, tokensCreated = false;
if (existsSync(SEATS_DIR)) { renameSync(SEATS_DIR, SEATS_BAK); seatsBacked = true; }
// The named-actor HTTP leg needs a bearer in mcpl/tokens.json. If the file
// exists it belongs to the operator — we skip the leg rather than touch it
// (permtest's env-gated posture); absent, we create and remove our own.
let namedToken: string | null = null;
if (!existsSync(TOKENS)) {
  namedToken = "seat-lifecycle-test-bearer";
  writeFileSync(TOKENS, JSON.stringify({ [namedToken]: { id: "seatbot" } }));
  tokensCreated = true;
} else console.log("  (mcpl/tokens.json exists — HTTP named-actor leg will be skipped, operator-import covers propose)");

const WORLDS = mkdtempSync(join(tmpdir(), "seatlife-"));
const server = Bun.spawn(["bun", "run", "server/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, WORLDS_DIR: WORLDS, JOIN_TOKEN: DOOR, PORT: String(PORT), EIDOVERSE_DIR: LIB },
  stdout: "pipe", stderr: "pipe",
});

let ag: WorldAgent | null = null;
let watcher: WebSocket | null = null;
const watcherEvents: any[] = [];

try {
  // readiness
  {
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { try { ok = (await fetch(`${BASE}/avatars`)).ok; } catch { await sleep(250); } }
    if (!ok) throw new Error("scratch server never came up");
  }

  console.log("serve-time verdicts");
  {
    const res = await fetch(`${BASE}/avatars`);
    const rev = res.headers.get("x-profiles-rev");
    const roster = await res.json() as any[];
    const claude = roster.find((e) => e.name === "claude");
    check("roster entries carry a seat verdict", !!claude?.seat, JSON.stringify(claude));
    check("no profile on disk → status missing", claude?.seat?.status === "missing");
    check("x-profiles-rev header rides the roster, rev 0", rev === "0", `rev=${rev}`);
  }

  console.log("write authority (B4)");
  const claudeSha = await sha(join(LIB, "eidoverse/assets/vrms/claude.vrm"));
  const clipSha = await sha(join(LIB, "eidoverse/assets/animations/sitting_normal_chair.vrma"));
  const goodProfile = {
    avatar: "claude", avatarSha256: claudeSha, pose: "sitchair", clipSha256: clipSha,
    seatContactY: 0.2055,
    derivation: { toolVersion: "seatlab-4", method: "skinned-pelvis-contact-v1",
      winner: { mesh: "Body", vertexIndex: 4417, rootLocal: [-0.012, 0.2055, 0.031] },
      supportPatch: { count: 214, spreadY: 0.0031, radiusXZ: 0.1 }, runs: 3, deterministic: true },
    review: { status: "proposed" },
  };
  {
    const anon = await fetch(`${BASE}/seat-profile?token=${DOOR}`, { method: "POST", body: JSON.stringify(goodProfile) });
    check("the anonymous door token cannot propose (401)", anon.status === 401, `${anon.status}`);
    const none = await fetch(`${BASE}/seat-profile`, { method: "POST", body: JSON.stringify(goodProfile) });
    check("no token cannot propose (401)", none.status === 401, `${none.status}`);
  }

  // a watcher client hears the broadcasts every consumer relies on
  watcher = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((res, rej) => {
    watcher!.onopen = () => { watcher!.send(JSON.stringify({ type: "join", world: "seatlab", id: "watcher", token: DOOR })); res(); };
    watcher!.onerror = () => rej(new Error("watcher ws failed"));
  });
  watcher.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.type === "avatar-profile-updated") watcherEvents.push(m); } catch { /* not ours */ } };
  await sleep(400);

  console.log("proposal");
  if (namedToken) {
    const bad = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify({ nonsense: true }) });
    check("a malformed proposal is refused with a named reason (422)", bad.status === 422, `${bad.status}: ${await bad.text()}`);
    const sneaky = await fetch(`${BASE}/seat-profile?token=${namedToken}`,
      { method: "POST", body: JSON.stringify({ ...goodProfile, review: { status: "accepted", receipt: "x", by: "me" } }) });
    check("this door writes proposals ONLY — accepted is refused (403)", sneaky.status === 403, `${sneaky.status}`);
    const ok = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify(goodProfile) });
    const body = await ok.json().catch(() => null);
    check("a named actor's valid proposal lands", ok.status === 200 && body?.status === "proposed", `${ok.status} ${JSON.stringify(body)}`);
    const ev = await until(() => watcherEvents.find((e) => e.name === "claude"));
    check("avatar-profile-updated broadcast reaches connected clients, rev-bearing", !!ev && Number.isFinite(ev.rev), JSON.stringify(watcherEvents));
  } else {
    // operator-import lane (attribution-less environments): same record, the
    // operator IS the provenance; the running server notices by mtime.
    const store2 = new SeatStore(join(ROOT, "assets", "opt"), LIB);
    const r = store2.importProposal(goodProfile, "lifecycle-test");
    check("operator import proposes", r.ok === true, JSON.stringify(r));
    const ev = await until(() => watcherEvents.find((e) => e.name === "claude"), 12000);
    check("external write announced by the mtime watch", !!ev, JSON.stringify(watcherEvents));
  }
  {
    const roster = await (await fetch(`${BASE}/avatars`)).json() as any[];
    const claude = roster.find((e) => e.name === "claude");
    check("proposed serves as proposed — never load-bearing", claude?.seat?.status === "proposed"
      && claude?.seat?.contactY === undefined, JSON.stringify(claude?.seat));
  }

  console.log("the headless consumer, end to end");
  process.env.WORLD_TOKEN = DOOR;   // the agent's door key rides the join message, from env
  ag = new WorldAgent({ url: `ws://127.0.0.1:${PORT}/ws`, name: "seatbot", world: "seatlab",
    avatar: "eidoverse/assets/vrms/claude.vrm", agentToken: namedToken ?? "" });
  await ag.connect();
  ag.verb("spawn", { id: "crate1", lib: "eidoverse/assets/props/crate.glb", pos: [0, 0, 0], yaw: 0 });
  ag.verb("comp", { id: "crate1", type: "sockets", data: {
    seatL: { pos: [0, 1, 0], pose: "sitchair" },                          // legacy: no anchor authored
    seatS: { pos: [0, 1, 0], pose: "sitchair", seatAnchor: "surface" },   // authored support plane
  } });
  await sleep(600);

  ag.verb("mount", { id: "seatbot", to: "crate1", slot: "seatL" });
  {
    const line = await until(() => { const l = ag!.look(); return /seated on crate1/.test(l) ? l : null; });
    check("legacy socket: seated, byte-identical composition (y = socket)", !!line && /ground height 1\.00m/.test(line ?? ""), line?.split("\n")[0]);
    check("legacy socket: declared, never silent", /seat approximate: legacy socket/.test(line ?? ""), line?.split("\n")[0]);
  }

  ag.verb("dismount", { id: "seatbot", pos: [1, 0, 1], yaw: 0 });
  await sleep(400);
  ag.verb("mount", { id: "seatbot", to: "crate1", slot: "seatS" });
  {
    const line = await until(() => { const l = ag!.look(); return /seated on crate1/.test(l) ? l : null; });
    check("surface socket + proposed profile: still approximate, reason names the countersign",
      /seat approximate: profile proposed — not countersigned/.test(line ?? ""), line?.split("\n")[0]);
  }

  console.log("countersign (operator-only, no HTTP path)");
  {
    const store2 = new SeatStore(join(ROOT, "assets", "opt"), LIB);
    const r = store2.accept("claude", "sitchair", "https://github.com/anima-research/eidoverse-worlds/issues/101#lifecycle", "lifecycle-test");
    check("operator accept succeeds", r.ok === true, JSON.stringify(r));
    const evs = watcherEvents.length;
    const line = await until(() => { const l = ag!.look(); return /ground height 0\.79m/.test(l) ? l : null; }, 12000);
    check("the agent's seat corrects IN PLACE on the push — contact plane onto the socket plane (1 − 0.2055 → 0.79)",
      !!line, ag!.look().split("\n")[0]);
    check("…and the approximation is gone from the line", !!line && !/seat approximate/.test(line ?? ""), line?.split("\n")[0]);
    const ev = await until(() => watcherEvents.length > evs);
    check("acceptance announced to every connected client", !!ev, `events=${watcherEvents.length}`);
    const roster = await (await fetch(`${BASE}/avatars`)).json() as any[];
    const claude = roster.find((e) => e.name === "claude");
    check("served verdict: accepted, value present, clip digest alongside",
      claude?.seat?.status === "accepted" && Math.abs(claude.seat.contactY - 0.2055) < 1e-9 && /^[0-9a-f]{64}$/.test(claude.seat.clipSha256 ?? ""),
      JSON.stringify(claude?.seat));
  }

  console.log("stale and unsupported are verdicts, not silence");
  {
    const store2 = new SeatStore(join(ROOT, "assets", "opt"), LIB);
    // aletheia's profile deliberately carries CLAUDE's avatar hash: the
    // moment it is judged against aletheia's actual bytes it must serve
    // stale — an accepted record can never outlive its bytes.
    store2.importProposal({ ...goodProfile, avatar: "aletheia" }, "lifecycle-test");
    store2.accept("aletheia", "sitchair", "receipt", "lifecycle-test");
    store2.importProposal({ avatar: "aporia", avatarSha256: await sha(join(LIB, "eidoverse/assets/vrms/aporia.vrm")),
      pose: "sitchair", unsupported: { refusal: "no humanoid mapping — no seat landmark derivable" }, review: { status: "proposed" } }, "lifecycle-test");
    const roster = await until(async () => {
      const r = await (await fetch(`${BASE}/avatars`)).json() as any[];
      return r.find((e) => e.name === "aletheia")?.seat?.status === "stale" ? r : null;
    }, 12000) as any[] | null;
    const aletheia = roster?.find((e) => e.name === "aletheia");
    const aporia = roster?.find((e) => e.name === "aporia");
    check("accepted-but-bytes-changed serves stale, naming which bytes", aletheia?.seat?.status === "stale" && aletheia?.seat?.which === "avatar", JSON.stringify(aletheia?.seat));
    check("stale withholds the number", aletheia?.seat?.contactY === undefined);
    check("an unsupported rig serves its refusal", aporia?.seat?.status === "unsupported" && /humanoid/.test(aporia?.seat?.refusal ?? ""), JSON.stringify(aporia?.seat));
  }

  console.log("dismount stamping unchanged (#18/#98 neighborhood)");
  {
    // The mechanism on main, byte-for-byte: a body dismount stamps the LOG
    // and clears the mount; the agent's own controller pos stays the
    // controller's ("dismount restores it" — agent.ts, pre-existing). The
    // profile correction must not have leaked into any of that.
    ag.verb("dismount", { id: "seatbot", pos: [2, 0, 2], yaw: 0 });
    const line = await until(() => { const l = ag!.look(); return !/seated on/.test(l) ? l : null; });
    check("dismount clears the seat and the controller's own truth returns, exactly as on main",
      !!line && /at \(0\.0, 0\.0\), ground height 0\.00m/.test(line ?? "") && !/seat approximate/.test(line ?? ""), line?.split("\n")[0]);
  }

} finally {
  try { ag?.close(); } catch { /* teardown */ }
  try { watcher?.close(); } catch { /* teardown */ }
  server.kill();
  await sleep(300);
  rmSync(SEATS_DIR, { recursive: true, force: true });
  if (seatsBacked) renameSync(SEATS_BAK, SEATS_DIR);
  if (tokensCreated) rmSync(TOKENS, { force: true });
  rmSync(WORLDS, { recursive: true, force: true });
}

console.log(fail ? `\n\x1b[31m${fail} failure(s), ${pass} passed\x1b[0m` : `\n\x1b[32mall ${pass} checks passed\x1b[0m`);
process.exit(fail ? 1 : 0);
