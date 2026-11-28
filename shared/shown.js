// A value as someone sent it, for a refusal to name: its JSON, cut at 60 code points; undefined reads "nothing".
// Numbers print as themselves (JSON writes NaN/Infinity as null); what JSON can't write (a BigInt, a cycle) never throws.

/** @param {unknown} v */
export function shown(v) {
  if (v === undefined) return 'nothing';
  let s;
  try { s = typeof v === 'number' || typeof v === 'bigint' ? String(v) : JSON.stringify(v) ?? String(v); }
  catch { s = Object.prototype.toString.call(v); }
  const points = Array.from(s);
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : s;
}
