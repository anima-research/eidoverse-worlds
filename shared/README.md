# shared/ — modules every runtime folds with

One copy of the facts. This directory is written so any of the three
runtimes can import it verbatim — the browser client (native ESM over HTTP at
`/shared/…`), the sequencer (Bun, from disk), and the mcpl agent — so shared
derivations (time of day, weather segments, particle meaning, and
the whole fold) come out of exactly one function everywhere. AGENTS.md's "the
fold is sacred" rule is true by construction only for code that lives here;
moving a mirrored pair into this directory is how a mirror is retired.

Constraints, on purpose:

- **Pure and dependency-free.** No three, no DOM, no Bun APIs, no
  `Date.now()` of its own — callers pass `now` (known exceptions: terrainshape.js's retry timing,
  bodyscale.js saveBodyPrefs' stamp, refusal.js's `now` defaults). If it can't run in all three
  runtimes untouched, it doesn't belong here. One exception: the script
  sandbox's isolation (`protocol/sandbox.js` :30 and :293–306, and
  `protocol/sandbox-child.js`, the process it spawns) uses node/Bun, loaded
  only where an authority runs it.
- **Plain JS + JSDoc types, no build step.** The browser imports these files
  as-is (the no-build doctrine holds); Bun's TS imports them directly. Type
  safety comes from `tsc --noEmit` over JSDoc, not from a compile.
- **Client code imports via `../../shared/…`** (from `client/lib/`): that
  path resolves to the repo root on disk (so headless tools can import client
  modules) and clamps to `/shared/…` in the browser (URLs don't ascend past
  root). The server serves this directory as static files, like client code.

Landmarks: `forecast.js` (day clock, weather policy, the sky fold),
`components.js` (the component library), `editschema.js` (what can be edited
on a thing, for every surface), `particles.js` (the `particles` component's
meaning), and `protocol/` — the protocol core: `protocol/fold.js` (the reference fold, conformance-tested against
`spec/conformance/` by `bun test/gate/run.ts conformance`), `protocol/authority.js`
(the authority and its one gate), `protocol/componentspec.js` (the component registry),
`protocol/replica.js` (what a client folds), `protocol/sandbox.js` (scripts) and
`protocol/simlayer.js` (physics beside the fold). spec/PROTOCOL.md is their
contract.

Who imports what (2026-11-08): most modules have two or three runtimes as
importers, but not all.
- **server only (40)**: the authority (`protocol/authority.js`, `protocol/authority/*`), the sandbox pair
  (`sandbox-child.js` is spawned by path), `protocol/{verbspec,verbclasses,refusalcodes,scriptrules,assetref}.js`,
  `skydefs`, `structdefs`, `uidefs`, `floradefs`, `flora-presets`, `blast`.
- **client only (8)**: `blueprint`, `credits`, `flightpilot`, `lookat`, `particlesim`, `reach`, `structure-edit`, `terrainlayers`.
- **no runtime importer**: `protocol/kernelspec.js` (the kernel pin's pure half, read by
  test/protocol/kernel-check.ts) and `protocol/scriptaudit.js` (an auditor's re-run, docs/guide/SCRIPTS.md).

`conformance/{motion,water}.json` aren't code: they are vectors the native (Unreal) port reproduces; CONTRIBUTING
"Where a file goes" says where every vector lives.

Every file's first line says what it is: `head -qn1 shared/*.js shared/protocol/*.js`.
