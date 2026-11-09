export const AGENT_GUIDE = 'agents.md';

function resolvePointer(url, base) {
  let u;
  try { u = new URL(url, base ?? undefined); }
  catch { return { why: base == null && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? "the world's server has no public origin set" : 'malformed' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { why: 'not http(s)' };
  if (u.username || u.password) return { why: 'credentials' };
  return { url: u.href };
}

export function resolveBriefing(value, base) {
  if (!value || !Array.isArray(value.docs)) return null;
  const docs = [], unknown = [];
  for (const doc of value.docs) {
    if (!doc || typeof doc.url !== 'string' || typeof doc.version !== 'string') continue;
    const resolved = resolvePointer(doc.url, base);
    if (resolved.url) docs.push({ url: resolved.url, version: doc.version });
    else unknown.push({ version: doc.version, why: resolved.why });
  }
  return { docs, unknown };
}

export function briefingLines(briefing) {
  if (!briefing) return [];
  if (briefing.docs.length === 0 && briefing.unknown.length === 0) return ['Agent guide: none offered on this connection'];
  return [
    ...briefing.docs.map(doc => `Agent guide: ${doc.url}, version ${doc.version} when you joined`),
    ...briefing.unknown.map(doc => `Agent guide: version ${doc.version} when you joined; its address is unknown on this connection (${doc.why})`),
  ];
}
