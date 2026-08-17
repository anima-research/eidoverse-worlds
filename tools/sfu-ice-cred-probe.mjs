// Does relay-cred actually carry iceServers to a browser? Ask the server.
const ws = new WebSocket('ws://127.0.0.1:8960/ws');
const done = (m) => { console.log(m); process.exit(0); };
setTimeout(() => done('TIMEOUT — no relay-cred in 12s'), 12000);
ws.onopen = () => ws.send(JSON.stringify({ type:'join', id:'icecheck', world:'staging', token:'dev' }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'joined' || m.type === 'snapshot') {
    ws.send(JSON.stringify({ type:'relay-cred', publish:true, subscribe:true }));
  }
  if (m.type === 'relay-cred') {
    console.log('  transport:', m.transport);
    console.log('  iceServers:', JSON.stringify(m.iceServers));
    done(Array.isArray(m.iceServers) && m.iceServers.length
      ? 'PASS — the browser receives a STUN server' : 'FAIL — field missing or empty');
  }
};
ws.onerror = (e) => done('WS ERROR ' + e.message);
