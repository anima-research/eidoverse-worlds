// A briefing is documentation offered by the door, never a world-log fact.
// No fetch or read receipt: each consumer owns its reading/wake policy.

/** The agent guide's pointer as the sequencer advertises it: relative to the
 * sequencer's HTTP base (its WORLD_URL without the trailing /ws), so every
 * reader resolves it against its own base and a mounted sequencer's guide
 * stays under its mount. */
export const AGENT_GUIDE = 'agents.md';

/** A pointer as an absolute http(s) URL without credentials, or why it can't be one here. */
function resolvePointer(url, base) {
  let u;
  try { u = new URL(url, base ?? undefined); }
  catch { return { why: base == null && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? 'no origin' : 'malformed' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { why: 'not http(s)' };
  if (u.username || u.password) return { why: 'credentials' };
  return { url: u.href };
}

// A pointer this reader can't resolve is never dropped silently: the motd
// says its address is unknown on this connection, and why, as the
// sequencer's own note says when its guide is unavailable. One malformed
// pointer does not discard the other guidance.
export function resolveBriefing(value, base) {
  if (!value || typeof value.motd !== 'string' || !Array.isArray(value.docs)) return null;
  const docs = [], unknown = [];
  for (const doc of value.docs) {
    if (!doc || typeof doc.title !== 'string' || typeof doc.url !== 'string' || typeof doc.version !== 'string') continue;
    const resolved = resolvePointer(doc.url, base);
    if (resolved.url) docs.push({ title: doc.title, url: resolved.url, version: doc.version });
    else unknown.push(resolved.why);
  }
  const why = [...new Set(unknown)].join(', ');
  const note = unknown.length === 0 ? ''
    : unknown.length === 1 ? ` The guide's address is unknown on this connection (${why}).`
    : ` ${unknown.length} guides' addresses are unknown on this connection (${why}).`;
  return { motd: value.motd + note, docs };
}
