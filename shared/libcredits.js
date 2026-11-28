// libcredits — who made a shipped library asset, and its licence. The table is defs/library/credits.json, written from the
// library's own CREDITS.md; where that doesn't say, the entry says so (`gap`) rather than guess.
/** The credits for a library path: its own entry, else the nearest directory default, else null. */
export function creditsFor(table, path) {
  if (!table || typeof path !== 'string') return null;
  if (table[path] && typeof table[path] === 'object') return { path, ...table[path] };
  let dir = path; while (dir.includes('/')) { dir = dir.slice(0, dir.lastIndexOf('/')); if (table[`${dir}/`]) return { path, ...table[`${dir}/`], from: `${dir}/` }; }
  return null;
}
/** One line: "Crow — Tripo or Meshy (generated-with), SkyeShark (rig…) · CC0-1.0". */
export function creditLine(c) {
  if (!c) return null;
  const who = (c.authors ?? []).map((a) => `${a.name} (${a.role})`).join(', ');
  return [c.title, who || null, c.license ?? null].filter(Boolean).join(' · ') + (c.gap ? ` (not recorded: ${c.gap})` : '');
}
