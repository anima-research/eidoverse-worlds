# The ktx2 negotiation key: who reads it, and its generations (shared/ktx2.js)

## Why the browser never reads the key from a file

The sequencer imports shared/ktx2.js at boot. The browser once imported it too, off the sequencer's disk. In the
window between `git pull` and the restart, the old process was serving the new file: a client read key 2 off disk and
asked a server that had never heard of it, which answered as if unflagged (webp, immutable), and nginx pinned that
under ?ktx2=2. So the browser asks the RUNNING process (/version carries `ktx2Key`, no-store, resolved at that
process's boot) and uses exactly what it was handed. No key handed (an older sequencer, a failed fetch) means no
negotiation: an unflagged fetch is always the right answer for its URL, so nothing can be pinned wrong, on any
deploy, in any order. The LOD recipe (`lodRecipe` on /version) follows the same rule: a bare `lod=1` under two
recipes would be one immutable URL for two different byte-streams.

## Generations

1. The §20 launch key (2026-08-10), retired 2026-08-24: provisional fall-throughs had been served immutable under it.
2. The rollout key, retired at once when an already-poisoned nginx cache entry was observed during rollout.
3. The clean post-rollout generation, retired 2026-09-25: built variants were served immutable under it, and a
   variant can now be rebuilt in place (the transfer-function and texel-cap fixes), so every browser that fetched one
   under 3 would hold the old bytes for a year.
4. Variants are served short-lived and revalidating from here on (routes.ts VARIANT_CC), so no future rebuild needs
   another generation.
