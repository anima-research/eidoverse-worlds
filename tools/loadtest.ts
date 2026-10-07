// Show-scale load harness: N synthetic performers + M spectators against a
// running sequencer. Measures what the audience will actually feel:
//   - join latency (ws open → snapshot), simultaneous-arrival burst
//   - stage-frame delivery rate, latency, and seq gaps per spectator
//   - chat-burst delivery completeness
//   - reconnect churn survival
//
//   bun tools/loadtest.ts                        # defaults: 24+176, 20s
//   PERFORMERS=24 SPECTATORS=176 DURATION_S=60 URL=ws://host:8940/ws TOKEN=… bun tools/loadtest.ts
//
// Exit 0 = all gates pass. Gates are printed at the end.
//
// The world must exist (a v4 world is founded by its operator: bun tools/protocol/world.ts found loadtest --owner <you>;
// joining never founds one). Every connection joins with v4fold (the world speaks protocol v4): chat is read from
// the snapshot's chat window (state.recentChat) and the v4-log stream's `say` entries, and a say is a door request.

const URL = process.env.URL ?? "ws://127.0.0.1:8940/ws";
const TOKEN = process.env.TOKEN ?? "";
const WORLD = process.env.WORLD ?? "loadtest";
const N_PERF = Number(process.env.PERFORMERS ?? 24);
const N_SPEC = Number(process.env.SPECTATORS ?? 176);
const DURATION = Number(process.env.DURATION_S ?? 20) * 1000;
const POSE_HZ = 15;
// AVATARS: comma-separated library paths; performers cycle through them. With
// real roster paths this doubles as a visual dress rehearsal (open a ?spectate
// client while it runs and watch a full stage of real bodies).
const AVATARS = (process.env.AVATARS ?? "x.vrm").split(",").map((s) => s.trim());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0;

type Spec = {
  ws: WebSocket; joinMs: number; frames: number; gaps: number; lastSeq: number;
  lat: number[]; says: Set<string>; openAt: number; snapAt: number;
};

function connect(id: string, spectate: boolean, n = 0): Promise<Spec> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const s: Spec = { ws, joinMs: -1, frames: 0, gaps: 0, lastSeq: -1, lat: [], says: new Set(), openAt: performance.now(), snapAt: 0 };
    const to = setTimeout(() => reject(new Error(`${id}: join timeout`)), 30_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: WORLD, id, avatar: AVATARS[n % AVATARS.length], spectate, token: TOKEN, v4fold: true }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.type === "snapshot") {
        s.snapAt = performance.now();
        s.joinMs = s.snapAt - s.openAt;
        // history counts: a late joiner gets earlier chat in the snapshot's chat window, not live
        for (const c of m.state?.recentChat ?? []) s.says.add(c.text);
        clearTimeout(to);
        resolve(s);
      } else if (m.type === "frame") {
        s.frames++;
        s.lat.push(Date.now() - m.t);
        if (s.lastSeq >= 0 && m.seq > s.lastSeq + 1) s.gaps += m.seq - s.lastSeq - 1;
        s.lastSeq = m.seq;
      } else if (m.type === "log") {
        for (const e of m.entries ?? []) if (e?.kind === "say") s.says.add(e.body?.text);
      } else if (m.type === "error") {
        clearTimeout(to);
        reject(new Error(`${id}: ${m.error}`));
      }
    };
    ws.onerror = () => { /* close follows */ };
  });
}

console.log(`loadtest → ${URL} world=${WORLD}: ${N_PERF} performers + ${N_SPEC} spectators, ${DURATION / 1000}s`);

// ---- simultaneous arrival burst (the pre-show doors moment) -----------------
const t0 = performance.now();
const all = await Promise.allSettled([
  ...Array.from({ length: N_PERF }, (_, i) => connect(`perf-${i}`, false, i)),
  ...Array.from({ length: N_SPEC }, (_, i) => connect(`spec-${i}`, true)),
]);
const ok = all.filter((r) => r.status === "fulfilled").map((r: any) => r.value as Spec);
const failed = all.length - ok.length;
const perfs = ok.slice(0, N_PERF - Math.min(failed, N_PERF));
const specs = ok.slice(perfs.length);
const joinTimes = ok.map((s) => s.joinMs);
console.log(`joined ${ok.length}/${all.length} in ${Math.round(performance.now() - t0)}ms — join p50 ${Math.round(pct(joinTimes, 50))}ms p95 ${Math.round(pct(joinTimes, 95))}ms max ${Math.round(Math.max(...joinTimes))}ms`);

