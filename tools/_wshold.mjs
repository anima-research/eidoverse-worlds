// Does a websocket SURVIVE through the tunnel, or just complete a handshake?
// The handshake check (101) has passed all day while sessions still died.
import WebSocket from 'ws';
const [,, URL, KEY] = process.argv;
const ws = new WebSocket(`${URL.replace('https','wss')}/ws?world=staging&key=${KEY}&name=holdtest`);
let opened = 0, msgs = 0;
const t0 = Date.now();
ws.on('open', () => { opened = Date.now(); console.log(`  open after ${opened - t0}ms`); });
ws.on('message', () => msgs++);
ws.on('close', (c, r) => { console.log(`  CLOSED after ${((Date.now()-opened)/1000).toFixed(1)}s alive — code=${c} reason=${r||'(none)'} msgs=${msgs}`); process.exit(0); });
ws.on('error', (e) => console.log(`  ERROR ${e.message}`));
setTimeout(() => { console.log(`  ✅ SURVIVED 60s — msgs=${msgs}`); ws.close(); }, 60000);
