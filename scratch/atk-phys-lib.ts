// scratch/atk-phys-lib.ts — a wire client for the physics attack (modelled on tools/protocol/server-check.ts client()).
// @ts-nocheck
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function client(port, world, id, extra = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = []; const waiters = new Map(); let n = 0;
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world, id, avatar: "", replica: true, ...extra }));
  for (let i = 0; i < 100 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const c = {
    id, ws, msgs, snapshot: msgs.find((m) => m.type === "snapshot"), error: msgs.find((m) => m.type === "error"),
    req: (verb, args = {}, raw = null) => new Promise((res) => { const rid = `${id}-${++n}`; waiters.set(rid, res); ws.send(raw ?? JSON.stringify({ type: "request", id: rid, verb, args })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 8000); }),
    // send a request whose JSON text is hand-written (for -0, NaN etc. that JSON.stringify would erase)
    reqText: (text) => { const rid = `${id}-${++n}`; return new Promise((res) => { waiters.set(rid, res); ws.send(text.replace("__RID__", rid)); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 8000); }); },
    send: (m) => ws.send(JSON.stringify(m)),
    of: (type) => msgs.filter((m) => m.type === type),
    close: () => ws.close(),
  };
  return c;
}
export const show = (r) => (r?.ok ? `ok ${JSON.stringify({ ...r, ok: undefined }).slice(0, 220)}` : `REFUSED ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
export async function timed(fn) { const a = performance.now(); const r = await fn(); return { ms: +(performance.now() - a).toFixed(1), r }; }
/** arrive (teleport), then walk in <=3 m steps (TRACK: 6 m/s, 4 m cap); c.at tracks the authority's answer */
export async function arrive(c, spawn = [0, 0, 8]) { const r = await c.req("move", { to: spawn, teleport: true }); if (r.ok) c.at = r.at; else if (r.refused?.at) c.at = r.refused.at; return r; }
export async function walk(c, to, step = 3) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    const cur = c.at ?? [0, 0, 8]; const d = Math.hypot(to[0] - cur[0], to[2] - cur[2]);
    const f = d <= step ? 1 : step / d; const nxt = [cur[0] + (to[0] - cur[0]) * f, to[1], cur[2] + (to[2] - cur[2]) * f];
    last = await c.req("move", { to: nxt }); if (last.ok) c.at = last.at; else if (last.refused?.at) c.at = last.refused.at;
    if (!last.ok && last.refused?.code === "solid") { // sidestep 1.2 m perpendicular to the path and try again (at most 4 times)
      c.side = (c.side ?? 0) + 1; if (c.side > 4) return last; const dx = (to[0] - cur[0]) / (d || 1), dz = (to[2] - cur[2]) / (d || 1); const sgn = c.side % 2 ? 1 : -1; const side = [cur[0] - dz * 1.2 * sgn * c.side, to[1], cur[2] + dx * 1.2 * sgn * c.side];
      await sleep(400); const r = await c.req("move", { to: side }); if (r.ok) c.at = r.at; await sleep(700); continue; }
    if (!last.ok && last.refused?.code !== "too-fast") return last; if (last.ok && f === 1) return last; await sleep(700);
  }
  return last;
}
export async function settleAll(c, max = 80) { let w; for (let i = 0; i < max; i++) { await sleep(250); w = await c.req("wait", {}); if (!Object.keys(w.inFlight ?? {}).length) break; } return w; }
export async function transformOf(c, id) { const r = await c.req("inspect", { id }); return r?.components?.transform ?? null; }
import fs from "node:fs"; import path from "node:path";
export const procs = []; process.on("exit", () => { for (const p of procs) try { p.kill(); } catch {} });
export async function freePort(from) { for (let p = from; p < from + 200; p++) { const ok = await new Promise((res) => { try { const s = Bun.listen({ hostname: "127.0.0.1", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (ok) return p; } throw new Error("no free port"); }
/** copy the live worlds dir (gym + dotfiles) to dst */
export function copyWorlds(src, dst) { fs.rmSync(dst, { recursive: true, force: true }); fs.mkdirSync(dst, { recursive: true });
  for (const f of [".custody.json", ".directory.json"]) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  fs.cpSync(path.join(src, "gym"), path.join(dst, "gym"), { recursive: true }); return dst; }
export async function startServer(tree, worlds, logf, port) {
  port ??= await freePort(9100 + Math.floor(Math.random() * 200));
  const p = Bun.spawn(["bun", "server/server.ts"], { cwd: tree, env: { ...process.env, PORT: String(port), WORLDS_DIR: worlds, SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "", RELAY_STATE_DIR: (fs.mkdirSync(worlds + "/.relay", { recursive: true }), worlds + "/.relay") }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  procs.push(p);
  for (let i = 0; i < 120; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return { port, proc: p, log: logf }; } catch {} }
  throw new Error(`server didn't come up: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-800) : ""}`);
}
