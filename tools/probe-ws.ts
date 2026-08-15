// End-to-end over the REAL websocket verbs against a running server.
const BASE = "ws://127.0.0.1:8947";
const WORLD = "staging";

function conn(id: string) {
  const ws = new WebSocket(`${BASE}/w/${WORLD}`);
  const msgs: any[] = [];
  ws.addEventListener("message", (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch {} });
  return { ws, msgs, id,
    send: (o: any) => ws.send(JSON.stringify(o)),
    open: () => new Promise<void>((r) => ws.readyState === 1 ? r() : ws.addEventListener("open", () => r())),
    wait: (t: string, ms = 4000) => new Promise<any>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = msgs.find((m) => m.type === t);
        if (m) { clearInterval(iv); res(m); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout ${t} for ${id}; got ${msgs.map(m=>m.type).join(",")}`)); }
      }, 50);
    }),
  };
}
const diag = async () => (await fetch(`http://127.0.0.1:8947/relay-diag?world=${WORLD}`)).json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = conn("spk"), B = conn("lis");
await A.open(); await B.open();
A.send({ type: "join", id: "spk", name: "spk" });
B.send({ type: "join", id: "lis", name: "lis" });
await sleep(600);
console.log("joined. A saw:", A.msgs.map(m=>m.type).join(","));

A.send({ type: "relay-cred" });
B.send({ type: "relay-cred" });
const ca = await A.wait("relay-cred"); const cb = await B.wait("relay-cred");
console.log("cred A:", ca.identity, "cred B:", cb.identity);

B.send({ type: "voice-consent", recv: true });
const c1 = await B.wait("voice-consent");
console.log("consent ON ->", JSON.stringify(c1));
await sleep(300);
let d: any = await diag();
console.log("diag after consent ON:", JSON.stringify(d.legs?.map((l:any)=>({id:l.id,gen:l.gen,hears:l.hears,pending:l.pendingRoutes}))));

// ── THE RECONNECT: listener's voice leg restarts. Same websocket/primary gen,
// new mediaGen. No new consent is ever stated.
B.msgs.length = 0;
B.send({ type: "relay-cred" });
const cb2 = await B.wait("relay-cred");
console.log("cred B after voice-leg reconnect:", cb2.identity, "(was", cb.identity + ")");
await sleep(400);
d = await diag();
console.log("diag AFTER reconnect:", JSON.stringify(d.legs?.map((l:any)=>({id:l.id,gen:l.gen,hears:l.hears,pending:l.pendingRoutes}))));
console.log("\n>>> If lis has a route to spk here with NO consent restated, the reconnect resurrected consent.");
process.exit(0);
