// @ts-nocheck
const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT ?? 8985}/ws`);
ws.onopen = () => { console.log("open"); ws.send(JSON.stringify({ type: "join", world: "gym", id: "atk-phys-j", avatar: "", replica: true })); };
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); console.log("msg", m.type, String(ev.data).length, JSON.stringify(m).slice(0, 200)); };
ws.onerror = (e) => console.log("err", e.message);
ws.onclose = (e) => console.log("close", e.code, e.reason);
setTimeout(() => process.exit(0), 6000);
