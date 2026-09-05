// chat-log-test substitutes this for base.js — the same CONFIG/bus the core
// stub hands out (one bus, one name), plus the helpers chat.js reads there.
export * from './chat-core-stub.mjs';
export function report() {}
export function angleDelta(a, b) { return b - a; }
export function setName() {}
