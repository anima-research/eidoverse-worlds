// Which voice transport is live, and the durable incarnation every credential
// carries. Transport-NEUTRAL by construction: this module imports no adapter.
//
// 🔴 WHY THIS FILE EXISTS. Both of these lived inside `relayadapter.ts` — the
// LiveKit adapter — so `server.ts` and `routes.ts` imported the LiveKit module
// merely to ask "are we on the SFU?", and the in-process SFU depended on the
// implementation it replaced. That is backwards, and it is what kept three
// LiveKit packages in a branch whose whole argument is "own the stack, no extra
// dependencies" (R, 2026-08-16: "I thought we were moving away from that").
//
// Extracting first, deleting second: nothing here is new logic, so the delete
// that follows is a delete and not a rewrite.

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { nextIncarnation } from "./relaydecision.ts";

/** Which voice transport is live.
 *  - "sfu": our in-process SFU. Needs no external service, so the flag alone
 *    enables it.
 *  - "off": NO VOICE AT ALL. 🔴 This used to mean "the P2P mesh is the path" —
 *    the mesh is now DELETED (25f61df, #104 phase-1 cutover), so an unset
 *    VOICE_TRANSPORT is a silent no-voice world: text/presence/builds all live,
 *    every voice control present and inert. Rollback to the mesh is `git
 *    revert` of the deletion, not this flag.
 *
 *  The default stays "off" — opt-in until the acceptance table passes — but an
 *  operator reading "off" should know it no longer names a fallback. */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- durable incarnation ----------------------------------------------------
// Advanced atomically at every boot: tmp + rename, so a torn write leaves the
// previous file intact, and the entropy suffix makes even a lost-file counter
// reuse non-colliding. Every credential and admission check carries it, so a
// restart strands every old credential structurally.
//
// 🔴 THIS IS THE IMPLEMENTATION THE SFU ADAPTER WAS IGNORING. sfuadapter.ts
// called `nextIncarnation(null, randomUUID())` with a hardcoded `null` prev, so
// its incarnation reset to `i1-…` on every process start while this correct,
// durable version sat two files away, already booted. Audited 2026-08-16; the
// extraction makes the good one the only one.
// 🔴 SELF-INITIALISING, because a getter that returns a sentinel is worse than
// one that is merely non-durable. The first cut of this module left
// `"i0-unstarted"` as the value until server.ts called bootIncarnation(), so
// every consumer that does NOT boot it — the adapter tests, any tool importing
// sfuadapter directly — got a credential stamped `i0-unstarted`. That is not a
// stale incarnation, it is a FIXED one shared by every such process: exactly
// the credential-collision amendment 2 exists to prevent, reintroduced while
// fixing amendment 2. (Caught by sfu-adapter-test going red — the test I was
// about to "fix" was right that something had changed.)
//
// So: a process-unique value from the start, upgraded to the durable one when
// a server boots it. Never a sentinel that can be mistaken for a real epoch.
let incarnation = nextIncarnation(null, crypto.randomUUID().slice(0, 8));

export function bootIncarnation(dir: string): string {
  const file = join(dir, "relay-incarnation");
  const prev = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  incarnation = nextIncarnation(prev, crypto.randomUUID().slice(0, 8));
  const tmp = file + ".tmp";
  writeFileSync(tmp, incarnation);
  renameSync(tmp, file);
  return incarnation;
}

export const currentIncarnation = () => incarnation;
