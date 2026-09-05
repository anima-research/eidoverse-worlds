// Semantic interpretation only: the generic component fold remains blind.
const text = (v, max) => typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()].slice(0, max).join('') : '';
export function readLabel(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { name: text(v.name, 120), description: text(v.description, 2000),
    visibility: ['nearby', 'always', 'inspect'].includes(v.visibility) ? v.visibility : 'nearby',
    offset: Array.isArray(v.offset) && v.offset.length === 3 && v.offset.every(n => Number.isFinite(n) && Math.abs(n) <= 100) ? [...v.offset] : null };
}
export function objectIdentity(entity, assets = []) {
  const label = readLabel(entity?.comp?.label);
  const assetName = text(assets.find(a => a.path === entity?.lib)?.name, 120);
  const basename = text((entity?.lib ?? '').split('/').pop()?.replace(/\.(glb|vrm)$/i, '').replace(/[_-]+/g, ' '), 120);
  return { ...label, authored: Boolean(label.name), id: String(entity?.id ?? ''), assetName, name: label.name || assetName || basename || String(entity?.id ?? '') };
}
// Shared bounded presentation policy, also exercised without a renderer.
export function visibleLabels(candidates, preference, selected) {
  if (preference === 'off') return [];
  return candidates.filter(c => c.authored && c.inView && c.distance <= (preference === 'all' || c.visibility === 'always' ? 60 : 12) &&
    (c.visibility !== 'inspect' || preference === 'all' || c.id === selected))
    .sort((a,b) => (b.id === selected) - (a.id === selected) || a.distance-b.distance).slice(0,32);
}
