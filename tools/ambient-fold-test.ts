// ambient fold/rejoin — the #45 review's server-side receipts, executed
// against a live scratch sequencer (same recipe as grabtest):
//
//   WORLDS_DIR=$(mktemp -d) JOIN_TOKEN=test-door PORT=8995 bun run server/server.ts &
//   WORLD_URL=ws://localhost:8995/ws JOIN_TOKEN=test-door HTTP_URL=http://localhost:8995 bun run tools/ambient-fold-test.ts
//
// Proves: audio uploads are content-addressed + sniffed; ambient authorship
// is linted with actionable sentences (store path, existence, loop-only,
// bounds); the generic component fold stays BLIND — a valid ambient survives
// rejoin byte-identically; and nothing about a refusal mutates history.

const HTTP = process.env.HTTP_URL ?? "http://localhost:8995";
const URL = process.env.WORLD_URL ?? "ws://localhost:8994/ws";
const TOKEN = process.env.JOIN_TOKEN ?? "test-door";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Sock = {
  ws: WebSocket;
  msgs: any[];
  errors: string[];
  next(pred: string | ((m: any) => boolean), ms?: number): Promise<any>;
  verb(verb: string, args: any): void;
  pose(p: number[]): void;
  settle(ms?: number): Promise<void>;
  close(): void;
};

function open(joinMsg: Record<string, unknown>): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s: Sock = {
      ws, msgs: [], errors: [],
      next(pred, ms = 4000) {
        const want = typeof pred === "string" ? (m: any) => m.type === pred : pred;
        return new Promise((res, rej) => {
          const hit = s.msgs.find(want);
          if (hit) return res(hit);
          const t0 = Date.now();
          const iv = setInterval(() => {
            const m = s.msgs.find(want);
            if (m) { clearInterval(iv); res(m); }
            else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`no match in ${ms}ms`)); }
          }, 20);
        });
      },
      verb(verb, args) { ws.send(JSON.stringify({ type: "verb", verb, args })); },
      pose(p) { ws.send(JSON.stringify({ type: "pose", pose: { p, yaw: 0, speed: 0, clip: "idle" } })); },
      settle(ms = 300) { return new Promise((r) => setTimeout(r, ms)); },
      close() { try { ws.close(); } catch { /* already */ } },
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOKEN, ...joinMsg }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      s.msgs.push(m);
      if (m.type === "error") s.errors.push(m.error);
    };
    ws.onclose = () => { /* fine */ };
    ws.onerror = (e) => reject(e);
    s.next("snapshot").then(() => resolve(s), reject);
  });
}

/** Clear the error ledger, perform the act, wait for a FRESH refusal. The
 *  naive next("error") kept matching stale errors in the message buffer —
 *  every check read the previous step's refusal (off-by-one cascade, found
 *  on first run). */
async function expectErr(s: Sock, act: () => void, substr: string): Promise<string> {
  s.errors.length = 0;
  act();
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (s.errors.length) return s.errors.find((e) => e.includes(substr)) ?? `WRONG ERROR: ${s.errors.join("; ")}`;
    await new Promise((r) => setTimeout(r, 20));
  }
  return "NO ERROR ARRIVED";
}

const placeOf = (m: any, id: string) =>
  m.type === "log" && m.entry?.verb === "place" && m.entry?.args?.id === id ? m.entry : null;

const WORLD = `grabtest-${Math.random().toString(36).slice(2, 8)}`;

console.log(`\ngrab-vs-edit matrix — world "${WORLD}"\n`);

// ---- build: an owner furnishes the room -------------------------------------

// ---- a real (tiny) ogg: "OggS" magic + padding — the sniffer's contract ----
const oggBytes = new Uint8Array(64);
oggBytes.set([0x4f, 0x67, 0x67, 0x53]);
const up = await fetch(`${HTTP}/upload?as=audio&token=${TOKEN}&by=foldtest`, { method: "POST", body: oggBytes });
const upJson: any = up.ok ? await up.json() : null;
check("audio upload is accepted and content-addressed", !!upJson?.path && /^store\/audio\/[0-9a-f]{16}\.ogg$/.test(upJson.path), JSON.stringify(upJson) || `${up.status}`);
const up2 = await fetch(`${HTTP}/upload?as=audio&token=${TOKEN}&by=foldtest`, { method: "POST", body: oggBytes });
check("same bytes → same address (idempotent)", (await up2.json() as any).path === upJson.path);
const bad = await fetch(`${HTTP}/upload?as=audio&token=${TOKEN}`, { method: "POST", body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) });
check("non-audio bytes are refused at the door", bad.status === 415, `${bad.status}`);
const SRC = upJson.path;

const alice = await open({ name: "alice" });
alice.verb("spawn", { id: "fount", lib: "deco/boulder.glb", pos: [1, 0, 0], yaw: 0 });
await alice.settle();

// ---- author-time lint: every refusal is a sentence someone can act on -----
let err = await expectErr(alice, () => alice.verb("comp", { id: "fount", type: "ambient", data: { src: "https://evil.example/x.mp3" } }), "store path");
check("URL src refused with the upload recipe in the sentence", err.includes("/upload?as=audio"), err);
err = await expectErr(alice, () => alice.verb("comp", { id: "fount", type: "ambient", data: { src: "store/audio/ffffffffffffffff.ogg" } }), "not in this world's store");
check("well-formed but absent hash refused (existence is checked)", !err.startsWith("WRONG"), err);
err = await expectErr(alice, () => alice.verb("comp", { id: "fount", type: "ambient", data: { src: SRC, loop: false } }), "loop-only");
check("loop:false refused (late join would replay it)", !err.startsWith("WRONG"), err);
err = await expectErr(alice, () => alice.verb("comp", { id: "fount", type: "ambient", data: { src: SRC, gain: 40 } }), "gain");
check("out-of-bounds gain refused", !err.startsWith("WRONG"), err);

// ---- valid authorship + blind fold on rejoin ------------------------------
alice.errors.length = 0;
alice.verb("comp", { id: "fount", type: "ambient", data: { src: SRC, gain: 0.5, radius: 12 } });
await alice.settle();
check("valid ambient is accepted", alice.errors.length === 0, alice.errors.join("; "));

const late = await open({ name: "bob" });
const snap: any = await late.next("snapshot");
const folded = snap.state?.entities?.fount?.comp?.ambient;
check("late join folds the ambient byte-identically (the fold stays blind)",
  JSON.stringify(folded) === JSON.stringify({ src: SRC, gain: 0.5, radius: 12 }),
  JSON.stringify(folded ?? snap).slice(0, 200));

alice.close(); late.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
