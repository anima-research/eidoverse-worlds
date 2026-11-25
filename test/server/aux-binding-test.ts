// aux-binding-test.ts — B1 (#57 review): an aux leg binds to the primary's
// identity authority, or it does not attach. Same-display existence is
// presence, not authority. Real ws door, owned spawned server, scratch worlds.
//
// The impostor scenario this pins: anyone joining surface:"voice" under an
// unreserved human's name made every listener mark that person voiceCapable
// (hold latency on each of their says) and could send RTC stamped as them.
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort, ROOT } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const PORT = freePort(8600);
const worldsDir = mkdtempSync(join(process.env.PROTOCOL_SCRATCH || tmpdir(), "eido-auxbind-"));
foundWorlds(worldsDir, ["commons"]);   // joining never founds a world

// The test OWNS its credential fixture: a scratch tokens.json reserving the
// agent names this test asserts on (hesp2, hesp3) and minting hesp2's bearer.
// The server reads it via AGENT_TOKENS_PATH, so the proof does not depend on —
// and cannot be contaminated by — whatever tokens.json sits in the checkout.
const tokensPath = join(worldsDir, "tokens.json");
writeFileSync(tokensPath, JSON.stringify({
  "surf-lab-hesp2": { id: "hesp2" },
  "surf-lab-hesp3": { id: "hesp3" },
}));

const S = suite("aux-binding");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

// process.execPath, not "bun": on Windows the PATH bun is a shim whose pid dies at once, orphaning the server
const CHILD_LOG = join(worldsDir, "server-output.txt");
const server = Bun.spawn([process.execPath, "run", "server/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", AGENT_TOKENS_PATH: tokensPath, SKIP_OPT_SWEEP: "1" },
  stdout: "pipe", stderr: "pipe",
});
for (const [stream, tag] of [[server.stdout, "out"], [server.stderr, "err"]] as const) {
  (async () => { for await (const chunk of stream) appendFileSync(CHILD_LOG, `[${tag}] ` + Buffer.from(chunk).toString()); })().catch(() => {});
}

