// My body's one switch (recut A2, 10-20): accept | ask | refuse — the answer every act on my body gets from the
// authority, which is the only place it's decided (A1: no client gate). This module only remembers my choice
// (localStorage, so it survives the session) and hands it to consentsync, which sends it on every arrival and change.
// A leaf with zero lib imports. setPushable/setPosable stay as the old /pushable switch's meaning: on = accept.
import { SWITCHES, DEFAULT_SWITCH } from '../../shared/protocol/consent.js';
export { SWITCHES };
export const SWITCH_WORDS = { accept: 'anyone may (pose, shove, drag, touch)', ask: 'ask me first, every time', refuse: 'nobody may' };

const KEY = 'ew-body-switch';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
let current = SWITCHES.includes(lsGet(KEY)) ? lsGet(KEY) : DEFAULT_SWITCH;
const listeners = new Set();

export const mySwitch = () => current;
export function setSwitch(v) { if (!SWITCHES.includes(v) || v === current) return false; current = v; lsSet(KEY, v); for (const fn of listeners) fn(v); return true; }
export function onConsentChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const bodyTable = () => ({ switch: current });   // what consentsync sends

export const pushable = () => current === 'accept';
export const posable = () => current === 'accept';
export const setPushable = (b) => setSwitch(b ? 'accept' : 'refuse');
export const setPosable = setPushable;
// what an incoming ask is for, in words (an ask still names its act; the answer is mine, per ask)
export const CLASS_WORDS = {
  near: 'stand close to me', follow: 'follow me around', touch: 'touch me (hands, shoulders, back, face)',
  intimate: 'touch me intimately (chest, waist, hips)', pose: 'pose my body', shove: 'knock me over',   // INTIMATE_POINTS (shared consent.js): I39
  displace: 'drag or carry me', voice: 'speak into my ear',
};
