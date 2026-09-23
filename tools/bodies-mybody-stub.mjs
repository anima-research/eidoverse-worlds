// mybody.js stand-in for bodies-wear-test: the two signals the Profile reads.
// `me` is what is ACTUALLY on screen (null, a real body, or the capsule); `getMyAvatarName` is INTENT
// and deliberately survives a failed load — that asymmetry is the bug under test.
const state = (globalThis.__bodyState ||= { me: null, name: null });
export function getMe() { return state.me; }
export function getMyAvatarName() { return state.name; }
