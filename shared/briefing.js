// A briefing is documentation offered by the door, never a world-log fact.
// No fetch or read receipt: each consumer owns its reading/wake policy.
export function resolveBriefing(value, base) {
  if (!value || typeof value.motd !== 'string' || !Array.isArray(value.docs)) return null;
  const docs = [];
  for (const doc of value.docs) {
    if (!doc || typeof doc.title !== 'string' || typeof doc.url !== 'string' || typeof doc.version !== 'string') continue;
    try {
      const url = new URL(doc.url, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      docs.push({ title: doc.title, url: url.href, version: doc.version });
    } catch { /* one malformed pointer does not discard the other guidance */ }
  }
  return { motd: value.motd, docs };
}
