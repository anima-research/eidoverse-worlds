// A value as someone sent it, for a refusal to name. What the door and the
// world refuse arrived as JSON, so its JSON reads back what was sent; a
// value left out reads "nothing", and a long one is cut at 60 code points,
// so a character outside the BMP is never split. Numbers print as
// themselves, since JSON writes NaN and Infinity as null, and a value JSON
// can't write (a BigInt, a cycle) is quoted as a string rather than
// throwing out of a refusal.

/** @param {unknown} v */
export function shown(v) {
  if (v === undefined) return 'nothing';
  let s;
  try { s = typeof v === 'number' || typeof v === 'bigint' ? String(v) : JSON.stringify(v) ?? String(v); }
  catch { s = Object.prototype.toString.call(v); }
  const points = Array.from(s);
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : s;
}
