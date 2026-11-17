// Which voice transport is live, and the incarnation (kept across restarts) every credential carries. Imports no adapter, so asking
// "are we on the SFU?" never loads one.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./fsutil.ts";
import { nextIncarnation } from "./relaydecision.ts";

/** Which voice transport is live.
 *  - "sfu": our in-process SFU (no external service, so the flag alone enables it).
 *  - "off" (the default): NO VOICE AT ALL — text/presence/builds live, every voice control present and inert. It names
 *    no fallback: there is no P2P mesh behind it. */
export const voiceTransport = (): "sfu" | "off" =>
  process.env.VOICE_TRANSPORT === "sfu" ? "sfu" : "off";

export const relayEnabled = () => voiceTransport() !== "off";

// ---- the incarnation, kept across restarts ----------------------------------------
// Advanced atomically at every boot (atomicWrite: no fsync, so a power loss just after boot can lose the advance); every credential carries it, so a restart strands every old one. Starts process-unique
// (not a fixed sentinel: processes that never boot, like tests and tools, would otherwise share one incarnation).
let incarnation = nextIncarnation(null, crypto.randomUUID().slice(0, 8));

export function bootIncarnation(dir: string): string {
  const file = join(dir, "relay-incarnation");
  const prev = existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  incarnation = nextIncarnation(prev, crypto.randomUUID().slice(0, 8));
  atomicWrite(file, incarnation);
  return incarnation;
}

export const currentIncarnation = () => incarnation;
