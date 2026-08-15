// join-probe — does the SERVER admit this key? Protocol level, no browser.
//
// 🔴 Written 2026-08-15 after a browser harness told me a wrong key was being
// ADMITTED — reported to R as a possible auth bypass. It was not. The client
// paints the world name optimistically before the server answers, so a refused
// join still renders "rabscuttle @ staging"; and hud.js uses ● for BOTH live
// and retrying, separated only by a CSS class. Three harness rewrites chased
// that glyph. This talks to /ws directly and reads what the server SAYS:
//
//   good key → {"type":"snapshot",...}
//   bad key  → CLOSED code=4003 reason=bad token
//
// The server was correct the whole time. When a browser check and a protocol
// check disagree, the protocol check is the evidence.
//
//   node tools/join-probe.mjs <http(s)-url> <key>
// Talk to the world server DIRECTLY over ws — no client code, no localStorage.
const [,, URL, KEY] = process.argv;
const ws = new WebSocket(`${URL.replace(/^http/,'ws')}/ws`);
const out = [];
ws.onopen = () => ws.send(JSON.stringify({ type:'join', world:'staging', id:'probe', token: KEY }));
ws.onmessage = (e) => { const s=String(e.data).slice(0,120); out.push(s); if(out.length>=2) finish(); };
ws.onclose = (e) => { console.log(`  key=${JSON.stringify(KEY)} → CLOSED code=${e.code} reason=${e.reason||'-'}`); process.exit(0); };
const finish = () => { console.log(`  key=${JSON.stringify(KEY)} → ${out[0]}`); process.exit(0); };
setTimeout(finish, 6000);
