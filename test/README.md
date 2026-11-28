# test

Every suite runs through the gate, not `bun test` (which finds nothing here: suites are plain scripts).

- **Run:** `bun run test` for everything, `bun run test <suite> <suite>` for some. Suite names are in `test/gate/suites.ts`; `docs/contributing/GATE-MANIFEST.md` lists them all.
- **Names:** see CONTRIBUTING's suffix rule (`-test`, `-check`, `-probe`, `-mutants`, `-bench`). Older files don't all follow it. A suite's lane is the list it's named in (`CORE`, `BROWSER` in `test/gate/suites.ts`; anything else is main), and the gate refuses a suite that launches a Chromium but isn't in `BROWSER`.
- **Layout:** each directory mirrors what it tests (`client/`, `server/`, `shared/`, `mcpl/`, `protocol/`, `services/`, `water/`). `harness/` and `stubs/` are shared helpers, `fixtures/` is data, `labs/` holds experiments outside the gate, `gate/` is the runner itself.
- **A new suite** goes in `test/gate/suites.ts`; then regenerate the manifest (`bun test/gate/run.ts --manifest` prints the table; paste it between the GENERATED markers in `docs/contributing/GATE-MANIFEST.md`) or the gate refuses to start. A test file that isn't a row must be listed in `test/gate/ungated.json` with a reason.
- **Watch it fail.** A suite that can't go red proves nothing; several here carry `--mutants` arms that break the code on purpose and must fail.
