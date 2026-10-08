// Dialect-3 (physics) → v4: translate-v1's own path (since translate-v1@10, 2026-10-08), which runs her sim beside the v1
// fold whenever a log enters an epoch. The old world is her instant fold COMPOSED with her sim (PROTOCOL_v2, conformance
// order: foldEntry, then simEntry); v4 holds the same world differently (design 20): a punt becomes a logged launch with
// its exact stamped state, every rest a logged result (P5). After every old entry translate-v1 checks, bit for bit, (1)
// the composed old world against the v4 blind fold and (2) every body in flight against the authority's sim layer.
// This file was the lab's separate translator (code/v4-lab/translate-d3.js @ 11db981); it had no identities, content
// addresses, founder key or namespace, so the importer refused physics-era worlds rather than lose their outcomes. It is
// kept as the name her four goldens are checked under (sweep §3), with the stats shape they read.
import { translate as translateV1, TRANSLATOR_SIM } from "./translate-v1.js";

export const TRANSLATOR = TRANSLATOR_SIM;

/** translate-v1 with dialect-3 stats always present (worldDivergences, flightDivergences, launches, rests, first). */
export function translate(old, opts = {}) {
  const r = translateV1(old, opts);
  const s = r.stats;
  const stats = { ...s, launches: s.launches ?? 0, rests: s.rests ?? 0, worldDivergences: s.worldDivergences ?? s.divergences,
    flightDivergences: (s.flightDivergences ?? 0) + (s.simDisagreements ?? 0), first: s.firstDivergence };
  return { ...r, stats };
}
