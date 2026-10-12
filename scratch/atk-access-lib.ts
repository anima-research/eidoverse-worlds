// ACCESS attack harness — wire client for the live gym. @ts-nocheck
const PORT = Number(process.env.ATK_PORT || 8985);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function sock() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = []; let n = 0; const waiters = new Map(); let closed = null;
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
    msgs.push(m); if (m.type === "reply") waiters.get(m.id)?.(m.reply); };
  ws.onclose = (e) => { closed = e.code; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return {
    msgs, get closed() { return closed; },
    async join(world, id, extra = {}) { const k = msgs.length;
      ws.send(JSON.stringify({ type: "join", world, id, avatar: "", replica: true, ...extra }));
      for (let i = 0; i < 80; i++) { if (msgs.slice(k).some((m) => m.type === "snapshot" || m.type === "error") || closed != null) break; await sleep(50); }
      await sleep(60);
      return { snapshot: msgs.slice(k).find((m) => m.type === "snapshot"),
               errors: msgs.slice(k).filter((m) => m.type === "error").map((m) => m.error) }; },
    req: (verb, args = {}) => new Promise((res) => { const id = `r${++n}`; waiters.set(id, res);
      ws.send(JSON.stringify({ type: "request", id, verb, args })); setTimeout(() => res({ ok: false, timeout: true }), 5000); }),
    raw: (m) => ws.send(JSON.stringify(m)),
    close: () => { try { ws.close(); } catch {} },
  };
}
export const show = (r) => r?.timeout ? "TIMEOUT" : r?.ok === true ? "ok" + (r.notes?.length?` ${JSON.stringify(r.notes).slice(0,80)}`:"") : r?.ok === false ? `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0,80)}` : JSON.stringify(r).slice(0,120);
