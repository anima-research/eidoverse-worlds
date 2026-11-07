# shared/ — modules every runtime folds with

One copy of the facts. Everything in this directory is imported verbatim by
all three species of runtime — the browser client (native ESM over HTTP at
`/shared/…`), the sequencer (Bun, from disk), and the mcpl agent — so shared
derivations (time of day, weather segments, particle meaning, and eventually
the whole fold) come out of exactly one function everywhere. The "fold is
sacred / mirrored math stays mirrored" house rules in AGENTS.md are true by
construction only for code that lives here; moving a mirrored pair into this
directory is how the rule is retired.

Constraints, on purpose:

- **Pure and dependency-free.** No three, no DOM, no Bun APIs, no
  `Date.now()` of its own — callers pass `now`. If it can't run in all three
  runtimes untouched, it doesn't belong here.
- **Plain JS + JSDoc types, no build step.** The browser imports these files
  as-is (the no-build doctrine holds); Bun's TS imports them directly. Type
  safety comes from `tsc --noEmit` over JSDoc, not from a compile.
- **Client code imports via `../../shared/…`** (from `client/lib/`): that
  path resolves to the repo root on disk (so headless tools can import client
  modules) and clamps to `/shared/…` in the browser (URLs don't ascend past
  root). The server route for `/shared/` serves this directory with the same
  no-store policy as client code.

Residents: `forecast.js` (day clock, weather policy, the sky fold),
`particles.js` (the `particles` component's meaning), and `protocol/` — the
protocol core: `protocol/fold.js` (the reference fold, conformance-tested against
`spec/conformance/` by `bun tools/protocol/run.ts conformance`), `protocol/authority.js`
(the authority and its one gate), `protocol/componentspec.js` (the component registry),
`protocol/replica.js` (what a client folds), `protocol/sandbox.js` (scripts) and
`protocol/simlayer.js` (physics beside the fold). spec/PROTOCOL.md is their
contract.
