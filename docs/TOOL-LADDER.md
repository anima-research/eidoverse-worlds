# The tool ladder

How a verb gets onto the agent surface (`mcpl/tools.ts`) — and how most of them don't. The component half of this
question is `docs/COMPONENT-LADDER.md`; the rule here is the one `mcpl/tools.ts` states above `TOOL_ROWS` (R's
standard, 2026-10-14) and the suites that enforce it. Hesperus, 2026-10-15.

## The three questions

Ask them in order. A "no" to any one ends the climb at that rung.

1. **Is it the same word the browser uses?** A person at the keyboard and an agent at the door must call one thing by
   one name (`move`, `create`, `inspect`, `edit`, `act`). If the human surface has no word for it, the human surface is
   the first place to add one — the agent never gets a verb people can't see. `vocab-check` fails spellings that drift
   (`comp`/`lib` → `components`/`model`).
2. **Is the name intuitive to everyone who might use the action?** Not to its author: to a stranger with the tool list
   and no docs. `take_off` is; `flightBodyDown` is not.
3. **Is the action useful in general situations?** A thing most worlds want most days. Nine flight verbs were not; one
   `move {mode: "fly"}` is. Moderation is not a tool each; it is `act {verb: kick|ban|unban|bans}`.

Passes all three → an **engine tool**: a row in `TOOL_ROWS` and a handler.
Fails 2 or 3 but the action exists → a **mode** of a general tool (`pose {wings}`, `reach {release}`, `create {from}`),
and if it had a name before, that name goes in `TOOL_FOLDS` so the old call answers with the call that does it now.
A rename of something that stays → an **alias** in `TOOL_ALIASES` *with* an entry in `TOOL_ALIAS_ARGS` that turns the
old argument shape into the new one (or refuses, teaching the two calls that do it now). An alias with no argument
translation is a shape error wearing a helpful note — that was `walk_to {x, z}` until 2026-10-15.

## The checklist (each line is a suite that fails without it)

- [ ] **The row**: `{ name, title, description, inputSchema, annotations }` in `TOOL_ROWS`. `annotations` is honest MCP
      metadata — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — and `agenttools-check` AT4 reads
      every row for it. A description carries one example call where the shape isn't obvious.
- [ ] **The handler**: `HANDLERS[name]`, returning `{content: [{type: "text", text}], isError?}`. A refusal from the
      authority is passed through in its own words (`refusalText`): the tool never invents a reason. The import-time
      check throws if a row has no handler or a handler no row.
- [ ] **One body**: a tool that moves, holds or places walks the AUTHORITY's body through the same shared code the
      browser uses (`shared/mover.js`, `shared/grab.js`) — `agenttools-check` AT1 is the "two bodies" guard.
- [ ] **Its live row**: an `AT` row in `tools/protocol/agenttools-check.ts` that calls it on a real `WorldAgent` against a
      real sequencer and checks the world, not the text. Watch it fail first (stash the handler).
- [ ] **Its words in AGENTS.md**: the tools table (`### The tools — general shapes, with modes`), in v4 words. `vocab-check`
      reads AGENTS.md too.
- [ ] **If it replaces a name**: `TOOL_ALIASES` + `TOOL_ALIAS_ARGS` (rename) or `TOOL_FOLDS` (became a mode) — and
      `mcpl/alias-test.ts` gets the translation row. Never delete a name without one of the two.
- [ ] **Not a tool at all**: a bench or rehearsal hook (`flightBodyDown`) is called on the agent directly by its test.

## Worked example — `walk_to` (2026-10-15)

`walk_to {x, z, run?, tolerance?}` was the agent's walk. Question 1: the browser has no `walk_to`; it has `move`
(the W key, the VR stick, `move {to}` at the door). So the tool is `move {to: [x, z] | [x, y, z] | "<name>", run?,
tolerance?, mode?: walk|fly}`, which also absorbs the nine flight verbs as a mode. `walk_to` stays as an alias:

```ts
TOOL_ALIASES.walk_to = "move";
TOOL_ALIAS_ARGS.walk_to = (a) => ({ to: [a.x, a.z], ...(a.run !== undefined ? { run: a.run } : {}), ...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}) });
```

and `agenttools-check` AT7 calls `walk_to {x, z, tolerance}` on a live agent and checks the body MOVED. Before the
translation landed, that row was red with "move needs to: [x, y, z]…" — the alias ran the right tool with the wrong
words, and nothing had tested it. `spawn {query}` is the other case: no one-step new form exists, so the translation
refuses and names the two calls (`library {query}` then `create {model}`).

## What this is for

So the next person who wants a tool can answer the three questions in a pull request's first paragraph, point at the
AT row that proves it, and be reviewed on those — not on taste.
