// mybody.js stand-in for bodies-wear-test: the two signals the Profile reads.
// `me` is what is ACTUALLY on screen (null, a real body, or the capsule); `getMyAvatarName` is INTENT
// and deliberately survives a failed load — that asymmetry is the bug under test.
const state = (globalThis.__bodyState ||= { me: null, name: null });
export function getMe() { return state.me; }
export function getMyAvatarName() { return state.name; }
// this body's size / plate lift (Profile › Avatar): the prefs the section reads, and the writer it calls
export function myBodyPrefs() { return state.prefs ?? { scale: 1, plateY: 0 }; }
// `name` defaults to the body worn NOW, as the real one does — the body the write is filed under is recorded
export function setMyBodyPref(patch, name = state.name) {
  state.prefs = { ...myBodyPrefs(), ...patch }; state.writes = (state.writes ?? 0) + 1;
  (state.writeNames ||= []).push(name); return state.prefs;
}
