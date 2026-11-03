// The report must survive missing subsystems and NAME the real failures.
function mkReport(win, doc) {
  const L=[]; const probe=(l,f)=>{ try{L.push(`${l}: ${f()}`);}catch(e){L.push(`${l}: unreadable (${e?.message??e})`);} };
  probe('transport', () => win.__voiceTransport ?? '(none — voice never initialised)');
  probe('mic', () => { const on = typeof win.__sfuMicOn==='function'?win.__sfuMicOn():null;
    return on===null?'unknown (no sfu bridge)':(on?'ON':'off'); });
  probe('ice', () => { const d = typeof win.relayDiag==='function'?win.relayDiag():null;
    return !d?'unknown (no diag)':`${d.iceConnectionState??'?'} / conn=${d.connectionState??'?'}`; });
  probe('playback', () => { const els=doc.audio; if(!els.length) return 'no <audio> elements yet';
    let p=0,q=0; for(const a of els)(a.paused?q++:p++);
    return `${els.length} element(s) — ${p} playing, ${q} PAUSED`+(q?'  ← tap the page to unlock':''); });
  return 'audio ▸ ' + L.join('  ·  ');
}
// 1. nothing initialised — must not throw
console.log('A:', mkReport({}, {audio:[]}));
// 2. this morning's ICE stall
console.log('B:', mkReport({__voiceTransport:'sfu', __sfuMicOn:()=>true,
  relayDiag:()=>({iceConnectionState:'checking',connectionState:'connecting'})}, {audio:[]}));
// 3. this morning's autoplay block
console.log('C:', mkReport({__voiceTransport:'sfu', __sfuMicOn:()=>true,
  relayDiag:()=>({iceConnectionState:'connected',connectionState:'connected'})},
  {audio:[{paused:true},{paused:true}]}));
// 4. a probe that throws must not kill the rest
console.log('D:', mkReport({get __voiceTransport(){throw new Error('boom');}}, {audio:[]}));
