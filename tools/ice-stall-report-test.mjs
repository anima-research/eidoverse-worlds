// Does the stall reporter actually FIRE? Simulate a pc that never leaves
// 'checking' — the exact phone case — and one that connects.
const mk = (states) => {
  let i = 0, handler = null;
  const pc = { iceConnectionState: states[0],
               set oniceconnectionstatechange(h) { handler = h; },
               get oniceconnectionstatechange() { return handler; } };
  return { pc, step: () => { if (++i < states.length) { pc.iceConnectionState = states[i]; handler?.(); } } };
};
const errs = [], chats = [];
const console2 = { error: (...a) => errs.push(a.join(' ')), info: () => {} };
const logChat2 = (_, t) => chats.push(t);

function install(pc, sawNonHost) {
  let timer = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'checking') { clear(); timer = setTimeout(() => {
      if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') {
        console2.error('[voice] ICE STALLED' + (!sawNonHost ? ' host-only' : ''));
        logChat2('*', 'voice: no media path');
      }}, 50); }
    else if (st === 'connected' || st === 'completed') { clear(); }
    else if (st === 'failed') { clear(); console2.error('[voice] ICE FAILED'); logChat2('*','voice: failed'); }
  };
}
// A: phone case — checking, stays there
const a = mk(['new','checking']); install(a.pc, false); a.step();
// B: healthy — checking then connected
const b = mk(['new','checking','connected']); install(b.pc, true); b.step(); b.step();
await new Promise(r => setTimeout(r, 150));
console.log('stall reports:', errs.length, '| chat lines:', chats.length);
console.log('  ', errs.join(' / '));
console.log(errs.length === 1 && chats.length === 1
  ? 'PASS — fires for the stalled peer, silent for the healthy one'
  : 'FAIL');
