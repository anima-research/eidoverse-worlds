/**
 * seat-lifecycle-test — #101's load-bearing integration matrix: a REAL
 * scratch sequencer and a REAL WorldAgent, no injected math anywhere.
 *
 * What must be true end-to-end (design round, B4/B5 + #105 review): the
 * server judges profiles against current bytes and serves one verdict;
 * proposals need a NAMED actor and a rostered subject, and dangerous keys
 * bounce whole; countersign is an operator write against a reviewed
 * revision; and the headless client receives the same profile revision
 * through its actual delivery path — httpBase fetch at join plus the two
 * update events, invalidation landing the moment an event does — until its
 * own look() says the corrected seat (or the declared approximation) out
 * loud.
 *
 * Door ownership (#105 review): the port is preflighted free, the child's
 * stdout/stderr are preserved and printed on failure, and our child must
 * itself log that it serves this port — a listener that answers without
 * that line in our child's output is somebody else's door, and the test
 * dies rather than inspect it.
 *
 * Run: bun run test/server/seat-lifecycle-test.ts
 * (scratch WORLDS_DIR, OPT_DIR and AGENT_TOKENS_PATH in one tmpdir: nothing in the repo is touched)
 */

import { mkdtempSync, existsSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorldAgent } from "../../mcpl/agent.ts";
import { SeatStore } from "../../server/seats.ts";
import { HANDLERS } from "../../mcpl/tools.ts";
import { foundWorlds, freePort, scratchState } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { until, tryUntil, WAIT_SCALE } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
const DOOR = "test-door";

const { check, done } = suite("seat-lifecycle");
const sha = async (path: string) => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
// ---- the door is OURS or the test is over -----------------------------------
const PORT = freePort(21000);
const BASE = `http://127.0.0.1:${PORT}`;
try { await fetch(`${BASE}/avatars`); throw new Error(`port ${PORT} answered before our child started — refusing to run`); }
catch (e: any) {
  const s = `${String(e)} ${e?.code ?? ""} ${e?.message ?? ""}`;
  if (!/fetch failed|refused|unable to connect|ECONN/i.test(s)) throw e;
}

// ---- everything this run writes lives in one scratch dir ---------------------
const SCRATCH = mkdtempSync(join(process.env.PROTOCOL_SCRATCH ?? tmpdir(), "seatlife-"));
const WORLDS = join(SCRATCH, "worlds"), OPT = join(SCRATCH, "opt"), TOKENS = join(SCRATCH, "tokens.json");
const PATCH = join(ROOT, "patched");
const SEATPROBE_VRM = join(OPT, "eidoverse", "assets", "vrms", "seatprobe.vrm");
const namedToken = "seat-lifecycle-test-bearer";
writeFileSync(TOKENS, JSON.stringify({ [namedToken]: { id: "seatbot" } }));
const opStore = () => new SeatStore(OPT, LIB, {}, { patchDir: PATCH });   // the operator's hand on the server's store
// the world exists before anyone joins (joining never founds one), founded by seatbot's enrolment: it builds the crate as the owner
foundWorlds(WORLDS, ["seatlab"], "agent:token:seatbot");
const CHILD_LOG = join(SCRATCH, "server-output.txt");
// process.execPath, not "bun": the PATH "bun" is an npm .cmd shim on Windows
// whose pid dies immediately, orphaning the real sequencer on this port where
// it poisons the next run.
const server = Bun.spawn([process.execPath, "run", "server/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, WORLDS_DIR: WORLDS, JOIN_TOKEN: DOOR, PORT: String(PORT), EIDOVERSE_DIR: LIB, ...scratchState(OPT), PATCH_DIR: PATCH, AGENT_TOKENS_PATH: TOKENS, TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1" },
  stdout: "pipe", stderr: "pipe",
});
// preserve the child's own words — a startup crash must be readable, not mute
for (const [stream, tag] of [[server.stdout, "out"], [server.stderr, "err"]] as const) {
  (async () => { for await (const chunk of stream) appendFileSync(CHILD_LOG, `[${tag}] ` + Buffer.from(chunk).toString()); })().catch(() => {});
}
const bail = (why: string): never => {
  console.error(`\nFATAL: ${why}\n--- child output ---`);
  try { console.error(Bun.file(CHILD_LOG).size ? require("node:fs").readFileSync(CHILD_LOG, "utf8").slice(-3000) : "(none)"); } catch { /* none */ }
  server.kill(); rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(2);
};

