# Labs: reproducing an owner's report in a copy of their world

A *lab* is a one-file, non-gated script that copies a real world, drives the client or the authority
to the moment an owner described, and renders or measures it. Labs are how the gym reports of
2026-10-10/11 were answered (hierarchy rows that could not be reached, a name that refused every act,
a held crate drawn in the wrong place, a stack that settled late). They are not tests: a lab is keyed
to one world's entities and one day's question, and it rots when the world changes. The method is
what lasts; most of the files were cut on 2026-10-15 (`git show --stat e414ab3d` lists them);
`tools/protocol/palm-frame.lab.ts` and `wsettings.lab.ts` stay as examples.

## The method
1. **Copy the world, never lab the live one.** `mkdir -p /tmp/lab && cp -r worlds/<name> /tmp/lab/` and
   serve the copy on its own port (`WORLDS_DIR=/tmp/lab PORT=<port> bun server/server.ts`). A lab that writes is writing to a copy.
2. **Reproduce the report in the owner's words.** Put their sentence in the file's header, dated. The lab
   does exactly what they did — the same menu, the same row, the same thing — before it measures anything.
3. **Measure, then look.** Print the numbers the question is about (where was it drawn vs where it is; how
   many ms between the act and the settle), AND render a frame to a file and open it. A number without the
   picture has been wrong here more than once.
4. **Turn the finding into a gate row.** Once the mechanism is named, the test belongs in a suite under
   `tools/protocol/run.ts` (`client-check` for the client, `authority-check` for the door, `scale-check` for
   budgets), red before the fix and green after. The lab is then done and can go.

## A runnable example
`tools/protocol/surface-parity.ts` (see `SURFACE-PARITY.md`) is the one lab-shaped tool that stayed: it copies
a world, opens it in two client trees, and diffs the pixels. Start a new lab from its world-copy and
headless-client scaffolding rather than from scratch.
