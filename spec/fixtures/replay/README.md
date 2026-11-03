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

`bun tools/replaybench.ts` checks these alongside operator worlds.
`bun tools/replaybench-test.ts` proves the gate rejects changed colliders,
boxes and insertion order, and compares the 0.5 digest across installed JS
engines. Operator baselines lacking a sim digest report that gap; committed
fixtures fail if their sim golden is missing.

`--write` records explicitly selected baselines and preserves unselected
ones. A changed digest for an unchanged old-law log requires investigation,
not a silent baseline refresh. Physics corrections belong to a new epoch
version; the 0.3 and 0.4 sim goldens were captured before the 0.5 correction.