// ---- performers move + speak ------------------------------------------------
let running = true;
const posesSent = { n: 0 };
const tickers = perfs.map((s, i) => setInterval(() => {
  if (!running || s.ws.readyState !== 1) return;
  const t = Date.now() / 1000 + i;
  s.ws.send(JSON.stringify({ type: "pose", pose: { p: [Math.sin(t * 0.5 + i) * 10, 0, Math.cos(t * 0.5 + i) * 10], yaw: t % (Math.PI * 2), speed: 1.4, clip: "walk" } }));
  posesSent.n++;
}, 1000 / POSE_HZ));

// chat burst mid-run: 24 messages in one second, all must arrive everywhere
const burstTexts = Array.from({ length: N_PERF }, (_, i) => `burst-${i}-${Math.floor(t0)}`);
setTimeout(() => {
  perfs.forEach((s, i) => { if (s.ws.readyState === 1 && burstTexts[i]) s.ws.send(JSON.stringify({ type: "request", id: `burst-${i}`, verb: "say", args: { text: burstTexts[i] } })); });
}, DURATION / 2);

// reconnect churn: 10 spectators drop and rejoin mid-run
setTimeout(async () => {
  for (let i = 0; i < Math.min(10, specs.length); i++) {
    const idx = specs.length - 1 - i;
    specs[idx].ws.close();
    try {
      const re = await connect(`spec-re-${i}`, true);
      specs[idx] = re; // replaces: fresh join must succeed under load
    } catch { specs[idx].joinMs = -2; }
  }
}, DURATION * 0.6);

await sleep(DURATION);
running = false;
tickers.forEach(clearInterval);
await sleep(500);

// ---- gates ------------------------------------------------------------------
const fail: string[] = [];
// rate over each spectator's own connected window (churn replacements joined late)
const endAt = performance.now();
const fpsPer = specs.map((s) => s.frames / Math.max(0.001, (endAt - s.snapAt - 500) / 1000));
const latAll = specs.flatMap((s) => s.lat);
const gapsTotal = specs.reduce((a, s) => a + s.gaps, 0);
const burstMisses = specs.filter((s) => burstTexts.filter((t) => t && !s.says.has(t)).length > 0).length;
const reconnFails = specs.filter((s) => s.joinMs === -2).length;

if (failed > 0) fail.push(`${failed} connections failed to join`);
if (pct(joinTimes, 95) > 3000) fail.push(`join p95 ${Math.round(pct(joinTimes, 95))}ms > 3000ms`);
if (pct(fpsPer, 50) < POSE_HZ * 0.8) fail.push(`median spectator frame rate ${pct(fpsPer, 50).toFixed(1)}/s < ${(POSE_HZ * 0.8).toFixed(0)}/s`);
if (pct(latAll, 95) > 250) fail.push(`frame latency p95 ${Math.round(pct(latAll, 95))}ms > 250ms`);
if (burstMisses > 0) fail.push(`${burstMisses} spectators missed chat-burst messages`);
if (reconnFails > 0) fail.push(`${reconnFails} reconnects failed under load`);

console.log(`
results
  poses sent          ${posesSent.n}
  spectator frame/s   p50 ${pct(fpsPer, 50).toFixed(1)}  min ${Math.min(...fpsPer).toFixed(1)}
  frame latency ms    p50 ${Math.round(pct(latAll, 50))}  p95 ${Math.round(pct(latAll, 95))}  max ${Math.round(Math.max(...latAll, 0))}
  frame seq gaps      ${gapsTotal} total across ${specs.length} spectators (backpressure drops)
  chat burst          ${specs.length - burstMisses}/${specs.length} spectators got all ${burstTexts.length}
  reconnect churn     ${10 - reconnFails}/10 ok
`);
console.log(fail.length ? `FAIL:\n  ${fail.join("\n  ")}` : "ALL GATES PASS");
for (const s of ok) s.ws.close();
process.exit(fail.length ? 1 : 0);
