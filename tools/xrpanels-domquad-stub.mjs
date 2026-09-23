// the domquad surface xrpanels.js imports — the REAL quads are part 4's VR
// runtime; the registration contract under test never reaches them. Recorders,
// not invented shape: every name here exists in client/lib/domquad.js.
export const calls = [];
const rec = (n) => (...a) => { calls.push([n, ...a]); };
export const domQuadsEnabled = () => false;
export const domQuadsEnter = rec('domQuadsEnter');
export const domQuadsExit = rec('domQuadsExit');
export const domQuadsPick = () => null;
export const domQuadsSetShown = rec('domQuadsSetShown');
export const domQuadsShown = () => false;
export const domQuadShow = rec('domQuadShow');
export const domQuadsGrab = rec('domQuadsGrab');
export const domQuadRelease = rec('domQuadRelease');
