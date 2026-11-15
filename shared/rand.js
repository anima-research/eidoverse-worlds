// shared/rand.js — the shared seeded stream, mulberry32 (#299): integer ops only, so every engine draws the same numbers.
// terrainmath.js and forecast.js keep their own copy of the same generator on purpose (the sim's pinned import closure; forecast imports nothing).

/** mulberry32: a function returning floats in [0, 1), seeded by a 32-bit integer. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n seeded bytes per call, from one mulberry32 stream: a lab's stand-in for crypto.getRandomValues. */
export function seededBytes(seed) {
  const rnd = mulberry32(seed);
  return (n) => Uint8Array.from({ length: n }, () => (rnd() * 256) | 0);
}