type Sock = { ws: WebSocket; seen: any[]; code: number | null };
const dial = (joinMsg: Record<string, unknown>): Promise<Sock> => new Promise((res, rej) => {
  const s: Sock = { ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws`), seen: [], code: null };
  const t = setTimeout(() => rej(new Error(`dial timeout for ${JSON.stringify(joinMsg)}`)), 8000);
  s.ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); s.seen.push(m);
    if (m.type === "snapshot" || m.type === "error") { clearTimeout(t); res(s); } };
  s.ws.onclose = (ev) => { clearTimeout(t); s.code = ev.code; res(s); };  // refused sockets may close before/without error frame
  s.ws.onopen = () => s.ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", replica: true, ...joinMsg }));
});
const closedWith = async (s: Sock) => (await tryUntil("the socket closes", () => s.code !== null, { ms: 3000 })) ? s.code : -1;

try {
  if (!await tryUntil("the scratch server answers /avatars", async () => (await fetch(`http://127.0.0.1:${PORT}/avatars`)).ok, { ms: 30_000 })) throw new Error("scratch server never came up");

  // A self-asserted human primary — the everyday case B1 protects.
  const rennet = await dial({ id: "rennet" });
  check("setup: self-asserted human primary joins embodied", rennet.seen.some((m) => m.type === "snapshot"),
    JSON.stringify(rennet.seen[0])?.slice(0, 80));

  // 1. IMPOSTOR: same display name, surface "voice", no credential of any kind.
  rennet.seen.length = 0;
  const impostor = await dial({ id: "rennet", surface: "voice" });
  const gotError = await tryUntil("the impostor hears an error", () => impostor.seen.find((m) => m.type === "error"), { ms: 3000 });
  check("impostor aux (same display, no credential) is refused with a loud error",
    !!gotError && /credential|login/i.test(gotError.error ?? ""), JSON.stringify(impostor.seen[0])?.slice(0, 100));
  check("impostor aux socket is closed with the unbindable-aux code", await closedWith(impostor) === 4009, "expected close 4009");

  // 2. RESERVED AGENT, correctly bound: primary with the agent's own bearer,
  //    then an aux leg presenting the SAME bearer — accepted, transition seen.
  const agentPrimary = await dial({ id: "hesp2", agentToken: "surf-lab-hesp2" });
  check("setup: reserved agent primary joins with its bearer",
    agentPrimary.seen.some((m) => m.type === "snapshot"), JSON.stringify(agentPrimary.seen[0])?.slice(0, 80));
  // the barrier for the impostor's negatives: rennet's stream has reached hesp2's arrival, which came after it
  const heard = await tryUntil("rennet hears hesp2 arrive", () => rennet.seen.some((m) => JSON.stringify(m).includes('"hesp2"')), { ms: 5000 });
  check("the primary never sees a surface-transition for the impostor (read past hesp2's arrival)",
    heard && !rennet.seen.some((m) => m.type === "surface-transition" && m.id === "rennet"),
    rennet.seen.map((m) => m.type).join(","));
  check("the primary never sees any capability signal from the impostor",
    heard && !rennet.seen.some((m) => m.type === "rtc" || m.surface === "voice"),
    rennet.seen.map((m) => m.type).join(","));
  agentPrimary.seen.length = 0; rennet.seen.length = 0;
  const agentAux = await dial({ id: "hesp2", surface: "voice", agentToken: "surf-lab-hesp2" });
  check("correctly bound agent aux is ACCEPTED",
    agentAux.seen.some((m) => m.type === "snapshot"), JSON.stringify(agentAux.seen[0])?.slice(0, 100));
  check("witnesses see the genuine leg's surface-transition",
    await tryUntil("rennet sees hesp2's voice transition", () => rennet.seen.some((m) => m.type === "surface-transition" && m.id === "hesp2" && m.surface === "voice"), { ms: 3000 }),
    rennet.seen.map((m) => m.type).join(","));

  // 3. Binding is PER LEG: a verified primary does not bless a bare aux.
  const bareAux = await dial({ id: "hesp2", surface: "voice" });
  check("aux without its own credential is refused even though a VERIFIED primary exists",
    await tryUntil("the bare aux is refused", () => bareAux.seen.some((m) => m.type === "error") || bareAux.code === 4009, { ms: 3000 }),
    JSON.stringify(bareAux.seen[0])?.slice(0, 80));

  // 4. Reserved-name protection still holds one level up (regression guard):
  //    an impostor cannot even land a PRIMARY under a reserved agent name.
  const namejack = await dial({ id: "hesp3" });
  check("reserved agent name still refuses an uncredentialed primary",
    namejack.seen.some((m) => m.type === "error" && /reserved/i.test(m.error ?? "")),
    JSON.stringify(namejack.seen[0])?.slice(0, 80));

  // 5. The same account's second socket, refused at the fold check (an old client), never installed a body: its close
  //    must not announce the live body's leave, reap that body's aux legs, or drop what it holds
  rennet.seen.length = 0; agentAux.seen.length = 0;
  const oldTab = await dial({ id: "hesp2", agentToken: "surf-lab-hesp2", replica: false });
  check("setup: the same account's non-folding second socket is refused 4005",
    await closedWith(oldTab) === 4005 && oldTab.seen.some((m) => m.type === "error"), { code: oldTab.code, first: JSON.stringify(oldTab.seen[0])?.slice(0, 80) });
  // the barrier: a later arrival rennet hears. A leave from the refused socket's close would have come before it
  const later = await dial({ id: "latecomer" });
  const heardLater = await tryUntil("rennet hears the latecomer arrive", () => rennet.seen.some((m) => JSON.stringify(m).includes('"latecomer"')), { ms: 5000 });
  check("P1 the refused second socket's close announces no leave for the account's body, which is still here",
    heardLater && !rennet.seen.some((m) => m.type === "leave" && m.id === "hesp2"), rennet.seen.map((m) => `${m.type}:${m.id ?? ""}`).join(","));
  check("P1b ...and the body's primary and its voice leg stay open",
    agentPrimary.code === null && agentAux.code === null, { primary: agentPrimary.code, aux: agentAux.code });
  later.ws.close();

  for (const s of [rennet, agentPrimary, agentAux]) s.ws.close();
} catch (e) {
  check(`FATAL ${(e as Error).message}`, false);
  try { console.log(`--- server output (tail) ---\n${readFileSync(CHILD_LOG, "utf8").split("\n").slice(-15).join("\n")}`); } catch { /* none */ }
} finally {
  server.kill();
}
S.done();
