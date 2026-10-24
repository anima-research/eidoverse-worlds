// sound-guard-test substitutes this for the modules sounds.js imports that the
// guard-label stub (main's) does not cover: the editor registry (inspect.js),
// the toast/hint seam (ui.js), and the three audio seams. No graph is ever
// built in that test — the editor block is rendered, not a sound — so the
// audio seams only have to EXIST; a call is a test bug and says so.
export const editors = [];
export const registerEditor = (fn) => { editors.push(fn); };
export const registerHandler = () => {};   // the edit-mode gestures (upload); these suites test the html block
export const commitEdit = () => ({ ok: true, errors: [] });
export const toast = () => {};
export const flashHint = () => {};
export const audioContext = () => { throw new Error('sound-guard-test builds no graph'); };
export const audioContextState = () => 'none';
export const playWhenAllowed = () => {};
export const volumeFor = () => 1;
// client/lib/serverclock.js's estimated server clock: sounds.js seeks the
// shared playhead against it (sound-clock-test exercises that; here the editor
// block is only rendered, so the value is never read)
export const serverNow = () => 0;