let ag: WorldAgent | null = null;
let probeAg: WorldAgent | null = null;
let watcher: WebSocket | null = null;
const watcherEvents: any[] = [];

try {
  if (!await tryUntil("the scratch server answers /avatars", async () => (await fetch(`${BASE}/avatars`)).ok, { ms: 30_000 })) bail("scratch server never came up");

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

  // a watcher client hears the broadcasts every consumer relies on; the
  // door-ownership proof follows its join
  watcher = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  await new Promise<void>((res, rej) => {
    watcher!.onopen = () => { watcher!.send(JSON.stringify({ type: "join", hello: helloOf(), world: "seatlab", id: "watcher", token: DOOR, replica: true })); res(); };
    watcher!.onerror = () => rej(new Error("watcher ws failed"));
  });
  watcher.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.type === "avatar-profile-updated") watcherEvents.push(m); } catch { /* not ours */ } };
  // the world dir is founded before the child starts, so only the child's own words prove the door is ours
  const owned = await tryUntil("our child says it serves this port", () => existsSync(CHILD_LOG) && new RegExp(`sequencer on http://\\S+:${PORT}\\b`).test(require("node:fs").readFileSync(CHILD_LOG, "utf8")), { ms: 6000 });
  if (!owned || server.exitCode !== null) bail(`our child did not say it serves :${PORT} (or exited) — the listener there is not ours`);
  check("door ownership: our child logged it serves this port, and is still running", true);

  console.log("write authority (B4) + dangerous keys (#105 B2)");
  const claudeSha = await sha(join(LIB, "eidoverse/assets/vrms/claude.vrm"));
  // The clip sha must be taken from the SAME ladder the store judges against
  // (patched fork first — seats.ts's clipBases, the order /library serves):
  // hashing the library's copy directly reads "stale (clip bytes changed)"
  // whenever a patched clip exists.
  const clipRel = "eidoverse/assets/animations/sitting_normal_chair.vrma";
  const clipFile = [PATCH, OPT, LIB]
    .map((d) => join(d, clipRel)).find((p) => existsSync(p))!;
  const clipSha = await sha(clipFile);
  const mkProfile = (avatar: string, avatarSha256: string, extra: Record<string, unknown> = {}) => ({
    avatar, avatarSha256, pose: "sitchair", clipSha256: clipSha,
    seatContactY: 0.2055,
    derivation: { toolVersion: "seatlab-4", method: "skinned-pelvis-contact-v1",
      winner: { mesh: "Body", vertexIndex: 4417, rootLocal: [-0.012, 0.2055, 0.031] },
      supportPatch: { count: 214, spreadY: 0.0031, radiusXZ: 0.1 }, runs: 3, deterministic: true },
    review: { status: "proposed" }, ...extra,
  });
  const goodProfile = mkProfile("claude", claudeSha);
  {
    const anon = await fetch(`${BASE}/seat-profile?token=${DOOR}`, { method: "POST", body: JSON.stringify(goodProfile) });
    check("the anonymous door token cannot propose (401)", anon.status === 401, `${anon.status}`);
    const none = await fetch(`${BASE}/seat-profile`, { method: "POST", body: JSON.stringify(goodProfile) });
    check("no token cannot propose (401)", none.status === 401, `${none.status}`);
  }
  {
    const revBefore = (await fetch(`${BASE}/avatars`)).headers.get("x-profiles-rev");
    for (const badName of ["__proto__", "constructor", "prototype"]) {
      const r = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify(mkProfile(badName, claudeSha)) });
      check(`real door: avatar "${badName}" bounces with a 4xx`, r.status >= 400 && r.status < 500, `${r.status}`);
    }
    const unknown = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify(mkProfile("no-such-avatar", claudeSha)) });
    check("real door: unrostered avatar bounces (404)", unknown.status === 404, `${unknown.status}`);
    const pose = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify({ ...goodProfile, pose: "sitground" }) });
    check("real door: pose outside the slice bounces (422)", pose.status === 422, `${pose.status}`);
    const revAfter = (await fetch(`${BASE}/avatars`)).headers.get("x-profiles-rev");
    check("refused writes moved nothing (rev unchanged, no events)", revAfter === revBefore && watcherEvents.length === 0, `rev ${revBefore}→${revAfter}`);
  }

  console.log("proposal");
  {
    const bad = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify({ nonsense: true }) });
    check("a malformed proposal is refused with a named reason (422)", bad.status === 422, `${bad.status}: ${await bad.text()}`);
    const bearer = await fetch(`${BASE}/seat-profile`, { method: "POST", headers: { authorization: `Bearer ${namedToken}` }, body: JSON.stringify({ nonsense: true }) });
    check("the named actor by Authorization: Bearer reaches the proposal check (422, not 401)", bearer.status === 422, `${bearer.status}`);
    const sneaky = await fetch(`${BASE}/seat-profile?token=${namedToken}`,
      { method: "POST", body: JSON.stringify({ ...goodProfile, review: { status: "accepted", receipt: "x", by: "me" } }) });
    check("this door writes proposals ONLY — accepted is refused (403)", sneaky.status === 403, `${sneaky.status}`);
    const ok = await fetch(`${BASE}/seat-profile?token=${namedToken}`, { method: "POST", body: JSON.stringify(goodProfile) });
    const body = await ok.json().catch(() => null);
    check("a named actor's valid proposal lands", ok.status === 200 && body?.status === "proposed", `${ok.status} ${JSON.stringify(body)}`);
    const ev = await tryUntil("the claude profile broadcast", () => watcherEvents.find((e) => e.name === "claude"));
    check("avatar-profile-updated broadcast reaches connected clients, rev-bearing", !!ev && Number.isFinite(ev.rev), JSON.stringify(watcherEvents));
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
    avatar: "eidoverse/assets/vrms/claude.vrm", agentToken: namedToken });
  await ag.connect();
  // the suite's names ride as placeholders (and the crate is labelled crate1: the tools take a label as an id)
  const { idAliases } = await import("../harness/idalias.ts"); const IDS = idAliases();
  const areq = async (verb: string, args: any) => IDS.back(await ag!.request(verb, IDS.out(verb, args)));
  // building is door requests (the agent waits for each answer); sitting is presence (the sit tool, nothing logged)
  // the crate stands 2 m off the spawn at (0, 0): over it, a dismount would be pushed out of the crate, not back on its own track
  const built = await areq("create", { id: "crate1", model: "eidoverse/assets/models/crate_large_blue.glb", components: { transform: { pos: [0, 0, 2] }, label: "crate1" } });
  check("seatbot (the owner) builds the crate through the door", built?.ok === true, JSON.stringify(built?.refused ?? built));
  // a seat is a socket child of the host with a station ({action, anim, anchor}) (G4-187: the old `sockets` component is
  // refused); the legacy seat's station authors no support plane
  const { addSocket } = await import("../../shared/requests.js");
  const mkSeat = (name: string, anchor?: "surface") => { const o = addSocket(IDS.of("crate1"), { name }, { pos: [0, 1, 0], station: { action: "sit", anim: "sitchair", ...(anchor ? { anchor } : {}) } }); return areq(o.verb, o.args); };
  const legacy = await mkSeat("seatL");
  check("…and gives it a (legacy) seat", legacy?.ok === true, JSON.stringify(legacy?.refused ?? legacy));
  // the seat-profile correction keys on a seat that authors its support plane: its body anchors at the surface
  // (D14: station.anchor 'surface', one enum; shared/seatcore.js socketAnchor).
  // (two of them: one body per socket, and seatbot is still on seatS when probebot sits below)
  const surface = [await mkSeat("seatS", "surface"), await mkSeat("seatS2", "surface")];
  check("…and a seat that authors its support plane (station.anchor: surface)", surface.every((r) => r?.ok === true), JSON.stringify(surface.map((r) => r?.refused ?? r?.ok)));
  // the agent attaches by what it sees: wait until its view of crate1 carries all three sockets
  const seesSeats = (a: WorldAgent) => [...a.entities.entries()].some(([id, e]: [string, any]) => e.label === "crate1" && a.socketsOf(id).length === 3);
  await until("seatbot sees crate1's three seats", () => seesSeats(ag!));

  await HANDLERS.attach(ag as any, { to: "crate1", socket: "seatL" }, {} as any, "attach");
  {
    const line = await tryUntil("seatbot seated on crate1", () => { const l = ag!.look(); return /seated on crate1/.test(l) ? l : null; });
    check("legacy socket: seated, byte-identical composition (y = socket)", !!line && /ground height 1\.00m/.test(line ?? ""), line?.split("\n")[0]);
    check("legacy socket: declared, never silent", /seat approximate: legacy socket/.test(line ?? ""), line?.split("\n")[0]);
  }

  await HANDLERS.detach(ag as any, {}, {} as any, "detach");   // get off
  await until("seatbot off the legacy seat", () => !/seated on/.test(ag!.look().split("\n")[0]));
  await HANDLERS.attach(ag as any, { to: "crate1", socket: "seatS" }, {} as any, "attach");
  {
    const line = await tryUntil("seatbot seated on crate1", () => { const l = ag!.look(); return /seated on crate1/.test(l) ? l : null; });
    check("surface socket + proposed profile: still approximate, reason names the countersign",
      /seat approximate: profile proposed — not countersigned/.test(line ?? ""), line?.split("\n")[0]);
  }

  console.log("countersign (operator-only, no HTTP path, reviewed revision)");
  {
    const store2 = opStore();
    const wrongRev = store2.accept("claude", "sitchair", "receipt", "op", store2.rev + 7);
    check("countersign against an unreviewed revision refuses", wrongRev.ok === false && /re-list/.test((wrongRev as any).why));
    const r = store2.accept("claude", "sitchair", "https://github.com/anima-research/eidoverse-worlds/issues/101#lifecycle", "lifecycle-test", store2.rev);
    check("operator accept at the reviewed revision succeeds", r.ok === true, JSON.stringify(r));
    const evs = watcherEvents.length;
    const line = await tryUntil("seatbot's seat corrects to 0.79", () => { const l = ag!.look(); return /ground height 0\.79m/.test(l) ? l : null; }, { ms: 12000 });
    check("the agent's seat corrects IN PLACE on the push — contact plane onto the socket plane (1 − 0.2055 → 0.79)",
      !!line, ag!.look().split("\n")[0]);
    check("…and the approximation is gone from the line", !!line && !/seat approximate/.test(line ?? ""), line?.split("\n")[0]);
    const ev = await tryUntil("the acceptance broadcast", () => watcherEvents.length > evs);
    check("acceptance announced to every connected client", !!ev, `events=${watcherEvents.length}`);
    const roster = await (await fetch(`${BASE}/avatars`)).json() as any[];
    const claude = roster.find((e) => e.name === "claude");
    check("served verdict: accepted, value present, clip digest alongside",
      claude?.seat?.status === "accepted" && Math.abs(claude.seat.contactY - 0.2055) < 1e-9 && /^[0-9a-f]{64}$/.test(claude.seat.clipSha256 ?? ""),
      JSON.stringify(claude?.seat));
  }

  console.log("live invalidation through the real door (#105 B1)");
  {
    // a disposable avatar whose BYTES this test owns: upload it, profile it,
    // seat a real agent on it, then change the bytes out from under it
    const claudeBytes = new Uint8Array(await Bun.file(join(LIB, "eidoverse/assets/vrms/claude.vrm")).arrayBuffer());
    const up = await fetch(`${BASE}/upload?as=avatar&name=seatprobe&token=${DOOR}`, { method: "POST", body: claudeBytes });
    check("seatprobe avatar uploaded to the scratch overlay", up.status === 200, `${up.status}`);
    const store2 = opStore();
    const probeSha = await sha(SEATPROBE_VRM);
    const pr = store2.importProposal(mkProfile("seatprobe", probeSha), "lifecycle-test");
    const ac = pr.ok ? store2.accept("seatprobe", "sitchair", "receipt", "lifecycle-test", store2.rev) : pr;
    check("seatprobe profile proposed + countersigned", pr.ok === true && ac.ok === true, JSON.stringify({ pr, ac }));

    probeAg = new WorldAgent({ url: `ws://127.0.0.1:${PORT}/ws`, name: "probebot", world: "seatlab",
      avatar: "eidoverse/assets/vrms/seatprobe.vrm" });
    await probeAg.connect();
    await until("probebot sees crate1's three seats", () => seesSeats(probeAg!));
    await HANDLERS.attach(probeAg as any, { to: "crate1", socket: "seatS2" }, {} as any, "attach");
    const seated = await tryUntil("probebot seated at 0.79", () => { const l = probeAg!.look(); return /ground height 0\.79m/.test(l) ? l : null; }, { ms: 12000 });
    check("probebot seats corrected under its accepted profile", !!seated, probeAg.look().split("\n")[0]);

    // now the bytes change: valid GLB magic, different sha
    const mutated = new Uint8Array(claudeBytes.length + 1);
    mutated.set(claudeBytes); mutated[claudeBytes.length] = 0x00;
    const re = await fetch(`${BASE}/upload?as=avatar&name=seatprobe&token=${DOOR}`, { method: "POST", body: mutated });
    check("seatprobe bytes re-uploaded (avatar-updated fires)", re.status === 200, `${re.status}`);
    // the event is sent before the upload answers (server/upload.ts), and its receipt demotes the verdict to pending at
    // once: so a short bound, not the refetch's 12 s (G6-132)
    const t0 = performance.now();
    const line = await tryUntil("probebot's correction stops", () => { const l = probeAg!.look(); return /seat approximate: profile (update pending|stale \(avatar bytes changed\))/.test(l) ? l : null; }, { ms: 1500, step: 20 });
    // the bound is the row's own: tryUntil returns a poll that STARTED before its deadline, however late it ends (wait.ts)
    const took = performance.now() - t0, bound = 1500 * WAIT_SCALE;
    check("the correction STOPS when the event lands (within 1.5 s of the upload's answer): the look says pending or stale",
      !!line && took <= bound, `${Math.round(took)} ms (bound ${bound}): ${probeAg.look().split("\n")[0]}`);
    const roster = await (await fetch(`${BASE}/avatars`)).json() as any[];
    const probeSeat = roster.find((e) => e.name === "seatprobe")?.seat;
    check("served verdict for seatprobe: stale, naming which bytes", probeSeat?.status === "stale" && probeSeat?.which === "avatar", JSON.stringify(probeSeat));
  }

  console.log("stale and unsupported are verdicts, not silence");
  {
    const store2 = opStore();
    // aletheia's profile deliberately carries CLAUDE's avatar hash: judged
    // against aletheia's actual bytes it must serve stale — an accepted
    // record can never outlive its bytes.
    const p1 = store2.importProposal(mkProfile("aletheia", claudeSha), "lifecycle-test");
    const a1 = p1.ok ? store2.accept("aletheia", "sitchair", "receipt", "lifecycle-test", store2.rev) : p1;
    const p2 = store2.importProposal({ avatar: "aporia", avatarSha256: await sha(join(LIB, "eidoverse/assets/vrms/aporia.vrm")),
      pose: "sitchair", unsupported: { refusal: "no humanoid mapping — no seat landmark derivable" }, review: { status: "proposed" } }, "lifecycle-test");
    check("stale/unsupported fixtures installed", p1.ok === true && a1.ok === true && p2.ok === true, JSON.stringify({ p1, a1, p2 }));
    const roster = await tryUntil("aletheia serves stale", async () => {
      const r = await (await fetch(`${BASE}/avatars`)).json() as any[];
      return r.find((e) => e.name === "aletheia")?.seat?.status === "stale" ? r : null;
    }, { ms: 12000 }) as any[] | undefined;
    const aletheia = roster?.find((e) => e.name === "aletheia");
    const aporia = roster?.find((e) => e.name === "aporia");
    check("accepted-but-bytes-changed serves stale, naming which bytes", aletheia?.seat?.status === "stale" && aletheia?.seat?.which === "avatar", JSON.stringify(aletheia?.seat));
    check("stale withholds the number", aletheia?.seat?.contactY === undefined);
    check("an unsupported rig serves its refusal", aporia?.seat?.status === "unsupported" && /humanoid/.test(aporia?.seat?.refusal ?? ""), JSON.stringify(aporia?.seat));
  }

  console.log("dismount: a detach of my own (the authority's let-go, vacated.at, is r10-check's)");
  {
    await HANDLERS.detach(ag as any, {}, {} as any, "detach");
    // the check reads the HEADER line only: probebot is still seated nearby,
    // legitimately declaring its stale seat in the People section
    const header = await tryUntil("seatbot off its seat", () => { const h = ag!.look().split("\n")[0]; return !/seated on/.test(h) ? h : null; });
    check("dismount clears the seat and its correction: the header is my own track again (no `at` moved me)",
      !!header && /at \(0\.0, 0\.0\), ground height 0\.00m/.test(header ?? "") && !/seat approximate/.test(header ?? ""), header ?? "");
  }

} finally {
  try { ag?.close(); } catch { /* teardown */ }
  try { probeAg?.close(); } catch { /* teardown */ }
  try { watcher?.close(); } catch { /* teardown */ }
  server.kill();
  await server.exited;
  rmSync(SCRATCH, { recursive: true, force: true });
}

done();
