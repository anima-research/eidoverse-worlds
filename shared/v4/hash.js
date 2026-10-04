// shared/v4/hash.js — SHA-256 of a string's UTF-8 bytes, as lowercase hex. Synchronous, everywhere.
//
// The v4 core hashes in three places: the world id (sha256 of genesis JCS), the state digest (§2.4) and blob names
// (§2.2). A reader verifying a chain hashes once per entry (research 29): that must be a synchronous hash. Awaiting
// WebCrypto's subtle.digest once per entry measured 30× slower than a sync pure-JS hash (334 µs vs 18.5 µs per
// entry), so the browser path is the sync pure-JS sha256hex from ../components.js (the same function blueprint and
// record hashes already use). Bun has a native sync hasher; the server uses it. tools/v4/run.ts proves both agree.
// No node: import here — the browser imports this file as-is.
import { sha256hex } from '../components.js';

const BunHasher = typeof globalThis.Bun !== 'undefined' ? globalThis.Bun.CryptoHasher : null;

/** @param {string} s @returns {string} 64 lowercase hex */
export const sha256 = BunHasher
  ? (s) => new BunHasher('sha256').update(s, 'utf8').digest('hex')
  : sha256hex;

/** The portable implementation, exported so a test can compare it with the native one. */
export const sha256Portable = sha256hex;

/** Lowercase hex of a string's UTF-8 bytes (what node's Buffer.from(s).toString("hex") gives). */
export function utf8Hex(s) {
  let out = '';
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, '0');
  return out;
}
