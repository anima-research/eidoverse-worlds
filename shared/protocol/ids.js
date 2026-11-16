// shared/protocol/ids.js — the ONE way an entity id is minted, by the authority (writers never choose ids). An id is
// world-scoped (PROTOCOL §3.1), but forks copy ids verbatim and a merge meets both sides' ids, so a minted id must not
// collide by construction: 26 base32 characters (130 random bits; about 2^-70 odds at a billion ids per world pair).
// OPAQUE: no readable slug (a slug goes stale; an id never changes). What a thing is called is its label; ids already
// minted with a slug stay valid. Ids stay [a-z0-9-]{1,64}.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rand = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
/** 26 random base32 characters (130 bits). */
export function randomPart() { const b = rand(26); let s = ""; for (const x of b) s += B32[x & 31]; return s; }
/** A fresh entity id: 26 base32 characters, nothing else (any argument is ignored: an id carries no word). */
export function mintId() { return randomPart(); }
/** A request-local placeholder for an id the authority will mint ('$table'; JSON:API's lid): written where a create's id
 *  goes, and anywhere in the same request that refers to that thing; the reply maps each one to the id it became. */
export const PLACEHOLDER = /^\$[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
export const isPlaceholder = (x) => typeof x === "string" && PLACEHOLDER.test(x);
/** The shape of a person's identity (server/directory.ts): an entity may never wear it, so a reference is never ambiguous. */
export const PERSON_ID = /^u-[a-z2-7]{20}(?:[a-z2-7]{4})?$/;
