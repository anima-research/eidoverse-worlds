// protocol/soundclock-check substitutes this for the modules sounds.js imports that the guard-label stub does not
// cover; the audio seams only have to EXIST (a graph call is a test bug and says so). sound-clock-stub builds one.
export const editors = [];
export const registerEditor = (fn) => { editors.push(fn); };
export const registerHandler = () => {};   // the build-mode gestures (upload); these suites test the html block
export const commitEdit = () => ({ ok: true, errors: [] });
export const toast = () => {};
export const flashHint = () => {};
export const audioContext = () => { throw new Error('this stub builds no graph'); };
export const audioContextState = () => 'none';
export const playWhenAllowed = () => {};
export const volumeFor = () => 1;
// client/lib/serverclock.js's estimated server clock: soundclock-check renders the editor block only, so it is never read
export const serverNow = () => 0;
