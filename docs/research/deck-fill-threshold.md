# Deck fill threshold (`DECK_FILL = 0.45`)

`mcpl/agent-ground.ts` on its summary fallback (no mesh to hand) registers a `/geom` top-surface band as a headless floor only when its **fill** (real up-facing `area`
divided by the band's bounding x/z rectangle, `fillOf`) is at least `DECK_FILL`. The rectangle alone overclaims badly
for sparse geometry: a palm's fronds bound a wide rectangle around almost nothing, and treating that as a floor rests
bodies in the canopy.

## Where 0.45 comes from

A survey of the shipped library (59 libs, 342 surfaces, 57 that the code would otherwise register). The two populations
separate cleanly and the gap between them is empty:

| population | fill |
|---|---|
| rubble piles | 0.004–0.036 (worst: 1.8 m² of surface in a 404 m² rectangle, 226× overclaim) |
| excavators, rig superstructure | 0.019–0.31 |
| palm canopy | 0.101 |
| everything sparse | ≤ 0.361 |
| perimeter walls | 0.53–0.57 |
| tank hull | 0.73 |
| wall pillar | 0.76 |
| watchtower decks | 0.76, 0.86 |
| rig top deck | 0.83 |
| wall gate | 1.00 |
| every real deck | ≥ 0.532 |

No surveyed surface falls between 0.361 and 0.532. 0.45 sits in the middle of that empty band, so library drift in
either direction has to travel before it changes an answer. `DECK_FILL` is the one line to move if the split needs
revisiting; re-run the survey first.

## The cost

On the summary fallback (no mesh to hand, or `registerMeshSupport` failed; the mesh fit returns first and never reads
`DECK_FILL`), a real-but-open deck (a catwalk, a grating) is abstained on, and a body falls to terrain instead. That is deliberate:
abstaining is the honest answer, and the alternative is inventing geometry.
