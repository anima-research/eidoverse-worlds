// Dialect-3 (physics) → v4: translate-v1's own path (since translate-v1@10, 2026-10-08), which runs her sim beside the v1
// fold whenever a log enters an epoch. The old world is her instant fold COMPOSED with her sim (PROTOCOL_v2, conformance
// order: foldEntry, then simEntry). Since translate-v1@11 (2026-10-09, the stomp) the runtime no longer carries her
// engine, so a punt stays its imported act and each rest she computes is a plain change by `sim`; after every old entry
// translate-v1 checks the composed old world against the v4 blind fold, bit for bit.
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
