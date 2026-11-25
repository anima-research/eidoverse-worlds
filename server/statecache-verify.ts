// server/statecache-verify.ts — a Worker that re-derives a world's state from genesis (the log's first coversIndex+1 lines folded and
// chained, plus their views via server/foldviews.ts) so server/livehost.ts can check the cache it booted from (server/statecache.ts).
// Peak RAM is about an eager boot's: the cache buys boot latency, not memory.
import fs from "node:fs";
import { readLog, fold } from "../shared/protocol/fold.js";
import { chainStep } from "../shared/protocol/authority/storage.js";
import { encodeState, stateDigest } from "./statecache.ts";
import { viewsFresh } from "./foldviews.ts";

declare const self: { onmessage: ((ev: { data: { logPath: string; coversIndex: number; views: { sim: boolean } | null } }) => void) | null; postMessage(m: unknown): void };
self.onmessage = ({ data: { logPath, coversIndex, views } }) => {
  try {
    const entries = readLog(fs.readFileSync(logPath)).slice(0, coversIndex + 1);
    let head = "00".repeat(32); for (const e of entries) head = chainStep(head, e);
    const v = views ? stateDigest(JSON.parse(JSON.stringify(viewsFresh(entries, { sim: views.sim })))) : undefined;
    self.postMessage({ digest: stateDigest(JSON.parse(JSON.stringify(encodeState(fold(entries))))), head, n: entries.length, views: v });
  } catch (x) { self.postMessage({ error: String((x as Error)?.message ?? x) }); }
};
