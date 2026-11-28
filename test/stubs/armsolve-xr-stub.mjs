// Stand-in for xr.js + controller.js in armsolve-test: solveArm/relaxArm touch none of these; they exist so
// the module's import list resolves (a missing export is a SyntaxError at import time).
export const myState = { yaw: 0, speed: 0 };
export const isPresenting = () => false, puppetScale = () => 1, xrRig = () => null, xrHands = () => ({}), xrFingerCurl = () => ({});
export const syncRigToBody = () => {}, applyTurnEarly = () => {};
