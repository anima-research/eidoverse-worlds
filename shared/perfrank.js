// perfrank — the performance ranking rule, shared by the client's perfscope and the server's library catalog so a card's
// rank and the loupe's agree. Five ranks; per-subject thresholds: crossing [i] puts you in tier i+1; overall = the worst category.
export const PERF_THRESHOLDS = {
  tris:  [5_000, 20_000, 60_000, 150_000],
  draws: [2, 5, 12, 25],
  texMB: [8, 24, 64, 128],
  bones: [75, 150, 256, 400],
  mats:  [2, 4, 8, 16],
  alpha: [1, 3, 6, 12],
};
export const TIER_NAMES = ['excellent', 'good', 'medium', 'poor', 'very poor'];
// data colours, not chrome
export const TIER_COLORS = ['#2fd08a', '#9be04a', '#ffc23d', '#ff7a2f', '#f23b52'];
export const tierOf = (v, k) => PERF_THRESHOLDS[k].reduce((t, th) => (v > th ? t + 1 : t), 0);
/** {tris, draws, texMB, bones, mats, alpha} → per-category tiers, the overall rank, and which category set it. */
export function rankOf(m) {
  const tiers = Object.fromEntries(Object.keys(PERF_THRESHOLDS).map((k) => [k, tierOf(m[k] ?? 0, k)]));
  const rank = Math.max(...Object.values(tiers));
  return { tiers, rank, worst: Object.keys(tiers).find((k) => tiers[k] === rank) };
}
