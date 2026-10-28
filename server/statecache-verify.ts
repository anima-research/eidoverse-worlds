// server/statecache-verify.ts — the background re-derive (a Worker, off the event loop): the log's first coversIndex+1 lines folded
// from genesis and chained, for server/livehost.ts to compare with the cache it booted from (server/statecache.ts).
import fs from "node:fs";
import { readLog, fold } from "../shared/protocol/fold.js";
import { chainStep } from "../shared/protocol/authority/storage.js";
import { encodeState, stateDigest } from "./statecache.ts";

declare const self: { onmessage: ((ev: { data: { logPath: string; coversIndex: number } }) => void) | null; postMessage(m: unknown): void };
self.onmessage = ({ data: { logPath, coversIndex } }) => {
  try {
    const entries = readLog(fs.readFileSync(logPath)).slice(0, coversIndex + 1);
    let head = "00".repeat(32); for (const e of entries) head = chainStep(head, e);
    self.postMessage({ digest: stateDigest(JSON.parse(JSON.stringify(encodeState(fold(entries))))), head, n: entries.length });
  } catch (x) { self.postMessage({ error: String((x as Error)?.message ?? x) }); }
};
