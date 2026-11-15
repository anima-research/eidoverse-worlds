// join-canary — does the server admit a good key and refuse a bad one? Joins over /ws directly, no client code.
//   bun tools/operator/join-canary.mjs <http(s)-url, no trailing slash> <world> <good-key>
// Exits 0 only when the good key gets a snapshot AND a made-up key is closed 4003 (the half that catches auth wired open).
// (The browser paints the world name before the server answers, so a browser check can't tell. Trust this one.)
import { helloOf } from '../../shared/protocol/hello.js';
const [,, URL, WORLD, KEY] = process.argv;
if (!URL || !WORLD || !KEY) { console.error('usage: bun tools/operator/join-canary.mjs <http(s)-url> <world> <good-key>'); process.exit(2); }

const attempt = (key) => new Promise((resolve) => {
  const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/ws`);
  const seen = []; let over = false;
  const end = (r) => { if (over) return; over = true; clearTimeout(timer); try { ws.close(); } catch { /* gone */ } resolve({ ...r, seen }); };
  const timer = setTimeout(() => end({ verdict: 'no answer in 6 s' }), 6000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', hello: helloOf(), world: WORLD, id: 'canary', token: key, replica: true }));
  ws.onmessage = (e) => { const s = String(e.data); seen.push(s.slice(0, 120)); let m = null; try { m = JSON.parse(s); } catch { /* not JSON */ }
    if (m?.type === 'snapshot') end({ verdict: 'joined' }); };
  ws.onclose = (e) => end({ verdict: `closed ${e.code} ${e.reason || '-'}`, code: e.code });
  ws.onerror = () => {};
});

let failed = 0;
const report = (what, ok, r) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${r.verdict}${ok ? '' : `\n      server said: ${r.seen.join(' | ') || '(nothing)'}`}`); };
const good = await attempt(KEY);
report(`good key joins ${WORLD}`, good.verdict === 'joined', good);
const bad = await attempt(`${KEY}-not-the-key-${Math.random().toString(36).slice(2)}`);
report('a made-up key is refused 4003', bad.code === 4003, bad);
process.exit(failed ? 1 : 0);
