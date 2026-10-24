# The maintenance command — the operator's procedure

Informative (recut C19, 2026-10-21). spec/PROTOCOL.md §4 keeps the rule: a load never writes; stored values are rewritten
only by one explicit maintenance command, as the system's own recorded acts (`lift-sockets`, `rename-components`,
`repair-shapes`, each carrying `command: "repair"` and `by`). This is how an operator runs it.

- From a shell on the host: `bun tools/protocol/world.ts repair <name>`.
- From inside the world, as a server operator: `operator-repair {verb: "repair"}` (the acts carry `operator: true`).

A world that needs a step whose old shape no reader serves refuses every write (not `leave`) with `repair-needed`, whose
text names the command. Each step is backed up first and can be rolled back.
