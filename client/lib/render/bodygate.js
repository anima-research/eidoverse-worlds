// The body-first gate: the world's models wait to PARSE until your own body is on screen — world GLB parses
// stretch the frames the body's pipeline compiles wait on. Downloads are not gated;
// only the CPU lane's parse+texture pass is held. ARMED once a body load begins (armBodyGate); nothing armed means
// nothing to wait for. Released by setMe, the viewer path, a failed body, or a 12 s race in loadGLB, so a hung body
// never holds the world hostage. After the first release it is a resolved promise.
// No imports on purpose: assets.js and mybody.js both reach it, and the graph has enough assets ↔ avatar cycles.
let release = null;
let released = false;
let armed = false;
export function armBodyGate() { armed = true; }
export const bodyGateArmed = () => armed;
const gate = new Promise((res) => { release = res; });
export function bodyGate() { return gate; }
export function releaseBodyGate(why = 'body') {
  if (released) return;
  released = true;
  try { console.log(`[body] gate open: ${why}`); } catch { /* headless */ }
  release?.();
}
export const bodyGateOpen = () => released;
// The wait at the load boundary (assets.js): armed and not yet open → wait, but never past maxMs — a hung body
// must not hold the world hostage. Not armed, or already open → resolves at once. Returns how it resolved.
export function awaitBodyGate(maxMs = 12000) {
  if (!armed || released) return Promise.resolve(released ? 'open' : 'unarmed');
  let timer;
  return Promise.race([gate.then(() => 'open'), new Promise((r) => { timer = setTimeout(() => r('timeout'), maxMs); })])
    .finally(() => clearTimeout(timer));
}
