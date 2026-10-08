// shared/protocol/ids.js — the ONE way an entity id is minted, by the authority, every client and every agent (review
// 2026-10-07 H5). An id is world-scoped (PROTOCOL §3.1: a thing's global name is (world id, entity id)), but forks copy
// ids verbatim and a merge meets both sides' ids, so a minted id must not collide by construction: 26 base32 characters
// (130 random bits; 2^-65 odds at a billion ids per world pair), after an optional readable slug. The old forms collided
// for certain (the authority's <slug>-<count>: two forks of one parent minted the same next id for different things) or
// by the birthday bound (a client's 8 hex = 32 bits: 2% at 10 000 things a fork). Ids stay [a-z0-9-]{1,64}.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const rand = (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); return b; };
/** 26 random base32 characters (130 bits). */
export function randomPart() { const b = rand(26); let s = ""; for (const x of b) s += B32[x & 31]; return s; }
/** A slug for a readable prefix: lowercase letters, digits and '-', cut so the id stays within 64. */
export const slugOf = (s, max = 37) => String(s ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
/** A fresh entity id: `<slug>-<26 base32>`, or the 26 characters alone with no prefix. */
export function mintId(prefix) { const p = slugOf(prefix); return p ? `${p}-${randomPart()}` : randomPart(); }
/** The shape of a person's identity (server/directory.ts): an entity may never wear it, so a reference is never ambiguous. */
export const PERSON_ID = /^u-[a-z2-7]{20}$/;
