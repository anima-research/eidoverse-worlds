# Fixtures

`01-build` … `06-components` are worlds in the retired first protocol (`spec/history/PROTOCOL-v1.md`): each holds
a `log.jsonl` (the whole log, genesis included) and `folded.json` (the state v1's reference fold gave it). They are
old-world inputs, not conformance vectors for this protocol: the importer's gates translate them
(`test/protocol/sweep.ts`, `tools/import-v1/snapshot-oracle.ts`, `pretrans-check.ts`) and the setup and
refused-join suites boot from `01-build`. What each exercised, in v1's words:

- `01-build`: creation, transforms, lights, a mount, and removing a parent.
- `02-swing`: sockets, reactions, an unknown component type, a motion in generous dialect, a `use`, a body mounting
  and dismounting, and an entry in a verb nobody knows.
- `03-authority`: the first joiner owning a new world; grants; the `*` wildcard.
- `04-overwrite`: the flat id namespace: a same-id `spawn` replaces the previous holder wholesale.
- `05-lightpolicy`: the light policy flags `keep` and `day`.
- `06-components`: the 2026-10-01 amendments: a lib-less `spawn` as an Empty, `light` and `collider` components.

01–04 were recorded from the v1 sequencer's websocket door; 05's and 06's `folded.json` are v1's fold of their logs.

License: CC0 1.0, as when they lived under spec/.
