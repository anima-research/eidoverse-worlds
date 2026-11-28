// shared/protocol/is.js — the value tests every reader and checker shares (one copy, not one per file).
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
/** a non-empty string */
export const isStr = (v) => typeof v === "string" && v.length > 0;
/** a plain object: not null, not an array */
export const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v @returns {v is [number, number, number]} three finite numbers (a position, a size) */
export const isFiniteVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
