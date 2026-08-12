// aux-binding-test.ts — B1 (#57 review): an aux leg binds to the primary's
// identity authority, or it does not attach. Same-display existence is
// presence, not authority. Real ws door, owned spawned server, scratch worlds.
//
// The impostor scenario this pins: anyone joining surface:"voice" under an
// unreserved human's name made every listener mark that person voiceCapable
// (hold latency on each of their says) and could send RTC stamped as them.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8600 + (process.pid % 150);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-auxbind-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  [" + extra + "]"}`);
  ok ? pass++ : fail++;
};

const server = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "" },
  stdout: "pipe", stderr: "pipe",
});

type Sock = { ws: WebSocket; seen: any[]; closed: Promise<{ code: number }> };
const dial = (joinMsg: Record<string, unknown>): Promise<Sock> => new Promise((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen: any[] = [];
  let closeRes: (v: { code: number }) => void;
  const closed = new Promise<{ code: number }>((r) => { closeRes = r; });
  const t = setTimeout(() => rej(new Error(`dial timeout for ${JSON.stringify(joinMsg)}`)), 8000);
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); seen.push(m);
    if (m.type === "snapshot" || m.type === "error") { clearTimeout(t); res({ ws, seen, closed }); } };
  ws.onclose = (ev) => { clearTimeout(t); closeRes({ code: ev.code });
    res({ ws, seen, closed }); };  // refused sockets may close before/without error frame
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: "commons", ...joinMsg }));
});

try {
  await sleep(2500);

  // A self-asserted human primary — the everyday case B1 protects.
  const rennet = await dial({ id: "rennet" });
  check("setup: self-asserted human primary joins embodied", rennet.seen.some((m) => m.type === "snapshot"),
    JSON.stringify(rennet.seen[0])?.slice(0, 80));

  // 1. IMPOSTOR: same display name, surface "voice", no credential of any kind.
  rennet.seen.length = 0;
  const impostor = await dial({ id: "rennet", surface: "voice" });
  await sleep(500);
  const gotError = impostor.seen.find((m) => m.type === "error");
  check("impostor aux (same display, no credential) is refused with a loud error",
    !!gotError && /credential|login/i.test(gotError.error ?? ""), JSON.stringify(impostor.seen[0])?.slice(0, 100));
  check("impostor aux socket is closed with the unbindable-aux code",
    (await Promise.race([impostor.closed, sleep(3000).then(() => ({ code: -1 }))])).code === 4009,
    "expected close 4009");
  check("the primary never sees a surface-transition for the impostor",
    !rennet.seen.some((m) => m.type === "surface-transition" && m.id === "rennet"),
    rennet.seen.map((m) => m.type).join(","));
  check("the primary never sees any capability signal from the impostor",
    !rennet.seen.some((m) => m.type === "rtc" || m.surface === "voice"),
    rennet.seen.map((m) => m.type).join(","));

  // 2. RESERVED AGENT, correctly bound: primary with the agent's own bearer,
  //    then an aux leg presenting the SAME bearer — accepted, transition seen.
  const agentPrimary = await dial({ id: "hesp2", agentToken: "surf-lab-hesp2" });
  check("setup: reserved agent primary joins with its bearer",
    agentPrimary.seen.some((m) => m.type === "snapshot"), JSON.stringify(agentPrimary.seen[0])?.slice(0, 80));
  agentPrimary.seen.length = 0; rennet.seen.length = 0;
  const agentAux = await dial({ id: "hesp2", surface: "voice", agentToken: "surf-lab-hesp2" });
  await sleep(500);
  check("correctly bound agent aux is ACCEPTED",
    agentAux.seen.some((m) => m.type === "snapshot"), JSON.stringify(agentAux.seen[0])?.slice(0, 100));
  check("witnesses see the genuine leg's surface-transition",
    rennet.seen.some((m) => m.type === "surface-transition" && m.id === "hesp2" && m.surface === "voice"),
    rennet.seen.map((m) => m.type).join(","));

  // 3. Binding is PER LEG: a verified primary does not bless a bare aux.
  const bareAux = await dial({ id: "hesp2", surface: "voice" });
  await sleep(300);
  check("aux without its own credential is refused even though a VERIFIED primary exists",
    bareAux.seen.some((m) => m.type === "error") || (await Promise.race([bareAux.closed, sleep(2000).then(() => ({ code: -1 }))])).code === 4009,
    JSON.stringify(bareAux.seen[0])?.slice(0, 80));

  // 4. Reserved-name protection still holds one level up (regression guard):
  //    an impostor cannot even land a PRIMARY under a reserved agent name.
  const namejack = await dial({ id: "hesp3" });
  check("reserved agent name still refuses an uncredentialed primary",
    namejack.seen.some((m) => m.type === "error" && /reserved/i.test(m.error ?? "")),
    JSON.stringify(namejack.seen[0])?.slice(0, 80));

  for (const s of [rennet, agentPrimary, agentAux]) s.ws.close();
} catch (e) {
  fail++;
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}`);
  for (const [label, stream] of [["out", server.stdout], ["err", server.stderr]] as const) {
    const text = await new Response(stream as ReadableStream).text().catch(() => "");
    if (text.trim()) console.log(`--- server ${label} (tail) ---\n${text.split("\n").slice(-15).join("\n")}`);
  }
} finally {
  server.kill();
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
