// The two failures the old one-shot 'click' listener had, as tests.
const listeners = {};
globalThis.addEventListener = (e, fn) => { (listeners[e] ??= []).push(fn); };
globalThis.removeEventListener = (e, fn) => { listeners[e] = (listeners[e]||[]).filter(f=>f!==fn); };
const fire = (e) => [...(listeners[e]||[])].forEach(f => f());

let blocked = true;
const mkAudio = (n) => ({ n, played: false,
  play: () => blocked ? Promise.reject(new Error('NotAllowedError'))
                      : (mkAudio.played?.add(n), Promise.resolve()) });
mkAudio.played = new Set();

// inline the module's logic (it imports chat.js, which needs a DOM)
const pending = new Set(); let armed = false;
function playWhenAllowed(a) {
  a.play().then(()=>{}).catch(() => { pending.add(a); arm(); });
}
function arm() {
  if (armed) return; armed = true;
  const events = ['pointerdown','touchend','click','keydown'];
  const unlock = () => {
    for (const a of [...pending]) a.play().then(() => pending.delete(a)).catch(()=>{});
    queueMicrotask(() => { if (pending.size === 0) { for (const e of events) removeEventListener(e, unlock); armed = false; } });
  };
  for (const e of events) addEventListener(e, unlock);
}

// THREE speakers all blocked — the old code unlocked at most one.
const a1=mkAudio('a1'), a2=mkAudio('a2'), a3=mkAudio('a3');
[a1,a2,a3].forEach(playWhenAllowed);
await new Promise(r=>setTimeout(r,10));
console.log('held after block:', pending.size, '(want 3)');

// A TOUCH, not a click — the old listener never heard this.
blocked = false;
fire('touchend');
await new Promise(r=>setTimeout(r,10));
console.log('released by touchend:', mkAudio.played.size, '(want 3)');
console.log(pending.size===0 && mkAudio.played.size===3
  ? 'PASS — a touch releases EVERY held element'
  : `FAIL — pending=${pending.size} played=${mkAudio.played.size}`);
