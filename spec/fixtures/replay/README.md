# Replay fixtures

These committed logs and `.replaybench.json` let a clean checkout check
both the instant fold and the complete ordered sim state without assets
or a running sequencer. Idle tick counters are excluded after settling.

- `eidosim-0.3/`: endpoint collisions, including that law's tunnelling.
- `eidosim-0.4/`: first-contact sweeps, including that law's deck sticking.
- `eidosim-0.5/`: remaining-motion sweeps and ground support contacts.
- `eidosim-order/`: two bodies at rest, so body insertion order is observable
  in the normative digest as well as static insertion order.

The first three tell the same story: terrain, a wall and deck before the
boxed epoch, two boxed spawns, punts, a wall moved during flight, and a
terrain change releasing bodies and rebuilding statics. The order fixture
adds a final punt so two bodies survive into the settled snapshot.

The `sweep` suite (`bun tools/protocol/run.ts sweep`, `tools/protocol/sweep.ts`) replays each fixture here against
its golden in `.replaybench.json` (`tools/replaybench.ts` and `replaybench-test.ts`, which once held this, are gone);
committed fixtures fail if their sim golden is missing.

Nothing rewrites `.replaybench.json`: a golden changes by a deliberate edit
of that file, one fixture at a time, never a silent refresh. A changed digest for an unchanged old-law log requires investigation,
not a silent baseline refresh. Physics corrections belong to a new epoch
version; the 0.3 and 0.4 sim goldens were captured before the 0.5 correction.
